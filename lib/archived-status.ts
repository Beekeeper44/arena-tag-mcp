// Archived, Precision Labeling and Arena Club tiles: change a card's status from TAG-BOT.
//   Not accepted   apply / remove   (authentication status)
//   Pending rescan apply / remove   (card status; a note is required to apply)
//   Archive        apply / remove   (card status; a note is required to apply)
// Every change is logged (tag_runs kind 'status') with each card's previous value, so it can be undone.
//
// The admin calls are set up in admin, then switched on here with ARCHIVE_STATUS_WRITE (JSON), e.g.
// {
//   "auth":   { "method": "PATCH", "path": "/cards/{id}", "body": { "authenticationStatus": "{value}" } },
//   "status": { "method": "PATCH", "path": "/cards/{id}", "body": { "status": "{value}" } },
//   "note":   { "method": "POST",  "path": "/cards/{id}/operation_logs", "body": { "note": "{note}", "noteType": "Archive" } },
//   "remove_status_to": "pending_review",
//   "remove_auth_to": "none"
// }
// Until it is set, dry runs work and live runs explain what's missing. Nothing is written.
import { randomBytes } from "crypto";
import { config } from "./config";
import { openAdminSession, liveCards, type AdminSession } from "./admin";
import { searchArchived, type ArchivedCard } from "./archived";
import { q } from "./db";

export const STATUS_ACTIONS = {
  not_accepted: { label: "Not accepted", field: "auth" as const, value: "not_accepted", note: false },
  pending_rescan: { label: "Pending rescan", field: "status" as const, value: "pending_rescan", note: true },
  archive: { label: "Archive", field: "status" as const, value: "archived", note: true },
};
export type StatusKey = keyof typeof STATUS_ACTIONS;
type Call = { method?: string; path: string; body?: unknown };
type WriteCfg = { auth?: Call; status?: Call; note?: Call; remove_status_to?: string; remove_auth_to?: string };

function writeCfg(): WriteCfg | null {
  const raw = process.env.ARCHIVE_STATUS_WRITE;
  if (!raw) return null;
  try { return JSON.parse(raw) as WriteCfg; } catch { throw new Error("ARCHIVE_STATUS_WRITE in Vercel isn't valid JSON."); }
}
const fill = (v: unknown, vars: Record<string, string>): unknown =>
  typeof v === "string" ? v.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? "") :
  Array.isArray(v) ? v.map((x) => fill(x, vars)) :
  v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fill(x, vars)])) : v;

