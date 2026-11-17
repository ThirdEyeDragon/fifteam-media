// The player's sound path and its tone knobs: BASS, MIDS and HIGHS, each 0 to 10. 0 silences that band completely, 5
// leaves the song exactly as it is, 10 is that band as loud as it goes (+12 dB). Any band can also be muted (hold its
// knob): gone completely, the other bands' filters made twice as steep at its edges so nothing of it leaks through.
// Each knob changes its own band and nothing else: no overall volume change, no compressor, and the other bands keep
// exactly their level whatever this one does.
//   Until a knob first leaves 5, the song is not routed through anything at all. After that:
//   all three at 5 -> straight to the speakers, untouched, bit for bit;
//   otherwise -> the crossover (Linkwitz-Riley, 48 dB/octave, at 250 Hz and 4 kHz; the bands add back up to the song
//   exactly), each band at its own level, put back together by the band guard (limiter-worklet.js): a band turned up
//   that would clip is held back, that band only, for that moment.
import { getCtx, dbToLinSafe } from "./ui.js";

const KEY = "fifteam-eq2", KEY_MUTE = "fifteam-mute";
const st = { vals: { bass: 5, mids: 5, highs: 5 }, mute: { bass: false, mids: false, highs: false }, audio: null, ctx: null, src: null, bands: null, guard: null, loading: false, route: "untouched" };
try { const s = JSON.parse(localStorage.getItem(KEY) || "null"); if (s) Object.assign(st.vals, s); } catch {}
try { const s = JSON.parse(localStorage.getItem(KEY_MUTE) || "null"); if (s) Object.assign(st.mute, s); } catch {}

const isFive = (v) => Math.abs(v - 5) < 1e-6;
/** A knob's setting as a gain: 0 is silence, 5 exactly unity, 10 four times (+12 dB). Below 5 it fades like a volume knob. */
export function gainOf(v) {
  if (v <= 0) return 0;
  if (isFive(v)) return 1;
  if (v < 5) return Math.pow(v / 5, 1.6);
  return dbToLinSafe((v - 5) * 2.4);
}
export function describe(v) {
  if (v <= 0) return "off";
  if (Math.abs(v - 5) < 0.05) return "normal";
  const db = 20 * Math.log10(gainOf(v));
  return `${db > 0 ? "+" : "−"}${Math.abs(db).toFixed(1)} dB`;
}
const BANDS = ["bass", "mids", "highs"];
const flat = () => BANDS.every((b) => isFive(st.vals[b]) && !st.mute[b]);

// 4th-order Butterworth: two sections. Squared (Linkwitz-Riley, 8th order) a low and a high add up to an allpass.
const QS = [1 / (2 * Math.cos(Math.PI / 8)), 1 / (2 * Math.cos((3 * Math.PI) / 8))];   // 0.5412, 1.3066

/**
 * The crossover and the band gains, on any audio context: { input, set(vals, now, mute), connect(dest, guard) }.
 * With a guard (the band worklet) the three bands go into it, each with its gain as the guard's parameter; without one
 * they are summed through plain gains.
 */
