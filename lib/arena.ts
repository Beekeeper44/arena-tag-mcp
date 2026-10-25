// Arena Club tile: search any number of orders through the Metabase question in ARENA_METABASE_CARD_ID,
// using its own Order Number filter (one query per order, so no row limit applies), and summarize each order.
// Columns are found by name or, for the item id, by value (UUIDs).
import { config } from "./config";
import { inBatches } from "./metabase";
import { parseRequest, buildLexiconFromRows, markPlainTag } from "./parse";

export type Param = { name: string; id: string; type: string; dimension: boolean };
const paramCache = new Map<number, { at: number; params: Param[] }>();
/** Optional: the "Overall Check" question (subgrades vs overall, VALIDATION = PASS / FAIL), searched by the same order numbers. */
const checkCardId = () => Number(process.env.ARENA_CHECK_CARD_ID || 15214) || null; // "Overall Check" (Order Number filter)

// "Arena Club Orders Raw" (filters: Order Number, Tag). ARENA_METABASE_CARD_ID overrides it.
const cardId = () => Number(process.env.ARENA_METABASE_CARD_ID || 45739);
async function mb(path: string, init: RequestInit = {}) {
  return fetch(`${config.metabaseHost()}${path}`, { ...init, headers: { "x-api-key": config.metabaseApiKey(), ...(init.headers || {}) } });
}

export async function params(id: number = cardId()): Promise<Param[]> {
  const hit = paramCache.get(id);
  if (hit && Date.now() - hit.at < 60_000) return hit.params;
  const res = await mb(`/api/card/${id}`);
  if (!res.ok) throw new Error(`Metabase question ${id} failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
  const card = await res.json();
  const byName = new Map<string, Param>();
  const sets = [card?.dataset_query?.native?.["template-tags"], ...(card?.dataset_query?.stages ?? []).map((st: any) => st?.["template-tags"])];
  for (const ts of sets) for (const [k, v] of Object.entries((ts ?? {}) as Record<string, any>)) {
    if (v?.type === "snippet" || v?.type === "card") continue;
    const dim = v?.type === "dimension";
    byName.set(v?.name || k, { name: v?.name || k, id: v?.id, dimension: dim, type: dim ? v?.["widget-type"] || "string/=" : v?.type === "number" ? "number/=" : "category" });
  }
  for (const p of card?.parameters ?? []) {
    const t = p?.target;
    const name = Array.isArray(t) && Array.isArray(t[1]) && t[1][0] === "template-tag" ? t[1][1] : null;
    if (!name) continue;
    const prev = byName.get(name);
    byName.set(name, { name, id: p.id || prev?.id, type: p.type || prev?.type || "category", dimension: prev?.dimension ?? t[0] === "dimension" });
  }
  const list = [...byName.values()].filter((p) => p.id);
  paramCache.set(id, { at: Date.now(), params: list });
  return list;
}

export async function run(param: Param, value: string, id: number = cardId()) {
  return runCard(id, [{ id: param.id, type: param.type, target: [param.dimension ? "dimension" : "variable", ["template-tag", param.name]], value: [param.type.startsWith("number") ? Number(value) : value] }]);
}
/** Run a question with any parameters (none = every row). */
export async function runCard(id: number, parameters: unknown[] = []) {
  const path = `/api/card/${id}/query/json`;
  let res = await mb(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ parameters, format_rows: false }) });
  if (!res.ok && res.status >= 400 && res.status < 500) {
    res = await mb(path, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ parameters: JSON.stringify(parameters), format_rows: "false" }).toString() });
  }
  if (!res.ok) throw new Error(`Metabase question ${id} failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  if (!Array.isArray(data)) throw new Error(`Unexpected Metabase response: ${JSON.stringify(data).slice(0, 300)}`);
  return data as Record<string, unknown>[];
}

// ---------- columns ----------
const K = (k: string) => k.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_|_$/g, "");
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
function col(o: Record<string, unknown>, names: string[], re?: RegExp) {
  for (const n of names) if (o[n] !== undefined && o[n] !== null && o[n] !== "") return o[n];
  if (!re) return null;
  const k = Object.keys(o).find((key) => re.test(key) && o[key] !== null && o[key] !== "");
  return k ? o[k] : null;
}
const s = (v: unknown) => (v === null || v === undefined || v === "" ? null : String(v));
const n = (v: unknown) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));

