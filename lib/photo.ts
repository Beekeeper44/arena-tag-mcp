// Card photo check: is the whole card in the photo, with a little space around it?
// A good scan (like a Lorcana back) has a thin even margin of background on all four sides, so the card's own edges and
// rounded corners show. A bad one has the card running into the edge of the photo (cut off) or sitting off to one side.
// The photo is read on the server: the browser can't read pixels from Google Storage images (no CORS).
import jpeg from "jpeg-js";

export type PhotoCheck = {
  url: string; w: number; h: number; ok: boolean;
  level: "ok" | "close" | "cut"; // close = whole card in, but very little / uneven space (light flag); cut = card cut off or badly off-centre (red)
  margins: { top: number; bottom: number; left: number; right: number }; // share of the photo's height / width
  issues: string[]; error?: string;
};
const ALLOWED = /^https:\/\/(storage\.googleapis\.com|assets\.arenaclub\.com)\//i;
const cache = new Map<string, PhotoCheck>();
const TOUCH = 0.004; // under 0.4% of space on a side = the card runs into the edge
const UNEVEN = 0.05; // sides more than 5% apart = off-centre
const LOOSE = 0.025; // more than 2.5% background on a side = crop not tight (fail)
const ROOMY = 0.015; // 1.5–2.5% = check

