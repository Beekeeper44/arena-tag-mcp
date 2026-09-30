// Fast, always-fresh search for the Tag Bot screen.
// Instead of pulling all of question 4131 to learn names, each part of the request is passed
// straight into 4131's own filters (like typing it into Metabase), so only matching cards come back.
import { queryCards, type CardFilters, type CardRow, type PostFilters } from "./metabase";
import { parseRequest, buildLexiconFromRows, extractIds, STOP, ALIAS as ALIAS_RAW, GENERIC_SETS, GENERIC_PARALLELS } from "./parse";
const ALIAS = ALIAS_RAW as Record<string, string>;

// categories people type in plain words -> 4131 SPORT value
const SPORTS: [string, string][] = [
  ["one piece", "one_piece"], ["one_piece", "one_piece"], ["pokemon", "pokemon"], ["pokémon", "pokemon"],
  ["basketball", "basketball"], ["baseball", "baseball"], ["football", "football"], ["hockey", "hockey"],
  ["soccer", "soccer"], ["magic", "magic"], ["yugioh", "yugioh"], ["yu-gi-oh", "yugioh"], ["lorcana", "lorcana"],
];
// words that never start or form a name on their own
const EXTRA_STOP = new Set(("this these those that here there some any one ones two three four five me us our ours your his her their " +
  "is it its be been being was were do does did get got go put make set sets list lists everything anything nothing " +
  "graded ungraded slabbed slabs slab card cards item items number numbers ac cert certs").split(" "));
// words that are set / brand / parallel vocabulary: keep them so "topps update" or "rainbow foil" can be matched
const CATALOG_WORDS = new Set(("topps panini prizm select optic donruss bowman chrome upper deck fleer update finest stadium club heritage " +
  "mosaic contenders immaculate flawless national treasures score leaf metal universe hoops sp spx fleer ultra " +
  "refractor refractors silver gold blue red green orange purple black pink wave ruby shimmer holo holos foil rainbow " +
  "reverse illustration rare edition first evolving skies crown zenith evolutions").split(" "));
const isStop = (w: string) =>
  !CATALOG_WORDS.has(w) && !CATALOG_WORDS.has(w.replace(/s$/, "")) && (STOP.has(w) || STOP.has(w.replace(/s$/, "")) || EXTRA_STOP.has(w));

