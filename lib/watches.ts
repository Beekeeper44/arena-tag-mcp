// Watches: Metabase question 45046 (WATCH_METABASE_CARD_ID). Pulls the question fresh on every search
// (no filters sent, so its own filter names don't matter), then matches the typed request against the
// actual brand / model / reference / dial values in the results. Columns are found by name.
import { config } from "./config";
import { parseRequest, buildLexiconFromRows, markPlainTag } from "./parse";
import { inBatches } from "./metabase";

export type WatchRow = {
  item_id: string; brand: string | null; model: string | null; reference: string | null; dial: string | null;
  serial: string | null; year: string | null; condition: string | null; material: string | null; size: string | null;
  bracelet: string | null; ev: number | null;
  title: string | null; movement: string | null; bracelet_material: string | null; bracelet_color: string | null;
  gender: string | null; box: string | null; papers: string | null; ac: string | null; order: string | null; po: string | null; cost: number | null; tag: string | null; status: string | null; img: string | null;
  url: string | null; bin: string | null; slot: string | null; extra: Record<string, unknown>;
};

export type WatchFilters = {
  brand?: string[]; model?: string[]; reference?: string[]; dial_color?: string[]; year?: string[];
  condition?: string[]; material?: string[]; min_estimated_value?: number; max_estimated_value?: number;
  tag?: string[]; serial?: string[]; any?: string[]; // any: PO #, order #, other ids, matched in any column
};

// ---------- read question 45046 ----------
const K = (k: string) => k.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_|_$/g, "");
const COLS: Record<string, string[]> = {
  item_id: ["ITEM_ID", "ID", "WATCH_ID", "ITEMS_ID", "UUID"],
  brand: ["BRAND_NAME", "BRAND", "WATCH_BRAND", "MAKE"],
  model: ["MODEL", "WATCH_MODEL", "MODEL_NAME", "COLLECTION", "NAME", "TITLE"],
  reference: ["REFERENCE", "REFERENCE_NUMBER", "REF", "REF_NUMBER", "REFERENCE_NO", "MODEL_NUMBER"],
  dial: ["DIAL_COLOR", "DIAL_COLOUR", "DIAL"],
  serial: ["SERIAL", "SERIAL_NUMBER", "SERIAL_NO"],
  year: ["YEAR", "PRODUCTION_YEAR", "MODEL_YEAR", "YEAR_OF_PRODUCTION"],
  condition: ["CONDITION", "WATCH_CONDITION", "CONDITION_NAME"],
  material: ["CASE_MATERIAL", "MATERIAL", "CASE_METAL"],
  size: ["CASE_SIZE", "CASE_DIAMETER", "SIZE", "CASE_SIZE_MM"],
  bracelet: ["BRACELET", "BRACELET_TYPE", "STRAP", "BAND"],
  ev: ["ESTIMATED_VALUE", "EV", "ESTIMATED_VALUE_USD", "ESTIMATE"],
  ev_cents: ["ESTIMATED_VALUE_CENTS", "EV_CENTS"],
  tag: ["TAG", "ITEM_TAG", "TAGS"],
  status: ["ITEM_STATUS", "STATUS", "WATCH_STATUS"],
  url: ["ITEM_URL", "ADMIN_URL", "WATCH_URL", "URL", "LINK"],
  bin: ["STORAGE_BIN_ID", "BIN", "STORAGE_BIN"],
  slot: ["STORAGE_BIN_SLOT", "SLOT"],
};
const pick = (o: Record<string, unknown>, names: string[]) => {
  for (const n of names) if (o[n] !== undefined && o[n] !== null && o[n] !== "") return o[n];
  return null;
};
const str = (v: unknown) => (v === null || v === undefined || v === "" ? null : String(v));

// first column whose name is one of these, else whose name matches the pattern
const loose = (o: Record<string, unknown>, names: string[], re?: RegExp) => {
  const v = pick(o, names);
  if (v != null || !re) return v;
  const k = Object.keys(o).find((key) => re.test(key) && o[key] !== null && o[key] !== "");
  return k ? o[k] : null;
};
const yn = (v: unknown) => (v === true || v === "true" ? "Yes" : v === false || v === "false" ? "No" : str(v));