export async function checkPhoto(url: string): Promise<PhotoCheck> {
  const hit = cache.get(url); if (hit) return hit;
  const out: PhotoCheck = { url, w: 0, h: 0, ok: true, level: "ok", margins: { top: 0, bottom: 0, left: 0, right: 0 }, issues: [] };
  try {
    if (!ALLOWED.test(url)) throw new Error("not an Arena photo address");
    const r = await fetch(url); if (!r.ok) throw new Error(`photo ${r.status}`);
    Object.assign(out, analyzeJpeg(Buffer.from(await r.arrayBuffer())), { url });
  } catch (e) { out.error = e instanceof Error ? e.message : String(e); out.ok = true; }
  cache.set(url, out); if (cache.size > 3000) cache.delete(cache.keys().next().value as string);
  return out;
}
export function analyzeJpeg(buf: Buffer): PhotoCheck {
  const out: PhotoCheck = { url: "", w: 0, h: 0, ok: true, level: "ok", margins: { top: 0, bottom: 0, left: 0, right: 0 }, issues: [] };
  {
    const img = jpeg.decode(buf, { useTArray: true, maxMemoryUsageInMB: 512, formatAsRGBA: true });
    const { width: w, height: h, data } = img; out.w = w; out.h = h;
    const px = (x: number, y: number) => { const i = (y * w + x) * 4; return [data[i], data[i + 1], data[i + 2]]; };
    // each side's background = the colour along that outer edge, if it's plain (scanner bed, white or black);
    // if the outer edge is busy (card art, text), the card itself is at the edge → no margin on that side
    const sample = (fixed: number, horizontal: boolean) => { const n = 60, len = horizontal ? w : h, o: number[][] = [];
      for (let k = 0; k < n; k++) { const t = Math.round(len * (0.2 + 0.6 * k / (n - 1))); o.push(horizontal ? px(t, fixed) : px(fixed, t)); } return o; };
    const near = (p: number[], c: number[]) => Math.abs(p[0] - c[0]) + Math.abs(p[1] - c[1]) + Math.abs(p[2] - c[2]) < 70;
    // 1) each side's edge colour (null = busy edge: card art/text right at the edge)
    const edgeCol = (from: number, horizontal: boolean) => { const e = sample(from, horizontal), c = [0, 1, 2].map((k) => e.reduce((a, p) => a + p[k], 0) / e.length);
      return e.filter((p) => near(p, c)).length / e.length >= 0.9 ? c : null; };
    const cols = { top: edgeCol(0, true), bottom: edgeCol(h - 1, true), left: edgeCol(0, false), right: edgeCol(w - 1, false) };
    // 2) the scanner bed is near-black or near-white; pick the plain edge colour closest to either. A plain edge in any other
    //    colour (a navy or coloured card border) is the card itself running into the edge, not space around it.
    const bedDist = (c: number[]) => Math.min(c[0] + c[1] + c[2], 765 - c[0] - c[1] - c[2]);
    // a side has space only if its outer edge is scanner background: near-white or near-black (the two can mix: white lid + dark shadow)
    const side = (key: keyof typeof cols, from: number, step: number, max: number, horizontal: boolean) => {
      const c = cols[key]; if (!c || bedDist(c) >= 90) return 0;
      let i = 0; while (i < max && sample(from + i * step, horizontal).filter((p) => near(p, c)).length / 60 >= 0.9) i++; return i;
    };
    const maxH = Math.round(h * 0.45), maxW = Math.round(w * 0.45);
    out.margins = {
      top: side("top", 0, 1, maxH, true) / h, bottom: side("bottom", h - 1, -1, maxH, true) / h,
      left: side("left", 0, 1, maxW, false) / w, right: side("right", w - 1, -1, maxW, false) / w,
    };
    const keys = ["top", "bottom", "left", "right"] as const;
    const lone = new Set<string>(keys.filter((k) => { const c = cols[k]; if (!c || bedDist(c) >= 90) return false;
      const same = keys.filter((o) => o !== k && cols[o] && near(cols[o] as number[], c)).length;
      const others = keys.filter((o) => o !== k && cols[o] && bedDist(cols[o] as number[]) < 90).length;
      return same === 0 && others >= 2; }));
    const cornerRounded = (x0: number, y0: number, dx: number, dy: number) => {
      const avg = (x: number, y: number) => { const o = [0, 0, 0]; let n = 0;
        for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) { const xx = Math.min(w - 1, Math.max(0, x + i)), yy = Math.min(h - 1, Math.max(0, y + j)); const p = px(xx, yy); o[0] += p[0]; o[1] += p[1]; o[2] += p[2]; n++; }
        return o.map((v) => v / n); };
      const P = avg(x0 + dx * 2, y0 + dy * 2);                                         // the very corner
      const A = avg(x0 + dx * Math.round(w * 0.08), y0 + dy * 2);                       // along the top/bottom edge, past the rounding
      const B = avg(x0 + dx * 2, y0 + dy * Math.round(h * 0.08));                       // along the side edge, past the rounding
      const d = (a: number[], b: number[]) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);
      return d(P, A) > 60 && d(P, B) > 60 && bedDist(P) < 120;                          // corner is background, edges next to it are card
    };
    const rounded = [cornerRounded(0, 0, 1, 1), cornerRounded(w - 1, 0, -1, 1), cornerRounded(0, h - 1, 1, -1), cornerRounded(w - 1, h - 1, -1, -1)].filter(Boolean).length;
    const trimmed = rounded === 4; // whole card in, cropped tight to its edges: that's a pass
    const m = out.margins, touch = (Object.keys(m) as (keyof typeof m)[]).filter((k) => m[k] < TOUCH);
    // a side with no space while the opposite side has plenty = the card slid that way and is cut off there
    const opp: Record<string, keyof typeof m> = { top: "bottom", bottom: "top", left: "right", right: "left" };
    const cut = touch.filter((k) => m[opp[k]] > 0.03), edge = trimmed ? [] : touch.filter((k) => !cut.includes(k));
    if (cut.length) out.issues.push(`card is cut off on the ${cut.join(" / ")} (shifted in the photo)`);
    if (edge.length) out.issues.push(`card runs into the ${edge.join(" / ")} edge (may be cut off)`);
    const gapV = lone.has("top") || lone.has("bottom") ? 0 : Math.abs(m.top - m.bottom), gapH = lone.has("left") || lone.has("right") ? 0 : Math.abs(m.left - m.right);
    if (gapV > UNEVEN || gapH > UNEVEN) out.issues.push("card is off-centre in the photo");
    // a good crop hugs the card: more than 2.5% of scanner background on a side = the crop isn't tight (fail); 1.5–2.5% = check
    const dark = keys.filter((k) => { const c = cols[k]; return !!c && c[0] + c[1] + c[2] < 90 && m[k] > 0.003 && !lone.has(k); });
    if (dark.length >= 3) out.issues.push(`dark scanner background around the card on the ${dark.join(" / ")} (crop takes in the scanner bed)`);
    const loose = (Object.keys(m) as (keyof typeof m)[]).filter((k) => m[k] > LOOSE && !lone.has(k));
    if (loose.length) out.issues.push(`too much background on the ${loose.join(" / ")} (crop not tight to the card)`);
    out.level = out.issues.length ? "cut" : "ok";
    // close call (light flag): the whole card is in, but a side has very little space or the space is a bit uneven
    if (out.level === "ok") {
      const thin = trimmed ? [] : (Object.keys(m) as (keyof typeof m)[]).filter((k) => m[k] < 0.008);
      if (thin.length) out.issues.push(`very little space on the ${thin.join(" / ")}: check the edges`);
      if (dark.length === 2) out.issues.push(`dark background on the ${dark.join(" / ")}: check the crop`);
      const wide = (Object.keys(m) as (keyof typeof m)[]).filter((k) => m[k] > ROOMY && !lone.has(k));
      if (wide.length) out.issues.push(`a lot of background on the ${wide.join(" / ")}: check the crop`);
      if (gapV > 0.025 || gapH > 0.025) out.issues.push("slightly off-centre");
      if (out.issues.length) out.level = "close";
    }
    out.ok = out.level === "ok";
  }
  return out;
}
export async function checkPhotos(urls: string[]) {
  const list = [...new Set(urls.filter(Boolean))].slice(0, 60), out: Record<string, PhotoCheck> = {};
  let i = 0; await Promise.all(Array.from({ length: 6 }, async () => { while (i < list.length) { const u = list[i++]; out[u] = await checkPhoto(u); } }));
  return out;
}
