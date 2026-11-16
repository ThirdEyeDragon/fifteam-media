// The player's sound path and its tone knobs: BASS, MIDS and HIGHS, each 0 to 10. 0 silences that band completely, 5
// leaves the song exactly as it is, 10 is that band as loud as it goes (+12 dB). Any band can also be muted (hold its
// knob): gone completely, the other bands' filters made twice as steep at its edges so nothing of it leaks through.
//   Until a knob first leaves 5, the song is not routed through anything at all. After that:
//   all three at 5 -> straight to the speakers, untouched, bit for bit;
//   any knob below 5 -> the crossover (Linkwitz-Riley, 24 dB/octave, at 250 Hz and 4 kHz; the bands add back up to the
//   song exactly) with each band's level, and nothing else;
//   any knob above 5 -> the same, then a clean look-ahead limiter that does nothing unless a sample would clip.
//   (No compressor anywhere.)
import { getCtx, dbToLinSafe } from "./ui.js";

const KEY = "fifteam-eq2", KEY_MUTE = "fifteam-mute";
const st = { vals: { bass: 5, mids: 5, highs: 5 }, mute: { bass: false, mids: false, highs: false }, audio: null, ctx: null, src: null, bands: null, lim: null, limLoading: false, route: "untouched" };
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
const boosting = () => BANDS.some((b) => !st.mute[b] && st.vals[b] > 5 + 1e-6);

/** The crossover and the band gains, on any audio context: { input, output, set(vals, now, mute) }. */
export function makeBands(ctx) {
  // (for lowpass and highpass, Web Audio takes Q in decibels: a Butterworth's 0.707 is -3.01 dB; allpass takes it plain)
  const bq = (type, f, q = Math.SQRT1_2) => {
    const b = ctx.createBiquadFilter(); b.type = type; b.frequency.value = f;
    b.Q.value = type === "lowpass" || type === "highpass" ? 20 * Math.log10(q) : q;
    return b;
  };
  const chain = (...nodes) => { for (let i = 0; i + 1 < nodes.length; i++) nodes[i].connect(nodes[i + 1]); return nodes[nodes.length - 1]; };
  // a stage that is either nothing or two more filters (a band's neighbour off: its edge made twice as steep)
  const kill = (from, ...filters) => {
    const out = ctx.createGain(), gd = ctx.createGain(), gk = ctx.createGain();
    from.connect(gd).connect(out);
    chain(from, ...filters, gk).connect(out);
    gk.gain.value = 0;
    return { out, gd, gk };
  };
  const F1 = 250, F2 = 4000;
  const input = ctx.createGain();
  // low band: below 250 Hz, plus the 4 kHz crossover's allpass so it stays in phase with the other two
  const gLow = ctx.createGain(), gMid = ctx.createGain(), gHigh = ctx.createGain();
  const punch = bq("peaking", 55, 1.1);
  punch.gain.value = 0;
  const kLow = kill(chain(input, bq("lowpass", F1), bq("lowpass", F1), bq("allpass", F2), punch), bq("lowpass", F1), bq("lowpass", F1));
  kLow.out.connect(gLow);
  // the rest, split again at 4 kHz
  const rest = chain(input, bq("highpass", F1), bq("highpass", F1));
  const kMidLo = kill(chain(rest, bq("lowpass", F2), bq("lowpass", F2)), bq("highpass", F1), bq("highpass", F1));
  const kMidHi = kill(kMidLo.out, bq("lowpass", F2), bq("lowpass", F2));
  kMidHi.out.connect(gMid);
  const kHigh = kill(chain(rest, bq("highpass", F2), bq("highpass", F2)), bq("highpass", F2), bq("highpass", F2));
  kHigh.out.connect(gHigh);
  const sum = ctx.createGain(), trim = ctx.createGain();
  gLow.connect(sum); gMid.connect(sum); gHigh.connect(sum);
  sum.connect(trim);
  return {
    input, output: trim,
    set(vals, now, mute = {}) {
      const t = ctx.currentTime, tc = now ? 0.0005 : 0.035;
      const gl = mute.bass ? 0 : gainOf(vals.bass), gm = mute.mids ? 0 : gainOf(vals.mids), gh = mute.highs ? 0 : gainOf(vals.highs);
      const at = (p, v) => (now ? p.setValueAtTime(v, t) : p.setTargetAtTime(v, t, tc));
      at(gLow.gain, gl); at(gMid.gain, gm); at(gHigh.gain, gh);
      // a band that is off: its neighbours' filters doubled at its edges, so not even their skirts carry any of it
      const engage = (k, on) => { at(k.gd.gain, on ? 0 : 1); at(k.gk.gain, on ? 1 : 0); };
      engage(kMidLo, gl === 0); engage(kLow, gm === 0); engage(kHigh, gm === 0); engage(kMidHi, gh === 0);
      // turned up, the bass gets its punch round 55 Hz as well (the "artificial" bass)
      at(punch.gain, gl > 0 ? Math.max(0, (vals.bass - 5) * 1.2) : 0);
      // a boost turns the whole down by part of itself, so the limiter has little or nothing to do
      const boostDb = Math.max(0, ...[gl, gm, gh].map((g) => (g > 0 ? 20 * Math.log10(g) : -99)));
      at(trim.gain, dbToLinSafe(-boostDb * 0.6));
    },
  };
}

function ensureSource() {
  if (st.src) return true;
  if (!st.audio) return false;
  st.ctx = getCtx();
  try { if (navigator.audioSession) navigator.audioSession.type = "playback"; } catch {}
  st.src = st.ctx.createMediaElementSource(st.audio);
  st.bands = makeBands(st.ctx);
  st.audio.addEventListener("play", () => { if (st.ctx.state !== "running") st.ctx.resume(); });
  loadLimiter();
  return true;
}
function loadLimiter() {
  if (st.lim || st.limLoading || !st.ctx || !st.ctx.audioWorklet) return;
  st.limLoading = true;
  st.ctx.audioWorklet.addModule(new URL("./limiter-worklet.js", import.meta.url).href).then(() => {
    st.lim = new AudioWorkletNode(st.ctx, "fifteam-limiter", { outputChannelCount: [2] });
    if (boosting()) rewire();
  }).catch(() => {}).finally(() => { st.limLoading = false; });
}
function rewire() {
  if (!st.src) { if (flat()) return; if (!ensureSource()) return; }
  const { ctx, src, bands } = st;
  for (const n of [src, bands.output, st.lim]) if (n) try { n.disconnect(); } catch {}
  let tail;
  if (flat()) tail = src;                        // 5 / 5 / 5: the song itself, nothing in between
  else {
    src.connect(bands.input);
    bands.set(st.vals, true, st.mute);
    tail = bands.output;
    if (boosting() && st.lim) { tail.connect(st.lim); tail = st.lim; }
  }
  tail.connect(ctx.destination);
  st.route = flat() ? "direct" : boosting() && st.lim ? "bands+limiter" : "bands";
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
    const wasFlat = flat(), wasBoost = boosting();
    st.vals[band] = v;
    try { localStorage.setItem(KEY, JSON.stringify(st.vals)); } catch {}
    if (!st.src || wasFlat !== flat() || wasBoost !== boosting()) rewire();
    else st.bands.set(st.vals, false, st.mute);
  },
  setMute(band, on) {
    const wasFlat = flat(), wasBoost = boosting();
    st.mute[band] = !!on;
    try { localStorage.setItem(KEY_MUTE, JSON.stringify(st.mute)); } catch {}
    if (!st.src || wasFlat !== flat() || wasBoost !== boosting()) rewire();
    else st.bands.set(st.vals, false, st.mute);
  },
};
