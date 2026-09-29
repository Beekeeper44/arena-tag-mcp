// The tag recipe: preview (draft) -> stage (freeze snapshot) -> go live (write) -> verify / undo.
// Two approvals, every step recorded with who asked.
import { randomBytes } from "crypto";
import { config, validateTag } from "./config";
import { queryCards, queryCardsDetailed, summarize, type CardFilters, type CardRow, type PostFilters } from "./metabase";
import { openAdminSession, patchTag, type WriteResult } from "./admin";
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
};

const newId = () => "r_" + randomBytes(5).toString("hex");
const hoursFromNow = (h: number) => new Date(Date.now() + h * 3600_000).toISOString();

function applyMode(rows: CardRow[], action: "set" | "clear", tag: string | null, mode: string) {
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
  okStatus: string
) {
  const session = await openAdminSession();
  let results: WriteResult[];
  try {
    results = await pool(items, config.writeConcurrency(), (it) => patchTag(session, it.item_id, it.target));
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

export async function goLive(input: { run_id: string; confirm: boolean; approved_by: string; dry_run?: boolean }) {
  if (input.confirm !== true) throw new Error("confirm must be true.");
  const run = await loadRun(input.run_id);
  if (new Date(run.expires_at) < new Date()) throw new Error("Staged run expired. Run a new preview.");
  const dry = config.dryRun() || input.dry_run === true;

  // Atomic claim: only one caller can move staged -> executing.
  const [claimed] = await q(
    `UPDATE tag_runs SET status='executing', approved_by=$2, live_at=now(), dry_run=$3
     WHERE id=$1 AND status='staged' RETURNING id`,
    [run.id, input.approved_by, dry]
  );
  if (!claimed) throw new Error(`Run is ${run.status}; only a staged run can go live, and only once.`);

  const items = await q<{ item_id: string }>(`SELECT item_id FROM tag_run_items WHERE run_id=$1 AND status='pending'`, [run.id]);

  if (dry) {
    await q(`UPDATE tag_run_items SET status='would_write', updated_at=now() WHERE run_id=$1`, [run.id]);
    const result = { dry_run: true, would_write: items.length };
    await q(`UPDATE tag_runs SET status='dry_run_completed', finished_at=now(), result=$2 WHERE id=$1`, [run.id, JSON.stringify(result)]);
    return { run_id: run.id, status: "dry_run_completed", ...result, note: "DRY_RUN is on. Nothing was written to admin." };
  }

  const res = await executeWrites(run.id, items.map((i) => ({ item_id: i.item_id, target: run.tag })), "written");
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
export async function undoRun(input: { run_id: string; confirm: boolean; requested_by: string }) {
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
    `INSERT INTO tag_runs (id, status, action, tag, mode, filters, post_filters, requested_by, preview_count, approved_by, live_at, dry_run, undo_of, expires_at)
     VALUES ($1,'executing','undo',NULL,'overwrite','{}','{}',$2,$3,$2,now(),false,$4,now())`,
    [undoId, input.requested_by, items.length, run.id]
  );
  await q(
    `INSERT INTO tag_run_items (run_id, item_id, previous_tag, new_tag)
     SELECT $1, t.item_id, $2, t.prev FROM unnest($3::text[], $4::text[]) AS t(item_id, prev)`,
    [undoId, run.tag, items.map((i) => i.item_id), items.map((i) => i.previous_tag)]
  );
  const res = await executeWrites(undoId, items.map((i) => ({ item_id: i.item_id, target: i.previous_tag })), "restored");
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
    `SELECT id, status, action, tag, requested_by, staged_by, approved_by, preview_count, staged_count, dry_run, undo_of, created_at, finished_at
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
  dry_run?: boolean;
  user: string;
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
  const rows = applyMode(await queryCards(input.filters, input.post_filters ?? {}), action, tag, input.mode ?? "overwrite");
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
  const result = await goLive({ run_id: id, confirm: true, approved_by: input.user, dry_run: input.dry_run });
  return { ...result, skipped_no_longer_matching: dropped, previous: Object.fromEntries(chosen.map((r) => [r.item_id, r.tag])) };
}
