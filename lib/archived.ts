// Archived tile: four Metabase questions (Arena Club / Customer × pre-graded / raw).
// Filters on the questions: Order Number, Issue. Numbers in the prompt are order numbers (Order Number filter) or 8AC numbers;
// every other word in the prompt has to appear somewhere on the row (issue, status, side, note, player, set...).
import { archivedCardId, ARCHIVED_VIEWS, type ArchivedView } from "./config";
import { inBatches } from "./metabase";
import { params, run, runCard, orderNumbers } from "./arena";
import { parseRequest, buildLexiconFromRows, markPlainTag, STOP } from "./parse";

const K = (k: string) => k.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_|_$/g, "");
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const s = (v: unknown) => (v === null || v === undefined || v === "" ? null : String(v));
const n = (v: unknown) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
const pick = (o: Record<string, unknown>, ...names: string[]) => { for (const k of names) if (o[k] !== undefined && o[k] !== null && o[k] !== "") return o[k]; return null; };

export type ArchivedNote = { side: string | null; issue: string | null; note: string | null; logged_at: string | null; note_type: string | null };
export type ArchivedCard = {
  kind: "archived"; view: ArchivedView; item_id: string; ac: string; cert: string; order_number: string; order_user_id: string | null;
  player_name: string; set_name: string; insert: string | null; set_number: string | null; parallel_name: string | null;
  grade: string; grading_company: string; ev: number; tag: string | null; img: string | null; card_url: string | null;
  archived_at: string | null; rescan_at: string | null; in_box: string | null;
  status: string | null; auth_status: string | null; order_owner: string | null; grade_type: string | null; value_range: string | null;
  parallel_total: string | null; order_url: string | null; order_status: string | null; order_source: string | null; order_kind: string | null; order_full_name: string | null;
  owner_type: string | null; owner_full_name: string | null; owner_username: string | null; owner_email: string | null; in_warehouse: string | null; item_status: string | null; cards_in_order: number | null;
  sport: string | null; ev_date: string | null; ev_age_days: number | null; po_number: string | null; times_sold_back: number | null; purchase_location: string | null;
  brand: string | null; title: string | null; reference: string | null; dial: string | null; movement: string | null; size: string | null; material: string | null;
  bracelet: string | null; gender: string | null; condition: string | null; box: string | null; papers: string | null; purchase_cost: number | null;
  notes: ArchivedNote[]; search: string;
};

