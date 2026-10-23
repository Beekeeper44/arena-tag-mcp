// The tag recipe: preview (draft) -> stage (freeze snapshot) -> go live (write) -> verify / undo.
// Two approvals, every step recorded with who asked.
import { randomBytes } from "crypto";
import { config, validateTag } from "./config";
import { queryCards, queryCardsDetailed, summarize, type CardFilters, type CardRow, type PostFilters } from "./metabase";
import { openAdminSession, patchTag, regenerateImages, approveReview, changeGradesLikeReview, type WriteResult, type WriteKind } from "./admin";
import { searchWatches, watchLabel, type WatchRow } from "./watches";
import { searchArena, type ArenaCard } from "./arena";
import { q } from "./db";

type Run = {
  id: string;
  status: string;
  action: "set" | "clear" | "undo";
  tag: string | null;
  mode: "overwrite" | "skip_tagged";
  filters: CardFilters;
  post_filters: PostFilters;
  requested_by: string;
  preview_count: number;
  dry_run: boolean | null;
  undo_of: string | null;
  expires_at: string;
  kind: WriteKind;
};

const newId = () => "r_" + randomBytes(5).toString("hex");
const hoursFromNow = (h: number) => new Date(Date.now() + h * 3600_000).toISOString();

function applyMode<T extends { tag: string | null }>(rows: T[], action: "set" | "clear", tag: string | null, mode: string) {
  // Drop no-ops, and (in skip_tagged mode) anything that already carries a different tag.
  return rows.filter((r) => {
    if (action === "clear") return !!r.tag;
    if (r.tag === tag) return false;
    if (mode === "skip_tagged" && r.tag) return false;
    return true;
  });
}

async function loadRun(id: string): Promise<Run> {
  const [run] = await q<Run>(`SELECT * FROM tag_runs WHERE id = $1`, [id]);
  if (!run) throw new Error(`No run ${id}`);
  return run;
}

async function pool<T, R>(items: T[], size: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.max(1, size) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx]);
    }
  });
  await Promise.all(workers);
  return out;
}

