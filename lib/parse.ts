// @ts-nocheck
// Reads a typed request ("tag jordan, lebron psa 10 over $1,000 as sd_goat") into filters.
// Same logic as the screen, run on the server against a fresh pull of question 4131.
import type { CardRow } from "./metabase";

const GENERIC_SETS=["prizm","topps chrome","chrome","bowman chrome","bowman","select","optic","donruss","mosaic","national treasures","flawless","immaculate","contenders","finest","stadium club","upper deck","base set","151","evolving skies","crown zenith","evolutions","fusion strike","paldea evolved","obsidian flames","scarlet & violet","scarlet and violet","sword & shield","jungle","fossil","team rocket","neo genesis"];
const GENERIC_PARALLELS=["ruby wave","gold wave","blue shimmer","refractor","silver","gold","illustration rare","special illustration rare","reverse holo","1st edition","holo","shadowless","full art","alt art","auto","autograph","patch","numbered"];
const STOP=new Set(("tag tags tagging tagged all the cards card and or with as between over under above below every from remove clear currently skip that already have "+
 "only untagged dont don't overwrite existing more than less least most graded grade grades in on set sets any my please dollars dollar each these those them it its of to for "+
 "a an is are be into onto new pack packs slab slabs raw give put add apply make want need would like just also plus minus value values estimated worth price priced range "+
 "rookie rookies rc parallel parallels numbered base first edition holo holos rare rares reverse illustration wave ruby gold blue shimmer silver refractor refractors "+
 "psa bgs sgc cgc chrome topps panini prizm select optic donruss bowman evolving skies crown zenith evolutions pokemon basketball baseball football hockey soccer sport sports "+
 "player players character characters cheap expensive high low end top best whole entire inventory warehouse no not without delete untag take off card's cards' "+
 "arena club only just please thanks").split(" "));
