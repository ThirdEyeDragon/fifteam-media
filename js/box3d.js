// The sub box in 3D: a small WebGL renderer for the box from boxmath's layout (its panels, the port, the subs with their
// cones, surrounds and magnets), turned with a finger (drag), zoomed with a pinch or the wheel, reset with a double tap.
// Solid, see-through (the walls like glass, the port's air glowing, the chambers tinted) or with the top off. Without
// WebGL it draws the same box as lines.

const FINISH = {
  mdf: { wall: [0.74, 0.6, 0.43], inner: [0.8, 0.66, 0.48], edge: [0.35, 0.25, 0.15, 0.55] },
  black: { wall: [0.12, 0.12, 0.14], inner: [0.74, 0.6, 0.43], edge: [0.42, 0.4, 0.55, 0.7] },
  gray: { wall: [0.38, 0.39, 0.42], inner: [0.74, 0.6, 0.43], edge: [0.18, 0.18, 0.22, 0.6] },
};
const AIR = [0.25, 0.85, 1.0], SEALED = [0.73, 0.45, 1.0], VENTED = [0.3, 0.55, 1.0];

// ---------------------------------------------------------------------------------------------------- the sub, to scale
const IN = 0.0254;
/** How a sub is built, for drawing it to scale (metres): its motor grows with its size and its power rating (a
 * 15″ rated 1500 W has a magnet about 8.6″ across, two slugs stacked), it always passes through the cutout and stays
 * inside the mounting depth; the surround's roll grows with its excursion. */
export function subParts(s) {
  const z = Math.max(0.1, s.size || 0.3), rc = Math.max(0.04, (s.cutout || z * 0.92) / 2), rf = Math.max(z / 2, rc + 0.4 * IN);
  const pe = Math.max(50, s.pe || 500), xmax = Math.max(0.003, s.xmax || 0.012), sizeIn = z / IN;
  let dm = (0.9 + 0.22 * sizeIn + 0.115 * Math.sqrt(pe)) * IN;                 // the magnet's diameter
  dm = Math.max(0.36 * z, Math.min(dm, 2 * rc * 0.92));
  const slugs = Math.max(1, Math.min(3, Math.round(pe / (55 * sizeIn))));      // stacked magnets: more power, more of them
  const panel = s.panel || 0.019, depth = Math.max(s.depth || z * 0.5, panel + 0.04);
  let slugH = 0.17 * dm, plate = 0.06 * dm, gap = 0.028 * dm;                // (a thin plate between stacked slugs)
  let motor = slugs * slugH + 2 * plate + (slugs - 1) * gap;
  const room = (depth - panel) * 0.62;                                         // (the basket takes the rest)
  if (motor > room) { const k = room / motor; slugH *= k; plate *= k; gap *= k; motor = room; }
  // the surround: wider for more excursion (a big roll on a long-throw sub)
  const roll = Math.min(z * 0.11, z * 0.035 + xmax * 1.4);
  const rs1 = Math.min(rf * 0.94, rc * 0.985), rs0 = Math.max(rs1 - roll, z * 0.2);
  return { z, rf, rc, rs1, rs0, dm, slugs, slugH, plate, gap, motor, depth, panel, rdc: z * 0.17, cd: z * 0.085 + xmax * 0.6 };
}

// ---------------------------------------------------------------------------------------------------- matrices
const m4 = () => { const m = new Float32Array(16); m[0] = m[5] = m[10] = m[15] = 1; return m; };
function mul4(a, b) {
  const o = new Float32Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) { let s = 0; for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k]; o[c * 4 + r] = s; }
  return o;
}
function persp(fov, asp, n, f) { const t = 1 / Math.tan(fov / 2), m = new Float32Array(16); m[0] = t / asp; m[5] = t; m[10] = (f + n) / (n - f); m[11] = -1; m[14] = (2 * f * n) / (n - f); return m; }
function rotX(a) { const m = m4(), c = Math.cos(a), s = Math.sin(a); m[5] = c; m[6] = s; m[9] = -s; m[10] = c; return m; }
function rotY(a) { const m = m4(), c = Math.cos(a), s = Math.sin(a); m[0] = c; m[2] = -s; m[8] = s; m[10] = c; return m; }
function trans(x, y, z) { const m = m4(); m[12] = x; m[13] = y; m[14] = z; return m; }
const xf = (m, p) => [m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12], m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13], m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14], m[3] * p[0] + m[7] * p[1] + m[11] * p[2] + m[15]];
const sub3 = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

