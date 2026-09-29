// Reads cards from Metabase question 4131 ("Warehouse Cards") using its own
// {{template-tag}} filters. The server never edits the question.
import { config } from "./config";

export type CardFilters = {
  sport?: string;
  set_name?: string | string[];
  player_name?: string | string[]; // one or more players / Pokémon; a card matches if it matches ANY
  parallel_name?: string | string[];
  grading_company?: string;
  grade?: string | string[];
  min_estimated_value?: number;
  max_estimated_value?: number;
  tag?: string; // contains-match on current tag (question's own filter)
  cert_number?: string;
  ac_number?: string;
  min_ev_age_days?: number;
  max_ev_age_days?: number;
  min_times_sold_back?: number;
};

export type PostFilters = {
  only_untagged?: boolean; // keep cards with no current tag
  current_tag_exact?: string; // keep cards whose current tag is exactly this
};

export type CardRow = {
  item_id: string;
  cert_number: string | null;
  ac_number: string | null;
  sport: string | null;
  set_name: string | null;
  insert: string | null;
  player_name: string | null;
  parallel_name: string | null;
  grading_company: string | null;
  grade: string | null;
  estimated_value: number | null;
  tag: string | null;
  item_status: string | null;
  front_slab_picture_url: string | null;
  card_url: string | null;
};

type TemplateTag = { name: string; type: string };
let tagCache: { at: number; tags: Record<string, TemplateTag> } | null = null;

async function mb(path: string, init: RequestInit = {}) {
  const res = await fetch(`${config.metabaseHost()}${path}`, {
    ...init,
    headers: { "x-api-key": config.metabaseApiKey(), ...(init.headers || {}) },
  });
  return res;
}

async function getTemplateTags(): Promise<Record<string, TemplateTag>> {
  if (tagCache && Date.now() - tagCache.at < 10 * 60 * 1000) return tagCache.tags;
  const res = await mb(`/api/card/${config.metabaseCardId()}`);
  if (!res.ok) throw new Error(`Metabase card fetch failed: ${res.status} ${await res.text()}`);
  const card = await res.json();
  const tags = (card?.dataset_query?.native?.["template-tags"] ?? {}) as Record<string, TemplateTag>;
  tagCache = { at: Date.now(), tags };
  return tags;
}

function buildParameters(filters: CardFilters, tags: Record<string, TemplateTag>) {
  const params: unknown[] = [];
  const unsupported: string[] = [];
  for (const [key, raw] of Object.entries(filters)) {
    if (raw === undefined || raw === null || raw === "") continue;
    const tt = tags[key];
    if (!tt) {
      unsupported.push(key);
      continue;
    }
    const isNumber = tt.type === "number";
    params.push({
      type: isNumber ? "number/=" : "category",
      target: ["variable", ["template-tag", key]],
      value: isNumber ? [Number(raw)] : [String(raw)],
    });
  }
  if (unsupported.length) {
    throw new Error(`Question ${config.metabaseCardId()} has no filter for: ${unsupported.join(", ")}`);
  }
  return params;
}

function normKey(k: string) {
  return k.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
}

function toRow(obj: Record<string, unknown>): CardRow {
  const o: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) o[normKey(k)] = v;
  const s = (v: unknown) => (v === null || v === undefined || v === "" ? null : String(v));
  const n = (v: unknown) => (v === null || v === undefined || v === "" ? null : Number(v));
  return {
    item_id: String(o.ITEM_ID ?? ""),
    cert_number: s(o.CERT_NUMBER),
    ac_number: s(o["8AC_NUMBER"]),
    sport: s(o.SPORT),
    set_name: s(o.SET_NAME),
    insert: s(o.INSERT),
    player_name: s(o.PLAYER_NAME),
    parallel_name: s(o.PARALLEL_NAME),
    grading_company: s(o.GRADING_COMPANY),
    grade: s(o.GRADE),
    estimated_value: n(o.ESTIMATED_VALUE),
    tag: s(o.TAG),
    item_status: s(o.ITEM_STATUS),
    front_slab_picture_url: s(o.FRONT_SLAB_PICTURE_URL),
    card_url: s(o.CARD_URL),
  };
}

// Question 4131 takes one value per filter. For lists (e.g. several players) the server
// runs one query per combination and merges the results by ITEM_ID.
const LIST_KEYS = ["player_name", "set_name", "parallel_name", "grade"] as const;
const MAX_QUERIES = 50; // e.g. 25 names × 2 sets

type SingleFilters = { [K in keyof CardFilters]: CardFilters[K] extends string | string[] | undefined ? string : CardFilters[K] };

