// FifTeam Media - the bass separator, inside the rebass worker. Demucs v4 (the bass model of htdemucs_ft) runs through
// ONNX Runtime: on the phone's graphics chip (WebGPU) when it has one, otherwise on its processor. Its files (about
// 51 MB) are downloaded the first time and kept on the phone, so after that it works offline too.
// The network runs as 16 stages one after another (models/README.txt): ONNX Runtime hands a run's in-between memory
// back only when the run ends, so one run per 7.8 s piece held about 2.4 GB on the graphics chip (on a phone, the
// phone's own memory) and kept the chip busy for seconds at a time. Stage by stage it holds a few hundred MB, and
// between stages the chip is left free for a moment, so the phone's screens and apps stay smooth.
//   separate(chs, sr, { progress(stage, p), cancelled() }) -> [left, right] the song's bass, at sr
import { separateBass, SEG, NB, LE } from "./demucs.js";

const ROOT = new URL("../", import.meta.url).href;
const CACHE = "fifteam-sep-1";
const FILES = [
  { key: "wasm", path: "vendor/ort/ort-wasm-simd-threaded.asyncify.wasm.gz", size: 7103195 },
  { key: "graph", path: "models/bass-sep.stages.gz", size: 152132 },
  { key: "q8", path: "models/bass-sep.q8", size: 43702127 },
];
export const DOWNLOAD_MB = Math.round(FILES.reduce((a, f) => a + f.size, 0) / 1e6);

let ort = null, plan = null, backend = "", queue = null;
const GPU_REST = 0.33;

/** Are the separator's files already on this phone? */
export async function isKept() {
  try {
    const c = await caches.open(CACHE);
    for (const f of FILES) if (!(await c.match(new URL(f.path, ROOT).href))) return false;
    return true;
  } catch { return false; }
}

const isGz = (u8) => u8.length > 2 && u8[0] === 0x1f && u8[1] === 0x8b;
async function gunzip(u8) {
  return new Uint8Array(await new Response(new Blob([u8]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer());
}

async function getFile(f, onBytes) {
  const url = new URL(f.path, ROOT).href;
  let cache = null;
  try { cache = await caches.open(CACHE); } catch {}
  let hit = cache ? await cache.match(url) : null;
  let u8;
  if (hit) { u8 = new Uint8Array(await hit.arrayBuffer()); onBytes(f.size); }
  else {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error("download");
    const reader = res.body.getReader(), parts = [];
    let got = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value); got += value.length; onBytes(Math.min(got, f.size));
    }
    u8 = new Uint8Array(got);
    let o = 0; for (const p of parts) { u8.set(p, o); o += p.length; }
    check(f, isGz(u8) ? await gunzip(u8) : u8);   // a cut-off download is never kept
    if (cache) try { await cache.put(url, new Response(u8)); } catch {}
  }
  return isGz(u8) ? gunzip(u8) : u8;
}
function check(f, u8) {
  if (f.key === "wasm" && !(u8[0] === 0 && u8[1] === 0x61 && u8[2] === 0x73 && u8[3] === 0x6d)) throw new Error("download");
  if (f.key === "graph") readStages(u8);
  if (f.key === "q8") {
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    if (u8.length < 8 || dv.getUint32(0, true) !== 0x38515446) throw new Error("download");
    const hdr = JSON.parse(new TextDecoder().decode(u8.subarray(8, 8 + dv.getUint32(4, true))));
    const need = 8 + dv.getUint32(4, true) + hdr.t.reduce((a, t) => a + t.b, 0);
    if (u8.length !== need) throw new Error("download");
  }
}

// half floats to floats
const H2F = new Float32Array(65536);
for (let h = 0; h < 65536; h++) {
  const s = h & 0x8000 ? -1 : 1, e = (h >> 10) & 31, m = h & 1023;
  H2F[h] = e === 0 ? s * m * 2 ** -24 : e === 31 ? (m ? NaN : s * Infinity) : s * (1 + m / 1024) * 2 ** (e - 15);
}