function toWatch(raw: Record<string, unknown>): WatchRow {
  const o: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) o[K(k)] = v;
  const evRaw = pick(o, COLS.ev);
  const evCents = pick(o, COLS.ev_cents);
  const ev = evRaw != null ? Number(evRaw) : evCents != null ? Number(evCents) / 100 : null;
  const imgKey = Object.keys(o).find((k) => /PICTURE|IMAGE|PHOTO|IMG/.test(k) && /^https?:\/\//.test(String(o[k] ?? "")));
  return {
    item_id: String(pick(o, COLS.item_id) ?? ""),
    brand: str(pick(o, COLS.brand)), model: str(pick(o, COLS.model)), reference: str(pick(o, COLS.reference)),
    dial: str(pick(o, COLS.dial)), serial: str(pick(o, COLS.serial)), year: str(pick(o, COLS.year)),
    condition: str(pick(o, COLS.condition)), material: str(pick(o, COLS.material)),
    size: ((v) => (v && /^\d+(\.\d+)?$/.test(v) ? `${v}mm` : v))(str(pick(o, COLS.size))),
    bracelet: str(pick(o, COLS.bracelet)), ev: Number.isFinite(ev as number) ? (ev as number) : null,
    title: str(loose(o, ["TITLE", "NAME", "LISTING_TITLE", "DISPLAY_NAME", "ITEM_NAME", "WATCH_NAME"])),
    movement: str(loose(o, ["MOVEMENT", "MOVEMENT_TYPE", "CALIBER"], /MOVEMENT/)),
    bracelet_material: str(loose(o, ["BRACELET_MATERIAL", "STRAP_MATERIAL", "BAND_MATERIAL"], /(BRACELET|STRAP|BAND).*MATERIAL/)),
    bracelet_color: str(loose(o, ["BRACELET_COLOR", "BRACELET_COLOUR", "STRAP_COLOR", "BAND_COLOR"], /(BRACELET|STRAP|BAND).*COLOU?R/)),
    gender: str(loose(o, ["GENDER", "SEX"], /GENDER/)),
    box: yn(loose(o, ["BOX_DETAILS", "BOX", "HAS_BOX", "BOX_TYPE", "ORIGINAL_BOX", "WATCH_BOX"], /(^|_)BOX(_|$)/)),
    papers: yn(loose(o, ["PAPERS_DETAILS", "PAPERS", "HAS_PAPERS", "PAPERS_TYPE", "ORIGINAL_PAPERS", "WATCH_PAPERS"], /PAPERS/)),
    ac: str(loose(o, ["AC_NUMBER", "8AC_NUMBER", "AC", "AC_NO"], /(^|_)AC(_|$)/)),
    order: str(loose(o, ["ORDER_NUMBER", "ORDER_NO", "ORDER", "NUMBER"], /^(?!PURCHASE).*ORDER/)),
    po: str(loose(o, ["PO_NUMBER", "PO", "PO_NO", "PO_ID", "PURCHASE_ORDER", "PURCHASE_ORDER_NUMBER"], /(^|_)PO(_|$)|PURCHASE_ORDER/)),
    cost: ((v) => (v == null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v)))(loose(o, ["PURCHASE_COST", "COST", "UNIT_COST", "PURCHASE_PRICE"], /COST/)),
    tag: str(pick(o, COLS.tag)), status: str(pick(o, COLS.status)), img: imgKey ? String(o[imgKey]) : null,
    url: str(pick(o, COLS.url)), bin: str(pick(o, COLS.bin)), slot: str(pick(o, COLS.slot)), extra: raw,
  };
}

// Question 45046 has LIMIT 5000 (newest first) in its SQL, so pulling it with no filters misses older watches.
// Every search goes through the question's own filters instead (they run inside the SQL, before the limit),
// exactly like using Reference Number / Brand / Model / Po Number / Order Number / Tag in Metabase. Results are merged.
// Field filters (dropdowns, exact values) get the exact values from the filter's own value list; text filters get the words.
type Param = { name: string; id: string; type: string; dimension: boolean };
let paramCache: { at: number; params: Param[] } | null = null;