async function call(session: AdminSession, c: Call, vars: Record<string, string>) {
  const path = String(fill(c.path, vars));
  const res = await fetch(`${config.adminApiUrl()}${path}`, {
    method: c.method || "PATCH",
    headers: { "Content-Type": "application/json", Accept: "application/json", Cookie: `sAccessToken=${session.accessToken}`, rid: "anti-csrf", "st-auth-mode": "cookie", Origin: config.adminOrigin() },
    body: c.body === undefined ? undefined : JSON.stringify(fill(c.body, vars)),
  });
  if (!res.ok) throw new Error(`${c.method || "PATCH"} ${path} ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

// Issue types for the archive note, checked in this order: the first match wins.
const ISSUE_TYPES: [string, RegExp][] = [
  ["Grading Company Issues", /grading compan|grading co\b|do not accept|don'?t accept|not accept/i],
  ["Altered", /alter|trim|mis ?cut/i],
  ["Damage", /damage|crack|chip|dent|\bben[dt]/i],
  ["Sticker", /stic?ker|residue|\blabel|tear|pen ?mark|\bink\b/i],
  ["Fiber", /fib(er|re)|\bfbr\b|hair|debris|dust/i],
  ["Image", /distort|no image|out of scanner|double im(a?ge?|g)|blur/i],
];
export function issueType(issue: string | null, note: string | null) {
  const t = `${issue ?? ""} ${note ?? ""}`;
  for (const [name, re] of ISSUE_TYPES) if (re.test(t)) return name;
  return issue ?? "";
}
/** Archive note for one card: value range, side, issue type, e.g. "<499 FS Damage", plus any extra text typed for the run. */
export function archiveNote(c: ArchivedCard, extra = "") {
  const x = c.notes[0] ?? { side: null, issue: null, note: null };
  const vr = c.value_range && /^(<\s*499|500\s*\+)$/.test(c.value_range.trim()) ? c.value_range.trim() : c.ev ? (c.ev >= 500 ? "500+" : "<499") : "";
  const side = x.side && !/not noted/i.test(x.side) ? x.side : "";
  return [[vr, side, issueType(x.issue, x.note)].filter(Boolean).join(" "), extra.trim()].filter(Boolean).join(" · ");
}
const cur = (c: ArchivedCard, field: "auth" | "status") => (field === "auth" ? c.auth_status : c.status) ?? null;
const newId = () => "s_" + randomBytes(5).toString("hex");

/** The value a card had before the last time this status was applied from TAG-BOT (for Remove). */
async function before(itemIds: string[], key: StatusKey) {
  if (!itemIds.length) return new Map<string, string | null>();
  const rows = await q<{ item_id: string; previous_tag: string | null }>(
    `SELECT DISTINCT ON (i.item_id) i.item_id, i.previous_tag FROM tag_run_items i JOIN tag_runs r ON r.id=i.run_id
      WHERE r.kind='status' AND r.action=$1 AND i.status='written' AND i.item_id = ANY($2::text[]) ORDER BY i.item_id, i.updated_at DESC`,
    [`${key}:apply`, itemIds]
  );
  return new Map(rows.map((r) => [r.item_id, r.previous_tag]));
}

async function liveList(view: string, ids: string[], asAdmin?: string) {
  const session = await openAdminSession(asAdmin);
  let got: Record<string, Record<string, unknown>> = {};
  try { got = await liveCards(session, ids); } finally { await session.revoke(); }
  const rows: ArchivedCard[] = Object.entries(got).map(([id, d]) => ({
    kind: "archived", view: view as ArchivedCard["view"], item_id: id, ac: "", cert: "", order_number: "", order_user_id: null,
    player_name: "", set_name: "", insert: null, set_number: null, parallel_name: null, grade: "", grading_company: "", ev: 0,
    tag: (d.tag as string) ?? null, img: null, card_url: null, status: (d.status as string) ?? null, auth_status: (d.authenticationStatus as string) ?? null,
    order_owner: null, grade_type: null, value_range: null, notes: [], search: "",
    parallel_total: null, order_url: null, order_status: null, order_source: null, order_kind: null, order_full_name: null, owner_type: null, owner_full_name: null, owner_username: null, owner_email: null, in_warehouse: null, item_status: null, cards_in_order: null,
    sport: null, ev_date: null, ev_age_days: null, po_number: null, times_sold_back: null, purchase_location: null,
    brand: null, title: null, reference: null, dial: null, movement: null, size: null, material: null, bracelet: null, gender: null, condition: null, box: null, papers: null, purchase_cost: null,
  }));
  return { rows, view: view as ArchivedCard["view"], view_label: view === "arena" ? "Arena Club" : view === "arch_watches" ? "Archived watches" : "Archived cards" };
}

export async function runArchivedStatus(input: {
  view: unknown; text: string; key: string; op: string; note?: string; notes?: Record<string, string>; item_ids: string[]; dry_run?: boolean; user: string; as_admin_user_id?: string;
}) {
  const key = input.key as StatusKey, act = STATUS_ACTIONS[key];
  if (!act) throw new Error(`Unknown status action "${input.key}".`);
  const op = input.op === "remove" ? "remove" : "apply";
  const note = (input.note ?? "").trim();
  // Archive builds a note per card (value side issue + typed text); Pending rescan uses the typed note
  // (Cards / Watches pills: the page builds the note from the card it shows, since admin's card record has no archive issue)
  const liveView = input.view === "arch_cards" || input.view === "arch_watches" || input.view === "arena";
  const noteFor = (c: ArchivedCard) => (key === "archive" ? (liveView && input.notes?.[c.item_id]?.trim() ? input.notes[c.item_id].trim().slice(0, 500) : archiveNote(c, note)) : note);
  if (op === "apply" && act.note && key !== "archive" && !note) throw new Error(`${act.label} needs a note.`);
  const wanted = [...new Set(input.item_ids)];
  if (!wanted.length) throw new Error("No cards selected.");
  if (wanted.length > config.maxItemsPerRun()) throw new Error(`${wanted.length} cards is over the ${config.maxItemsPerRun()}-card limit.`);

  // Archived → Cards / Watches use the Cards / Watches searches, so read each card's current status straight from admin
  const live = input.view === "arch_cards" || input.view === "arch_watches" || input.view === "arena";
  const fresh = live ? await liveList(String(input.view), wanted, input.as_admin_user_id) : await searchArchived(input.view, input.text);
  const byId = new Map(fresh.rows.map((r) => [r.item_id, r]));
  const cards = wanted.map((id) => byId.get(id)).filter((c): c is ArchivedCard => !!c && !c.item_id.startsWith("noid:"));
  if (!cards.length) throw new Error("None of the selected cards still match. Search again.");

  // Apply: skip cards already there. Remove: only cards that have it now; they go back to what they had before.
  const cfg = writeCfg();
  const prev = op === "remove" ? await before(cards.map((c) => c.item_id), key) : new Map<string, string | null>();
  const fallback = act.field === "auth" ? cfg?.remove_auth_to ?? "none" : cfg?.remove_status_to ?? null;
  type Change = { c: ArchivedCard; from: string | null; to: string | null };
  const changes: Change[] = cards.flatMap((c): Change[] => {
    const now = cur(c, act.field);
    if (op === "apply") return now === act.value ? [] : [{ c, from: now, to: act.value }];
    if (now !== act.value) return [];
    return [{ c, from: now, to: prev.get(c.item_id) ?? fallback }];
  });
  if (op === "apply" && act.note) {
    const blank = changes.filter((x) => !noteFor(x.c)).map((x) => x.c.ac || x.c.item_id);
    if (blank.length) throw new Error(`${act.label} needs a note: ${blank.slice(0, 5).join(", ")}${blank.length > 5 ? "…" : ""} ${blank.length === 1 ? "has" : "have"} no value, side or issue. Type a note to add to every card.`);
  }
  const noTarget = changes.filter((x) => x.to === null).map((x) => x.c.ac || x.c.item_id);
  const todo = changes.filter((x): x is { c: ArchivedCard; from: string | null; to: string } => x.to !== null);
  const skipped = cards.length - changes.length;
  if (!todo.length) throw new Error(noTarget.length ? `Nothing to go back to for ${noTarget.join(", ")}: set remove_status_to in ARCHIVE_STATUS_WRITE.` : op === "apply" ? `All selected cards are already ${act.value}.` : `None of the selected cards are ${act.value}.`);

  const dry = config.dryRun() || input.dry_run === true;
  const id = newId();
  await q(
    `INSERT INTO tag_runs (id, status, action, tag, mode, filters, post_filters, requested_by, preview_count, staged_by, staged_at, staged_count, approved_by, live_at, dry_run, expires_at, kind)
     VALUES ($1,'executing',$2,$3,'overwrite',$4,'{}',$5,$6,$5,now(),$6,$5,now(),$7,now()+interval '1 hour','status')`,
    [id, `${key}:${op}`, op === "apply" ? act.value : null, JSON.stringify({ text: input.text, source: `archived_${fresh.view}`, field: act.field, note }), input.user, todo.length, dry]
  );
  await q(
    `INSERT INTO tag_run_items (run_id, item_id, previous_tag, new_tag, label, ev)
     SELECT $1, t.item_id, t.prev, t.next, t.label, t.ev FROM unnest($2::text[], $3::text[], $4::text[], $5::text[], $6::numeric[]) AS t(item_id, prev, next, label, ev)`,
    [id, todo.map((x) => x.c.item_id), todo.map((x) => x.from), todo.map((x) => x.to), todo.map((x) => [fresh.view_label, `8AC ${x.c.ac}`, `${act.field} ${x.from ?? "—"} → ${x.to}`, op === "apply" && act.note ? `note: ${noteFor(x.c)}` : ""].filter(Boolean).join(" · ")), todo.map((x) => x.c.ev)]
  );
  const base = { run_id: id, field: act.field, skipped, no_target: noTarget, changes: todo.map((x) => ({ item_id: x.c.item_id, from: x.from, to: x.to, note: op === "apply" && act.note ? noteFor(x.c) : undefined })) };
  if (dry) {
    await q(`UPDATE tag_run_items SET status='dry_run', updated_at=now() WHERE run_id=$1`, [id]);
    await q(`UPDATE tag_runs SET status='dry_run_completed', finished_at=now() WHERE id=$1`, [id]);
    return { ...base, status: "dry_run_completed", dry_run: true, written_ids: [] as string[], failed: 0, failures: [] as { item_id: string; error: string }[] };
  }
  const writeCall = cfg?.[act.field];
  if (!cfg || !writeCall || (op === "apply" && act.note && !cfg.note)) {
    await q(`UPDATE tag_runs SET status='blocked', finished_at=now() WHERE id=$1`, [id]);
    throw new Error(`Status changes aren't connected to admin yet. Once admin has the endpoints, set ARCHIVE_STATUS_WRITE in Vercel (needs "${act.field}"${act.note ? ' and "note"' : ""}). Dry run works now.`);
  }
  const session = await openAdminSession(input.as_admin_user_id);
  const written: string[] = [], failures: { item_id: string; error: string }[] = [];
  try {
    for (let i = 0; i < todo.length; i += 4) {
      await Promise.all(todo.slice(i, i + 4).map(async (x) => {
        const vars = { id: x.c.item_id, value: x.to, note: noteFor(x.c), user: input.user, ac: x.c.ac, order: x.c.order_number };
        try {
          await call(session, writeCall, vars);
          if (op === "apply" && act.note && cfg.note) await call(session, cfg.note, vars);
          written.push(x.c.item_id);
          await q(`UPDATE tag_run_items SET status='written', updated_at=now() WHERE run_id=$1 AND item_id=$2`, [id, x.c.item_id]);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          failures.push({ item_id: x.c.item_id, error: msg });
          await q(`UPDATE tag_run_items SET status='failed', error=$3, updated_at=now() WHERE run_id=$1 AND item_id=$2`, [id, x.c.item_id, msg]);
        }
      }));
    }
  } finally { await session.revoke(); }
  await q(`UPDATE tag_runs SET status=$2, finished_at=now(), result=$3 WHERE id=$1`, [id, failures.length ? "partial" : "completed", JSON.stringify({ written: written.length, failed: failures.length })]);
  return { ...base, status: failures.length ? "partial" : "completed", dry_run: false, written_ids: written, failed: failures.length, failures };
}