/** The compact weights back to the fp32 block the graph points at (see models/README.txt). */
function expand(q8) {
  const dv = new DataView(q8.buffer, q8.byteOffset, q8.byteLength);
  const hl = dv.getUint32(4, true);
  const hdr = JSON.parse(new TextDecoder().decode(q8.subarray(8, 8 + hl)));
  const out = new Float32Array(hdr.bytes32 / 4);
  let p = 8 + hl;
  for (const t of hdr.t) {
    const o = t.o / 4, n = t.n;
    if (t.rows) {
      const rows = t.rows, cols = n / rows, blk = t.blk, nb = Math.ceil(cols / blk), ns = rows * nb;
      const sc = new Float32Array(ns);
      for (let i = 0; i < ns; i++) sc[i] = H2F[dv.getUint16(p + 2 * i, true)];
      p += 2 * ns;
      const q = new Int8Array(q8.buffer, q8.byteOffset + p, n);
      p += n;
      if (!t.sw) {
        for (let r = 0; r < rows; r++) { const base = r * cols, sb = r * nb; for (let c = 0; c < cols; c++) out[o + base + c] = q[base + c] * sc[sb + ((c / blk) | 0)]; }
      } else {
        // kept output-channel first; the graph wants (in, out, ...) for these
        const d1 = t.d1, K = n / (t.d0 * d1);
        for (let r = 0; r < rows; r++) { const base = r * cols, sb = r * nb; for (let c = 0; c < cols; c++) { const i = (c / K) | 0; out[o + i * d1 * K + r * K + (c - i * K)] = q[base + c] * sc[sb + ((c / blk) | 0)]; } }
      }
    } else {
      for (let i = 0; i < n; i++) out[o + i] = H2F[dv.getUint16(p + 2 * i, true)];
      p += 2 * n;
    }
  }
  return new Uint8Array(out.buffer);
}

/** The staged network: "FTST", the header's length, the header { stages: [{ len, inputs, outputs }], outputs, last:
 * { tensor: the stage that uses it last } }, then each stage's ONNX bytes. */
function readStages(u8) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  if (u8.length < 8 || dv.getUint32(0, true) !== 0x54535446) throw new Error("download");
  const hl = dv.getUint32(4, true), hdr = JSON.parse(new TextDecoder().decode(u8.subarray(8, 8 + hl)));
  let p = 8 + hl;
  for (const st of hdr.stages) { st.bytes = u8.subarray(p, p + st.len); p += st.len; }
  if (p !== u8.length) throw new Error("download");
  return hdr;
}

// the graphics chip's queue (seen as ONNX Runtime sends it work), to wait for it to finish a stage
function watchQueue() {
  if (!self.GPUQueue || GPUQueue.prototype.__ftWatched) return;
  const submit = GPUQueue.prototype.submit;
  GPUQueue.prototype.submit = function (cbs) { queue = this; return submit.call(this, cbs); };
  GPUQueue.prototype.__ftWatched = true;
}

async function release() {
  if (plan) for (const st of plan.stages) if (st.session) { try { await st.session.release(); } catch {} st.session = null; }
}