async function mb(path: string, init: RequestInit = {}) {
  return fetch(`${config.metabaseHost()}${path}`, { ...init, headers: { "x-api-key": config.metabaseApiKey(), ...(init.headers || {}) } });
}

async function watchParams(): Promise<Param[]> {
  if (paramCache && Date.now() - paramCache.at < 60_000) return paramCache.params;
  const res = await mb(`/api/card/${config.watchCardId()}`);
  if (!res.ok) throw new Error(`Metabase watches question ${config.watchCardId()} failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
  const card = await res.json();
  const byName = new Map<string, Param>();
  const tagsets = [card?.dataset_query?.native?.["template-tags"], ...(card?.dataset_query?.stages ?? []).map((st: any) => st?.["template-tags"])];
  for (const ts of tagsets) for (const [k, v] of Object.entries((ts ?? {}) as Record<string, any>)) {
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
  const params = [...byName.values()].filter((p) => p.id);
  paramCache = { at: Date.now(), params };
  return params;
}

/** The question's filters, by what they're for (names matched loosely). */
async function watchFilters() {
  const ps = await watchParams();
  const key = (p: Param) => p.name.replace(/[^a-z#]/gi, "_").toLowerCase();
  const find = (re: RegExp) => ps.filter((p) => re.test(key(p)));
  return {
    tag: find(/^tags?$|(^|_)tag(_|$)/),
    brand: find(/brand|make/),
    model: find(/model/),
    dial: find(/dial|colou?r/),
    reference: find(/ref/),
    ids: [...find(/(^|_)po(_|$|#|_?n(umber|o))|purchase_order/), ...find(/order/).filter((p) => !/purchase/.test(key(p))), ...find(/serial|(^|_)ac(_|$)/)],
  };
}

// exact-value filters ("=" / category / dropdown) vs. ones that match part of the text
const isExact = (p: Param) => !/contains|starts|ends/.test(p.type);

/** The values a filter's dropdown offers (Metabase's own list), cached 10 minutes. null = not available. */
const valueCache = new Map<string, { at: number; values: string[] | null }>();
async function filterValues(p: Param): Promise<string[] | null> {
  const hit = valueCache.get(p.id);
  if (hit && Date.now() - hit.at < 600_000) return hit.values;
  let values: string[] | null = null;
  try {
    const res = await mb(`/api/card/${config.watchCardId()}/params/${encodeURIComponent(p.id)}/values`);
    if (res.ok) {
      const body = await res.json();
      const list = Array.isArray(body) ? body : body?.values;
      if (Array.isArray(list)) values = list.map((v: unknown) => (Array.isArray(v) ? v[0] : v)).filter((v: unknown) => v != null && v !== "").map(String);
    }
  } catch { /* fall back to typed words */ }
  valueCache.set(p.id, { at: Date.now(), values });
  return values;
}

async function runWith(param: Param | null, value: string | string[]): Promise<WatchRow[]> {
  const vals = ([] as string[]).concat(value);
  const parameters = param
    ? [{ id: param.id, type: param.type, target: [param.dimension ? "dimension" : "variable", ["template-tag", param.name]], value: param.dimension ? vals : [vals[0]] }]
    : [];
  const path = `/api/card/${config.watchCardId()}/query/json`;
  let res = await mb(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ parameters, format_rows: false }) });
  if (!res.ok && res.status >= 400 && res.status < 500) {
    res = await mb(path, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ parameters: JSON.stringify(parameters), format_rows: "false" }).toString() });
  }
  if (!res.ok) throw new Error(`Metabase watches question ${config.watchCardId()} failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  if (!Array.isArray(data)) throw new Error(`Unexpected Metabase response: ${JSON.stringify(data).slice(0, 300)}`);
  return withIds(data);
}

// The item id is found by its values, not its column name: the column (any name) whose values are UUIDs,
// or contain one (e.g. an admin link). Names with ITEM / ID win ties.
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
let idColumn: string | null | undefined; // remembered between searches
function findIdColumn(data: Record<string, unknown>[]): string | null {
  const sample = data.slice(0, 200);
  let best: { key: string; score: number } | null = null;
  for (const key of Object.keys(sample[0] ?? {})) {
    let full = 0, inside = 0;
    for (const r of sample) {
      const v = String(r[key] ?? "");
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)) full++;
      else if (UUID.test(v)) inside++;
    }
    if (!full && !inside) continue;
    const name = K(key);
    const score = full * 3 + inside + (/ITEM/.test(name) ? 0.6 : 0) + (/(^|_)ID$|UUID/.test(name) ? 0.4 : 0) - (/USER|OWNER|CUSTOMER|ORDER|SELLER|BUYER|TYPE|CONDITION|BRAND|MODEL/.test(name) ? 2 : 0);
    if (!best || score > best.score) best = { key, score };
  }
  return best && best.score > 0 ? best.key : null;
}