// ---------- 1. Draft + preview (read only) ----------
export async function previewRun(input: {
  filters: CardFilters;
  post_filters?: PostFilters;
  action: "set" | "clear";
  tag?: string | null;
  mode?: "overwrite" | "skip_tagged";
  requested_by: string;
}) {
  const action = input.action;
  const tag = action === "clear" ? null : (input.tag ?? "").trim();
  if (action === "set") {
    const err = validateTag(tag as string);
    if (err) throw new Error(err);
  }
  if (!Object.values(input.filters).some((v) => v !== undefined && v !== "")) {
    throw new Error("At least one filter is required.");
  }
  const mode = input.mode ?? "overwrite";
  const post = input.post_filters ?? {};

  const { rows: matched, missing } = await queryCardsDetailed(input.filters, post);
  const rows = applyMode(matched, action, tag, mode);
  const summary = summarize(rows, tag);

  const id = newId();
  await q(
    `INSERT INTO tag_runs (id, status, action, tag, mode, filters, post_filters, requested_by, preview, preview_count, expires_at)
     VALUES ($1,'draft',$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [id, action, tag, mode, JSON.stringify(input.filters), JSON.stringify(post), input.requested_by,
     JSON.stringify(summary), rows.length, hoursFromNow(config.runExpiryHours())]
  );

  return {
    run_id: id,
    status: "draft",
    action,
    tag,
    mode,
    matched_before_exclusions: matched.length,
    no_cards_found_for: missing.map((m) => `${m.key}: ${m.value}`),
    excluded_as_no_op_or_skipped: matched.length - rows.length,
    ...summary,
    cap: config.maxItemsPerRun(),
    over_cap: rows.length > config.maxItemsPerRun(),
    dry_run: config.dryRun(),
    warning: missing.length
      ? `No cards matched ${missing.map((m) => m.value).join(", ")}. Tell the user before staging; check spelling.`
      : undefined,
    next_step:
      rows.length === 0
        ? "Nothing to do."
        : `Review the breakdown. To freeze this exact list, call stage_tag_run with run_id=${id} and confirm_count=${rows.length}.`,
  };
}

// ---------- 2. Stage: approval #1, freeze snapshot ----------
export async function stageRun(input: { run_id: string; confirm_count: number; staged_by: string }) {
  const run = await loadRun(input.run_id);
  if (run.status !== "draft") throw new Error(`Run is ${run.status}, not draft.`);
  if (new Date(run.expires_at) < new Date()) throw new Error("Draft expired. Run a new preview.");
  if (input.confirm_count !== run.preview_count) {
    throw new Error(`confirm_count ${input.confirm_count} does not match the preview count ${run.preview_count}.`);
  }
  if (run.preview_count > config.maxItemsPerRun()) {
    throw new Error(`Preview has ${run.preview_count} cards; cap is ${config.maxItemsPerRun()}. Narrow the filters.`);
  }

  // Re-query so the snapshot reflects now; refuse if the set drifted.
  const rows = applyMode(await queryCards(run.filters, run.post_filters), run.action as "set" | "clear", run.tag, run.mode);
  if (rows.length !== run.preview_count) {
    await q(`UPDATE tag_runs SET status='cancelled', result=$2 WHERE id=$1`, [
      run.id, JSON.stringify({ reason: "count drifted", preview: run.preview_count, now: rows.length }),
    ]);
    throw new Error(`Matches changed from ${run.preview_count} to ${rows.length} since preview. Draft cancelled; run a new preview.`);
  }

  await q(
    `INSERT INTO tag_run_items (run_id, item_id, previous_tag, new_tag, label, ev)
     SELECT $1, t.item_id, t.prev, $2, t.label, t.ev
     FROM unnest($3::text[], $4::text[], $5::text[], $6::numeric[]) AS t(item_id, prev, label, ev)`,
    [
      run.id,
      run.tag,
      rows.map((r) => r.item_id),
      rows.map((r) => r.tag),
      rows.map((r) => [r.ac_number, r.set_name, r.player_name, r.parallel_name, r.grade].filter(Boolean).join(" · ")),
      rows.map((r) => r.estimated_value),
    ]
  );
  const [updated] = await q<{ expires_at: string }>(
    `UPDATE tag_runs SET status='staged', staged_by=$2, staged_at=now(), staged_count=$3, expires_at=$4
     WHERE id=$1 AND status='draft' RETURNING expires_at`,
    [run.id, input.staged_by, rows.length, hoursFromNow(config.runExpiryHours())]
  );
  if (!updated) throw new Error("Run changed state while staging.");

  return {
    run_id: run.id,
    status: "staged",
    frozen_cards: rows.length,
    action: run.action,
    tag: run.tag,
    previous_tags_saved_for_undo: true,
    expires_at: updated.expires_at,
    dry_run: config.dryRun(),
    next_step: `To write to admin, call go_live_tag_run with run_id=${run.id} and confirm=true.`,
  };
}

// ---------- 3. Go live: approval #2, write to admin ----------
async function executeWrites(
  runId: string,
  items: { item_id: string; target: string | null }[],
  okStatus: string,
  adminUserId?: string,
  kind: WriteKind = "card"
) {
  const session = await openAdminSession(adminUserId);
  let results: WriteResult[];
  try {
    results = await pool(items, config.writeConcurrency(), (it) => patchTag(session, it.item_id, it.target, kind));
  } finally {
    await session.revoke();
  }
  const statuses = results.map((r, i) => {
    if (!r.ok) return "failed";
    if (r.returnedTag !== undefined && r.returnedTag !== items[i].target) return "mismatch";
    return okStatus;
  });
  await q(
    `UPDATE tag_run_items AS i SET status=t.status, http_status=t.http, returned_tag=t.ret, error=t.err, updated_at=now()
     FROM unnest($2::text[], $3::text[], $4::int[], $5::text[], $6::text[]) AS t(item_id, status, http, ret, err)
     WHERE i.run_id=$1 AND i.item_id=t.item_id`,
    [
      runId,
      items.map((x) => x.item_id),
      statuses,
      results.map((r) => r.status),
      results.map((r) => (r.returnedTag === undefined ? null : r.returnedTag)),
      results.map((r) => r.error ?? null),
    ]
  );
  const tally = (s: string) => statuses.filter((x) => x === s).length;
  return {
    written_ids: items.filter((_, i) => statuses[i] === okStatus).map((x) => x.item_id),
    succeeded: tally(okStatus),
    failed: tally("failed"),
    mismatch: tally("mismatch"),
    failures: results
      .map((r, i) => ({ item_id: items[i].item_id, status: r.status, error: r.error }))
      .filter((_, i) => statuses[i] !== okStatus)
      .slice(0, 20),
  };
}

export async function goLive(input: { run_id: string; confirm: boolean; approved_by: string; dry_run?: boolean; as_admin_user_id?: string }) {
  if (input.confirm !== true) throw new Error("confirm must be true.");
  const run = await loadRun(input.run_id);
  if (new Date(run.expires_at) < new Date()) throw new Error("Staged run expired. Run a new preview.");
  const dry = config.dryRun() || input.dry_run === true;

  // Atomic claim: only one caller can move staged -> executing.
  const [claimed] = await q(
    `UPDATE tag_runs SET status='executing', approved_by=$2, live_at=now(), dry_run=$3, admin_as=$4
     WHERE id=$1 AND status='staged' RETURNING id`,
    [run.id, input.approved_by, dry, input.as_admin_user_id ?? null]
  );
  if (!claimed) throw new Error(`Run is ${run.status}; only a staged run can go live, and only once.`);
  if (!dry && run.kind === "watch" && !config.watchTagPath()) {
    await q(`UPDATE tag_runs SET status='staged' WHERE id=$1`, [run.id]);
    throw new Error("Watch tags can't be written yet: set WATCH_TAG_PATH in Vercel (the admin path that saves a watch's tag). Dry runs work now.");
  }

  const items = await q<{ item_id: string }>(`SELECT item_id FROM tag_run_items WHERE run_id=$1 AND status='pending'`, [run.id]);

  if (dry) {
    await q(`UPDATE tag_run_items SET status='would_write', updated_at=now() WHERE run_id=$1`, [run.id]);
    const result = { dry_run: true, would_write: items.length };
    await q(`UPDATE tag_runs SET status='dry_run_completed', finished_at=now(), result=$2 WHERE id=$1`, [run.id, JSON.stringify(result)]);
    return { run_id: run.id, status: "dry_run_completed", ...result, note: "DRY_RUN is on. Nothing was written to admin." };
  }

  const res = await executeWrites(run.id, items.map((i) => ({ item_id: i.item_id, target: run.tag })), "written", input.as_admin_user_id, run.kind);
  const status = res.failed || res.mismatch ? "partial" : "completed";
  await q(`UPDATE tag_runs SET status=$2, finished_at=now(), result=$3 WHERE id=$1`, [run.id, status, JSON.stringify(res)]);
  return {
    run_id: run.id,
    status,
    action: run.action,
    tag: run.tag,
    ...res,
    next_step: `Call verify_tag_run after the warehouse syncs. Undo with undo_tag_run run_id=${run.id}.`,
  };
}

// ---------- Undo: restore each card's previous tag ----------
export async function undoRun(input: { run_id: string; confirm: boolean; requested_by: string; as_admin_user_id?: string }) {
  if (input.confirm !== true) throw new Error("confirm must be true.");
  const run = await loadRun(input.run_id);
  if (!["completed", "partial"].includes(run.status)) throw new Error(`Run is ${run.status}; only completed or partial runs can be undone.`);
  if (config.dryRun()) throw new Error("DRY_RUN is on; undo would not write. Turn DRY_RUN off first.");

  const items = await q<{ item_id: string; previous_tag: string | null }>(
    `SELECT item_id, previous_tag FROM tag_run_items WHERE run_id=$1 AND status IN ('written','mismatch')`,
    [run.id]
  );
  const undoId = newId();
  await q(
    `INSERT INTO tag_runs (id, status, action, tag, mode, filters, post_filters, requested_by, preview_count, approved_by, live_at, dry_run, undo_of, expires_at, kind)
     VALUES ($1,'executing','undo',NULL,'overwrite','{}','{}',$2,$3,$2,now(),false,$4,now(),$5)`,
    [undoId, input.requested_by, items.length, run.id, run.kind]
  );
  await q(
    `INSERT INTO tag_run_items (run_id, item_id, previous_tag, new_tag)
     SELECT $1, t.item_id, $2, t.prev FROM unnest($3::text[], $4::text[]) AS t(item_id, prev)`,
    [undoId, run.tag, items.map((i) => i.item_id), items.map((i) => i.previous_tag)]
  );
  // grade runs: approve the previous grades again (only values that were known; "{}" = nothing to put back)
  const restore = run.kind === "grades" ? items.filter((i) => i.previous_tag && i.previous_tag !== "{}") : items;
  const res = run.kind === "grades"
    ? await writeGrades(undoId, restore.map((i) => ({ item_id: i.item_id, grades: JSON.parse(i.previous_tag as string) })), "restored", input.as_admin_user_id, input.requested_by)
    : await executeWrites(undoId, restore.map((i) => ({ item_id: i.item_id, target: i.previous_tag })), "restored", input.as_admin_user_id, run.kind);

  const status = res.failed || res.mismatch ? "partial" : "completed";
  await q(`UPDATE tag_runs SET status=$2, finished_at=now(), result=$3 WHERE id=$1`, [undoId, status, JSON.stringify(res)]);
  await q(`UPDATE tag_runs SET status='undone' WHERE id=$1 AND $2 = 'completed'`, [run.id, status]);
  return { undo_run_id: undoId, undid: run.id, status, ...res };
}

// ---------- Verify: warehouse readback ----------
export async function verifyRun(runId: string) {
  const run = await loadRun(runId);
  const items = await q<{ item_id: string; new_tag: string | null }>(
    `SELECT item_id, new_tag FROM tag_run_items WHERE run_id=$1 AND status IN ('written','restored')`,
    [runId]
  );
  if (!items.length) return { run_id: runId, checked: 0, note: "No written items to verify." };
  if (run.action !== "set") {
    return { run_id: runId, note: "Warehouse verify covers set runs only; check a few cleared/restored cards in admin." };
  }
  const rows = await queryCards({ tag: run.tag as string }, { current_tag_exact: run.tag as string });
  const seen = new Set(rows.map((r) => r.item_id));
  const missing = items.filter((i) => !seen.has(i.item_id)).map((i) => i.item_id);
  return {
    run_id: runId,
    tag: run.tag,
    written: items.length,
    confirmed_in_warehouse: items.length - missing.length,
    not_yet_visible: missing.length,
    missing_sample: missing.slice(0, 20),
    note: missing.length
      ? "Cards may not have synced to Snowflake yet, or have left warehouse scope (sold, retrieved). Re-check later."
      : "All written cards show the tag in the warehouse.",
  };
}

export async function getRun(runId: string) {
  const run = await loadRun(runId);
  const counts = await q(`SELECT status, count(*)::int AS n FROM tag_run_items WHERE run_id=$1 GROUP BY status`, [runId]);
  return { ...run, item_counts: counts };
}

export async function listRuns(limit = 20) {
  return q(
    `SELECT id, kind, status, action, tag, requested_by, staged_by, approved_by, preview_count, staged_count, dry_run, undo_of, created_at, finished_at
     FROM tag_runs ORDER BY created_at DESC LIMIT $1`,
    [Math.min(Math.max(limit, 1), 100)]
  );
}

// ---------- Web app: one confirmed action on an exact, user-picked set of cards ----------
// The screen shows the matches, the user deselects what they don't want and confirms once.
// Recorded as a normal run (staged + approved by the same person) so the audit trail matches.
export async function runSelection(input: {
  filters: CardFilters;
  post_filters?: PostFilters;
  action: "set" | "clear";
  tag?: string | null;
  mode?: "overwrite" | "skip_tagged";
  item_ids: string[];
  queries?: CardFilters[]; // the exact 4131 searches the screen ran; re-run fresh before writing
  dry_run?: boolean;
  user: string;
  as_admin_user_id?: string; // write as this person's own admin login
}) {
  const action = input.action;
  const tag = action === "clear" ? null : (input.tag ?? "").trim();
  if (action === "set") {
    const err = validateTag(tag as string);
    if (err) throw new Error(err);
  }
  const wanted = [...new Set(input.item_ids)];
  if (!wanted.length) throw new Error("No cards selected.");
  if (wanted.length > config.maxItemsPerRun()) throw new Error(`${wanted.length} cards is over the ${config.maxItemsPerRun()}-card limit.`);

  // Re-check against live data: only cards that still match the request (and still need changing) are written.
  const fresh = input.queries?.length
    ? (await Promise.all(input.queries.slice(0, 60).map((q1) => queryCards(q1, input.post_filters ?? {})))).flat()
    : await queryCards(input.filters, input.post_filters ?? {});
  const rows = applyMode(fresh, action, tag, input.mode ?? "overwrite");
  const byId = new Map(rows.map((r) => [r.item_id, r]));
  const chosen = wanted.map((id) => byId.get(id)).filter((r): r is CardRow => !!r);
  const dropped = wanted.length - chosen.length;
  if (!chosen.length) throw new Error("None of the selected cards still match. Search again.");

  const id = newId();
  await q(
    `INSERT INTO tag_runs (id, status, action, tag, mode, filters, post_filters, requested_by, preview_count, staged_by, staged_at, staged_count, expires_at)
     VALUES ($1,'staged',$2,$3,$4,$5,$6,$7,$8,$7,now(),$8,$9)`,
    [id, action, tag, input.mode ?? "overwrite", JSON.stringify(input.filters), JSON.stringify(input.post_filters ?? {}), input.user, chosen.length, hoursFromNow(1)]
  );
  await q(
    `INSERT INTO tag_run_items (run_id, item_id, previous_tag, new_tag, label, ev)
     SELECT $1, t.item_id, t.prev, $2, t.label, t.ev
     FROM unnest($3::text[], $4::text[], $5::text[], $6::numeric[]) AS t(item_id, prev, label, ev)`,
    [
      id,
      tag,
      chosen.map((r) => r.item_id),
      chosen.map((r) => r.tag),
      chosen.map((r) => [r.ac_number, r.set_name, r.player_name, r.parallel_name, r.grade].filter(Boolean).join(" · ")),
      chosen.map((r) => r.estimated_value),
    ]
  );
  const result = await goLive({ run_id: id, confirm: true, approved_by: input.user, dry_run: input.dry_run, as_admin_user_id: input.as_admin_user_id });
  return { ...result, skipped_no_longer_matching: dropped, previous: Object.fromEntries(chosen.map((r) => [r.item_id, r.tag])) };
}

// ---------- Watches: same one-step confirm, re-checked against a fresh pull of the watches question ----------
export async function runWatchSelection(input: {
  text: string;
  action: "set" | "clear";
  tag?: string | null;
  mode?: "overwrite" | "skip_tagged";
  item_ids: string[];
  dry_run?: boolean;
  user: string;
  as_admin_user_id?: string;
}) {
  const action = input.action;
  const tag = action === "clear" ? null : (input.tag ?? "").trim();
  if (action === "set") {
    const err = validateTag(tag as string);
    if (err) throw new Error(err);
  }
  const wanted = [...new Set(input.item_ids)];
  if (!wanted.length) throw new Error("No watches selected.");
  if (wanted.length > config.maxItemsPerRun()) throw new Error(`${wanted.length} watches is over the ${config.maxItemsPerRun()}-item limit.`);

  const fresh = await searchWatches(input.text);
  const rows = applyMode(fresh.rows, action, tag, input.mode ?? "overwrite");
  const byId = new Map(rows.map((r) => [r.item_id, r]));
  const chosen = wanted.map((id) => byId.get(id)).filter((r): r is WatchRow => !!r);
  const dropped = wanted.length - chosen.length;
  if (!chosen.length) throw new Error("None of the selected watches still match. Search again.");
  if (chosen.some((r) => r.item_id.startsWith("noid:")))
    throw new Error(`These watches have no item id in question ${config.watchCardId()}, so they can't be tagged. Add the watch's item id (items.id) as a column in ${config.watchCardId()}.`);

  const id = newId();
  await q(
    `INSERT INTO tag_runs (id, status, action, tag, mode, filters, post_filters, requested_by, preview_count, staged_by, staged_at, staged_count, expires_at, kind)
     VALUES ($1,'staged',$2,$3,$4,$5,'{}',$6,$7,$6,now(),$7,$8,'watch')`,
    [id, action, tag, input.mode ?? "overwrite", JSON.stringify({ text: input.text, ...fresh.parsed.filters }), input.user, chosen.length, hoursFromNow(1)]
  );
  await q(
    `INSERT INTO tag_run_items (run_id, item_id, previous_tag, new_tag, label, ev)
     SELECT $1, t.item_id, t.prev, $2, t.label, t.ev
     FROM unnest($3::text[], $4::text[], $5::text[], $6::numeric[]) AS t(item_id, prev, label, ev)`,
    [id, tag, chosen.map((r) => r.item_id), chosen.map((r) => r.tag), chosen.map(watchLabel), chosen.map((r) => r.ev)]
  );
  const result = await goLive({ run_id: id, confirm: true, approved_by: input.user, dry_run: input.dry_run, as_admin_user_id: input.as_admin_user_id });
  return { ...result, skipped_no_longer_matching: dropped, previous: Object.fromEntries(chosen.map((r) => [r.item_id, r.tag])) };
}

// ---------- Arena Club orders: same one-step confirm, re-checked against a fresh pull of those orders ----------
export async function runArenaSelection(input: {
  text: string; action: "set" | "clear"; tag?: string | null; mode?: "overwrite" | "skip_tagged";
  item_ids: string[]; dry_run?: boolean; user: string; as_admin_user_id?: string;
}) {
  const action = input.action;
  const tag = action === "clear" ? null : (input.tag ?? "").trim();
  if (action === "set") { const err = validateTag(tag as string); if (err) throw new Error(err); }
  const wanted = [...new Set(input.item_ids)];
  if (!wanted.length) throw new Error("No cards selected.");
  if (wanted.length > config.maxItemsPerRun()) throw new Error(`${wanted.length} cards is over the ${config.maxItemsPerRun()}-item limit.`);
  const fresh = await searchArena(input.text);
  const rows = applyMode(fresh.rows, action, tag, input.mode ?? "overwrite");
  const byId = new Map(rows.map((r) => [r.item_id, r]));
  const chosen = wanted.map((id) => byId.get(id)).filter((r): r is ArenaCard => !!r);
  if (!chosen.length) throw new Error("None of the selected cards still match. Search again.");
  if (chosen.some((r) => r.item_id.startsWith("noid:"))) throw new Error("These cards have no item id in the Arena Club question, so they can't be tagged. Add the card's item id as a column.");
  const id = newId();
  const label = (r: ArenaCard) => [r.order_number && `order ${r.order_number}`, r.set_name, r.player_name, r.parallel_name, r.grade].filter(Boolean).join(" · ");
  await q(
    `INSERT INTO tag_runs (id, status, action, tag, mode, filters, post_filters, requested_by, preview_count, staged_by, staged_at, staged_count, expires_at, kind)
     VALUES ($1,'staged',$2,$3,$4,$5,'{}',$6,$7,$6,now(),$7,$8,'card')`,
    [id, action, tag, input.mode ?? "overwrite", JSON.stringify({ text: input.text, source: "arena_club", ...fresh.parsed.filters }), input.user, chosen.length, hoursFromNow(1)]
  );
  await q(
    `INSERT INTO tag_run_items (run_id, item_id, previous_tag, new_tag, label, ev)
     SELECT $1, t.item_id, t.prev, $2, t.label, t.ev FROM unnest($3::text[], $4::text[], $5::text[], $6::numeric[]) AS t(item_id, prev, label, ev)`,
    [id, tag, chosen.map((r) => r.item_id), chosen.map((r) => r.tag), chosen.map(label), chosen.map((r) => r.ev)]
  );
  const result = await goLive({ run_id: id, confirm: true, approved_by: input.user, dry_run: input.dry_run, as_admin_user_id: input.as_admin_user_id });
  return { ...result, skipped_no_longer_matching: wanted.length - chosen.length, previous: Object.fromEntries(chosen.map((r) => [r.item_id, r.tag])) };
}

// ---------- Arena Club: type a new overall grade on a card and save it to admin (logged, undoable) ----------
// 0 is a grade (authentic, or centering 0 = no override); otherwise half steps up to 10
const validGrade = (v: number) => Number.isFinite(v) && v >= 0 && v <= 10 && Math.round(v * 2) === v * 2;
export async function runOverallUpdate(input: { text: string; items: { item_id: string; overall: number }[]; dry_run?: boolean; user: string; as_admin_user_id?: string }) {
  const items = input.items.filter((x) => x && x.item_id);
  if (!items.length) throw new Error("Type a new overall on at least one card.");
  const bad = items.find((x) => !validGrade(Number(x.overall)));
  if (bad) throw new Error(`"${bad.overall}" isn't a grade. Use 0 to 10 in half steps (e.g. 8.5).`);
  if (items.length > config.maxItemsPerRun()) throw new Error(`${items.length} cards is over the ${config.maxItemsPerRun()}-item limit.`);
  const fresh = await searchArena(input.text);
  const byId = new Map(fresh.rows.map((r) => [r.item_id, r]));
  const chosen = items.map((x) => ({ card: byId.get(x.item_id), overall: Number(x.overall) })).filter((x): x is { card: ArenaCard; overall: number } => !!x.card && !x.card.item_id.startsWith("noid:"));
  if (!chosen.length) throw new Error("None of those cards are in these orders anymore. Search again.");
  const changes = chosen.filter((x) => x.card.grade_num !== x.overall);
  if (!changes.length) throw new Error("Those cards already have that overall.");
  const dry = config.dryRun() || input.dry_run === true;
  const id = newId();
  await q(
    `INSERT INTO tag_runs (id, status, action, tag, mode, filters, post_filters, requested_by, preview_count, staged_by, staged_at, staged_count, approved_by, live_at, dry_run, expires_at, kind)
     VALUES ($1,'executing','overall',NULL,'overwrite',$2,'{}',$3,$4,$3,now(),$4,$3,now(),$5,$6,'overall')`,
    [id, JSON.stringify({ text: input.text, source: "arena_club" }), input.user, changes.length, dry, hoursFromNow(1)]
  );
  await q(
    `INSERT INTO tag_run_items (run_id, item_id, previous_tag, new_tag, label, ev)
     SELECT $1, t.item_id, t.prev, t.next, t.label, t.ev FROM unnest($2::text[], $3::text[], $4::text[], $5::text[], $6::numeric[]) AS t(item_id, prev, next, label, ev)`,
    [id, changes.map((x) => x.card.item_id), changes.map((x) => (x.card.grade_num == null ? null : String(x.card.grade_num))), changes.map((x) => String(x.overall)),
     changes.map((x) => [`order ${x.card.order_number}`, x.card.player_name, `overall ${x.card.grade_num} → ${x.overall}`].join(" · ")), changes.map((x) => x.card.ev)]
  );
  if (dry) {
    await q(`UPDATE tag_run_items SET status='dry_run', updated_at=now() WHERE run_id=$1`, [id]);
    await q(`UPDATE tag_runs SET status='dry_run_completed', finished_at=now(), result=$2 WHERE id=$1`, [id, JSON.stringify({ would_write: changes.length })]);
    return { run_id: id, status: "dry_run_completed", dry_run: true, would_write: changes.length, written_ids: [] as string[], succeeded: 0, failed: 0, mismatch: 0, failures: [] };
  }
  const res = await executeWrites(id, changes.map((x) => ({ item_id: x.card.item_id, target: String(x.overall) })), "written", input.as_admin_user_id, "overall");
  const status = res.failed || res.mismatch ? "partial" : "completed";
  await q(`UPDATE tag_runs SET status=$2, finished_at=now(), result=$3 WHERE id=$1`, [id, status, JSON.stringify(res)]);
  return { run_id: id, status, dry_run: false, ...res };
}

// After grades change: rebuild label + slab images, and optionally approve (the review page's "Approve").
// A failure here doesn't undo the grade save; it's reported per card.
async function rebuildImages(ids: string[], adminUserId?: string, approve?: { name: string }) {
  const res = { rebuilt: 0, rebuild_failed: [] as { item_id: string; error: string }[], approved: 0, approve_failed: [] as { item_id: string; error: string }[] };
  if (!ids.length) return res;
  const who = adminUserId || config.sessionUserId();
  const session = await openAdminSession(adminUserId);
  try {
    await pool(ids, Math.min(3, config.writeConcurrency()), async (id) => {
      let links: Record<string, unknown> = {};
      if (config.regenerateImages()) {
        const r = await regenerateImages(session, id);
        if (r.error) res.rebuild_failed.push({ item_id: id, error: r.error }); else { res.rebuilt++; links = r.links; }
      }
      if (approve) {
        const a = await approveReview(session, id, who, approve.name, links);
        if (a.ok) res.approved++; else res.approve_failed.push({ item_id: id, error: a.error ?? `status ${a.status}` });
      }
    });
    return res;
  } finally {
    await session.revoke();
  }
}

// Apply grades to cards the review page's way (label → slab → approve), one admin session, results per item.
async function writeGrades(runId: string, items: { item_id: string; grades: Record<string, number> }[], okStatus: string, adminUserId: string | undefined, reviewer: string) {
  const who = adminUserId || config.sessionUserId();
  const session = await openAdminSession(adminUserId);
  let results: Awaited<ReturnType<typeof changeGradesLikeReview>>[];
  try {
    results = await pool(items, Math.min(3, config.writeConcurrency()), (it) => changeGradesLikeReview(session, it.item_id, who, reviewer, it.grades));
  } finally {
    await session.revoke();
  }
  const statuses = results.map((r) => (r.ok ? okStatus : "failed"));
  await q(
    `UPDATE tag_run_items AS i SET status=t.status, http_status=t.http, error=t.err, updated_at=now()
     FROM unnest($2::text[], $3::text[], $4::int[], $5::text[]) AS t(item_id, status, http, err)
     WHERE i.run_id=$1 AND i.item_id=t.item_id`,
    [runId, items.map((x) => x.item_id), statuses, results.map((r) => r.status), results.map((r) => r.error ?? null)]
  );
  const ok = items.filter((_, i) => results[i].ok).map((x) => x.item_id);
  return {
    written_ids: ok, succeeded: ok.length, failed: items.length - ok.length, mismatch: 0,
    approved: ok.length, rebuilt: results.filter((r) => r.ok && r.rebuilt).length, rebuild_failed: [] as { item_id: string; error: string }[], approve_failed: [] as { item_id: string; error: string }[],
    failures: results.map((r, i) => ({ item_id: items[i].item_id, status: r.status, error: r.error })).filter((_, i) => !results[i].ok).slice(0, 20),
  };
}

// ---------- Arena Club: change any subgrade and/or the overall on cards (logged, undoable) ----------
const GRADES = ["overall", "centering", "corners", "edges", "surface"] as const;
type Grade = (typeof GRADES)[number];
export async function runGradeUpdate(input: { text: string; items: { item_id: string; grades: Partial<Record<Grade, number>> }[]; dry_run?: boolean; approve?: boolean; user: string; as_admin_user_id?: string }) {
  const items = input.items.filter((x) => x && x.item_id && x.grades && Object.keys(x.grades).length);
  if (!items.length) throw new Error("Change at least one grade first.");
  for (const x of items) for (const [k, v] of Object.entries(x.grades)) {
    if (!(GRADES as readonly string[]).includes(k)) throw new Error(`Unknown grade "${k}".`);
    if (!validGrade(Number(v))) throw new Error(`"${v}" isn't a grade. Use 0 to 10 in half steps (e.g. 8.5).`);
  }
  if (items.length > config.maxItemsPerRun()) throw new Error(`${items.length} cards is over the ${config.maxItemsPerRun()}-item limit.`);
  const fresh = await searchArena(input.text);
  const byId = new Map(fresh.rows.map((r) => [r.item_id, r]));
  const now = (c: ArenaCard, g: Grade): number | null => {
    const v = g === "overall" ? ((c as any).check_overall ?? c.grade_num) : (c as any)[g];
    return v == null || v === "" ? null : Number(v);
  };
  const changes = items.flatMap((x) => {
    const c = byId.get(x.item_id);
    if (!c || c.item_id.startsWith("noid:")) return [];
    const next: Record<string, number> = {}, prev: Record<string, number> = {};
    for (const [k, v] of Object.entries(x.grades) as [Grade, number][]) {
      const cur = now(c, k);
      if (cur === Number(v)) continue;
      next[k] = Number(v);
      if (cur != null) prev[k] = cur; // undo restores only values we knew
    }
    return Object.keys(next).length ? [{ c, next, prev }] : [];
  });
  if (!changes.length) throw new Error("Nothing to save: those cards already have those grades.");
  const dry = config.dryRun() || input.dry_run === true;
  const id = newId();
  const fmt = (o: Record<string, number>) => Object.entries(o).map(([k, v]) => `${k} ${v}`).join(", ");
  await q(
    `INSERT INTO tag_runs (id, status, action, tag, mode, filters, post_filters, requested_by, preview_count, staged_by, staged_at, staged_count, approved_by, live_at, dry_run, expires_at, kind)
     VALUES ($1,'executing','grades',NULL,'overwrite',$2,'{}',$3,$4,$3,now(),$4,$3,now(),$5,$6,'grades')`,
    [id, JSON.stringify({ text: input.text, source: "arena_club", approve: !!input.approve }), input.user, changes.length, dry, hoursFromNow(1)]
  );
  await q(
    `INSERT INTO tag_run_items (run_id, item_id, previous_tag, new_tag, label, ev)
     SELECT $1, t.item_id, t.prev, t.next, t.label, t.ev FROM unnest($2::text[], $3::text[], $4::text[], $5::text[], $6::numeric[]) AS t(item_id, prev, next, label, ev)`,
    [id, changes.map((x) => x.c.item_id), changes.map((x) => JSON.stringify(x.prev)), changes.map((x) => JSON.stringify(x.next)),
     changes.map((x) => [`order ${x.c.order_number}`, x.c.player_name, fmt(x.next)].join(" · ")), changes.map((x) => x.c.ev)]
  );
  if (dry) {
    await q(`UPDATE tag_run_items SET status='dry_run', updated_at=now() WHERE run_id=$1`, [id]);
    await q(`UPDATE tag_runs SET status='dry_run_completed', finished_at=now(), result=$2 WHERE id=$1`, [id, JSON.stringify({ would_write: changes.length })]);
    return { run_id: id, status: "dry_run_completed", dry_run: true, would_write: changes.length, written_ids: [] as string[], succeeded: 0, failed: 0, mismatch: 0, failures: [] };
  }
  const res = await writeGrades(id, changes.map((x) => ({ item_id: x.c.item_id, grades: x.next })), "written", input.as_admin_user_id, input.user);
  const status = res.failed ? (res.succeeded ? "partial" : "failed") : "completed";
  await q(`UPDATE tag_runs SET status=$2, finished_at=now(), result=$3 WHERE id=$1`, [id, status, JSON.stringify(res)]);
  return { run_id: id, status, dry_run: false, ...res };
}
