// Card photo check core, shared by the server (lib/photo.ts) and the demo page (copied into public/tagbot.html between
// "photo-core:start" / "photo-core:end"; run `node scripts/sync-photo-core.mjs` after editing this file).
// px(x, y) -> [r, g, b]. Returns { margins, issues, level, ok }.
export function analyzePixels(w, h, px, T = { TOUCH: 0.004, UNEVEN: 0.05, LOOSE: 0.025, ROOMY: 0.015 }) {
  const { TOUCH, UNEVEN, LOOSE, ROOMY } = T;
  const out = { margins: { top: 0, bottom: 0, left: 0, right: 0 }, issues: [], level: "ok", ok: true };
    // each side's background = the colour along that outer edge, if it's plain (scanner bed, white or black);
    // if the outer edge is busy (card art, text), the card itself is at the edge → no margin on that side
    const sample = (fixed, horizontal) => { const n = 60, len = horizontal ? w : h, o = [];
      for (let k = 0; k < n; k++) { const t = Math.round(len * (0.2 + 0.6 * k / (n - 1))); o.push(horizontal ? px(t, fixed) : px(fixed, t)); } return o; };
    const near = (p, c) => Math.abs(p[0] - c[0]) + Math.abs(p[1] - c[1]) + Math.abs(p[2] - c[2]) < 70;
    // 1) each side's edge colour (null = busy edge: card art/text right at the edge)
    const edgeCol = (from, horizontal) => { const e = sample(from, horizontal), c = [0, 1, 2].map((k) => e.reduce((a, p) => a + p[k], 0) / e.length);
      return e.filter((p) => near(p, c)).length / e.length >= 0.9 ? c : null; };
    const cols = { top: edgeCol(0, true), bottom: edgeCol(h - 1, true), left: edgeCol(0, false), right: edgeCol(w - 1, false) };
    // 2) the scanner bed is near-black or near-white; pick the plain edge colour closest to either. A plain edge in any other
    //    colour (a navy or coloured card border) is the card itself running into the edge, not space around it.
    const bedDist = (c) => Math.min(c[0] + c[1] + c[2], 765 - c[0] - c[1] - c[2]);
    // a side has space only if its outer edge is scanner background: near-white or near-black (the two can mix: white lid + dark shadow)
    const side = (key, from, step, max, horizontal) => {
      const c = cols[key]; if (!c || bedDist(c) >= 90) return 0;
      let i = 0; while (i < max && sample(from + i * step, horizontal).filter((p) => near(p, c)).length / 60 >= 0.9) i++; return i;
    };
    const maxH = Math.round(h * 0.45), maxW = Math.round(w * 0.45);
    out.margins = {
      top: side("top", 0, 1, maxH, true) / h, bottom: side("bottom", h - 1, -1, maxH, true) / h,
      left: side("left", 0, 1, maxW, false) / w, right: side("right", w - 1, -1, maxW, false) / w,
    };
    const keys = ["top", "bottom", "left", "right"];
    const m0 = out.margins, realLone = new Set();
    const lone = new Set(keys.filter((k) => { const c = cols[k]; if (!c || bedDist(c) >= 90) return false;
      const same = keys.filter((o) => o !== k && cols[o] && near(cols[o], c)).length;
      const others = keys.filter((o) => o !== k && cols[o] && bedDist(cols[o]) < 90).length;
      if (!(same === 0 && others >= 2)) return false;
      const depth = Math.round((k === "top" || k === "bottom" ? h : w) * m0[k]), horiz = k === "top" || k === "bottom";
      const at = k === "top" ? depth : k === "bottom" ? h - 1 - depth : k === "left" ? depth : w - 1 - depth;
      const line = sample(Math.min(Math.max(at + (k === "top" || k === "left" ? 1 : -1), 0), (horiz ? h : w) - 1), horiz);
      const mean = [0, 1, 2].map((i) => line.reduce((a, p) => a + p[i], 0) / line.length);
      const cleanEdge = line.filter((p) => near(p, mean)).length / line.length >= 0.8 && !near(mean, c);
      if (cleanEdge) { realLone.add(k); return false; } // real dark strip: keep counting it
      return true; }));
    const cornerRounded = (x0, y0, dx, dy) => {
      // sample at exactly the same depth from the edge (a 1px scanner line must not look like a rounded corner)
      const avg = (x, y, along) => { const o = [0, 0, 0]; let n = 0;
        for (let i = -1; i <= 1; i++) { const xx = Math.min(w - 1, Math.max(0, x + (along === "x" ? i : 0))), yy = Math.min(h - 1, Math.max(0, y + (along === "y" ? i : 0))); const p = px(xx, yy); o[0] += p[0]; o[1] += p[1]; o[2] += p[2]; n++; }
        return o.map((v) => v / n); };
      const P = avg(x0 + dx, y0 + dy, "");                                                 // the very corner
      const A = avg(x0 + dx * Math.round(w * 0.08), y0 + dy, "x");                           // along the top/bottom edge, past the rounding
      const B = avg(x0 + dx, y0 + dy * Math.round(h * 0.08), "y");                           // along the side edge, past the rounding
      const d = (a, b) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);
      return d(P, A) > 60 && d(P, B) > 60 && bedDist(P) < 120;                          // corner is background, edges next to it are card
    };
    const corners = { "top-left": cornerRounded(0, 0, 1, 1), "top-right": cornerRounded(w - 1, 0, -1, 1), "bottom-left": cornerRounded(0, h - 1, 1, -1), "bottom-right": cornerRounded(w - 1, h - 1, -1, -1) };
    // with a thin margin, the card's own corners sit just inside it: all four rounded there = whole card in, thin space is fine
    const mt = Math.round(out.margins.top * h), mb = Math.round(out.margins.bottom * h), ml = Math.round(out.margins.left * w), mr = Math.round(out.margins.right * w);
    const insetWhole = [cornerRounded(ml, mt, 1, 1), cornerRounded(w - 1 - mr, mt, -1, 1), cornerRounded(ml, h - 1 - mb, 1, -1), cornerRounded(w - 1 - mr, h - 1 - mb, -1, -1)].every(Boolean);
    const square = Object.entries(corners).filter(([, v]) => !v).map(([k]) => k), rounded = 4 - square.length;
    const trimmed = rounded === 4; // whole card in, cropped tight to its edges: that's a pass
    const mostly = rounded >= 2;   // tight crop with a corner or two squared off = clipped a little: check, not fail
    const m = out.margins, touch = (Object.keys(m)).filter((k) => m[k] < TOUCH);
    // a side with no space while the opposite side has plenty = the card slid that way and is cut off there
    const opp = { top: "bottom", bottom: "top", left: "right", right: "left" };
    const cut = touch.filter((k) => m[opp[k]] > 0.03), edge = trimmed || insetWhole || (mostly && !cut.length) ? [] : touch.filter((k) => !cut.includes(k));
    const slid = touch.filter((k) => m[opp[k]] > 0.008);                     // touching here, space on the other side
    const clippedFail = !trimmed && !insetWhole && mostly && !cut.length && touch.length > 0 && slid.length > 0;
    const mt0 = Math.round(m0.top * h), mb0 = Math.round(m0.bottom * h), ml0 = Math.round(m0.left * w), mr0 = Math.round(m0.right * w);
    const ins = { "top-left": cornerRounded(ml0, mt0, 1, 1), "top-right": cornerRounded(w - 1 - mr0, mt0, -1, 1), "bottom-left": cornerRounded(ml0, h - 1 - mb0, 1, -1), "bottom-right": cornerRounded(w - 1 - mr0, h - 1 - mb0, -1, -1) };
    const pairSide = [["top", ["top-left", "top-right"], ["bottom-left", "bottom-right"]], ["bottom", ["bottom-left", "bottom-right"], ["top-left", "top-right"]],
      ["left", ["top-left", "bottom-left"], ["top-right", "bottom-right"]], ["right", ["top-right", "bottom-right"], ["top-left", "bottom-left"]]];
    const someSpace = Object.values(m0).some((v) => v > TOUCH);
    const cutCorners = trimmed || insetWhole || !someSpace ? null : pairSide.find(([sd, gone, kept]) => !lone.has(sd) && gone.every((c) => !ins[c]) && kept.every((c) => ins[c]));
    if (cutCorners) { // one clear message instead of two saying the same thing
      out.issues = out.issues.filter((t) => !t.startsWith(`card runs into the ${cutCorners[0]} edge`));
      out.issues.unshift(`card cut off at the ${cutCorners[0]}: no rounded corner at the ${cutCorners[1].join(" / ")}, while the ${cutCorners[2].join(" / ")} are rounded`); }
    const clipped = !trimmed && !insetWhole && !cutCorners && mostly && !cut.length && touch.length > 0 && !clippedFail; // light flag below
    if (clippedFail) out.issues.push(`no rounded corner at the ${square.join(" / ")} and the card sits against the ${slid.join(" / ")} edge: cut off there`);
    if (cut.length) out.issues.push(`card is cut off on the ${cut.join(" / ")} (shifted in the photo)`);
    if (edge.length && !(cutCorners && edge.every((e) => e === cutCorners[0]))) { // already said by "card cut off at the …"
      // name the card corners that are missing next to those edges (compare top corners with bottom ones)
      const mt = Math.round(m.top * h), mb = Math.round(m.bottom * h), ml = Math.round(m.left * w), mr = Math.round(m.right * w);
      const inset = { "top-left": cornerRounded(ml, mt, 1, 1), "top-right": cornerRounded(w - 1 - mr, mt, -1, 1), "bottom-left": cornerRounded(ml, h - 1 - mb, 1, -1), "bottom-right": cornerRounded(w - 1 - mr, h - 1 - mb, -1, -1) };
      const gone = Object.entries(inset).filter(([k, v]) => !v && edge.some((e) => k.includes(e))).map(([k]) => k);
      const kept = Object.entries(inset).filter(([, v]) => v).map(([k]) => k);
      out.issues.push(`card runs into the ${edge.join(" / ")} edge (may be cut off)` + (gone.length && kept.length ? `: no rounded corner at the ${gone.join(" / ")}, while the ${kept.join(" / ")} ${kept.length === 1 ? "is" : "are"} rounded` : ""));
    }
    const gapV = lone.has("top") || lone.has("bottom") ? 0 : Math.abs(m.top - m.bottom), gapH = lone.has("left") || lone.has("right") ? 0 : Math.abs(m.left - m.right);
    const tight = rounded >= 2 && !cut.length;
    if (!tight && (gapV > UNEVEN || gapH > UNEVEN)) out.issues.push("card is off-centre in the photo");
    // a good crop hugs the card: more than 2.5% of scanner background on a side = the crop isn't tight (fail); 1.5–2.5% = check
    const dark = keys.filter((k) => { const c = cols[k]; return !!c && c[0] + c[1] + c[2] < 90 && m[k] > 0.003 && !lone.has(k); });
    if (!tight && dark.length >= 3) out.issues.push(`dark scanner background around the card on the ${dark.join(" / ")} (crop takes in the scanner bed)`);
    const loose = tight ? [] : (Object.keys(m)).filter((k) => m[k] > LOOSE && !lone.has(k));
    if (loose.length) out.issues.push(`too much background on the ${loose.join(" / ")} (crop not tight to the card)`);
    out.level = out.issues.length ? "cut" : "ok";
    // close call (light flag): the whole card is in, but a side has very little space or the space is a bit uneven
    if (out.level === "ok") {
      if (clipped) out.issues.push(`no rounded corner at the ${square.join(" / ")}: card may be clipped there`);
      const thin = trimmed || clipped || insetWhole ? [] : (Object.keys(m)).filter((k) => m[k] < 0.008);
      if (thin.length) out.issues.push(`very little space on the ${thin.join(" / ")}: check the edges`);
      if (!tight && dark.length === 2) out.issues.push(`dark background on the ${dark.join(" / ")}: check the crop`);
      const wide = tight ? [] : (Object.keys(m)).filter((k) => m[k] > ROOMY && !lone.has(k));
      if (wide.length) out.issues.push(`a lot of background on the ${wide.join(" / ")}: check the crop`);
      if (!tight && (gapV > 0.025 || gapH > 0.025)) out.issues.push("slightly off-centre");
      if (out.issues.length) out.level = "close";
    }
    out.ok = out.level === "ok";
  return out;
}