// ---------------------------------------------------------------------------------------------------- the meshes
/** Triangles (position, normal, colour) and lines, from the layout. tri: { opaque: [], clear: [{ v: [30 floats], c: centre }] } */
const rgbOf = (hex) => { const m = /^#?([0-9a-f]{6})$/i.exec(hex || ""); const n = m ? parseInt(m[1], 16) : 0x7a4bff; return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]; };
function build(L, mode, finish, paint) {
  // (painted: the colour chosen on the outside, a satin look; MDF inside)
  const F = finish === "paint" ? { wall: rgbOf(paint).map((v) => Math.min(1, v * 0.92 + 0.04)), inner: FINISH.mdf.inner, edge: [...rgbOf(paint).map((v) => v * 0.45), 0.7] } : FINISH[finish] || FINISH.mdf;
  const W = (p) => [p[0] - L.W / 2, p[1] - L.H / 2, (L.D + L.Dt) / 4 - p[2]];   // layout (z from the front) -> world (front toward +z)
  const opaque = [], clear = [], lines = [];
  const tri = (a, b, c, n, col) => {
    const v = [...a, ...n, ...col, ...b, ...n, ...col, ...c, ...n, ...col];
    if (col[3] < 0.999) clear.push({ v, c: [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3] });
    else opaque.push(...v);
  };
  const quad = (a, b, c, d, col) => { const n = norm(cross(sub3(c, a), sub3(d, b))); tri(a, b, c, n, col); tri(a, c, d, n, col); };
  const FACES = [[0, 1, 2, 3], [4, 5, 6, 7], [0, 1, 5, 4], [3, 2, 6, 7], [0, 3, 7, 4], [1, 2, 6, 5]];
  const EDGES = [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]];
  const see = mode === "see", open = mode === "open";
  // the holes cut through the wood: each sub's cutout, each round port's tube (in layout coordinates: where it starts,
  // the way into the wood, how deep, how wide)
  const holes = [];
  for (const s of L.subs) holes.push({ at: s.at, into: s.dir.map((v) => -v), deep: s.panel, r: s.cutout / 2, sq: !!s.sq });
  for (const p of L.ports) for (const tb of p.tubes || []) holes.push({ at: tb.at, into: tb.dir, deep: tb.through, r: tb.r + 0.003 });
  const axisOf = (d) => (Math.abs(d[0]) > 0.5 ? 0 : Math.abs(d[2]) > 0.5 ? 2 : 1);
  const holesIn = (c) => {
    const lo = [0, 1, 2].map((k) => Math.min(...c.map((q) => q[k]))), hi = [0, 1, 2].map((k) => Math.max(...c.map((q) => q[k])));
    return holes.filter((h) => {
      const a = axisOf(h.into), s = Math.sign(h.into[a]), z0 = h.at[a], z1 = h.at[a] + s * h.deep;
      if (lo[a] < Math.min(z0, z1) - 1e-6 || hi[a] > Math.max(z0, z1) + 1e-6) return false;
      return [0, 1, 2].every((k) => k === a || (h.at[k] + h.r > lo[k] && h.at[k] - h.r < hi[k]));
    });
  };
  // a flat face with holes (round, or square for a square sub): cut into thin strips, each strip the wood between the
  // holes (as trapezoids)
  const holedFace = (pts, hs, a, col) => {
    const ui = a === 0 ? 2 : 0, P2 = pts.map((q) => [q[ui], q[1]]), fixed = pts[0][a];
    const to3 = (u, v) => { const o = [0, 0, 0]; o[a] = fixed; o[ui] = u; o[1] = v; return o; };
    const hs2 = hs.map((h) => { const w = W(h.at); return { u: w[ui], v: w[1], r: h.r, sq: h.sq }; });
    const vmin = Math.min(...P2.map((q) => q[1])), vmax = Math.max(...P2.map((q) => q[1]));
    const cuts = new Set([vmin, vmax]);
    for (const h of hs2) for (let i = 0; i <= 18; i++) { const v = h.v - h.r + (2 * h.r * i) / 18; if (v > vmin && v < vmax) cuts.add(v); }
    const ys = [...cuts].sort((x, y) => x - y);
    const span = (v) => {                                     // the face's u range at height v (a convex quad)
      let lo = Infinity, hi = -Infinity;
      for (let i = 0; i < 4; i++) {
        const [u0, v0] = P2[i], [u1, v1] = P2[(i + 1) % 4];
        if ((v - v0) * (v - v1) <= 0 && v0 !== v1) { const u = u0 + ((v - v0) / (v1 - v0)) * (u1 - u0); lo = Math.min(lo, u); hi = Math.max(hi, u); }
        else if (v0 === v1 && Math.abs(v - v0) < 1e-9) { lo = Math.min(lo, u0, u1); hi = Math.max(hi, u0, u1); }
      }
      return [lo, hi];
    };
    const n = [0, 0, 0]; n[a] = 1;
    for (let i = 0; i < ys.length - 1; i++) {
      const ya = ys[i], yb = ys[i + 1], ym = (ya + yb) / 2, [a0, a1] = span(ya), [b0, b1] = span(yb);
      const act = hs2.filter((h) => Math.abs(ym - h.v) < h.r).sort((p, q) => p.u - q.u);
      const hw = (h, y) => (h.sq ? h.r : Math.sqrt(Math.max(0, h.r * h.r - (y - h.v) ** 2)));
      let ca = a0, cb = b0;
      const piece = (ea, eb) => { if (ea - ca > 1e-7 || eb - cb > 1e-7) { tri(to3(ca, ya), to3(ea, ya), to3(eb, yb), n, col); tri(to3(ca, ya), to3(eb, yb), to3(cb, yb), n, col); } };
      for (const h of act) { piece(Math.max(ca, h.u - hw(h, ya)), Math.max(cb, h.u - hw(h, yb))); ca = Math.max(ca, h.u + hw(h, ya)); cb = Math.max(cb, h.u + hw(h, yb)); }
      piece(a1, b1);
    }
  };
  for (const p of L.parts) {
    if (p.kind === "dowel") continue;                         // (drawn round, below)
    if (p.kind === "prism") {
      // a port bend's 45° strip: a triangle run along the bend
      const col = [...F.inner, 1], a = p.p.map(W), b = p.p.map((q) => W(q.map((x, k) => x + p.ext[k])));
      const n0 = norm(cross(sub3(a[1], a[0]), sub3(a[2], a[0])));
      tri(a[0], a[1], a[2], n0, col); tri(b[0], b[2], b[1], n0, col);
      for (let i = 0; i < 3; i++) { const j = (i + 1) % 3; quad(a[i], a[j], b[j], b[i], col); lines.push(a[i], b[i], [0.35, 0.25, 0.15, 0.45]); }
      continue;
    }
    let col, edge = null;
    if (p.group === "wall") {
      if (open && p.name === "top") continue;
      col = see ? [...F.wall, 0.13] : [...F.wall, 1];
      edge = see ? [0.78, 0.7, 1, 0.55] : F.edge;
    } else if (p.group === "inner") { col = [...F.inner, 1]; edge = [0.35, 0.25, 0.15, 0.45]; }
    else if (p.group === "air") { if (!see && !open) continue; col = [...AIR, 0.3]; }
    else if (p.group === "chamber") { if (!see) continue; col = [...(p.vented ? VENTED : SEALED), 0.07]; }
    else continue;
    const c = p.c.map(W);
    const hs = p.group === "wall" || p.group === "inner" ? holesIn(p.c) : [];
    const ax = hs.length ? axisOf(hs[0].into) : -1;
    FACES.forEach((f, i) => {
      // (the faces across a hole's way get the hole: front and back faces for z, the left and right ones for x)
      if ((ax === 2 && i < 2) || (ax === 0 && (i === 4 || i === 5))) holedFace(f.map((k) => c[k]), hs, ax, col);
      else quad(c[f[0]], c[f[1]], c[f[2]], c[f[3]], col);
    });
    if (edge) for (const [a, b] of EDGES) lines.push(c[a], c[b], edge);
  }
  // surfaces of revolution: a profile [[r, h]] round an axis (h along it) at a centre. Square (sq): the same profile
  // swept round a square instead (r its half side, the sides along the box's edges; seg a multiple of 8, so the
  // corners are on it)
  const lathe = (prof, at, dir, col, seg = 40, sq = false) => {
    const a = norm(dir), u = norm(Math.abs(a[1]) < 0.9 ? cross(a, [0, 1, 0]) : cross(a, [1, 0, 0])), v = cross(a, u);
    const k2 = (ph) => (sq ? 1 / Math.max(Math.abs(Math.cos(ph)), Math.abs(Math.sin(ph))) : 1);
    const P = (r, h, ph) => { const cs = Math.cos(ph) * k2(ph), sn = Math.sin(ph) * k2(ph); return [at[0] + a[0] * h + (u[0] * cs + v[0] * sn) * r, at[1] + a[1] * h + (u[1] * cs + v[1] * sn) * r, at[2] + a[2] * h + (u[2] * cs + v[2] * sn) * r]; };
    // (the way a side faces: out from the axis; on a square, straight out of the side it's on)
    const out = (pm) => { let c = Math.cos(pm), s = Math.sin(pm); if (sq) { if (Math.abs(c) > Math.abs(s)) { c = Math.sign(c); s = 0; } else { s = Math.sign(s); c = 0; } } return [c, s]; };
    for (let i = 0; i < prof.length - 1; i++) {
      const [r0, h0] = prof[i], [r1, h1] = prof[i + 1];
      const dr = r1 - r0, dh = h1 - h0, l = Math.hypot(dr, dh) || 1, nr = dh / l, nh = -dr / l;
      for (let k = 0; k < seg; k++) {
        const p0 = (k / seg) * 2 * Math.PI, p1 = ((k + 1) / seg) * 2 * Math.PI, pm = (p0 + p1) / 2, [oc, os] = out(pm);
        const n = [(u[0] * oc + v[0] * os) * nr + a[0] * nh, (u[1] * oc + v[1] * os) * nr + a[1] * nh, (u[2] * oc + v[2] * os) * nr + a[2] * nh];
        const A = P(r0, h0, p0), B = P(r0, h0, p1), Cc = P(r1, h1, p1), Dd = P(r1, h1, p0);
        tri(A, B, Cc, n, col); tri(A, Cc, Dd, n, col);
      }
    }
  };
  const toW = (d) => [d[0], d[1], -d[2]];          // a direction, layout -> world
  for (const s of L.subs) {
    const at = W(s.at), dir = toW(s.dir), S = subParts(s), z = S.z;
    const { rf, rc, rs1, rs0, rdc, cd } = S;
    const ring = [], sq = !!s.sq;                                                                                     // (square: frame, surround, cone, cutout)
    lathe([[rf, 0], [rf, 0.007], [rs1 + 0.004, 0.009], [rs1, 0.006]], at, dir, [0.2, 0.2, 0.23, 1], 40, sq);         // the frame
    for (let i = 0; i <= 8; i++) { const ph = (i / 8) * Math.PI; ring.push([(rs0 + rs1) / 2 + ((rs1 - rs0) / 2) * Math.cos(ph), 0.006 + ((rs1 - rs0) / 2) * 0.9 * Math.sin(ph)]); }
    lathe(ring, at, dir, [0.07, 0.07, 0.08, 1], 40, sq);                                                                 // the surround
    if (sq) lathe([[rs0, 0.006], [rs0 * 0.94, -cd * 0.35], [rdc * 1.05, -cd]], at, dir, [0.1, 0.1, 0.12, 1], 40, true);  // the cone (square, rounding to its centre)
    else lathe([[rs0, 0.006], [rdc * 1.05, -cd]], at, dir, [0.1, 0.1, 0.12, 1]);                                         // the cone
    const cap = []; for (let i = 0; i <= 6; i++) { const ph = (i / 6) * (Math.PI / 2); cap.push([rdc * Math.cos(ph), -cd + z * 0.035 * Math.sin(ph)]); }
    lathe([[rdc * 1.05, -cd], ...cap], at, dir, [0.16, 0.16, 0.19, 1]);                                                  // the dust cap
    // behind the wood: the basket down to the motor, then the motor (top plate, the magnet slugs, the back plate, the
    // vented pole), all the way back to the sub's mounting depth
    const back = -S.panel, md = S.depth, mr = S.dm / 2, front = -(md - S.motor);
    lathe([[rc, 0], [rc, back]], at, dir, [...FINISH.mdf.inner.map((v) => v * 0.8), 1], 40, sq);                      // the cutout's edge
    lathe([[rc * 0.97, back], [rc * 0.9, back - 0.006], [mr * 0.78, front]], at, dir, [0.27, 0.27, 0.31, 1], 32);           // the basket
    let h = front;
    const plateC = [0.55, 0.56, 0.6, 1], slugC = [0.12, 0.12, 0.14, 1];
    const disc = (r0, r1, h0, h1, col) => lathe([[r0, h0], [r1, h0], [r1, h1], [r0, h1], [r0, h0]], at, dir, col, 36);
    disc(mr * 0.3, mr * 0.9, h, h - S.plate, plateC); h -= S.plate;                                                     // top plate
    for (let i = 0; i < S.slugs; i++) {
      disc(mr * 0.32, mr, h, h - S.slugH, slugC);                                                                      // a magnet slug
      h -= S.slugH;
      if (i < S.slugs - 1) { disc(mr * 0.34, mr * 1.012, h, h - S.gap, plateC); h -= S.gap; }                          // the plate between slugs
    }
    disc(0.012, mr * 0.96, h, h - S.plate, plateC); h -= S.plate;                                                      // back plate
    lathe([[0.012, h], [0.012, h + 0.002], [0, h + 0.002]], at, dir, [0.05, 0.05, 0.06, 1], 18);                     // the pole vent
  }
  // the bracing: wooden dowels
  for (const p of L.parts) if (p.kind === "dowel") lathe([[p.r, 0], [p.r, p.len]], W(p.at), toW(p.dir), [0.86, 0.72, 0.52, 1], 18);
  for (const p of L.ports) for (const tb of p.tubes || []) {
    const at = W(tb.at), dir = toW(tb.dir), r = tb.r, w = 0.003;
    lathe([[r + w, 0], [r + w, tb.len], [r, tb.len], [r, 0]], at, dir, [0.16, 0.16, 0.18, 1], 32);
    lathe([[r, -0.002], [r + 0.022, -0.002], [r + 0.022, 0.001]], at, dir, [0.22, 0.22, 0.25, 1], 32);                  // the flare
    if (see || open) lathe([[r * 0.98, 0], [r * 0.98, tb.len]], at, dir, [...AIR, 0.28], 20);
  }
  // a faint floor grid under it
  const y = -L.H / 2 - 0.002, ext = Math.max(L.W, L.D) * 0.95, step = ext / 6;
  for (let i = -6; i <= 6; i++) {
    const a = 0.1 * (1 - Math.abs(i) / 7);
    lines.push([i * step, y, -ext], [i * step, y, ext], [0.6, 0.55, 1, a]);
    lines.push([-ext, y, i * step], [ext, y, i * step], [0.6, 0.55, 1, a]);
  }
  return { opaque: new Float32Array(opaque), clear, lines };
}