const SUFFIX=new Set(["jr","jr.","sr","sr.","ii","iii","iv","ex","gx","v","vmax","vstar","lv.x","star","δ"]);
const ALIAS={wemby:"Wembanyama",caitlin:"Clark",shohei:"Ohtani",cj:"Stroud","c.j.":"Stroud",cooper:"Flagg",zard:"Charizard",pika:"Pikachu",mj:"Michael Jordan",lebron:"LeBron James",kobe:"Kobe Bryant"};
let LEX=null;
const words=s=>String(s||"").toLowerCase().split(/[^a-z0-9.&é]+/).filter(Boolean);
function buildLexicon(cards){
  const full=new Map(), last=new Map(), lastParts=new Map(), nameParts=new Set(), vocab=new Set();
  const sets=new Set(GENERIC_SETS), pars=new Set(GENERIC_PARALLELS), sports=new Set(["pokemon"]);
  for(const c of cards){
    if(c.player_name){
      const nm=c.player_name.trim(), lw=nm.toLowerCase();
      const parts=words(nm).filter(w=>!SUFFIX.has(w));
      parts.forEach(w=>nameParts.add(w));
      const key=parts.length?parts[parts.length-1]:lw;
      const disp=nm.split(/\s+/).filter(w=>!SUFFIX.has(w.toLowerCase()));
      const filterVal=(disp[disp.length-1]||nm).replace(/[.,]$/,"");
      full.set(lw,nm.replace(/\s+(jr\.?|sr\.?|ii|iii|iv)$/i,""));
      if(key.length>=3){ if(!last.has(key)) last.set(key,filterVal); if(!lastParts.has(key)) lastParts.set(key,new Set()); parts.forEach(w=>lastParts.get(key).add(w)); }
    }
    if(c.set_name){ const noYear=c.set_name.toLowerCase().replace(/^\s*\d{4}(-\d{2})?\s+/,"").trim(); if(noYear.length>=4) sets.add(noYear); words(c.set_name).forEach(w=>vocab.add(w)); }
    if(c.parallel_name){ pars.add(c.parallel_name.toLowerCase().trim()); words(c.parallel_name).forEach(w=>vocab.add(w)); }
    if(c.sport){ sports.add(c.sport.toLowerCase()); vocab.add(c.sport.toLowerCase()); }
  }
  const byLen=a=>[...a].sort((x,y)=>y.length-x.length);
  return {full,last,lastParts,nameParts,vocab,sets:byLen(sets),pars:byLen(pars),sports:[...sports]};
}
const hasPhrase=(t,p)=>new RegExp("(^|[^a-z0-9])"+p.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")+"(?:s|es)?($|[^a-z0-9])").test(t);

function readRequest(text){
  if(!LEX) LEX=buildLexicon([]);
  const t=text.toLowerCase().replace(/[’']/g,"'").replace(/pokémon/g,"pokemon"); const f={}; let action="set", tag=null, mode="overwrite";
  if(/\b(clear|remove|untag|take off|delete)\b/.test(t)) action="clear";
  const ct=t.match(/(?:currently tagged|already tagged|tagged with|tagged|with (?:the )?tag|that have(?: the tag)?|have tag)\s+#?([a-z0-9_]+)/);
  if(ct && /_/.test(ct[1])) f.tag=ct[1];
  if(action==="set"){
    const raw=text.replace(/[’']/g,"'");
    const norm=w=>w.toLowerCase().replace(/-/g,"_").replace(/[^a-z0-9_]/g,"");
    const hash=raw.match(/#([A-Za-z0-9_-]+)/g);
    const colon=raw.match(/\btag\s*[:=]\s*#?([A-Za-z0-9_-]+)/i);
    const as=raw.match(/\b(?:as|to|with tag|tag it|tag them)\s+#?([A-Za-z0-9]+[_-][A-Za-z0-9_-]+)/i);
    const snake=[...raw.matchAll(/\b([A-Za-z][A-Za-z0-9]*_[A-Za-z0-9_]+)\b/g)].map(m=>norm(m[1])).filter(w=>w!==f.tag);
    tag=hash?norm(hash[hash.length-1].slice(1)):colon?norm(colon[1]):as?norm(as[1]):(snake.length?snake[snake.length-1]:null);
    if(tag===f.tag) tag=null;
  }
  if(/skip|only untagged|don'?t overwrite|do not overwrite|no tag yet|without a tag|untagged/.test(t)) mode="skip_tagged";

  // strip tag words and prices before looking for names, sets and parallels
  const body=t.replace(/#[a-z0-9_-]+/g," ").replace(/\btag\s*[:=]\s*[a-z0-9_-]+/g," ").replace(/\b[a-z0-9]+(?:[_-][a-z0-9]+)+\b/g," ").replace(/\$\s*[\d,.]+k?/g," ");

  // set and parallel phrases (longest first) — consume their words so they aren't read as names
  let rest=" "+body+" ";
  for(const ph of LEX.sets){ if(hasPhrase(rest,ph)){ f.set_name=ph.replace(/\b\w/g,c=>c.toUpperCase()); rest=rest.replace(ph," "); break; } }
  const yr=body.match(/\b((?:19|20)\d\d)\b/); if(yr){ f.set_name=f.set_name?`${yr[1]}%${f.set_name}`:yr[1]; }
  for(const ph of LEX.pars){ if(hasPhrase(rest,ph)){ f.parallel_name=ph.replace(/\b\w/g,c=>c.toUpperCase()); rest=rest.replace(new RegExp(ph.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")+"(?:s|es)?","g")," "); break; } }
  if(/\bbase\b/.test(rest)&&!f.parallel_name&&!/base set/.test(body)) f.parallel_name="__base__";
  for(const sp of LEX.sports) if(hasPhrase(body,sp)) f.sport=sp;

  // names: full names, then last names, nicknames, close spellings; every other unknown word stays as a name
  const names=[], used=new Set();
  const add=(v,ws)=>{ if(!names.some(n=>n.toLowerCase()===v.toLowerCase())) names.push(v); ws.forEach(w=>used.add(w)); };
  for(const [lw,val] of LEX.full){ if(lw.length>=4&&hasPhrase(rest,lw)) add(val,words(lw)); }
  const toks=rest.split(/[^a-z.&]+/).filter(Boolean);
  for(const w of toks){
    if(used.has(w)) continue;
    const w1=w.replace(/'s$/,"");
    if(ALIAS[w1]) { const k=ALIAS[w1].toLowerCase().split(" ").pop(); add(ALIAS[w1],[w,...(LEX.lastParts.get(k)||[])]); continue; }
    if(LEX.last.has(w1)) { add(LEX.last.get(w1),[w,...LEX.lastParts.get(w1)]); continue; }
    if(w1.endsWith("s")&&LEX.last.has(w1.slice(0,-1))) { const k=w1.slice(0,-1); add(LEX.last.get(k),[w,...LEX.lastParts.get(k)]); continue; }
  }
  for(const w of toks){
    if(used.has(w)||STOP.has(w)||LEX.vocab.has(w)||w.length<5||LEX.nameParts.has(w)) continue;
    const cands=[...new Set([...LEX.last.entries()].filter(([k])=>k.length>=5&&k.slice(0,5)===w.slice(0,5)).map(([,v])=>v))];
    if(cands.length>=1&&cands.length<=2){ for(const [k,v] of LEX.last) if(cands.includes(v)) add(v,[w,...LEX.lastParts.get(k)]); }
  }
  // a first name on its own (e.g. "victor") only counts if no full/last name used it
  for(const w of toks){ if(!used.has(w)&&LEX.nameParts.has(w)&&!STOP.has(w)&&w.length>=4&&!LEX.vocab.has(w)) add(w.charAt(0).toUpperCase()+w.slice(1),[w]); }
  const unknown=toks.filter(w=>/^[a-z]{4,}$/.test(w)&&!used.has(w)&&!STOP.has(w)&&!STOP.has(w.replace(/s$/,""))&&!LEX.vocab.has(w)&&!LEX.nameParts.has(w));
  for(const w of unknown) add(w.charAt(0).toUpperCase()+w.slice(1),[w]);
  if(names.length) f.player_name=names.length===1?names[0]:names;

  const gm=body.match(/\b(psa|bgs|sgc|cgc)\s*(\d{1,2}(?:\.5)?)?s?\b/);
  if(gm){f.grading_company=gm[1]; if(gm[2]) f.grade=`${gm[1]} ${gm[2]}`}
  const money='\\$?\\s*([\\d,]+(?:\\.\\d+)?)\\s*(k)?';
  const val=(n,k)=>Number(String(n).replace(/,/g,""))*(k?1000:1);
  const bw=t.match(new RegExp('between\\s*'+money+'\\s*(?:and|to|-|–)\\s*'+money))||t.match(new RegExp('\\$\\s*([\\d,]+)\\s*(k)?\\s*(?:-|–|to)\\s*\\$?\\s*([\\d,]+)\\s*(k)?'));
  if(bw){f.min_estimated_value=val(bw[1],bw[2]);f.max_estimated_value=val(bw[3],bw[4])}
  else{
    const ov=t.match(new RegExp('(?:over|above|more than|at least|min(?:imum)?|>=?)\\s*'+money)); if(ov) f.min_estimated_value=val(ov[1],ov[2]);
    const un=t.match(new RegExp('(?:under|below|less than|at most|max(?:imum)?|<=?)\\s*'+money)); if(un) f.max_estimated_value=val(un[1],un[2]);
    const plus=t.match(/\$\s*([\d,]+)\s*\+/); if(plus&&f.min_estimated_value==null) f.min_estimated_value=val(plus[1]);
  }
  return {action,tag,mode,filters:f};
}


export function buildLexiconFromRows(rows: CardRow[]) {
  return buildLexicon(rows.map((r) => ({ player_name: r.player_name, set_name: r.set_name, parallel_name: r.parallel_name, sport: r.sport })));
}

export function parseRequest(text: string, lex) {
  LEX = lex; // readRequest is synchronous, so this is safe per call
  const p = readRequest(text);
  const filters = Object.fromEntries(Object.entries(p.filters).filter(([, v]) => v != null && v !== ""));
  const post: Record<string, boolean> = {};
  if (filters.parallel_name === "__base__") { delete filters.parallel_name; post.only_base = true; }
  return { action: p.action, tag: p.tag, mode: p.mode, filters, post_filters: post };
}

// Same matching as question 4131's filters (ILIKE '%value%'; % inside a value is a wildcard).
export function like(v, q) {
  if (v == null) return false;
  const parts = String(q).toLowerCase().split("%");
  const s = String(v).toLowerCase();
  let i = 0;
  for (const p of parts) { const j = s.indexOf(p, i); if (j < 0) return false; i = j + p.length; }
  return true;
}

export function filterRows(rows: CardRow[], f, post = {}) {
  const any = (v, q) => [].concat(q).some((x) => like(v, x));
  let out = rows.filter((c) =>
    (!f.sport || like(c.sport, f.sport)) &&
    (!f.set_name || any(c.set_name, f.set_name)) &&
    (!f.player_name || any(c.player_name, f.player_name)) &&
    (!f.parallel_name || any(c.parallel_name, f.parallel_name)) &&
    (!f.grading_company || like(c.grading_company, f.grading_company)) &&
    (!f.grade || any(c.grade, f.grade)) &&
    (f.min_estimated_value == null || (c.estimated_value ?? 0) >= f.min_estimated_value) &&
    (f.max_estimated_value == null || (c.estimated_value ?? 0) <= f.max_estimated_value) &&
    (!f.tag || like(c.tag, f.tag))
  );
  if (post.only_untagged) out = out.filter((r) => !r.tag);
  if (post.only_base) out = out.filter((r) => !r.parallel_name);
  return out;
}
