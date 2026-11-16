// A rotary knob, 0 to 10. Drag up or right to turn it up (or round it), double-tap to put it back to 5, arrow keys and
// the mouse wheel work too. Press and hold it still for 3 seconds to mute that band completely (a ring fills while you
// hold); hold again to bring it back where it was. Turning a muted knob un-mutes it. The lit arc runs from 5 (straight
// up) to the value: right of centre is a boost, left a cut.
const NS = "http://www.w3.org/2000/svg";
const A0 = -135, A1 = 135, HOLD_MS = 3000;
const pt = (a, r) => [50 + r * Math.sin((a * Math.PI) / 180), 50 - r * Math.cos((a * Math.PI) / 180)];
function arc(a, b, r) {
  if (Math.abs(b - a) < 0.01) return "";
  const [x0, y0] = pt(Math.min(a, b), r), [x1, y1] = pt(Math.max(a, b), r);
  return `M${x0.toFixed(2)} ${y0.toFixed(2)} A${r} ${r} 0 ${Math.abs(b - a) > 180 ? 1 : 0} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}
let gid = 0;

export function makeKnob(host, { label, value = 5, def = 5, muted = false, sub = (v) => "", onInput, onMute }) {
  const id = "kg" + gid++;
  host.classList.add("knob-wrap");
  host.innerHTML = `
    <div class="knob" role="slider" tabindex="0" aria-label="${label}" aria-valuemin="0" aria-valuemax="10">
      <svg viewBox="0 0 100 100" aria-hidden="true">
        <defs><linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#2f78ff"/><stop offset=".55" stop-color="#7a4bff"/><stop offset="1" stop-color="#bb4dff"/></linearGradient></defs>
        <g class="ticks"></g>
        <path class="trk" d="${arc(A0, A1, 40)}"/>
        <path class="val" stroke="url(#${id})"/>
        <circle class="hold" cx="50" cy="50" r="46" pathLength="100" transform="rotate(-90 50 50)"/>
        <circle class="cap" cx="50" cy="50" r="29"/>
        <line class="ptr" x1="50" y1="23" x2="50" y2="29"/>
      </svg>
      <span class="knob-num"></span>
    </div>
    <span class="knob-label">${label}</span><span class="knob-sub"></span>`;
  const k = host.querySelector(".knob"), ticks = host.querySelector(".ticks");
  for (let i = 0; i <= 10; i++) {
    const a = A0 + (i / 10) * (A1 - A0), [x0, y0] = pt(a, 45.5), [x1, y1] = pt(a, i % 5 ? 47.5 : 49.5);
    const l = document.createElementNS(NS, "line");
    l.setAttribute("x1", x0); l.setAttribute("y1", y0); l.setAttribute("x2", x1); l.setAttribute("y2", y1);
    if (i % 5 === 0) l.setAttribute("class", "major");
    ticks.appendChild(l);
  }
  let v = value, mute = !!muted;
  function paint() {
    const a = A0 + (v / 10) * (A1 - A0), mid = A0 + (def / 10) * (A1 - A0);
    host.querySelector(".val").setAttribute("d", arc(mid, a, 40));
    host.querySelector(".ptr").setAttribute("transform", `rotate(${a.toFixed(1)} 50 50)`);
    host.classList.toggle("muted", mute);
    host.querySelector(".knob-num").textContent = mute ? "MUTE" : v.toFixed(1).replace(/\.0$/, "");
    const s = mute ? "muted" : sub(v);
    host.querySelector(".knob-sub").textContent = s;
    k.setAttribute("aria-valuenow", v.toFixed(1)); k.setAttribute("aria-valuetext", `${v.toFixed(1)} of 10, ${s}`);
  }
  function setMute(m, fire = true) {
    if (m === mute) return;
    mute = m; paint();
    if (fire && onMute) onMute(mute);
  }
  function set(nv, fire = true) {
    nv = Math.round(Math.max(0, Math.min(10, nv)) * 10) / 10;
    if (nv === v && !(fire && mute)) return;
    v = nv;
    if (fire && mute) setMute(false);
    paint(); if (fire && onInput) onInput(v);
  }
  // press and hold, still, for 3 s: mute (or un-mute)
  let holdT = 0, showT = 0, held = false;
  const cancelHold = () => { clearTimeout(holdT); clearTimeout(showT); k.classList.remove("holding"); };
  // drag: up or right turns it up; 180 px is the whole turn
  let start = null;
  k.addEventListener("pointerdown", (e) => {
    k.setPointerCapture(e.pointerId); start = { x: e.clientX, y: e.clientY, v, moved: false }; held = false;
    k.classList.add("on"); e.preventDefault();
    cancelHold();
    showT = setTimeout(() => k.classList.add("holding"), 250);
    holdT = setTimeout(() => {
      k.classList.remove("holding"); held = true; start = null;
      setMute(!mute);
      try { navigator.vibrate && navigator.vibrate(mute ? [30, 40, 30] : 30); } catch {}
    }, HOLD_MS);
  });
  k.addEventListener("pointermove", (e) => {
    if (!start) return;
    if (!start.moved && Math.hypot(e.clientX - start.x, e.clientY - start.y) < 6) return;
    if (!start.moved) { start.moved = true; cancelHold(); start.x = e.clientX; start.y = e.clientY; }
    set(start.v + ((start.y - e.clientY) + (e.clientX - start.x) * 0.6) / 18);
  });
  const end = () => { start = null; cancelHold(); k.classList.remove("on"); };
  k.addEventListener("pointerup", end); k.addEventListener("pointercancel", end);
  k.addEventListener("contextmenu", (e) => e.preventDefault());
  let lastTap = 0;
  k.addEventListener("pointerup", () => {
    if (held) { lastTap = 0; return; }
    const t = performance.now(); if (t - lastTap < 300) { set(def); if (mute) setMute(false); } lastTap = t;
  });
  k.addEventListener("wheel", (e) => { e.preventDefault(); set(v - Math.sign(e.deltaY) * 0.5); }, { passive: false });
  k.addEventListener("keydown", (e) => {
    const d = { ArrowUp: 0.5, ArrowRight: 0.5, ArrowDown: -0.5, ArrowLeft: -0.5, PageUp: 1, PageDown: -1 }[e.key];
    if (d) { set(v + d); e.preventDefault(); } else if (e.key === "Home") set(0); else if (e.key === "End") set(10);
    else if (e.key === "m" || e.key === "M") setMute(!mute);
  });
  paint();
  return { get value() { return v; }, get muted() { return mute; }, set: (nv) => set(nv, false), mute: (m) => setMute(!!m, false) };
}
