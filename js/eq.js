// The player's tone knobs: BASS (a low shelf with a punch at 55 Hz, the "artificial bass"), MIDS and HIGHS, each 0 to
// 10 with 5 flat, up to 12 dB either way. A limiter at the end keeps any boost from clipping. The song is routed through
// them only once a knob leaves 5 (straight playback is lighter on the phone, and keeps playing behind the lock screen).
import { getCtx, dbToLinSafe } from "./ui.js";

const KEY = "fifteam-eq";
const st = { vals: { bass: 5, mids: 5, highs: 5 }, nodes: null, audio: null };
try { const s = JSON.parse(localStorage.getItem(KEY) || "null"); if (s) Object.assign(st.vals, s); } catch {}

export const dbOf = (v) => (v - 5) * 2.4;
const flat = () => st.vals.bass === 5 && st.vals.mids === 5 && st.vals.highs === 5;

function build() {
  const ctx = getCtx();
  try { if (navigator.audioSession) navigator.audioSession.type = "playback"; } catch {}
  const src = ctx.createMediaElementSource(st.audio);
  const shelf = ctx.createBiquadFilter(); shelf.type = "lowshelf"; shelf.frequency.value = 95;
  const punch = ctx.createBiquadFilter(); punch.type = "peaking"; punch.frequency.value = 55; punch.Q.value = 1.1;
  const mid = ctx.createBiquadFilter(); mid.type = "peaking"; mid.frequency.value = 1000; mid.Q.value = 0.75;
  const high = ctx.createBiquadFilter(); high.type = "highshelf"; high.frequency.value = 6500;
  const trim = ctx.createGain();
  const lim = ctx.createDynamicsCompressor();
  lim.threshold.value = -1.5; lim.knee.value = 0; lim.ratio.value = 20; lim.attack.value = 0.002; lim.release.value = 0.15;
  src.connect(shelf).connect(punch).connect(mid).connect(high).connect(trim).connect(lim).connect(ctx.destination);
  st.nodes = { ctx, shelf, punch, mid, high, trim };
  // keep the engine awake while the song plays
  st.audio.addEventListener("play", () => { if (ctx.state !== "running") ctx.resume(); });
  apply(true);
}

function apply(now) {
  const n = st.nodes; if (!n) return;
  const t = n.ctx.currentTime, tc = now ? 0.001 : 0.04;
  const b = dbOf(st.vals.bass), m = dbOf(st.vals.mids), h = dbOf(st.vals.highs);
  n.shelf.gain.setTargetAtTime(b * 0.75, t, tc);
  n.punch.gain.setTargetAtTime(b * 0.55, t, tc);
  n.mid.gain.setTargetAtTime(m * 0.85, t, tc);
  n.high.gain.setTargetAtTime(h, t, tc);
  // turn the whole down by part of the biggest boost, so the limiter only catches what's left
  const boost = Math.max(0, b * 1.1, m * 0.85, h);
  n.trim.gain.setTargetAtTime(dbToLinSafe(-boost * 0.6), t, tc);
}

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