function idColumn(rows: Record<string, unknown>[]) {
  let best: { key: string; score: number } | null = null;
  for (const key of Object.keys(rows[0] ?? {})) {
    let full = 0;
    for (const r of rows.slice(0, 200)) if (UUID.test(String(r[key] ?? ""))) full++;
    if (!full) continue;
    const name = K(key);
    const score = full + (/ITEM/.test(name) ? 0.6 : 0) + (/(^|_)ID$|UUID/.test(name) ? 0.4 : 0) - (/USER|OWNER|CUSTOMER|ORDER|SELLER|BUYER|BATCH|TASK/.test(name) ? 5 : 0);
    if (!best || score > best.score) best = { key, score };
  }
  return best && best.score > 0 ? best.key : null;
}

/** "pass" / "fail" / null from the overall-check column, whatever it's called and however it's written. */
function overallCheck(o: Record<string, unknown>): "pass" | "fail" | null {
  return parseCheck(col(o, ["VALIDATION", "OVERALL_CHECK", "OVERALL_GRADE_CHECK", "GRADE_CHECK", "OVERALL_MATCH", "CHECK"], /VALIDATION|OVERALL.*(CHECK|MATCH|OK|VALID)|GRADE_?CHECK|(^|_)CHECK(_|$)/));
}
/** "✅PASS" / "❌FAIL" / true / false / good / bad / match / mismatch -> pass | fail */
function parseCheck(v: unknown): "pass" | "fail" | null {
  if (v === null || v === undefined || v === "") return null;
  const t = String(v).trim().toLowerCase().replace(/[^a-z0-9 ]+/g, "").trim();
  if (v === true || /^(true|t|1|yes|y|pass|passed|ok|good|correct|match|matches|valid|✓|✔)$/.test(t)) return "pass";
  if (v === false || /^(false|f|0|no|n|fail|failed|bad|wrong|incorrect|mismatch|no match|invalid|✗|✘|x)$/.test(t)) return "fail";
  return /fail|wrong|mismatch|bad|incorrect/.test(t) ? "fail" : /pass|good|ok|match|correct/.test(t) ? "pass" : null;
}

/** The overall grade as a number: "ARENA_CLUB 9.5" -> 9.5, "7.5" -> 7.5 */
function gradeNum(o: Record<string, unknown>): number | null {
  const v = col(o, ["OVERALL_GRADE", "OVERALL", "FINAL_GRADE", "GRADE"], /OVERALL_?GRADE|(^|_)GRADE$/);
  const m = String(v ?? "").match(/(\d+(?:\.\d+)?)\s*$/) || String(v ?? "").match(/(\d+(?:\.\d+)?)/);
  return m ? Number(m[1]) : null;
}

export type ArenaCard = Record<string, unknown> & { item_id: string; order_number: string; tag: string | null; ev: number; overall_check: "pass" | "fail" | null; grade_num: number | null };

type CheckRow = { centering: number | null; corners: number | null; edges: number | null; surface: number | null; overall: number | null; expected: number | null; validation: string | null; result: "pass" | "fail" | null };
function toCheck(o0: Record<string, unknown>): CheckRow {
  const o: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o0)) o[K(k)] = v;
  const validation = s(col(o, ["VALIDATION", "RESULT", "CHECK", "OVERALL_CHECK"], /VALID|RESULT|CHECK/));
  return {
    centering: n(col(o, ["CENTERING"], /CENTER/)), corners: n(col(o, ["CORNERS"], /CORNER/)), edges: n(col(o, ["EDGES"], /EDGE/)),
    surface: n(col(o, ["SURFACE"], /SURFACE/)), overall: n(col(o, ["OVERALL", "OVERALL_GRADE", "GRADE"])), expected: n(col(o, ["EXPECTED", "EXPECTED_OVERALL"], /EXPECT/)),
    validation, result: parseCheck(validation),
  };
}

