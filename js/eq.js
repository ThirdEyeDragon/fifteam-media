// The player's tone knobs: BASS, MIDS and HIGHS, each 0 to 10. 0 silences that band completely, 5 is the song as it
// is, 10 is that band as loud as it goes (+12 dB). The song is split three ways the way a car amplifier's crossover
// does it (Linkwitz-Riley, 24 dB per octave, at 250 Hz and 4 kHz): at 5 the three bands add back up to exactly the
// song, and each band can be turned all the way off. A limiter at the end keeps any boost from clipping. The song is
// routed through all this only once a knob leaves 5 (straight playback is lighter on the phone).
import { getCtx, dbToLinSafe } from "./ui.js";

const KEY = "fifteam-eq2";
const st = { vals: { bass: 5, mids: 5, highs: 5 }, nodes: null, audio: null };
try { const s = JSON.parse(localStorage.getItem(KEY) || "null"); if (s) Object.assign(st.vals, s); } catch {}

/** A knob's setting as a gain: 0 is silence, 5 unity, 10 four times (+12 dB). Below 5 it fades like a volume knob. */
export function gainOf(v) {
  if (v <= 0) return 0;
  if (v < 5) return Math.pow(v / 5, 1.6);
  return dbToLinSafe((v - 5) * 2.4);
}
export function describe(v) {
  if (v <= 0) return "off";
  if (Math.abs(v - 5) < 0.05) return "normal";
  const db = 20 * Math.log10(gainOf(v));
  return `${db > 0 ? "+" : "−"}${Math.abs(db).toFixed(1)} dB`;
}
const flat = () => st.vals.bass === 5 && st.vals.mids === 5 && st.vals.highs === 5;

/** The crossover and the band gains, on any audio context: { input, output, set(vals, now) }. */
export function makeBands(ctx) {
  // (for lowpass and highpass, Web Audio takes Q in decibels: a Butterworth's 0.707 is -3.01 dB; allpass takes it plain)
  const bq = (type, f, q = Math.SQRT1_2) => {
    const b = ctx.createBiquadFilter(); b.type = type; b.frequency.value = f;
    b.Q.value = type === "lowpass" || type === "highpass" ? 20 * Math.log10(q) : q;
    return b;
  };
  const chain = (...nodes) => { for (let i = 0; i + 1 < nodes.length; i++) nodes[i].connect(nodes[i + 1]); return nodes[nodes.length - 1]; };
  const F1 = 250, F2 = 4000;
  const input = ctx.createGain();
  // low band: below 250 Hz, plus the 4 kHz crossover's allpass so it stays in phase with the other two
  const gLow = ctx.createGain(), gMid = ctx.createGain(), gHigh = ctx.createGain();
  const punch = bq("peaking", 55, 1.1);
  chain(input, bq("lowpass", F1), bq("lowpass", F1), bq("allpass", F2), punch, gLow);
  // the rest, split again at 4 kHz
  const rest = chain(input, bq("highpass", F1), bq("highpass", F1));
  chain(rest, bq("lowpass", F2), bq("lowpass", F2), gMid);
  chain(rest, bq("highpass", F2), bq("highpass", F2), gHigh);
  const sum = ctx.createGain(), trim = ctx.createGain();
  gLow.connect(sum); gMid.connect(sum); gHigh.connect(sum);
  sum.connect(trim);
  return {
    input, output: trim,
    set(vals, now) {
      const t = ctx.currentTime, tc = now ? 0.0005 : 0.035;
      const gl = gainOf(vals.bass), gm = gainOf(vals.mids), gh = gainOf(vals.highs);
      const at = (p, v) => (now ? p.setValueAtTime(v, t) : p.setTargetAtTime(v, t, tc));
      at(gLow.gain, gl); at(gMid.gain, gm); at(gHigh.gain, gh);
      // turned up, the bass gets its punch round 55 Hz as well (the "artificial" bass)
      at(punch.gain, Math.max(0, (vals.bass - 5) * 1.2));
      // turn the whole down by part of the biggest boost, so the limiter only catches what's left
      const boostDb = Math.max(0, ...[gl, gm, gh].map((g) => (g > 0 ? 20 * Math.log10(g) : -99)));
      at(trim.gain, dbToLinSafe(-boostDb * 0.6));
    },
  };
}

function build() {
  const ctx = getCtx();
  try { if (navigator.audioSession) navigator.audioSession.type = "playback"; } catch {}
  const src = ctx.createMediaElementSource(st.audio);
  const bands = makeBands(ctx);
  const lim = ctx.createDynamicsCompressor();
  lim.threshold.value = -1.5; lim.knee.value = 0; lim.ratio.value = 20; lim.attack.value = 0.002; lim.release.value = 0.15;
  src.connect(bands.input); bands.output.connect(lim).connect(ctx.destination);
  st.nodes = { ctx, bands };
  st.audio.addEventListener("play", () => { if (ctx.state !== "running") ctx.resume(); });
  apply(true);
}
function apply(now) { if (st.nodes) st.nodes.bands.set(st.vals, now); }

export const eq = {
  get values() { return { ...st.vals }; },
  attach(audio) { st.audio = audio; },
  /** Call from a tap or from play (phones need a gesture before sound can be processed). */
  engageIfNeeded() { if (!st.nodes && !flat() && st.audio) build(); else if (st.nodes && st.nodes.ctx.state !== "running") st.nodes.ctx.resume(); },
  set(band, v) {
    st.vals[band] = v;
    try { localStorage.setItem(KEY, JSON.stringify(st.vals)); } catch {}
    if (!st.nodes && !flat() && st.audio) build(); else apply(false);
  },
};