function toCard(o0: Record<string, unknown>, view: ArchivedView, i: number): ArchivedCard {
  const o: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o0)) o[K(k)] = v;
  const id = String(pick(o, "ITEM_ID", "CARD_ID") ?? "").match(UUID)?.[0]?.toLowerCase();
  const img = s(pick(o, "FRONT_IMAGE", "FRONT_SLAB_PICTURE_URL", "IMAGE"));
  return {
    kind: "archived", view,
    item_id: id || `noid:${s(pick(o, "8AC_NUMBER", "AC_NUMBER")) ?? i}`,
    ac: s(pick(o, "8AC_NUMBER", "AC_NUMBER")) ?? "",
    cert: s(pick(o, "CERT_NUMBER", "CERT")) ?? "",
    order_number: s(pick(o, "ORDER_NUMBER")) ?? "",
    order_user_id: s(pick(o, "ORDER_USER_ID")),
    player_name: s(pick(o, "PLAYER_NAME")) ?? (s(pick(o, "8AC_NUMBER", "AC_NUMBER")) ? `AC ${s(pick(o, "8AC_NUMBER", "AC_NUMBER"))}` : "(no player)"),
    set_name: s(pick(o, "SET_NAME")) ?? "",
    insert: s(pick(o, "INSERT_NAME", "INSERT")),
    set_number: s(pick(o, "SET_NUMBER")),
    parallel_name: s(pick(o, "PARALLEL_NAME")),
    parallel_total: s(pick(o, "PARALLEL_TOTAL")),
    // order columns (Archived → Orders, question 45805)
    order_url: s(pick(o, "ORDER_URL")), order_status: s(pick(o, "ORDER_STATUS")), order_source: s(pick(o, "ORDER_SOURCE")), order_kind: s(pick(o, "ORDER_KIND")),
    order_full_name: s(pick(o, "ORDER_FULL_NAME")), owner_type: s(pick(o, "OWNER_TYPE")), owner_full_name: s(pick(o, "OWNER_FULL_NAME")), owner_username: s(pick(o, "OWNER_USERNAME")),
    owner_email: s(pick(o, "OWNER_EMAIL")), in_warehouse: s(pick(o, "IN_WAREHOUSE")), item_status: s(pick(o, "ITEM_STATUS")), cards_in_order: n(pick(o, "CARDS_IN_ORDER")),
    grade: (() => { const g = s(pick(o, "GRADE", "GRADE_NAME")) ?? "", co = s(pick(o, "GRADING_COMPANY")) ?? ""; return (/^[\d.]+$/.test(g) && co ? `${co} ${g}` : g).toLowerCase(); })(),
    grading_company: (s(pick(o, "GRADING_COMPANY")) ?? "").toLowerCase(),
    ev: n(pick(o, "ESTIMATED_VALUE")) ?? 0,
    tag: s(pick(o, "TAG")),
    archived_at: s(pick(o, "ARCHIVED_AT")), rescan_at: s(pick(o, "RESCAN_REQUESTED_AT")), in_box: s(pick(o, "BOX_NUMBER", "BOX_ID")),
    img: img && /^https?:\/\//.test(img) ? img : null,
    card_url: s(pick(o, "CARD_URL")),
    status: s(pick(o, "CARD_STATUS", "ITEM_STATUS", "STATUS")),
    auth_status: s(pick(o, "AUTHENTICATION_STATUS")),
    order_owner: s(pick(o, "ORDER_OWNER", "OWNER_FULL_NAME", "ORDER_FULL_NAME", "OWNER_USERNAME")),
    grade_type: s(pick(o, "GRADE_TYPE")),
    value_range: s(pick(o, "VALUE_RANGE")),
    // card columns (Archived → Cards); shown like the Cards tile and its popup
    sport: s(pick(o, "SPORT")), ev_date: s(pick(o, "EV_DATE", "ESTIMATED_VALUE_DATE")), ev_age_days: n(pick(o, "EV_AGE_DAYS", "EV_AGE")),
    po_number: s(pick(o, "PO_NUMBER", "PO")), times_sold_back: n(pick(o, "TIMES_SOLD_BACK")), purchase_location: s(pick(o, "PURCHASE_LOCATION", "BOUGHT_AT")),
    // watch columns (Archived → Watches); shown in the same layout as the Watches tile
    brand: s(pick(o, "BRAND", "WATCH_BRAND")), title: s(pick(o, "TITLE", "WATCH_TITLE", "MODEL")), reference: s(pick(o, "REFERENCE", "REF", "REFERENCE_NUMBER")),
    dial: s(pick(o, "DIAL", "DIAL_COLOR")), movement: s(pick(o, "MOVEMENT")), size: s(pick(o, "SIZE", "CASE_SIZE")), material: s(pick(o, "MATERIAL", "CASE_MATERIAL")),
    bracelet: s(pick(o, "BRACELET", "BRACELET_MATERIAL")), gender: s(pick(o, "GENDER")), condition: s(pick(o, "CONDITION")), box: s(pick(o, "BOX")), papers: s(pick(o, "PAPERS")),
    purchase_cost: n(pick(o, "PURCHASE_COST", "COST")),
    notes: [{ side: s(pick(o, "SIDE")), issue: s(pick(o, "ISSUE")), note: s(pick(o, "OPERATION_LOG_NOTE", "NOTE")), logged_at: s(pick(o, "NOTE_LOGGED_AT_PT", "NOTE_LOGGED_AT")), note_type: s(pick(o, "NOTE_TYPE")) }],
    search: Object.values(o0).map((v) => String(v ?? "")).join(" ").toLowerCase(),
  };
}

