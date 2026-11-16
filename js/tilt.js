// The album art turns the way the phone is tilted: a spring follows the motion sensor (or the pointer, on a computer),
// the blurred glow behind it slides the other way, a sheen of light crosses it, and quick moves blur it a little.

export function makeTilt({ stage, art, img, glow, sheen }) {
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const st = { tx: 0, ty: 0, rx: 0, ry: 0, vx: 0, vy: 0, b0: null, g0: null, active: false, lastT: 0, sensor: false };
  const MAX = 22;

  function onOrient(e) {
    if (e.beta == null || e.gamma == null) return;
    st.sensor = true;
    let beta = e.beta, gamma = e.gamma;
    // keep the axes right in landscape
    const ang = (screen.orientation && screen.orientation.angle) || window.orientation || 0;
    if (ang === 90) [beta, gamma] = [-gamma, beta];
    else if (ang === -90 || ang === 270) [beta, gamma] = [gamma, -beta];
    else if (ang === 180) [beta, gamma] = [-beta, -gamma];
    // the way the phone is usually held drifts slowly into "level", so the art always answers the tilt from there
    if (st.b0 == null) { st.b0 = beta; st.g0 = gamma; }
    st.b0 += (beta - st.b0) * 0.004;
    st.g0 += (gamma - st.g0) * 0.004;
    st.ty = clamp((gamma - st.g0) * 0.9, -MAX, MAX);
    st.tx = clamp(-(beta - st.b0) * 0.9, -MAX, MAX);
  }
  function onPointer(e) {
    if (st.sensor) return;
    const r = stage.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width - 0.5, y = (e.clientY - r.top) / r.height - 0.5;
    st.ty = clamp(x * 2 * MAX, -MAX, MAX); st.tx = clamp(-y * 2 * MAX, -MAX, MAX);
  }
  function onLeave() { if (!st.sensor) { st.tx = 0; st.ty = 0; } }

  function frame(t) {
    if (!st.active) return;
    const dt = Math.min(0.05, st.lastT ? (t - st.lastT) / 1000 : 0.016);
    st.lastT = t;
    // a soft spring, a touch under-damped so it settles with life
    const k = 70, c = 13;
    st.vx += ((st.tx - st.rx) * k - st.vx * c) * dt;
    st.vy += ((st.ty - st.ry) * k - st.vy * c) * dt;
    st.rx += st.vx * dt; st.ry += st.vy * dt;
    const speed = Math.hypot(st.vx, st.vy);
    const blur = Math.min(2.6, speed / 90);
    art.style.transform = `rotateX(${st.rx.toFixed(2)}deg) rotateY(${st.ry.toFixed(2)}deg)`;
    img.style.filter = blur > 0.15 ? `blur(${blur.toFixed(2)}px)` : "none";
    glow.style.transform = `translate3d(${(-st.ry * 1.6).toFixed(1)}px, ${(st.rx * 1.6).toFixed(1)}px, 0) scale(1.06)`;
    const ang = 115 + st.ry * 2.2 - st.rx * 1.4;
    const pos = 50 + st.ry * 1.8;
    sheen.style.background = `linear-gradient(${ang.toFixed(1)}deg, rgba(255,255,255,0) ${(pos - 30).toFixed(1)}%, rgba(255,255,255,${(0.05 + Math.min(0.14, (Math.abs(st.rx) + Math.abs(st.ry)) / 160)).toFixed(3)}) ${pos.toFixed(1)}%, rgba(255,255,255,0) ${(pos + 30).toFixed(1)}%)`;
    requestAnimationFrame(frame);
  }

  const canAsk = typeof DeviceOrientationEvent !== "undefined" && typeof DeviceOrientationEvent.requestPermission === "function";
  const api = {
    /** iPhones ask once, from a tap (other phones send motion without asking). Returns whether motion is on. */
    async enable() {
      try {
        if (canAsk) { const r = await DeviceOrientationEvent.requestPermission(); if (r !== "granted") return false; }
        addEventListener("deviceorientation", onOrient);
        return true;
      } catch { return false; }
    },
    /** True when the phone could tilt the art but hasn't sent any motion yet (an iPhone waiting for permission). */
    get needsPermission() { return canAsk && !st.sensor; },
    start() {
      if (reduce || st.active) return;
      st.active = true; st.lastT = 0;
      requestAnimationFrame(frame);
    },
    stop() { st.active = false; },
    get hasSensor() { return st.sensor; },
  };
  stage.addEventListener("pointermove", onPointer);
  stage.addEventListener("pointerleave", onLeave);
  addEventListener("deviceorientation", onOrient);
  return api;
}

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