/** Put every card in a status run back to the value it had before. */
export async function undoArchivedStatus(input: { run_id: string; user: string; as_admin_user_id?: string }) {
  const runs = await q<{ id: string; kind: string; action: string; filters: { field?: string } }>(`SELECT id, kind, action, filters FROM tag_runs WHERE id=$1`, [input.run_id]);
  const run = runs[0];
  if (!run || run.kind !== "status") throw new Error("That isn't a status run.");
  const field = run.filters?.field === "auth" ? "auth" : "status";
  const cfg = writeCfg(), writeCall = cfg?.[field];
  if (!writeCall) throw new Error("Status changes aren't connected to admin yet (ARCHIVE_STATUS_WRITE).");
  const items = await q<{ item_id: string; previous_tag: string | null }>(`SELECT item_id, previous_tag FROM tag_run_items WHERE run_id=$1 AND status='written'`, [run.id]);
  const back = items.filter((x) => x.previous_tag);
  const session = await openAdminSession(input.as_admin_user_id);
  const restored: string[] = [], failures: { item_id: string; error: string }[] = [];
  try {
    for (const x of back) {
      try { await call(session, writeCall, { id: x.item_id, value: x.previous_tag as string, note: "", user: input.user, ac: "", order: "" }); restored.push(x.item_id); }
      catch (e) { failures.push({ item_id: x.item_id, error: e instanceof Error ? e.message : String(e) }); }
    }
  } finally { await session.revoke(); }
  await q(`UPDATE tag_runs SET status='undone' WHERE id=$1`, [run.id]);
  return { restored_ids: restored, restored: restored.length, failed: failures.length, failures, previous: Object.fromEntries(back.map((x) => [x.item_id, x.previous_tag])) };
}