const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Splits the leftover words into name phrases: "victor wembanyama, lebron and pikachu" -> 3 phrases. */
function namePhrases(text: string, used: string[]) {
  let t = " " + text.toLowerCase().replace(/[’']/g, "'") + " ";
  t = t.replace(/#[a-z0-9_-]+/g, " | ").replace(/\btag\s*[:=]\s*[a-z0-9_-]+/g, " | ").replace(/\b[a-z0-9]+(?:_[a-z0-9-]+)+\b/g, " | ");
  t = t.replace(/\$\s*[\d,.]+\s*k?\+?/g, " | ").replace(/\b\d+(?:\.\d+)?k?\b/g, " | ");
  for (const u of used.filter(Boolean).sort((a, b) => b.length - a.length)) t = t.replace(new RegExp("\\b" + esc(u) + "(?:s|es)?\\b", "g"), " | ");
  t = t.replace(GRADER_RE, " | ");
  t = t.replace(/[,;/&+()]|\b(and|or|plus|with|vs)\b/g, " | ");
  const phrases: string[] = [];
  let cur: string[] = [];
  const flush = () => { if (cur.length) { phrases.push(cur.join(" ")); cur = []; } };
  const toks = t.split(/\s+/);
  const bareOf = (x: string | undefined) => (x ?? "").replace(/[^a-z0-9.é'-]/g, "").replace(/'s$/, "");
  for (let ti = 0; ti < toks.length; ti++) {
    const w = toks[ti];
    if (!w || w === "|") { flush(); continue; }
    const bare = w.replace(/[^a-z0-9.é'-]/g, "").replace(/'s$/, "");
    if (!bare) { flush(); continue; }
    const nextBare = bareOf(toks[ti + 1]);
    const aliasLast = (ALIAS[bare] || "").toLowerCase().split(" ").pop();
    if (ALIAS[bare] && nextBare !== aliasLast && !cur.length) { flush(); phrases.push(ALIAS[bare]); continue; }
    if (isStop(bare) || bare.length < 2) { flush(); continue; }
    cur.push(bare);
  }
  flush();
  // one entry per name, ignoring case ("Cooper" -> Flagg and "flagg" are the same person)
  const seen = new Set<string>();
  return phrases.map((p) => p.trim()).filter((p) => {
    const k = p.toLowerCase();
    if (p.length < 3 || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}


export async function smartSearch(text: string) {
  const t0 = Date.now();
  const cn = extractCardNumbers(text);
  const ids = extractIds(cn.rest);
  const parsed = parseRequest(ids.rest, buildLexiconFromRows([]));
  const base: CardFilters = { ...(parsed.filters as CardFilters) };
  delete base.player_name;
  delete base.ac_number;
  delete base.cert_number;
  const post: PostFilters = parsed.post_filters;
  if (cn.numbers.length) base.set_number = cn.numbers.length === 1 ? cn.numbers[0] : cn.numbers;

  // grading companies and grades: any number of them ("psa beckett sgc 10s", "psa 10, bgs 9.5")
  delete base.grading_company;
  delete base.grade;
  const g = readGrading(ids.rest);
  const single = g.companies.length === 1 && g.pairs.length <= 1 && g.nums.length <= 1 && !(g.pairs.length && g.nums.length);
  if (single) {
    // one company (optionally one grade): let Metabase filter it (fastest)
    const c = g.companies[0];
    base.grading_company = c === "bgs" ? "b" : c; // "b" matches both bgs and beckett in 4131's contains filter
    const n = g.pairs[0]?.[1] ?? g.nums[0];
    if (n) post.grade_pairs = companyVariants(c).map((v) => [v, n] as [string, string]);
    else post.graders = companyVariants(c);
  } else if (g.companies.length || g.nums.length) {
    post.graders = g.companies.flatMap(companyVariants);
    post.grade_pairs = g.pairs.flatMap(([c, n]) => companyVariants(c).map((v) => [v, n] as [string, string]));
    post.grade_nums = g.nums;
  }

  // plain-word categories
  const low = " " + ids.rest.toLowerCase() + " ";
  let sportWord: string | null = null;
  for (const [word, sport] of SPORTS) if (new RegExp("\\b" + esc(word) + "\\b").test(low)) { base.sport = sport; sportWord = word; break; }

  // ---- card numbers: straight lookups ----
  if (ids.ac.length || ids.cert.length) {
    const queries: CardFilters[] = [];
    if (ids.ac.length) queries.push({ ac_number: ids.ac });
    if (ids.cert.length) queries.push({ cert_number: ids.cert });
    const rows = await union(queries, post);
    const missing = [...ids.ac.filter((n) => !rows.some((r) => r.ac_number === n)).map((n) => "AC " + n),
                     ...ids.cert.filter((n) => !rows.some((r) => r.cert_number === n)).map((n) => "cert " + n)];
    const display = { ...(ids.ac.length ? { ac_number: ids.ac.length === 1 ? ids.ac[0] : ids.ac } : {}), ...(ids.cert.length ? { cert_number: ids.cert.length === 1 ? ids.cert[0] : ids.cert } : {}) };
    return done(t0, parsed, display, post, queries, rows, missing);
  }

  // ---- names: each phrase goes into 4131's player filter; if nothing, try it as a set, then a parallel ----
  const setWords = typeof base.set_name === "string" ? base.set_name.toLowerCase().split("%") : [];
  const parWords = typeof base.parallel_name === "string" ? [base.parallel_name.toLowerCase()] : [];
  const used = [...setWords, ...parWords, ...(sportWord ? [sportWord] : []), ...GENERIC_SETS.filter((g) => setWords.includes(g)), ...GENERIC_PARALLELS.filter((g) => parWords.includes(g))];
  const phrases = namePhrases(ids.rest, used);

  if (!phrases.length) {
    const hasFilter = Object.keys(base).length > 0 || !!post.only_base;
    if (!hasFilter) return done(t0, parsed, {}, post, [], [], [], false);
    const rows = await union([base], post);
    return done(t0, parsed, base, post, [base], rows, []);
  }

  const probe = makeProber(base, post);
  const segs = (await Promise.all(phrases.map((ph) => segment(ph.split(" "), probe, base)))).flat();
  // a full name ("shohei ohtani") means that player's own cards, not shared ones ("Shohei Ohtani/Ichiro Suzuki");
  // type just the last name ("ohtani") to include cards he shares with other players
  for (const g of segs) {
    if (g.type !== "player" || !g.text.includes(" ")) continue;
    const exact = g.rows.filter((r) => normName(r.player_name) === normName(g.text));
    if (exact.length) { g.rows = exact; g.exact = true; }
  }
  const found = segs.filter((g) => g.type !== "none");
  const unknown = segs.filter((g) => g.type === "none").map((g) => g.text);

  // players OR'd together, sets OR'd, parallels OR'd; AND across the three
  const byType = (t: SegType) => found.filter((g) => g.type === t);
  let acc: CardRow[] | null = null;
  for (const t of ["player", "set", "parallel"] as SegType[]) {
    const group = byType(t);
    if (!group.length) continue;
    const u = dedupe(group.flatMap((g) => g.rows));
    acc = acc === null ? u : intersect(acc, u);
  }
  let rows: CardRow[] = acc ?? [];
  // nothing matched as a player/set/parallel, but other filters were given (e.g. "rated rookie psa 10"):
  // pull those cards and match the words against insert, set, parallel, player
  if (!found.length && unknown.length && (Object.keys(base).length || post.only_base)) rows = await union([base], post);

  // words that aren't a player, set or parallel: match them against the cards already found (insert, set, parallel, player…)
  const missing: string[] = [], contains: string[] = [];
  for (const w of unknown) {
    const hits: CardRow[] = rows.filter((r) => [r.insert, r.set_name, r.parallel_name, r.player_name, r.grade, r.tag, r.sport].some((v) => v && v.toLowerCase().includes(w.toLowerCase())));
    if (hits.length) { rows = hits; contains.push(w); }
    else missing.push(w);
  }
  if (!found.length && !contains.length) rows = [];

  const display: CardFilters = { ...base };
  const lab = (t: SegType) => byType(t).map((g) => g.text);
  if (lab("player").length) display.player_name = lab("player").length === 1 ? lab("player")[0] : lab("player");
  if (lab("set").length) display.set_name = lab("set").length === 1 ? lab("set")[0] : lab("set");
  if (lab("parallel").length) display.parallel_name = lab("parallel").length === 1 ? lab("parallel")[0] : lab("parallel");
  if (contains.length) (display as Record<string, unknown>).contains = contains.join(" ");
  if (g.companies.length) display.grading_company = (g.companies.length === 1 ? g.companies[0] : g.companies) as unknown as string;
  const gradeLabels = [...g.pairs.map(([c, n]) => `${c} ${n}`), ...g.nums.map((n) => (g.companies.length ? n : `any ${n}`))];
  if (gradeLabels.length) display.grade = gradeLabels.length === 1 ? gradeLabels[0] : gradeLabels;
  else delete display.grade;

  if (yearOnly(base) && byType("set").length) display.set_name = byType("set").map((g) => g.field.replace("%", " ")).join(" / ");
  if (base.set_number) (display as Record<string, unknown>).set_number = base.set_number;

  // the exact searches to re-run before writing
  const P = byType("player").length ? byType("player").map((g) => g.field) : [null];
  const S = byType("set").length ? byType("set").map((g) => g.field) : [null];
  const R = byType("parallel").length ? byType("parallel").map((g) => g.field) : [null];
  const queries: CardFilters[] = [];
  for (const a of P) for (const b of S) for (const c of R) queries.push({ ...base, ...(a ? { player_name: a } : {}), ...(b ? { set_name: b } : {}), ...(c ? { parallel_name: c } : {}) });
  return done(t0, parsed, display, post, queries.slice(0, 60), rows, missing);
}

// ---- card numbers on the card: "#US189", "us189", "card #189", "no. 12", "LITM-1" ----
function extractCardNumbers(text: string) {
  const numbers: string[] = [];
  let t = " " + text + " ";
  const keep = (n: string) => { const v = n.replace(/^#/, "").toUpperCase(); if (!numbers.includes(v)) numbers.push(v); return " "; };
  // labeled: "card #189", "card number 189", "no. 189", "number US189"
  t = t.replace(/\b(?:card\s*(?:#|no\.?|number)|no\.|number)\s*#?\s*([a-z]{0,6}-?\d{1,4}[a-z]{0,2})\b/gi, (_m, n) => keep(n));
  // "#US189" / "#189" (a # followed by letters+digits with no underscore is a card number, not a tag)
  t = t.replace(/(^|\s)#([a-z]{0,6}-?\d{1,4}[a-z]{0,2})(?=\s|$|[,.])/gi, (_m, pre, n) => pre + keep(n));
  // bare letters+digits: "us189", "litm-1", "tc12" (not graders like "psa10", not tags, not money)
  t = t.replace(/(^|[\s,(])([a-z]{1,6}-?\d{1,4}[a-z]{0,2})(?=[\s,.)]|$)/gi, (m, pre, n) =>
    /^(psa|bgs|sgc|cgc|csg|hga|isa|beckett)-?\d/i.test(n) ? m : pre + keep(n));
  return { numbers, rest: t.trim() };
}

// ---- grading ----
const GRADERS: [RegExp, string][] = [
  [/\bpsa\b/, "psa"], [/\bbgs\b/, "bgs"], [/\bbeckett\b/, "beckett"], [/\bsgc\b/, "sgc"], [/\bcgc\b/, "cgc"],
  [/\bcsg\b/, "csg"], [/\bhga\b/, "hga"], [/\bisa\b/, "isa"], [/\barena[ _]club\b/, "arena_club"],
];
const GRADER_RE = /\b(psa|bgs|beckett|sgc|cgc|csg|hga|isa|arena[ _]club)\b/g;
// BGS cards are stored as "beckett" in 4131; accept either spelling
const companyVariants = (c: string) => (c === "bgs" || c === "beckett" ? ["beckett", "bgs"] : [c]);

function readGrading(text: string) {
  const t = " " + text.toLowerCase().replace(/[$][\s\d,.]+k?/g, " ") + " ";
  const companies: string[] = [];
  for (const [re, c] of GRADERS) if (re.test(t) && !companies.includes(c)) companies.push(c);
  // company immediately followed by a grade: "psa 10", "beckett 9.5", "sgc 10s"
  const pairs: [string, string][] = [];
  const pairRe = /\b(psa|bgs|beckett|sgc|cgc|csg|hga|isa|arena[ _]club)\s*(10|[1-9](?:\.5)?)s?\b/g;
  let m: RegExpExecArray | null;
  const paired = new Set<string>();
  while ((m = pairRe.exec(t))) { const c = m[1].replace(" ", "_"); pairs.push([c, m[2]]); paired.add(m.index + ":" + m[0].length); }
  // grades on their own: "10s", "grade 10", "9.5s", or a grade after a list of companies ("psa and sgc 10")
  const nums: string[] = [];
  const stripped = t.replace(pairRe, " ");
  for (const n of stripped.match(/\b(?:grade\s*)?(10|[1-9]\.5|[1-9])s?\b(?!\s*(?:k|\d))/g) ?? []) {
    const v = n.replace(/grade\s*/, "").replace(/s$/, "");
    // ignore small numbers that are clearly counts ("top 5", "2 cards")
    if (!/grade|s$/.test(n) && !companies.length) continue;
    if (!nums.includes(v)) nums.push(v);
  }
  // "psa 10 and sgc" -> psa 10 + any sgc; "psa sgc 10" -> the 10 belongs to both
  if (pairs.length && !nums.length) {
    const lastPair = pairs[pairs.length - 1];
    const loose = companies.filter((c) => !pairs.some(([pc]) => pc === c));
    // a lone grade right after the last company applies to the companies listed just before it
    if (loose.length && pairs.length === 1 && t.indexOf(lastPair[0].replace("_", " ")) > Math.max(...loose.map((c) => t.indexOf(c.replace("_", " "))))) {
      for (const c of loose) pairs.push([c, lastPair[1]]);
    }
  }
  return { companies, pairs, nums };
}

type SegType = "player" | "set" | "parallel" | "none";
type Seg = { type: SegType; text: string; field: string; rows: CardRow[]; exact?: boolean };
const normName = (v: unknown) => String(v ?? "").toLowerCase().replace(/[.,']/g, "").replace(/\b(jr|sr|ii|iii|iv)\b/g, "").replace(/\s+/g, " ").trim();
type Prober = (type: Exclude<SegType, "none">, text: string) => Promise<CardRow[]>;

const yearOnly = (b: CardFilters) => typeof b.set_name === "string" && /^(19|20)\d\d$/.test(b.set_name);
// value actually sent for a phrase: sets get the year in front when the request only gave a year
export const fieldFor = (base: CardFilters, type: string, text: string) => (type === "set" && yearOnly(base) ? `${base.set_name}%${text}` : text);

function makeProber(base: CardFilters, post: PostFilters): Prober {
  const cache = new Map<string, Promise<CardRow[]>>();
  return (type, text) => {
    const key = type + "|" + text;
    if (!cache.has(key)) {
      const field = type === "player" ? "player_name" : type === "set" ? "set_name" : "parallel_name";
      // don't override a set/parallel the request already named (a bare year is fine: it joins the set)
      if ((type === "set" && base.set_name && !yearOnly(base)) || (type === "parallel" && base.parallel_name)) cache.set(key, Promise.resolve([]));
      else cache.set(key, queryCards({ ...base, [field]: fieldFor(base, type, text) }, post));
    }
    return cache.get(key)!;
  };
}

/** What is this run of words? Tries it as a player, set, then parallel. If none, splits it
 *  ("victor wembanyama haunted hoops" -> player + set) and, for a single leftover word, tries a close spelling. */
async function segment(words: string[], probe: Prober, base: CardFilters = {}): Promise<Seg[]> {
  const text = words.join(" ");
  const types = ["player", "set", "parallel"] as const;
  const whole = await Promise.all(types.map((t) => probe(t, text)));
  const hit = whole.findIndex((r) => r.length > 0);
  if (hit >= 0) return [{ type: types[hit], text, field: fieldFor(base, types[hit], text), rows: whole[hit] }];

  if (words.length > 1 && words.length <= 8) {
    for (let k = words.length - 1; k >= 1; k--) {
      const left = words.slice(0, k).join(" ");
      const lr = await Promise.all(types.map((t) => probe(t, left)));
      const li = lr.findIndex((r) => r.length > 0);
      if (li >= 0) return [{ type: types[li], text: left, field: fieldFor(base, types[li], left), rows: lr[li] }, ...(await segment(words.slice(k), probe, base))];
    }
    return [{ type: "none", text: words[0], field: words[0], rows: [] }, ...(await segment(words.slice(1), probe, base))];
  }

  const w = words[0];
  if (w.length >= 6) {
    for (const cut of [5, 4]) {
      const stem = w.slice(0, cut);
      const r = await probe("player", stem);
      if (r.length) return [{ type: "player", text: w, field: stem, rows: r }];
    }
  }
  return [{ type: "none", text: w, field: w, rows: [] }];
}

function intersect(a: CardRow[], b: CardRow[]) {
  const ids = new Set(b.map((r) => r.item_id));
  return a.filter((r) => ids.has(r.item_id));
}

async function union(queries: CardFilters[], post: PostFilters) {
  const all = await Promise.all(queries.map((q) => queryCards(q, post)));
  return dedupe(all.flat());
}
function dedupe(rows: CardRow[]) {
  const m = new Map<string, CardRow>();
  for (const r of rows) m.set(r.item_id, r);
  return [...m.values()];
}
function done(t0: number, parsed: ReturnType<typeof parseRequest>, display: CardFilters, post: PostFilters, queries: CardFilters[], rows: CardRow[], missing: string[], hasFilter = true) {
  return {
    parsed: { ...parsed, filters: display, post_filters: post },
    queries,
    rows,
    missing,
    has_filter: hasFilter,
    ms: Date.now() - t0,
  };
}

/** Re-runs a saved plan (used right before writing, so Confirm re-checks against fresh 4131 data). */
export const rerun = (queries: CardFilters[], post: PostFilters) => union(queries, post);
