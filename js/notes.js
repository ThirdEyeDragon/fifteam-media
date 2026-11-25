// Custom notes: the editor where the new bass is placed by hand, note by note, over the song (the Rebass screen's
// "Custom notes"). The song's own bass is taken out as usual; these notes are played instead.
//   Time runs left to right (the song's own timeline), pitch bottom to top (whole semitones on the song's own tuning,
// with note names and Hz down the side). The song's own bass line shows faintly behind, folded into view, with its hits
// along the bottom, to place notes in time and in key.
//   Tap an empty spot: a note there (as long as the last one). Drag a note: move it. Drag its right edge: longer or
// shorter. Drag the empty grid: move along the song. Pinch (or the mouse wheel): zoom. Tap the time strip on top: play
// from there. A note's tapped: it's chosen (its own buttons: shorter, longer, delete).
const NAMES = ["C", "C♯", "D", "D♯", "E", "F", "F♯", "G", "G♯", "A", "A♯", "B"];
export const hz2st = (f) => 69 + 12 * Math.log2(f / 440);
export const st2hz = (m) => 440 * Math.pow(2, (m - 69) / 12);
export const noteName = (st) => { const r = Math.round(st); return NAMES[((r % 12) + 12) % 12] + (Math.floor(r / 12) - 1); };
const MAX_NOTES = 4000, GUTTER = 50, RULER = 22, HITS = 18;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/**
 * An editor in `host`. opts: duration (s), guide ({ t0, hop, f0, env, tune } or null), notes ([{ t, d, f, v }]),
 * lowHz / highHz (the pitch range shown), playhead() (s, or null), seek(t), onChange(notes), onSelect(note | null).
 * Returns { notes(), set(list), undo(), remove(), clear(), nudge(dLen), draw(), canUndo(), selected() }.
 */