function expand(filters: CardFilters): SingleFilters[] {
  let combos: Record<string, unknown>[] = [{ ...filters }];
  for (const key of LIST_KEYS) {
    const v = filters[key];
    if (!Array.isArray(v)) continue;
    const values = [...new Set(v.map((x) => x.trim()).filter(Boolean))];
    if (!values.length) {
      combos = combos.map((c) => { const n = { ...c }; delete n[key]; return n; });
      continue;
    }
    combos = combos.flatMap((c) => values.map((val) => ({ ...c, [key]: val })));
  }
  if (combos.length > MAX_QUERIES) {
    throw new Error(`That request needs ${combos.length} separate searches; the limit is ${MAX_QUERIES}. Use fewer names or sets per run.`);
  }
  return combos as SingleFilters[];
}

export type QueryResult = { rows: CardRow[]; missing: { key: string; value: string }[] };

export async function queryCardsDetailed(filters: CardFilters, post: PostFilters = {}): Promise<QueryResult> {
  const combos = expand(filters);
  const results = await Promise.all(combos.map((c) => queryOnce(c as CardFilters, post)));
  const byId = new Map<string, CardRow>();
  for (const rows of results) for (const r of rows) byId.set(r.item_id, r);

  // Which listed values found nothing at all (e.g. a misspelled or absent player)?
  const missing: { key: string; value: string }[] = [];
  for (const key of LIST_KEYS) {
    const v = filters[key];
    if (!Array.isArray(v)) continue;
    for (const val of new Set(v)) {
      const hit = combos.some((c, i) => (c as Record<string, unknown>)[key] === val && results[i].length > 0);
      if (!hit) missing.push({ key, value: val });
    }
  }
  return { rows: [...byId.values()], missing };
}

export async function queryCards(filters: CardFilters, post: PostFilters = {}): Promise<CardRow[]> {
  return (await queryCardsDetailed(filters, post)).rows;
}

// One call to question 4131. Uses the JSON export endpoint so results are not capped at 2,000 rows.
async function queryOnce(filters: CardFilters, post: PostFilters = {}): Promise<CardRow[]> {
  const tags = await getTemplateTags();
  const parameters = buildParameters(filters, tags);
  const path = `/api/card/${config.metabaseCardId()}/query/json`;

  // Newer Metabase takes a JSON body; older versions take form fields. Try JSON, then form.
  let res = await mb(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ parameters, format_rows: false }),
  });
  if (!res.ok && res.status >= 400 && res.status < 500) {
    const form = new URLSearchParams({ parameters: JSON.stringify(parameters), format_rows: "false" });
    res = await mb(path, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });
  }
  if (!res.ok) throw new Error(`Metabase query failed: ${res.status} ${(await res.text()).slice(0, 500)}`);

  const data = await res.json();
  if (!Array.isArray(data)) {
    throw new Error(`Unexpected Metabase response: ${JSON.stringify(data).slice(0, 500)}`);
  }
  let rows = data.map(toRow).filter((r) => r.item_id);

  if (post.only_untagged) rows = rows.filter((r) => !r.tag);
  if (post.current_tag_exact) rows = rows.filter((r) => r.tag === post.current_tag_exact);
  return rows;
}

export function summarize(rows: CardRow[], newTag?: string | null) {
  const count = (key: (r: CardRow) => string | null) => {
    const m = new Map<string, number>();
    for (const r of rows) {
      const k = key(r) ?? "(blank)";
      m.set(k, (m.get(k) ?? 0) + 1);
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([value, n]) => ({ value, count: n }));
  };
  const totalEv = rows.reduce((s, r) => s + (r.estimated_value ?? 0), 0);
  const alreadyThisTag = newTag ? rows.filter((r) => r.tag === newTag).length : 0;
  const overwrites = rows.filter((r) => r.tag && r.tag !== newTag).length;
  return {
    matched: rows.length,
    total_estimated_value: Math.round(totalEv * 100) / 100,
    already_has_this_tag: alreadyThisTag,
    would_overwrite_other_tag: overwrites,
    untagged: rows.filter((r) => !r.tag).length,
    by_set: count((r) => r.set_name),
    by_player: count((r) => r.player_name),
    by_parallel: count((r) => r.parallel_name),
    by_grade: count((r) => r.grade),
    by_current_tag: count((r) => r.tag),
    sample: rows.slice(0, 10).map((r) => ({
      item_id: r.item_id,
      ac_number: r.ac_number,
      cert: r.cert_number,
      card: [r.set_name, r.player_name, r.parallel_name].filter(Boolean).join(" · "),
      grade: r.grade,
      ev: r.estimated_value,
      current_tag: r.tag,
      image: r.front_slab_picture_url,
    })),
  };
}