export function makeBands(ctx) {
  // (for lowpass and highpass, Web Audio takes Q in decibels; allpass takes it plain)
  const bq = (type, f, q) => {
    const b = ctx.createBiquadFilter(); b.type = type; b.frequency.value = f;
    b.Q.value = type === "lowpass" || type === "highpass" ? 20 * Math.log10(q) : q;
    return b;
  };
  const lr8 = (type, f) => [bq(type, f, QS[0]), bq(type, f, QS[1]), bq(type, f, QS[0]), bq(type, f, QS[1])];
  const ap4 = (f) => [bq("allpass", f, QS[0]), bq("allpass", f, QS[1])];
  const chain = (...nodes) => { nodes = nodes.flat(); for (let i = 0; i + 1 < nodes.length; i++) nodes[i].connect(nodes[i + 1]); return nodes[nodes.length - 1]; };
  // a stage that is either nothing or the same filters once more (a band's neighbour off: its edge made twice as steep)
  const kill = (from, filters) => {
    const out = ctx.createGain(), gd = ctx.createGain(), gk = ctx.createGain();
    from.connect(gd).connect(out);
    chain(from, filters, gk).connect(out);
    gk.gain.value = 0;
    return { out, gd, gk };
  };
  const F1 = 250, F2 = 4000;
  const input = ctx.createGain();
  // low band: below 250 Hz, plus the 4 kHz crossover's allpass so it stays in phase with the other two
  const kLow = kill(chain(input, lr8("lowpass", F1), ap4(F2)), lr8("lowpass", F1));
  // turned up, the bass gets a punch round 55 Hz as well (the "artificial" bass): kept apart as what it adds, so the
  // guard can hold it back with the rest of the bass boost
  const punch = bq("peaking", 55, 1.1), inv = ctx.createGain(), added = ctx.createGain();
  punch.gain.value = 0; inv.gain.value = -1;
  kLow.out.connect(punch).connect(added); kLow.out.connect(inv).connect(added);
  // the rest, split again at 4 kHz
  const rest = chain(input, lr8("highpass", F1));
  const kMidLo = kill(chain(rest, lr8("lowpass", F2)), lr8("highpass", F1));
  const kMidHi = kill(kMidLo.out, lr8("lowpass", F2));
  const kHigh = kill(chain(rest, lr8("highpass", F2)), lr8("highpass", F2));
  const outs = [kLow.out, kMidHi.out, kHigh.out, added];
  // without the guard: plain gains, summed (the bass with its punch)
  const gains = [punch, kMidHi.out, kHigh.out].map((o) => { const g = ctx.createGain(); o.connect(g); return g; });
  const sum = ctx.createGain();
  gains.forEach((g) => g.connect(sum));
  let guard = null;
  return {
    input,
    /** Sends the bands to `dest`, through `guard` if there is one (the band worklet). */
    connect(dest, withGuard) {
      for (const n of [sum, guard]) if (n) try { n.disconnect(); } catch {}
      if (guard) outs.forEach((o, i) => { try { o.disconnect(guard, 0, i); } catch {} });
      guard = withGuard || null;
      if (guard) { outs.forEach((o, i) => o.connect(guard, 0, i)); guard.connect(dest); }
      else sum.connect(dest);
    },
    disconnect() {
      for (const n of [sum, guard]) if (n) try { n.disconnect(); } catch {}
    },
    set(vals, now, mute = {}) {
      const t = ctx.currentTime, tc = now ? 0.0005 : 0.035;
      const gl = mute.bass ? 0 : gainOf(vals.bass), gm = mute.mids ? 0 : gainOf(vals.mids), gh = mute.highs ? 0 : gainOf(vals.highs);
      const at = (p, v) => (now ? p.setValueAtTime(v, t) : p.setTargetAtTime(v, t, tc));
      [gl, gm, gh].forEach((v, i) => at(gains[i].gain, v));
      if (guard) { at(guard.parameters.get("low"), gl); at(guard.parameters.get("mid"), gm); at(guard.parameters.get("high"), gh); }
      // a band that is off: its neighbours' filters doubled at its edges, so not even their skirts carry any of it
      const engage = (k, on) => { at(k.gd.gain, on ? 0 : 1); at(k.gk.gain, on ? 1 : 0); };
      engage(kMidLo, gl === 0); engage(kLow, gm === 0); engage(kHigh, gm === 0); engage(kMidHi, gh === 0);
      // the bass's punch (inside the bass band)
      at(punch.gain, gl > 0 ? Math.max(0, (vals.bass - 5) * 1.2) : 0);
    },
  };
}

/** The band guard (see limiter-worklet.js), once its module has loaded on this context. */
export async function makeGuard(ctx) {
  await ctx.audioWorklet.addModule(new URL("./limiter-worklet.js", import.meta.url).href);
  return new AudioWorkletNode(ctx, "fifteam-bands", { numberOfInputs: 4, numberOfOutputs: 1, outputChannelCount: [2] });
}

function ensureSource() {
  if (st.src) return true;
  if (!st.audio) return false;
  st.ctx = getCtx();
  try { if (navigator.audioSession) navigator.audioSession.type = "playback"; } catch {}
  st.src = st.ctx.createMediaElementSource(st.audio);
  st.bands = makeBands(st.ctx);
  st.audio.addEventListener("play", () => { if (st.ctx.state !== "running") st.ctx.resume(); });
  loadGuard();
  return true;
}
function loadGuard() {
  if (st.guard || st.loading || !st.ctx || !st.ctx.audioWorklet) return;
  st.loading = true;
  makeGuard(st.ctx).then((g) => { st.guard = g; if (!flat()) rewire(); }).catch(() => {}).finally(() => { st.loading = false; });
}
function rewire() {
  if (!st.src) { if (flat()) return; if (!ensureSource()) return; }
  const { ctx, src, bands } = st;
  try { src.disconnect(); } catch {}
  bands.disconnect();
  if (flat()) { src.connect(ctx.destination); st.route = "direct"; return; }   // 5 / 5 / 5: the song itself, nothing in between
  src.connect(bands.input);
  bands.connect(ctx.destination, st.guard);
  bands.set(st.vals, true, st.mute);
  st.route = st.guard ? "bands+guard" : "bands";
}

export const eq = {
  get values() { return { ...st.vals }; },
  isMuted(band) { return !!st.mute[band]; },
  get route() { return st.route; },
  attach(audio) { st.audio = audio; },
  /** Call from a tap or from play (phones need a gesture before sound can be processed). */
  engageIfNeeded() {
    if (!st.src) { if (!flat()) rewire(); }
    else if (st.ctx.state !== "running") st.ctx.resume();
  },
  set(band, v) {
    const wasFlat = flat();
    st.vals[band] = v;
    try { localStorage.setItem(KEY, JSON.stringify(st.vals)); } catch {}
    if (!st.src || wasFlat !== flat()) rewire();
    else st.bands.set(st.vals, false, st.mute);
  },
  setMute(band, on) {
    const wasFlat = flat();
    st.mute[band] = !!on;
    try { localStorage.setItem(KEY_MUTE, JSON.stringify(st.mute)); } catch {}
    if (!st.src || wasFlat !== flat()) rewire();
    else st.bands.set(st.vals, false, st.mute);
  },
};