async function start(progress, forceCpu) {
  if (plan && plan.stages[0].session && (!forceCpu || backend === "wasm")) return;
  const total = FILES.reduce((a, f) => a + f.size, 0);
  const got = {}, data = {};
  const kept = await isKept();
  for (const f of FILES) {
    data[f.key] = await getFile(f, (b) => {
      got[f.key] = b;
      if (!kept) progress("model", Object.values(got).reduce((a, v) => a + v, 0) / total);
    });
  }
  progress("start", 0);
  if (!ort) {
    ort = await import(new URL("vendor/ort/ort.webgpu.min.mjs", ROOT).href);
    ort.env.wasm.wasmPaths = new URL("vendor/ort/", ROOT).href;
    // on the processor, it leaves the phone most of its cores (3 of 8), so everything else on it stays quick
    const cores = navigator.hardwareConcurrency || 2;
    ort.env.wasm.numThreads = self.crossOriginIsolated ? (cores >= 8 ? 3 : cores >= 6 ? 2 : 1) : 1;
    ort.env.logLevel = "error";
  }
  ort.env.wasm.wasmBinary = data.wasm;
  let weights = expand(data.q8);
  data.q8 = null;
  await release();
  plan = readStages(data.graph);
  const finals = new Set(plan.outputs);
  // every stage takes its own weights from the one expanded block; on the graphics chip what passes between stages
  // stays there, only the network's two outputs come back. On the processor its threads wait asleep (not spinning),
  // and memory goes back after each stage rather than into a pool kept per stage.
  const make = (ep, st, gpu) => ort.InferenceSession.create(st.bytes, {
    executionProviders: [ep], graphOptimizationLevel: "all", enableCpuMemArena: false,
    externalData: [{ path: "bass-sep.weights", data: weights }],
    ...(gpu ? { preferredOutputLocation: Object.fromEntries(st.outputs.map((k) => [k, finals.has(k) ? "cpu" : "gpu-buffer"])) } : {}),
    extra: { session: { intra_op: { allow_spinning: "0" }, inter_op: { allow_spinning: "0" } } },
  });
  // each stage is made just before its first run (making them all at once held every stage's weights twice on the
  // graphics chip for a moment); the expanded weights go once the last one is made
  const lazy = (ep, gpu) => {
    plan.make = async (st) => {
      st.session = await make(ep, st, gpu);
      if (plan.stages.every((x) => x.session)) { weights = null; plan.make = null; }
    };
  };
  backend = "";
  if (!forceCpu && self.navigator && navigator.gpu) {
    watchQueue();
    try {
      if (await navigator.gpu.requestAdapter()) {
        // (in-between buffers handed back at the end of each stage, not kept in a pool)
        lazy({ name: "webgpu", storageBufferCacheMode: "lazyRelease" }, true);
        await plan.make(plan.stages[0]);
        backend = "webgpu";
      }
    } catch { await release(); }
  }
  if (!backend) { lazy("wasm", false); await plan.make(plan.stages[0]); backend = "wasm"; }
  progress("start", 1);
}

/** One 7.8 s piece through the network, stage by stage: { z, xt }. */
async function runNet(seg, sp, cancelled) {
  const finals = new Set(plan.outputs);
  const vals = { mix: new ort.Tensor("float32", seg, [1, 2, SEG]), spec: new ort.Tensor("float32", sp, [1, 4, NB, LE]) };
  const drop = (k) => { const v = vals[k]; delete vals[k]; if (v && v.location === "gpu-buffer") v.dispose(); };
  try {
    for (let s = 0; s < plan.stages.length; s++) {
      if (cancelled()) throw new Error("cancelled");
      const st = plan.stages[s], t1 = performance.now();
      if (!st.session) await plan.make(st);
      const o = await st.session.run(Object.fromEntries(st.inputs.map((k) => [k, vals[k]])));
      for (const k of st.outputs) vals[k] = o[k];
      for (const k of st.inputs) if (plan.last[k] === s && !finals.has(k)) drop(k);
      // on the graphics chip: wait for it to finish this stage, then leave it free for a third as long again, so the
      // phone's own screens and apps get it too (and it stays cool)
      if (backend === "webgpu") {
        if (queue) await queue.onSubmittedWorkDone();
        await new Promise((r) => setTimeout(r, Math.min(250, (performance.now() - t1) * GPU_REST)));
      }
    }
    return { z: vals.zspec.data, xt: vals.xt.data };
  } finally {
    for (const k of Object.keys(vals)) if (!finals.has(k)) drop(k);
  }
}

/** The song's bass: [left, right] at sr. Throws "cancelled" if cancelled() turns true. */
export async function separate(chs, sr, { progress = () => {}, cancelled = () => false } = {}) {
  await start(progress, false);
  for (let attempt = 0; attempt < 2; attempt++) {
    let first = true, t0 = 0;
    const run = async (seg, sp) => {
      const { z, xt } = await runNet(seg, sp, cancelled);
      if (first) {
        first = false;
        // a graphics chip that gets it wrong: everything again on the processor
        for (let i = 0; i < xt.length; i += 997) if (!Number.isFinite(xt[i])) throw new Error("bad-gpu");
        for (let i = 0; i < z.length; i += 997) if (!Number.isFinite(z[i])) throw new Error("bad-gpu");
      }
      return { z, xt };
    };
    try {
      t0 = performance.now();
      const out = await separateBass(chs, sr, run, (p) => progress("separate", p, (performance.now() - t0) / 1000));
      return out;
    } catch (e) {
      // the graphics chip failed (wrong numbers, lost, out of memory): once more on the processor
      if (e.message === "cancelled" || attempt || backend !== "webgpu") throw e;
      await start(progress, true);
    }
  }
}

export const separatorBackend = () => backend;