function withIds(data: Record<string, unknown>[]): WatchRow[] {
  if (!data.length) return [];
  if (idColumn === undefined || (idColumn && !(idColumn in data[0]))) idColumn = findIdColumn(data);
  return data.map((raw, i) => {
    const w = toWatch(raw);
    const m = idColumn ? String(raw[idColumn] ?? "").match(UUID) : null;
    // no item id anywhere: still show the watch (keyed by AC / order / row) so searching works; tagging needs the id
    w.item_id = m ? m[0].toLowerCase() : `noid:${w.ac ?? w.order ?? w.reference ?? i}`;
    return w;
  });
}

export const hasItemIds = (rows: WatchRow[]) => rows.some((r) => !r.item_id.startsWith("noid:"));

/** Words to send through 45046's filters: tag names, words (brand / model / tag), and numbers (PO / order / reference). */
function searchTerms(text: string) {
  const raw = markPlainTag(text);
  // current tags only: the new tag ("... as sd_x") isn't on any watch yet, so searching for it would hide everything else
  const parsed = parseRequest(raw, buildLexiconFromRows([]));
  const tags = ([] as string[]).concat((parsed.filters.tag as string | string[] | undefined) ?? []).map((x) => String(x).toLowerCase());
  let t = " " + norm(raw.replace(/#[A-Za-z0-9_-]+/g, " ").replace(/\b[A-Za-z0-9]*_[A-Za-z0-9_]+\b/g, " ").replace(/\$\s*[\d,.]+k?\+?/gi, " ")) + " ";
  for (const [a, full] of Object.entries(ALIAS)) t = t.replace(new RegExp(`(^|[^a-z0-9])${esc(a)}(?=$|[^a-z0-9])`, "g"), `$1${full}`);
  const toks = t.split(/[\s,]+/).filter(Boolean);
  const words = toks.filter((w) => /^[a-z][a-z.&-]*$/.test(w) && w.length >= 3 && !STOP.has(w) && !COLORS.includes(w));
  const numbers = toks.filter((w) => /\d/.test(w) && w.replace(/[^a-z0-9]/g, "").length >= 3 && !/^(19|20)\d\d$/.test(w) && !/^\d{1,3}(mm)?$/.test(w));
  return { tags: [...new Set(tags)], words: [...new Set(words)], numbers: [...new Set(numbers)], expanded: t };
}

/** Which of a filter's values the request names: whole value typed ("patek philippe"), or a typed word that is one
 *  of the value's words ("patek", "datejust"); tags must match exactly; references by prefix. */
function pickValues(values: string[], kind: "tag" | "words" | "reference", text: string, words: string[], numbers: string[], tags: string[]) {
  const t = " " + norm(text) + " ";
  if (kind === "tag") { const want = new Set([...tags, ...words]); return values.filter((v) => want.has(v.toLowerCase())); }
  if (kind === "reference") return values.filter((v) => numbers.some((n) => alnum(v).startsWith(alnum(n))));
  return values.filter((v) => {
    const nv = norm(v);
    if (nv.length >= 2 && has(t, nv)) return true;
    const vw = nv.split(/[\s-]+/);
    return words.some((w) => vw.includes(w) || (w.includes("-") && nv.includes(w)));
  });
}

export async function queryWatches(text = ""): Promise<{ rows: WatchRow[]; searches: number; notice?: string }> {
  const f = await watchFilters();
  const { tags, words, numbers, expanded } = searchTerms(text);
  const jobs: [Param, string | string[]][] = [];
  const route = async (ps: Param[], kind: "tag" | "words" | "reference", typed: string[]) => {
    for (const p of ps) {
      if (isExact(p)) {
        const values = await filterValues(p);
        if (values) { const hit = pickValues(values, kind, expanded, words, numbers, tags); if (hit.length) jobs.push([p, hit]); continue; }
      }
      for (const v of typed) jobs.push([p, v]); // text filter (or no value list): send what was typed
    }
  };
  await route(f.tag, "tag", [...tags, ...words]);
  await route(f.brand, "words", words);
  await route(f.model, "words", words);
  await route(f.dial, "words", words);
  await route(f.reference, "reference", numbers);
  for (const n of numbers) for (const p of f.ids) jobs.push([p, n]);
  if (!jobs.length) {
    // nothing to route through a filter (e.g. "blue dial over $40k"): whole question, which its SQL may cap
    const rows = await runWith(null, "");
    return { rows, searches: 1, notice: rows.length >= 5000 ? `Question ${config.watchCardId()} only returns its newest ${rows.length.toLocaleString()} watches without a filter. Add a brand, model, tag or reference to search all of them, or remove the LIMIT from its SQL.` : undefined };
  }
  // exact-value filters take every matching value in one query; text filters one value per query
  const runs: [Param, string | string[]][] = jobs.flatMap(([p, v]) => (Array.isArray(v) && !p.dimension ? v.map((x) => [p, x] as [Param, string]) : [[p, v] as [Param, string | string[]]]));
  const results = await inBatches(runs, 8, ([p, v]) => runWith(p, v));
  const byId = new Map<string, WatchRow>();
  for (const rs of results) for (const r of rs) byId.set(r.item_id, r);
  return { rows: [...byId.values()], searches: runs.length };
}

// ---------- read the typed request ----------
const norm = (s: unknown) => String(s ?? "").toLowerCase().replace(/[’']/g, "").replace(/[^a-z0-9.&\s-]+/g, " ").replace(/\s+/g, " ").trim();
const alnum = (s: unknown) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const has = (t: string, p: string) => p.length > 1 && new RegExp(`(^|[^a-z0-9])${esc(p)}(s|es)?($|[^a-z0-9])`).test(t);

const ALIAS: Record<string, string> = {
  ap: "audemars piguet", pp: "patek philippe", patek: "patek philippe", vc: "vacheron constantin", alange: "a. lange",
  lange: "a. lange", jlc: "jaeger-lecoultre", heuer: "tag heuer", rollie: "rolex", sub: "submariner", gmt: "gmt-master",
  dj: "datejust", dd: "day-date", speedy: "speedmaster", mop: "mother of pearl",
};
const COLORS = ["ice blue", "mother of pearl", "tiffany blue", "blue", "black", "white", "green", "silver", "grey", "gray", "champagne",
  "brown", "chocolate", "pink", "salmon", "gold", "yellow", "red", "purple", "orange", "slate", "rhodium", "meteorite", "panda",
  "sundust", "olive", "turquoise", "tiffany", "cream", "ivory", "aventurine", "wimbledon"];
const STOP = new Set(("tag tags tagging tagged all the watch watches and or with as between over under above below every from remove clear " +
  "currently skip that already have only untagged dont overwrite existing more than less least most in on any my please dollars dollar " +
  "each these those them it its of to for a an is are be into new give put add apply make want need would like just also plus value " +
  "values estimated worth price priced range cheap expensive high low end top best whole entire inventory warehouse no not without " +
  "delete untag take off dial dials color colour ref reference references model models brand brands year years condition arena club " +
  "thanks steel gold timebox time box vip ship").split(" "));

function phraseValues(rows: WatchRow[], f: keyof WatchRow) {
  return [...new Set(rows.map((r) => norm(r[f])).filter((v) => v.length >= 2))].sort((a, b) => b.length - a.length);
}

export function readWatchRequest(text: string, rows: WatchRow[]) {
  // action / tag / mode / value range / "tagged with x": same reader as cards
  const base = parseRequest(text, buildLexiconFromRows([]));
  const f: WatchFilters = {};
  if (base.filters.min_estimated_value != null) f.min_estimated_value = base.filters.min_estimated_value as number;
  if (base.filters.max_estimated_value != null) f.max_estimated_value = base.filters.max_estimated_value as number;
  if (base.filters.tag) f.tag = ([] as string[]).concat(base.filters.tag as string | string[]).map((x) => String(x).toLowerCase());
  const newTag = base.tag;

  let t = " " + norm(text.replace(/#[A-Za-z0-9_-]+/g, " ").replace(/\b[A-Za-z0-9]+(?:_[A-Za-z0-9]+)+\b/g, " ").replace(/\$\s*[\d,.]+k?\+?/gi, " ")) + " ";
  for (const [a, full] of Object.entries(ALIAS)) if (has(t, a) && !has(t, full)) t = t.replace(new RegExp(`(^|[^a-z0-9])${esc(a)}(?=$|[^a-z0-9])`, "g"), `$1${full}`);

  const used = new Set<string>();
  const take = (key: keyof WatchFilters, field: keyof WatchRow, wordMatch: boolean) => {
    const found: string[] = [];
    for (const v of phraseValues(rows, field)) if (has(t, v)) { found.push(v); t = t.replace(v, " "); }
    if (wordMatch) {
      for (const w of t.split(/[^a-z0-9.&-]+/)) {
        if (w.length < 4 || STOP.has(w) || used.has(w) || /^\d+$/.test(w)) continue;
        const vals = phraseValues(rows, field).filter((v) => v.split(/[\s-]+/).includes(w) || (w.includes("-") && v.includes(w)));
        if (vals.length) { found.push(w); used.add(w); w.split(/[-.]/).forEach((x) => used.add(x)); }
      }
    }
    if (found.length) (f[key] as string[]) = [...new Set(found)];
  };
  take("brand", "brand", true);
  take("model", "model", true);
  take("condition", "condition", false);
  take("material", "material", false);

  // dial colors: real dial values first, then color words ("blue" matches "Ice Blue")
  const dials: string[] = [];
  for (const v of phraseValues(rows, "dial")) if (has(t, v)) { dials.push(v); t = t.replace(v, " "); }
  for (const c of COLORS) if (has(t, c)) { dials.push(c); t = t.replace(c, " "); }
  if (dials.length) f.dial_color = [...new Set(dials)];

  // years and reference numbers
  const years = [...t.matchAll(/\b(19[4-9]\d|20[0-4]\d)\b/g)].map((m) => m[1]);
  if (years.length && rows.some((r) => r.year)) { f.year = [...new Set(years)]; years.forEach((y) => (t = t.replace(y, " "))); }
  const refs: string[] = [], serials: string[] = [], anyIds: string[] = [];
  for (const w of t.split(/[\s,]+/)) {
    const a = alnum(w);
    if (a.length < 3 || !/\d/.test(a) || /^\d{1,2}(mm)?$/.test(a)) continue;
    if (rows.some((r) => alnum(r.reference).startsWith(a))) refs.push(a);
    else if (rows.some((r) => alnum(r.serial) === a)) serials.push(a);
    else if (rows.some((r) => Object.values(r.extra).some((v) => alnum(v) === a))) anyIds.push(a); // PO #, order #
    else if (a.length >= 4) refs.push(a);
  }
  if (refs.length) f.reference = [...new Set(refs)];
  if (serials.length) f.serial = [...new Set(serials)];
  if (anyIds.length) f.any = [...new Set(anyIds)];

  // a plain word that is a watch's tag ("vookum")
  const rowTags = new Set(rows.map((r) => (r.tag ?? "").toLowerCase()).filter(Boolean));
  for (const w of t.split(/[^a-z0-9_]+/)) if (w.length >= 3 && rowTags.has(w) && !used.has(w)) { f.tag = [...new Set([...(f.tag ?? []), w])]; used.add(w); }

  // words that matched nothing (likely a brand/model not in inventory, or a typo)
  const missing = t.split(/[^a-z]+/).filter((w) => w.length >= 4 && !STOP.has(w) && !used.has(w));
  const onlyTags = !!f.tag?.length && Object.keys(f).every((k) => k === "tag");
  return { action: onlyTags && !newTag ? "clear" : base.action, tag: newTag, mode: base.mode, filters: f, missing: [...new Set(missing)] };
}

// ---------- match ----------
const anyContains = (v: unknown, list?: string[]) => !list?.length || list.some((x) => norm(v).includes(x));
const anyWord = (v: unknown, list?: string[]) => !list?.length || list.some((x) => norm(v) === x || norm(v).split(/[\s-]+/).includes(x) || norm(v).includes(x));

export function filterWatches(rows: WatchRow[], f: WatchFilters) {
  return rows.filter((r) =>
    anyWord(r.brand, f.brand) && anyWord(r.model, f.model) && anyContains(r.dial, f.dial_color) &&
    anyContains(r.condition, f.condition) && anyContains(r.material, f.material) &&
    (!f.year?.length || f.year.includes(String(r.year ?? "").slice(0, 4))) &&
    (!f.reference?.length || f.reference.some((x) => alnum(r.reference).startsWith(x))) &&
    (!f.serial?.length || f.serial.includes(alnum(r.serial))) &&
    (!f.any?.length || f.any.some((x) => Object.values(r.extra).some((v) => alnum(v) === x))) &&
    (f.min_estimated_value == null || (r.ev ?? 0) >= f.min_estimated_value) &&
    (f.max_estimated_value == null || (r.ev ?? 0) <= f.max_estimated_value) &&
    (!f.tag?.length || (!!r.tag && f.tag.includes(r.tag.toLowerCase())))
  );
}

const hasFilter = (f: WatchFilters) =>
  Object.entries(f).some(([, v]) => (Array.isArray(v) ? v.length > 0 : v != null));

export async function searchWatches(text: string) {
  text = markPlainTag(text);
  const t0 = Date.now();
  const pulled = await queryWatches(text);
  const all = pulled.rows;
  const p = readWatchRequest(text, all);
  const unknownOnly = !hasFilter(p.filters) && p.missing.length > 0; // e.g. "cartier tank" with no Cartier in inventory
  const rows = unknownOnly ? [] : filterWatches(all, p.filters);
  return {
    parsed: { action: p.action, tag: p.tag, mode: p.mode, filters: p.filters, post_filters: {} },
    has_filter: hasFilter(p.filters) || unknownOnly,
    queries: [] as unknown[],
    ms: Date.now() - t0,
    rows,
    missing: [...(rows.length ? [] : p.missing), ...(p.filters.tag ?? []).filter((t) => !rows.some((r) => (r.tag ?? "").toLowerCase() === t))],
    inventory: all.length,
    searches: pulled.searches,
    notice: [pulled.notice, rows.length && !hasItemIds(rows) ? `Question ${config.watchCardId()} has no item id in its results, so these watches can be searched but not tagged yet. Add the watch's item id (items.id) as a column in ${config.watchCardId()}.` : ""].filter(Boolean).join(" ") || undefined,
  };
}

/** Same shape the screen draws for cards, so tiles, selection and undo work unchanged. */
export const watchToTile = (r: WatchRow) => ({
  kind: "watch", item_id: r.item_id,
  player_name: [r.brand, r.model].filter(Boolean).join(" ") || "(watch)",
  set_name: r.reference ? `Ref ${r.reference}` : "", insert: [r.year, r.size, r.material].filter(Boolean).join(" · ") || null,
  parallel_name: r.dial ? `${r.dial} dial` : null, grade: r.condition ?? "", ev: r.ev ?? 0, tag: r.tag, img: r.img,
  card_url: r.url, status: r.status, bin: r.bin, slot: r.slot, ac: r.reference ?? "", cert: r.serial ?? "",
  brand: r.brand, model: r.model, reference: r.reference, dial: r.dial, serial: r.serial, year: r.year,
  condition: r.condition, material: r.material, size: r.size, bracelet: r.bracelet, extra: r.extra,
  title: r.title || r.model || "", movement: r.movement,
  bracelet_material: r.bracelet_material, bracelet_color: r.bracelet_color, gender: r.gender, box: r.box, papers: r.papers,
  watch_ac: r.ac, order_number: r.order, po_number: r.po, purchase_cost: r.cost,
  parallel_total: null, ev_age_days: null,
});

export const watchLabel = (r: WatchRow) => [r.brand, r.model, r.reference, r.dial && `${r.dial} dial`].filter(Boolean).join(" · ");
