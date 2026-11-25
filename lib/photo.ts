// Card photo check: is the whole card in the photo, with a little space around it?
// A good scan (like a Lorcana back) has a thin even margin of background on all four sides, so the card's own edges and
// rounded corners show. A bad one has the card running into the edge of the photo (cut off) or sitting off to one side.
// The photo is read on the server: the browser can't read pixels from Google Storage images (no CORS).
import jpeg from "jpeg-js";
// @ts-ignore plain JS module shared with the demo page
import { analyzePixels } from "./photo-core.js";

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

export async function checkPhoto(url: string, fresh = false): Promise<PhotoCheck> {
  const hit = fresh ? undefined : cache.get(url); if (hit) return hit;
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
    Object.assign(out, analyzePixels(w, h, px, { TOUCH, UNEVEN, LOOSE, ROOMY }));
  }
  return out;
}
export async function checkPhotos(urls: string[], fresh = false) {
  const list = [...new Set(urls.filter(Boolean))].slice(0, 60), out: Record<string, PhotoCheck> = {};
  let i = 0; await Promise.all(Array.from({ length: 6 }, async () => { while (i < list.length) { const u = list[i++]; out[u] = await checkPhoto(u, fresh); } }));
  return out;
}