/** One tile per card: several log notes on the same card are kept together, newest first. */
function merge(cards: ArchivedCard[]) {
  const by = new Map<string, ArchivedCard>();
  for (const c of cards) {
    const prev = by.get(c.item_id);
    if (!prev) { by.set(c.item_id, c); continue; }
    for (const k of Object.keys(c) as (keyof ArchivedCard)[]) {
      if (k === "notes" || k === "search") continue;
      const pv = prev[k] as unknown, cv = c[k] as unknown;
      if ((pv === null || pv === "" || pv === "(no player)" || (k === "player_name" && String(pv).startsWith("AC ")) || pv === 0) && cv !== null && cv !== "") (prev as Record<string, unknown>)[k] = cv;
    }
    const seen = new Set(prev.notes.map((x) => JSON.stringify(x)));
    for (const x of c.notes) if (!seen.has(JSON.stringify(x))) prev.notes.push(x);
    prev.search += " " + c.search;
  }
  for (const c of by.values()) {
    c.notes = c.notes.filter((x) => x.side || x.issue || x.note || x.note_type);
    c.notes.sort((a, b) => (Date.parse(b.logged_at ?? "") || 0) - (Date.parse(a.logged_at ?? "") || 0));
  }
  return [...by.values()];
}

export async function searchArchived(viewIn: unknown, text: string) {
  const t0 = Date.now();
  const { view, id } = archivedCardId(viewIn);
  const raw = markPlainTag(text);
  const orders = orderNumbers(raw);
  const rest = raw.replace(/(?<![\d.])\d{6,12}(?![\d.])/g, " ");
  const p = parseRequest(rest, buildLexiconFromRows([]));
  // Words with underscores (pending_rescan, not_accepted) read like tag names. Only treat them as a current tag
  // when removing tags or when the prompt says so ("tagged x", "with tag x"); otherwise they are search words.
  const tagIntent = p.action === "clear" || /\b(tagged|with tag|has tag|current tag)\b/i.test(rest);
  const curTags = tagIntent ? ([] as string[]).concat((p.filters.tag as string | string[] | undefined) ?? []).map((x) => String(x).toLowerCase()) : [];

  // words that narrow the list: everything that isn't a command word, the new tag, a current tag or an order number
  const drop = new Set([...(p.tag ? [String(p.tag).toLowerCase()] : []), ...curTags]);
  const words = rest.toLowerCase()
    .replace(/\b(as|to|named|called)\s+[a-z0-9_\-]+/g, " ")
    .split(/[^a-z0-9$+<>.\-_]+/).map((w) => w.replace(/^[.\-]+|[.\-]+$/g, ""))
    .filter((w) => w && !drop.has(w) && !STOP.has(w) && !/^(orders?|archived?|archive|tag|tags|untag|remove|clear|add|set|show|showing|find|get|give|list|pull|display|see|view|load|me|my|us|cards?|items?|rows?|records?|results?|all|every|everything|anything|please|pls|in|on|of|for|from|a|an|the|them|those|these|it|now)$/.test(w));

  // Numbers can be order numbers or 8AC numbers (paste a whole list of either, or both)
  const ps = await params(id);
  const orderParam = ps.find((x) => /order/i.test(x.name));
  let all: ArchivedCard[] | null = null;
  const everything = async () => (all ??= merge((await runCard(id)).map((r, i) => toCard(r, view, i))));
  let cards: ArchivedCard[];
  if (orders.length) {
    const byOrder = orderParam ? merge((await inBatches(orders, 8, (o) => run(orderParam, o, id))).flat().map((r, i) => toCard(r, view, i))) : [];
    const found = new Set(byOrder.map((c) => c.order_number));
    const rest = orders.filter((o) => !found.has(o));
    const extra = rest.length ? (await everything()).filter((c) => rest.includes(c.ac) || (!orderParam && rest.includes(c.order_number))) : [];
    cards = merge([...byOrder, ...extra]);
  } else cards = await everything();

  if (curTags.length) cards = cards.filter((c) => !!c.tag && curTags.includes(c.tag.toLowerCase()));
  if (words.length) cards = cards.filter((c) => words.every((w) => c.search.includes(w)));
  const missing = orders.filter((o) => !cards.some((c) => c.order_number === o || c.ac === o));

  return {
    parsed: { action: p.action, tag: p.tag, mode: p.mode, filters: {}, post_filters: {} },
    has_filter: true, // a whole archive list is a valid request (lists are small); narrowed: orders/words/tags
    ms: Date.now() - t0, rows: cards, card_id: id, view, view_label: ARCHIVED_VIEWS[view].label,
    words, orders, missing,
  };
}