function toCard(o0: Record<string, unknown>, idKey: string | null, i: number, orderFallback: string): ArenaCard {
  const o: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o0)) o[K(k)] = v;
  const id = idKey ? String(o0[idKey] ?? "").match(UUID)?.[0]?.toLowerCase() : null;
  const gc = s(col(o, ["GRADING_COMPANY", "GRADER"]));
  const grade = s(col(o, ["GRADE", "OVERALL_GRADE", "FINAL_GRADE"]));
  const img = Object.keys(o).find((k) => /PICTURE|IMAGE|PHOTO|IMG/.test(k) && /^https?:\/\//.test(String(o[k] ?? "")));
  const order = s(col(o, ["ORDER_NUMBER", "ORDER_NO", "NUMBER", "ORDER"], /^(?!PURCHASE).*ORDER_?(NUMBER|NO)?$/)) ?? orderFallback;
  const cardUrl = s(col(o, ["CARD_URL", "ITEM_URL", "ADMIN_URL"]));
  const orderUrl = s(col(o, ["ORDER_URL", "ORDER_LINK", "ADMIN_ORDER_URL"], /ORDER.*(URL|LINK)/)) ?? (cardUrl?.match(/^(https?:\/\/[^?#]*?\/orders\/[^/?#]+)/)?.[1] ?? null);
  return {
    kind: "arena",
    item_id: id || `noid:${s(col(o, ["AC_NUMBER", "8AC_NUMBER"])) ?? i}`,
    ac: s(col(o, ["8AC_NUMBER", "AC_NUMBER", "AC"], /(^|_)AC(_NUMBER)?$/)) ?? "",
    cert: s(col(o, ["CERT_NUMBER", "CERT"], /CERT/)) ?? "",
    sport: (s(col(o, ["SPORT"])) ?? "").toLowerCase(),
    set_name: s(col(o, ["SET_NAME", "SET"])) ?? "",
    player_name: s(col(o, ["PLAYER_NAME", "PLAYER", "NAME", "CHARACTER"])) ?? "(no player)",
    parallel_name: s(col(o, ["PARALLEL_NAME", "PARALLEL"])),
    insert: s(col(o, ["INSERT", "INSERT_NAME"])),
    set_number: s(col(o, ["SET_NUMBER", "CARD_NUMBER"])),
    parallel_total: s(col(o, ["PARALLEL_TOTAL", "PRINT_RUN"])),
    grading_company: (gc ?? "").toLowerCase(),
    grade: (grade && gc && !grade.toLowerCase().startsWith(gc.toLowerCase()) ? `${gc} ${grade}` : grade ?? "").toLowerCase(),
    grade_num: gradeNum(o),
    // "Authentic" (or a 0 overall): no numeric grade; grouped with 7.5-or-lower
    authentic: /auth/i.test(String(col(o, ["GRADE", "OVERALL_GRADE", "FINAL_GRADE", "OVERALL"]) ?? "")) || gradeNum(o) === 0,
    overall_check: overallCheck(o),
    check_from_grade: false,
    ev: n(col(o, ["ESTIMATED_VALUE", "EV"])) ?? (n(col(o, ["ESTIMATED_VALUE_CENTS"])) ?? 0) / 100,
    last_comp: n(col(o, ["LAST_COMP", "LAST_COMP_VALUE"], /LAST_COMP/)),
    tag: s(col(o, ["TAG", "ITEM_TAG"])),
    img: img ? String(o[img]) : null,
    card_url: cardUrl,
    order_number: order,
    order_url: orderUrl ?? (process.env.ARENA_ORDER_URL ? process.env.ARENA_ORDER_URL.replace("{order}", order) : null),
    po_number: s(col(o, ["PO_NUMBER", "PO"])),
    status: s(col(o, ["ITEM_STATUS", "STATUS"])),
    ev_age_days: n(col(o, ["EV_AGE_DAYS"])),
    ev_date: s(col(o, ["ESTIMATED_VALUE_DATE", "EV_DATE"])),
    times_sold_back: n(col(o, ["TIMES_SOLD_BACK"])),
    bin: s(col(o, ["STORAGE_BIN_ID", "BIN"])),
    slot: s(col(o, ["STORAGE_BIN_SLOT", "SLOT"])),
    extra: o0,
  } as ArenaCard;
}

// ---------- request ----------
/** Order numbers typed: 6+ digit numbers, with or without "order(s)", commas, spaces or new lines. */
export function orderNumbers(text: string) {
  const out: string[] = [];
  for (const m of text.replace(/\$\s*[\d,.]+k?/gi, " ").matchAll(/(?<![\d.])(\d{6,12})(?![\d.])/g)) if (!out.includes(m[1])) out.push(m[1]);
  return out;
}

export async function searchArena(text: string) {
  const t0 = Date.now();
  const raw = markPlainTag(text);
  const orders = orderNumbers(raw);
  const p = parseRequest(raw.replace(/(?<![\d.])\d{6,12}(?![\d.])/g, " "), buildLexiconFromRows([]));
  const curTags = ([] as string[]).concat((p.filters.tag as string | string[] | undefined) ?? []).map((x) => String(x).toLowerCase());
  if (!orders.length) {
    return { parsed: { action: p.action, tag: p.tag, mode: p.mode, filters: {}, post_filters: {} }, has_filter: false, queries: [], ms: Date.now() - t0, rows: [] as ArenaCard[], orders: [] as unknown[], missing: [] as string[], card_id: cardId(), check_card_id: checkCardId() };
  }
  const ps = await params();
  const chkId = checkCardId();
  const chkParams = chkId ? await params(chkId) : [];
  const chkOrder = chkParams.find((x) => /order/i.test(x.name) && !/purchase|po/i.test(x.name)) ?? chkParams.find((x) => /order/i.test(x.name));
  if (chkId && !chkOrder) throw new Error(`The Overall Check question ${chkId} has no Order Number filter.`);
  const orderParam = ps.find((x) => /order/i.test(x.name) && !/purchase|po/i.test(x.name)) ?? ps.find((x) => /order/i.test(x.name));
  if (!orderParam) throw new Error(`Question ${cardId()} has no Order Number filter. Add one (e.g. [[AND order_number = {{order_number}}]]) so each order can be searched on its own.`);
  const [results, checks] = await Promise.all([
    inBatches(orders, 8, (o) => run(orderParam, o)),
    chkId && chkOrder ? inBatches(orders, 8, (o) => run(chkOrder, o, chkId)) : Promise.resolve([] as Record<string, unknown>[][]),
  ]);
  // Overall Check rows by 8AC number, and by any UUID in their card link
  const checkBy = new Map<string, CheckRow>();
  for (const r of checks.flat()) {
    const c = toCheck(r);
    const up: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(r)) up[K(k)] = v;
    const ac = s(col(up, ["8AC_NUMBER", "AC_NUMBER", "8AC"], /AC_?NUMBER|(^|_)8AC/));
    if (ac) checkBy.set("ac:" + ac, c);
    for (const v of Object.values(r)) { const m = String(v ?? "").match(new RegExp(UUID.source, "gi")); m?.forEach((u) => checkBy.set("id:" + u.toLowerCase(), c)); }
  }
  const all = results.flat();
  const idKey = all.length ? idColumn(all) : null;
  const byId = new Map<string, ArenaCard>();
  results.forEach((rs, oi) => rs.forEach((r, i) => {
    const c = toCard(r, idKey, oi * 100000 + i, orders[oi]);
    const k = checkBy.get("ac:" + c.ac) ?? checkBy.get("id:" + c.item_id);
    if (k) Object.assign(c, { overall_check: k.result ?? c.overall_check, centering: k.centering, corners: k.corners, edges: k.edges, surface: k.surface, check_overall: k.overall, expected: k.expected, validation: k.validation });
    if ((c as any).authentic) c.overall_check = "pass"; // Authentic (all 0s) counts as a pass
    byId.set(c.item_id, c);
  }));
  const everyCard = [...byId.values()];
  // narrowing to current tags ("remove tag sp_hold from …") changes what's shown, not the order totals
  const rows = curTags.length ? everyCard.filter((r) => !!r.tag && curTags.includes(String(r.tag).toLowerCase())) : everyCard;

  const summary = orders.map((o) => {
    const cs = everyCard.filter((r) => r.order_number === o);
    return {
      order: o,
      url: (cs.find((c) => c.order_url)?.order_url as string | null) ?? null,
      total: cs.length,
      low: cs.filter((c) => (c as any).authentic || (c.grade_num != null && c.grade_num <= 7.5)).length,
      authentic: cs.filter((c) => (c as any).authentic).length,
      fails: cs.filter((c) => c.overall_check === "fail").length,
      checked: cs.filter((c) => c.overall_check != null).length,
      shown: rows.filter((r) => r.order_number === o).length,
      check_from_grade: cs.every((c) => (c as any).check_from_grade),
    };
  });
  return {
    parsed: { action: p.action, tag: p.tag, mode: p.mode, filters: { order: orders.length === 1 ? orders[0] : orders, ...(curTags.length ? { tag: curTags.length === 1 ? curTags[0] : curTags } : {}) }, post_filters: {} },
    has_filter: true,
    queries: [],
    ms: Date.now() - t0,
    rows,
    orders: summary,
    missing: summary.filter((x) => !x.total).map((x) => x.order),
    no_ids: rows.length > 0 && rows.every((r) => r.item_id.startsWith("noid:")),
    check_connected: !!chkId,
    card_id: cardId(),
    check_card_id: chkId,
  };
}