// ---------------------------------------------------------------------------------------------------- the view
const VS = `attribute vec3 p; attribute vec3 n; attribute vec4 c; uniform mat4 mvp; uniform mat4 mv; varying vec4 vc; varying vec3 vn;
void main() { gl_Position = mvp * vec4(p, 1.0); vn = (mv * vec4(n, 0.0)).xyz; vc = c; }`;
const FS = `precision mediump float; varying vec4 vc; varying vec3 vn; uniform float lit;
void main() {
  vec3 N = normalize(vn + vec3(1e-5));
  float d1 = abs(dot(N, normalize(vec3(-0.45, 0.75, 0.55)))), d2 = abs(dot(N, normalize(vec3(0.7, 0.1, 0.6))));
  float k = mix(1.0, 0.36 + 0.56 * d1 + 0.2 * d2, lit);
  gl_FragColor = vec4(vc.rgb * k, vc.a);
}`;

/** The 3D view in `canvas` (labels on `overlay`, a 2D canvas over it). */
export function boxView(canvas, overlay) {
  const V = { yaw: -0.62, pitch: 0.38, zoom: 1, mode: "solid", finish: "mdf", L: null, labels: [], vy: 0, vp: 0, raf: 0, mesh: null, dirty: true };
  let gl = null;
  try { gl = canvas.getContext("webgl", { antialias: true, alpha: true, premultipliedAlpha: false }) || canvas.getContext("experimental-webgl"); } catch {}
  let prog = null, buf = null, cbuf = null, lbuf = null, loc = {};
  const setup = () => {
    if (!gl) return;
    const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); return s; };
    prog = gl.createProgram(); gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS)); gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) { gl = null; return; }
    loc = { p: gl.getAttribLocation(prog, "p"), n: gl.getAttribLocation(prog, "n"), c: gl.getAttribLocation(prog, "c"), mvp: gl.getUniformLocation(prog, "mvp"), mv: gl.getUniformLocation(prog, "mv"), lit: gl.getUniformLocation(prog, "lit") };
    buf = gl.createBuffer(); cbuf = gl.createBuffer(); lbuf = gl.createBuffer();
    V.dirty = true;
  };
  setup();
  canvas.addEventListener("webglcontextlost", (e) => e.preventDefault());
  canvas.addEventListener("webglcontextrestored", () => { setup(); draw(); });

  const size = () => {
    const r = canvas.getBoundingClientRect(), dpr = Math.min(2, devicePixelRatio || 1);
    const w = Math.max(1, Math.round(r.width * dpr)), h = Math.max(1, Math.round(r.height * dpr));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    if (overlay && (overlay.width !== w || overlay.height !== h)) { overlay.width = w; overlay.height = h; }
    return { w, h, dpr, cw: r.width, ch: r.height };
  };
  const matrices = (asp) => {
    const L = V.L, rad = 0.5 * Math.hypot(L.W, L.H, L.D);
    const dist = (rad / Math.sin((34 * Math.PI) / 360)) * 1.08 / V.zoom;
    const mv = mul4(trans(0, -rad * 0.04, -dist), mul4(rotX(V.pitch), rotY(V.yaw)));
    const pr = persp((34 * Math.PI) / 180, asp, dist * 0.05, dist * 4);
    return { mv, mvp: mul4(pr, mv) };
  };
  const attrib = (stride) => {
    gl.enableVertexAttribArray(loc.p); gl.vertexAttribPointer(loc.p, 3, gl.FLOAT, false, stride * 4, 0);
    gl.enableVertexAttribArray(loc.n); gl.vertexAttribPointer(loc.n, 3, gl.FLOAT, false, stride * 4, 12);
    gl.enableVertexAttribArray(loc.c); gl.vertexAttribPointer(loc.c, 4, gl.FLOAT, false, stride * 4, 24);
  };
  function draw() {
    V.raf = 0;
    if (!V.L || !canvas.isConnected) return;
    const { w, h, dpr, cw, ch } = size();
    if (cw < 2 || ch < 2) return;
    if (V.dirty) { V.mesh = build(V.L, V.mode, V.finish, V.paint); V.dirty = false; V.uploaded = false; }
    const { mv, mvp } = matrices(w / h);
    if (gl) {
      gl.viewport(0, 0, w, h); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      gl.useProgram(prog); gl.uniformMatrix4fv(loc.mvp, false, mvp); gl.uniformMatrix4fv(loc.mv, false, mv);
      gl.enable(gl.DEPTH_TEST); gl.disable(gl.CULL_FACE); gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      if (!V.uploaded) {
        gl.bindBuffer(gl.ARRAY_BUFFER, buf); gl.bufferData(gl.ARRAY_BUFFER, V.mesh.opaque, gl.STATIC_DRAW);
        const lf = []; for (let i = 0; i < V.mesh.lines.length; i += 3) { const [a, b, c] = [V.mesh.lines[i], V.mesh.lines[i + 1], V.mesh.lines[i + 2]]; lf.push(...a, 0, 0, 0, ...c, ...b, 0, 0, 0, ...c); }
        V.lineData = new Float32Array(lf);
        gl.bindBuffer(gl.ARRAY_BUFFER, lbuf); gl.bufferData(gl.ARRAY_BUFFER, V.lineData, gl.STATIC_DRAW);
        V.uploaded = true;
      }
      // solid things
      gl.depthMask(true); gl.uniform1f(loc.lit, 1);
      gl.bindBuffer(gl.ARRAY_BUFFER, buf); attrib(10); gl.drawArrays(gl.TRIANGLES, 0, V.mesh.opaque.length / 10);
      // panel edges and the floor
      gl.uniform1f(loc.lit, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, lbuf); attrib(10); gl.drawArrays(gl.LINES, 0, V.lineData.length / 10);
      // see-through things, back to front
      if (V.mesh.clear.length) {
        const zs = V.mesh.clear.map((t) => mv[2] * t.c[0] + mv[6] * t.c[1] + mv[10] * t.c[2]);
        const order = zs.map((z, i) => i).sort((a, b) => zs[a] - zs[b]);
        const d = new Float32Array(order.length * 30); order.forEach((k, i) => d.set(V.mesh.clear[k].v, i * 30));
        gl.depthMask(false); gl.uniform1f(loc.lit, 1);
        gl.bindBuffer(gl.ARRAY_BUFFER, cbuf); gl.bufferData(gl.ARRAY_BUFFER, d, gl.DYNAMIC_DRAW); attrib(10);
        gl.drawArrays(gl.TRIANGLES, 0, order.length * 3);
        gl.depthMask(true);
      }
    }
    // labels (and, without WebGL, the whole box as lines)
    if (overlay) {
      const g = overlay.getContext("2d"); g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, w, h);
      const proj = (p) => { const q = xf(mvp, p); return q[3] > 0 ? [((q[0] / q[3]) * 0.5 + 0.5) * w, (0.5 - (q[1] / q[3]) * 0.5) * h] : null; };
      if (!gl) {
        g.lineWidth = dpr;
        for (let i = 0; i < V.mesh.lines.length; i += 3) {
          const a = proj(V.mesh.lines[i]), b = proj(V.mesh.lines[i + 1]), c = V.mesh.lines[i + 2];
          if (!a || !b) continue;
          g.strokeStyle = `rgba(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)},${Math.max(0.25, c[3])})`;
          g.beginPath(); g.moveTo(a[0], a[1]); g.lineTo(b[0], b[1]); g.stroke();
        }
        g.strokeStyle = "rgba(220,210,255,0.8)";
        for (const s of V.L.subs) {
          const Lw = V.L, at = [s.at[0] - Lw.W / 2, s.at[1] - Lw.H / 2, (Lw.D + Lw.Dt) / 4 - s.at[2]], d = [s.dir[0], s.dir[1], -s.dir[2]];
          const u = norm(Math.abs(d[1]) < 0.9 ? cross(d, [0, 1, 0]) : cross(d, [1, 0, 0])), v = cross(d, u);
          for (const r of [s.size / 2, s.size * 0.17]) {
            g.beginPath();
            for (let k = 0; k <= 32; k++) { const ph = (k / 32) * 2 * Math.PI, q = proj([at[0] + (u[0] * Math.cos(ph) + v[0] * Math.sin(ph)) * r, at[1] + (u[1] * Math.cos(ph) + v[1] * Math.sin(ph)) * r, at[2] + (u[2] * Math.cos(ph) + v[2] * Math.sin(ph)) * r]); if (q) (k ? g.lineTo(q[0], q[1]) : g.moveTo(q[0], q[1])); }
            g.stroke();
          }
        }
      }
      g.font = `700 ${Math.round(11.5 * dpr)}px Inter, system-ui, sans-serif`; g.textAlign = "center"; g.textBaseline = "middle";
      for (const lb of V.labels) {
        const q = proj(lb.p); if (!q) continue;
        const tw = g.measureText(lb.text).width + 14 * dpr, th = 20 * dpr;
        g.fillStyle = "rgba(14,11,40,0.82)"; g.strokeStyle = "rgba(170,140,255,0.55)"; g.lineWidth = dpr;
        const x = q[0] - tw / 2, y = q[1] - th / 2, r = th / 2;
        g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + tw, y, x + tw, y + th, r); g.arcTo(x + tw, y + th, x, y + th, r); g.arcTo(x, y + th, x, y, r); g.arcTo(x, y, x + tw, y, r); g.closePath(); g.fill(); g.stroke();
        g.fillStyle = "#fff"; g.fillText(lb.text, q[0], q[1] + 0.5);
      }
    }
    // still turning after a flick
    if (Math.abs(V.vy) > 1e-4 || Math.abs(V.vp) > 1e-4) {
      if (!V.held) { V.yaw += V.vy; V.pitch = clampP(V.pitch + V.vp); V.vy *= 0.93; V.vp *= 0.93; }
      if (!V.held) req();
    }
  }
  const req = () => { if (!V.raf) V.raf = requestAnimationFrame(draw); };
  const clampP = (p) => Math.max(-1.45, Math.min(1.45, p));

  // turning, zooming, resetting
  const pts = new Map(); let pinch0 = 0, zoom0 = 1, lastTap = 0, moved = 0;
  canvas.addEventListener("pointerdown", (e) => {
    canvas.setPointerCapture && canvas.setPointerCapture(e.pointerId);
    pts.set(e.pointerId, [e.clientX, e.clientY]); V.held = true; V.vy = V.vp = 0; moved = 0;
    if (pts.size === 2) { const [a, b] = [...pts.values()]; pinch0 = Math.hypot(a[0] - b[0], a[1] - b[1]); zoom0 = V.zoom; }
  });
  canvas.addEventListener("pointermove", (e) => {
    const p = pts.get(e.pointerId); if (!p) return;
    const dx = e.clientX - p[0], dy = e.clientY - p[1]; pts.set(e.pointerId, [e.clientX, e.clientY]);
    if (pts.size === 1) { V.yaw += dx * 0.009; V.pitch = clampP(V.pitch + dy * 0.009); V.vy = dx * 0.009; V.vp = dy * 0.009; moved += Math.abs(dx) + Math.abs(dy); }
    else if (pts.size === 2 && pinch0) { const [a, b] = [...pts.values()]; V.zoom = Math.max(0.45, Math.min(3.5, zoom0 * (Math.hypot(a[0] - b[0], a[1] - b[1]) / pinch0))); moved += 10; }
    req();
  });
  const up = (e) => {
    pts.delete(e.pointerId);
    if (pts.size) return;
    V.held = false; pinch0 = 0;
    const now = performance.now();
    if (moved < 6) { if (now - lastTap < 320) { api.reset(); lastTap = 0; } else lastTap = now; }
    req();
  };
  canvas.addEventListener("pointerup", up); canvas.addEventListener("pointercancel", up);
  canvas.addEventListener("wheel", (e) => { e.preventDefault(); V.zoom = Math.max(0.45, Math.min(3.5, V.zoom * Math.exp(-e.deltaY * 0.0015))); req(); }, { passive: false });
  if ("ResizeObserver" in window) new ResizeObserver(() => req()).observe(canvas);

  const api = {
    webgl: !!gl,
    state: V,
    /** A new box (and its dimension labels: [{ p: [x, y, z] in the layout's coordinates, text }]). */
    show(L, labels = []) {
      V.L = L; V.dirty = true;
      V.labels = labels.map((l) => ({ text: l.text, p: [l.p[0] - L.W / 2, l.p[1] - L.H / 2, (L.D + L.Dt) / 4 - l.p[2]] }));
      req();
    },
    setMode(m) { V.mode = m; V.dirty = true; req(); },
    setFinish(f, paint) { V.finish = f; if (paint) V.paint = paint; V.dirty = true; req(); },
    /** A picture of the box (as it's turned now) with its name under it, for sharing: a square JPEG. */
    snapshot(title = "", lines = []) {
      if (!V.L) return Promise.resolve(null);
      draw();                                                   // (drawn now, so the picture can be read straight away)
      const S = 1080, c = document.createElement("canvas"); c.width = c.height = S;
      const g = c.getContext("2d");
      const bg = g.createLinearGradient(0, 0, 0, S); bg.addColorStop(0, "#1a1446"); bg.addColorStop(1, "#08071a");
      g.fillStyle = bg; g.fillRect(0, 0, S, S);
      const glow = g.createRadialGradient(S / 2, S * 0.38, 20, S / 2, S * 0.38, S * 0.55); glow.addColorStop(0, "rgba(122,75,255,0.35)"); glow.addColorStop(1, "rgba(122,75,255,0)");
      g.fillStyle = glow; g.fillRect(0, 0, S, S);
      // the box: as big as it fits above the words
      const area = { x: 40, y: 40, w: S - 80, h: S - 300 }, k = Math.min(area.w / canvas.width, area.h / canvas.height);
      const w = canvas.width * k, h = canvas.height * k, x = area.x + (area.w - w) / 2, y = area.y + (area.h - h) / 2;
      try { g.drawImage(canvas, x, y, w, h); if (overlay) g.drawImage(overlay, x, y, w, h); } catch {}
      // the words
      const line = g.createLinearGradient(80, 0, S - 80, 0); line.addColorStop(0, "#2f78ff"); line.addColorStop(0.55, "#7a4bff"); line.addColorStop(1, "#bb4dff");
      g.fillStyle = line; g.fillRect(80, S - 250, S - 160, 4);
      g.fillStyle = "#fff"; g.textBaseline = "top"; g.font = "700 50px Sora, Inter, system-ui, sans-serif";
      g.fillText(title.slice(0, 38), 80, S - 225);
      g.fillStyle = "rgba(220,215,255,0.85)"; g.font = "500 33px Inter, system-ui, sans-serif";
      lines.slice(0, 3).forEach((t, i) => g.fillText(String(t).slice(0, 56), 80, S - 160 + i * 44));
      return new Promise((res) => c.toBlob((b) => res(b), "image/jpeg", 0.9));
    },
    reset() { V.yaw = -0.62; V.pitch = 0.38; V.zoom = 1; V.vy = V.vp = 0; req(); },
    redraw: req,
    /** For tests: how many solid and see-through triangles it drew. */
    counts() { return V.mesh ? { opaque: V.mesh.opaque.length / 30, clear: V.mesh.clear.length, lines: V.mesh.lines.length / 3 } : null; },
  };
  return api;
}