export function noteEditor(host, opts) {
  const cv = document.createElement("canvas"); cv.className = "ne-canvas"; cv.setAttribute("aria-label", "Your bass notes over the song");
  host.replaceChildren(cv);
  const E = {
    notes: (opts.notes || []).map((n) => ({ ...n })), sel: -1, undo: [], last: 0.5,
    t0: 0, span: Math.min(8, Math.max(2, opts.duration || 8)), dur: opts.duration || 0,
    tune: opts.guide && isFinite(opts.guide.tune) ? opts.guide.tune - Math.floor(opts.guide.tune) : 0,
    lo: 0, hi: 0, w: 0, h: 0, dpr: 1, raf: 0,
  };
  E.lo = Math.floor(hz2st(opts.lowHz || 18) - E.tune) + E.tune; E.hi = Math.ceil(hz2st(opts.highHz || 125) - E.tune) + E.tune;
  const rows = () => Math.round(E.hi - E.lo) + 1;
  const snapSt = (st) => clamp(Math.round(st - E.tune) + E.tune, E.lo, E.hi);
  // geometry
  const size = () => {
    const r = cv.getBoundingClientRect(); E.dpr = Math.min(3, devicePixelRatio || 1);
    E.w = Math.max(200, r.width); E.h = Math.max(200, r.height);
    cv.width = Math.round(E.w * E.dpr); cv.height = Math.round(E.h * E.dpr);
  };
  const gridH = () => E.h - RULER - HITS;
  const rowH = () => gridH() / rows();
  const xOf = (t) => GUTTER + ((t - E.t0) / E.span) * (E.w - GUTTER);
  const tOf = (x) => E.t0 + ((x - GUTTER) / (E.w - GUTTER)) * E.span;
  const yOf = (st) => RULER + (E.hi - st) * rowH();             // the top of that semitone's row (st at its centre - half a row)
  const stOf = (y) => E.hi - (y - RULER) / rowH() + 0.5;
  const keepIn = () => { E.span = clamp(E.span, 1, Math.max(1, Math.min(60, E.dur || 60))); E.t0 = clamp(E.t0, 0, Math.max(0, E.dur - E.span)); };
  const changed = () => { opts.onChange && opts.onChange(E.notes.map((n) => ({ ...n }))); draw(); };
  const snapshot = () => { E.undo.push(JSON.stringify(E.notes)); if (E.undo.length > 60) E.undo.shift(); };
  const select = (i) => { E.sel = i; opts.onSelect && opts.onSelect(i >= 0 ? { ...E.notes[i] } : null); draw(); };

  // ------------------------------------------------------------------------------------------------ drawing
  function draw() { if (!E.raf) E.raf = requestAnimationFrame(paint); }
  function paint() {
    E.raf = 0;
    if (!cv.isConnected) return;
    if (!E.w || Math.abs(cv.getBoundingClientRect().width - E.w) > 1) size();
    const g = cv.getContext("2d"), W = E.w, H = E.h, rh = rowH(), GH = gridH();
    g.setTransform(E.dpr, 0, 0, E.dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    // the background: deep, a little lighter at the top
    const bg = g.createLinearGradient(0, 0, 0, H); bg.addColorStop(0, "#15123d"); bg.addColorStop(1, "#0a0920");
    g.fillStyle = bg; g.fillRect(0, 0, W, H);
    // rows: the natural notes a shade lighter than the sharps, each octave (C) marked by a soft violet line
    for (let st = E.lo; st <= E.hi + 1e-6; st++) {
      const y = yOf(st), k = ((Math.round(st) % 12) + 12) % 12, sharp = [1, 3, 6, 8, 10].includes(k);
      g.fillStyle = sharp ? "rgba(0,0,0,0.16)" : "rgba(255,255,255,0.025)";
      g.fillRect(GUTTER, y, W - GUTTER, rh);
      if (k === 0) { g.fillStyle = "rgba(170,140,255,0.32)"; g.fillRect(GUTTER, y + rh - 1, W - GUTTER, 1); }
    }
    // the time strip on top, with the seconds; beat lines down the grid (every second a little brighter)
    const tg = g.createLinearGradient(0, 0, 0, RULER); tg.addColorStop(0, "rgba(122,75,255,0.28)"); tg.addColorStop(1, "rgba(122,75,255,0.10)");
    g.fillStyle = tg; g.fillRect(0, 0, W, RULER);
    const step = E.span <= 4 ? 0.5 : E.span <= 10 ? 1 : E.span <= 24 ? 2 : 5;
    g.font = "600 10px Inter, system-ui, sans-serif"; g.textBaseline = "middle";
    for (let t = Math.ceil(E.t0 / step) * step; t <= E.t0 + E.span; t += step) {
      const x = xOf(t), whole = Math.abs(t - Math.round(t)) < 1e-6;
      g.fillStyle = whole ? "rgba(255,255,255,0.09)" : "rgba(255,255,255,0.045)"; g.fillRect(x, RULER, 1, GH);
      g.fillStyle = "rgba(255,255,255,0.28)"; g.fillRect(x, RULER - 5, 1, 5);
      g.fillStyle = "rgba(255,255,255,0.75)"; g.fillText(`${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}${step < 1 ? "." + Math.round((t % 1) * 10) : ""}`, x + 4, RULER / 2);
    }
    // the song's own bass, faintly: its hits along the bottom, and its line (folded into view by octaves), softly glowing
    const gd = opts.guide;
    if (gd && gd.f0 && gd.f0.length) {
      const i0 = Math.max(0, Math.floor((E.t0 - gd.t0) / gd.hop)), i1 = Math.min(gd.f0.length - 1, Math.ceil((E.t0 + E.span - gd.t0) / gd.hop));
      const by = H - HITS, stride = Math.max(1, Math.floor((i1 - i0) / (W - GUTTER))), bw = Math.max(1, stride * ((W - GUTTER) / ((i1 - i0) || 1)));
      g.fillStyle = "rgba(0,0,0,0.25)"; g.fillRect(GUTTER, by, W - GUTTER, HITS);
      const hg = g.createLinearGradient(0, by, 0, H); hg.addColorStop(0, "rgba(187,77,255,0.75)"); hg.addColorStop(1, "rgba(47,120,255,0.35)");
      g.fillStyle = hg;
      for (let i = i0; i <= i1; i += stride) {
        const e = gd.env[i] || 0; if (e <= 0.003) continue;
        const x = xOf(gd.t0 + i * gd.hop), hh = Math.min(HITS - 3, 2 + Math.sqrt(e) * (HITS - 3));
        g.fillRect(x, H - hh - 1, bw, hh);
      }
      g.save();
      g.strokeStyle = "rgba(170,190,255,0.42)"; g.lineWidth = 2.2; g.lineJoin = "round"; g.lineCap = "round";
      g.shadowColor = "rgba(140,160,255,0.55)"; g.shadowBlur = 6;
      g.beginPath();
      let pen = false, lastY = 0;
      for (let i = i0; i <= i1; i += stride) {
        const f = gd.f0[i], e = gd.env[i] || 0;
        if (!(f > 0) || e < 0.01) { pen = false; continue; }
        let st = hz2st(f); while (st > E.hi) st -= 12; while (st < E.lo) st += 12;
        const x = xOf(gd.t0 + i * gd.hop), y = yOf(snapSt(st)) + rh / 2;
        if (pen && Math.abs(y - lastY) > rh * 6) pen = false;        // (an octave fold: a gap, not a jump)
        if (pen) g.lineTo(x, y); else { g.moveTo(x, y); pen = true; }
        lastY = y;
      }
      g.stroke(); g.restore();
    }
    // the notes: glowing, their names inside when there's room
    E.notes.forEach((n, i) => {
      const x0 = xOf(n.t), x1 = xOf(n.t + n.d);
      if (x1 < GUTTER || x0 > W) return;
      const st = snapSt(hz2st(n.f)), hh = Math.max(5, rh - 1.5), y = yOf(st) + (rh - hh) / 2;
      const xs = Math.max(GUTTER, x0), wd = Math.max(4, x1 - xs), r = Math.min(6, hh / 2), sel = i === E.sel;
      const a = 0.6 + 0.4 * (n.v == null ? 1 : n.v);
      g.save();
      g.shadowColor = sel ? "rgba(255,255,255,0.65)" : "rgba(150,90,255,0.7)"; g.shadowBlur = sel ? 14 : 9;
      const gr = g.createLinearGradient(xs, 0, xs + wd, 0); gr.addColorStop(0, `rgba(47,120,255,${a})`); gr.addColorStop(0.55, `rgba(122,75,255,${a})`); gr.addColorStop(1, `rgba(187,77,255,${a})`);
      g.fillStyle = gr; roundRect(g, xs, y, wd, hh, r); g.fill();
      g.restore();
      // a light edge along the top
      g.fillStyle = "rgba(255,255,255,0.28)"; roundRect(g, xs + 1, y + 1, Math.max(2, wd - 2), Math.max(1, hh * 0.35), Math.min(r, hh * 0.18)); g.fill();
      if (wd > 40 && hh >= 9) { g.fillStyle = "rgba(255,255,255,0.95)"; g.font = `700 ${Math.min(10, hh - 2)}px Inter, system-ui, sans-serif`; g.textBaseline = "middle"; g.fillText(`${Math.round(n.f)} Hz`, xs + 6, y + hh / 2 + 0.5); }
      if (sel) {
        g.strokeStyle = "#fff"; g.lineWidth = 2; roundRect(g, xs, y, wd, hh, r); g.stroke();
        // the grip on its right edge (drag it to make the note longer or shorter)
        g.fillStyle = "#fff"; const gx = x1 - 6;
        g.fillRect(gx, y + hh * 0.25, 1.5, hh * 0.5); g.fillRect(gx + 3, y + hh * 0.25, 1.5, hh * 0.5);
      }
    });
    // the frequencies down the side: each row's Hz (every other row when they're too close together to read)
    g.fillStyle = "#0d0b26"; g.fillRect(0, RULER, GUTTER, GH);
    const every = rh >= 11 ? 1 : 2;
    g.font = `700 ${Math.max(8, Math.min(10.5, rh))}px Inter, system-ui, sans-serif`; g.textBaseline = "middle"; g.textAlign = "right";
    let row = 0;
    for (let st = E.hi; st >= E.lo - 1e-6; st--, row++) {
      if (row % every) continue;
      const y = yOf(st), hz = st2hz(st);
      g.fillStyle = Math.round(hz) % 10 === 0 || every > 1 ? "rgba(255,255,255,0.9)" : "rgba(255,255,255,0.62)";
      g.fillText(`${hz < 100 ? hz.toFixed(hz < 30 ? 1 : 0) : Math.round(hz)} Hz`, GUTTER - 5, y + rh / 2);
    }
    g.textAlign = "left";
    g.fillStyle = "rgba(160,130,255,0.35)"; g.fillRect(GUTTER - 1, RULER, 1, GH);
    // the play position: a glowing line, with a marker on the time strip
    const ph = opts.playhead && opts.playhead();
    if (ph != null && ph >= E.t0 && ph <= E.t0 + E.span) {
      const x = xOf(ph);
      g.save(); g.shadowColor = "rgba(255,79,135,0.9)"; g.shadowBlur = 8; g.fillStyle = "#ff4f87"; g.fillRect(x - 1, RULER, 2, H - RULER); g.restore();
      g.fillStyle = "#ff4f87"; g.beginPath(); g.moveTo(x - 6, RULER - 8); g.lineTo(x + 6, RULER - 8); g.lineTo(x, RULER); g.closePath(); g.fill();
    }
    // how much of the song is in view
    if (E.dur > E.span) { const a = E.t0 / E.dur, b = (E.t0 + E.span) / E.dur; g.fillStyle = "rgba(255,255,255,0.35)"; roundRect(g, GUTTER + a * (W - GUTTER), H - 3, Math.max(6, (b - a) * (W - GUTTER)), 3, 1.5); g.fill(); }
  }
  function roundRect(g, x, y, w, h, r) { g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath(); }

  // ------------------------------------------------------------------------------------------------ touch
  const hit = (x, y) => {
    const st = snapSt(stOf(y));
    for (let i = E.notes.length - 1; i >= 0; i--) {
      const n = E.notes[i], x0 = xOf(n.t), x1 = xOf(n.t + n.d);
      if (Math.abs(snapSt(hz2st(n.f)) - st) < 0.5 && x >= x0 - 4 && x <= x1 + 10) return { i, edge: x >= x1 - Math.min(14, (x1 - x0) / 3) };
    }
    return null;
  };
  const pts = new Map();
  let gest = null;
  const local = (e) => { const r = cv.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  cv.addEventListener("pointerdown", (e) => {
    cv.setPointerCapture(e.pointerId);
    const p = local(e); pts.set(e.pointerId, p);
    if (pts.size === 2) { const [a, b] = [...pts.values()]; gest = { kind: "pinch", d: Math.abs(a.x - b.x) || 1, span: E.span, mid: tOf((a.x + b.x) / 2) }; return; }
    if (p.y < RULER) { gest = { kind: "seek" }; return; }
    const h = hit(p.x, p.y);
    if (h) { const n = E.notes[h.i]; gest = { kind: h.edge ? "resize" : "move", i: h.i, x: p.x, y: p.y, t: n.t, d: n.d, st: snapSt(hz2st(n.f)), moved: false, snap: false }; }
    else gest = { kind: "empty", x: p.x, y: p.y, t0: E.t0, moved: false };
  });
  cv.addEventListener("pointermove", (e) => {
    if (!pts.has(e.pointerId) || !gest) return;
    const p = local(e); pts.set(e.pointerId, p);
    const secPx = E.span / (E.w - GUTTER);
    if (gest.kind === "pinch" && pts.size === 2) {
      const [a, b] = [...pts.values()], d = Math.abs(a.x - b.x) || 1;
      E.span = gest.span * (gest.d / d); keepIn();
      E.t0 = gest.mid - ((a.x + b.x) / 2 - GUTTER) * (E.span / (E.w - GUTTER)); keepIn(); draw(); return;
    }
    const dx = p.x - gest.x, dy = p.y - gest.y;
    if (!gest.moved && Math.hypot(dx, dy) < 6) return;
    if (!gest.moved && (gest.kind === "move" || gest.kind === "resize")) { snapshot(); gest.snap = true; if (E.sel !== gest.i) select(gest.i); }
    gest.moved = true;
    if (gest.kind === "empty") { E.t0 = gest.t0 - dx * secPx; keepIn(); draw(); }
    else if (gest.kind === "move") {
      const n = E.notes[gest.i];
      n.t = Math.round(clamp(gest.t + dx * secPx, 0, Math.max(0, E.dur - n.d)) * 100) / 100;
      n.f = st2hz(snapSt(gest.st - dy / rowH()));
      draw();
    } else if (gest.kind === "resize") {
      const n = E.notes[gest.i];
      n.d = Math.round(clamp(gest.d + dx * secPx, 0.05, Math.max(0.05, E.dur - n.t)) * 100) / 100; E.last = n.d; draw();
    }
  });
  const up = (e) => {
    if (!pts.has(e.pointerId)) return;
    const p = local(e); pts.delete(e.pointerId);
    const g = gest;
    if (!g) return;
    if (g.kind === "pinch") { if (!pts.size) gest = null; return; }
    gest = null;
    if (e.type === "pointercancel") { draw(); return; }
    if (g.kind === "seek") { opts.seek && opts.seek(clamp(tOf(p.x), 0, E.dur)); return; }
    if (g.kind === "empty" && !g.moved) {
      if (E.sel >= 0) { select(-1); return; }                  // (a tap away from a chosen note just lets it go)
      if (E.notes.length >= MAX_NOTES) return;
      const t = clamp(tOf(p.x), 0, Math.max(0, E.dur - 0.05)), st = snapSt(stOf(p.y));
      if (p.y > E.h - HITS || p.x < GUTTER) return;
      snapshot();
      E.notes.push({ t: Math.round(t * 100) / 100, d: Math.min(E.last, Math.max(0.05, E.dur - t)), f: st2hz(st), v: 1 });
      E.notes.sort((a, b) => a.t - b.t);
      select(E.notes.findIndex((n) => n.t === Math.round(t * 100) / 100 && Math.abs(hz2st(n.f) - st) < 0.01));
      changed(); return;
    }
    if ((g.kind === "move" || g.kind === "resize") && !g.moved) { select(E.sel === g.i ? -1 : g.i); return; }
    if (g.kind === "move" || g.kind === "resize") {
      const keep = E.notes[g.i];
      E.notes.sort((a, b) => a.t - b.t);
      E.sel = E.notes.indexOf(keep);
      opts.onSelect && opts.onSelect({ ...keep });
      changed();
    }
  };
  cv.addEventListener("pointerup", up); cv.addEventListener("pointercancel", up);
  cv.addEventListener("wheel", (e) => {
    e.preventDefault();
    const p = local(e), at = tOf(p.x);
    if (e.ctrlKey || Math.abs(e.deltaY) > Math.abs(e.deltaX)) { E.span *= Math.exp(e.deltaY * 0.0025); keepIn(); E.t0 = at - (p.x - GUTTER) * (E.span / (E.w - GUTTER)); }
    else E.t0 += e.deltaX * (E.span / (E.w - GUTTER));
    keepIn(); draw();
  }, { passive: false });
  addEventListener("resize", () => { E.w = 0; draw(); });

  // ------------------------------------------------------------------------------------------------ the outside
  const api = {
    notes: () => E.notes.map((n) => ({ ...n })),
    set(list, keepUndo) { if (!keepUndo) snapshot(); E.notes = list.slice(0, MAX_NOTES).map((n) => ({ ...n })).sort((a, b) => a.t - b.t); select(-1); changed(); },
    undo() { if (!E.undo.length) return; E.notes = JSON.parse(E.undo.pop()); select(-1); changed(); },
    canUndo: () => E.undo.length > 0,
    remove() { if (E.sel < 0) return; snapshot(); E.notes.splice(E.sel, 1); select(-1); changed(); },
    clear() { if (!E.notes.length) return; snapshot(); E.notes = []; select(-1); changed(); },
    /** The chosen note: longer or shorter (s), or up or down (semitones). */
    nudge(dLen = 0, dSt = 0) {
      if (E.sel < 0) return;
      snapshot();
      const n = E.notes[E.sel];
      if (dLen) { n.d = Math.round(clamp(n.d + dLen, 0.05, Math.max(0.05, E.dur - n.t)) * 100) / 100; E.last = n.d; }
      if (dSt) n.f = st2hz(snapSt(hz2st(n.f) + dSt));
      opts.onSelect && opts.onSelect({ ...n });
      changed();
    },
    selected: () => (E.sel >= 0 ? { ...E.notes[E.sel] } : null),
    /** Keep the play position in view while it plays. */
    follow(t) { if (t != null && (t < E.t0 || t > E.t0 + E.span * 0.92)) { E.t0 = t - E.span * 0.1; keepIn(); } draw(); },
    draw,
  };
  size(); draw();
  return api;
}
