// A rotary knob, 0 to 10. Drag up or right to turn it up (or round it), double-tap to put it back to 5, arrow keys and
// the mouse wheel work too. The lit arc runs from 5 (straight up) to the value: right of centre is a boost, left a cut.
const NS = "http://www.w3.org/2000/svg";
const A0 = -135, A1 = 135;
const pt = (a, r) => [50 + r * Math.sin((a * Math.PI) / 180), 50 - r * Math.cos((a * Math.PI) / 180)];
function arc(a, b, r) {
  if (Math.abs(b - a) < 0.01) return "";
  const [x0, y0] = pt(Math.min(a, b), r), [x1, y1] = pt(Math.max(a, b), r);
  return `M${x0.toFixed(2)} ${y0.toFixed(2)} A${r} ${r} 0 ${Math.abs(b - a) > 180 ? 1 : 0} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}
let gid = 0;

export function makeKnob(host, { label, value = 5, def = 5, sub = (v) => "", onInput }) {
  const id = "kg" + gid++;
  host.classList.add("knob-wrap");
  host.innerHTML = `
    <div class="knob" role="slider" tabindex="0" aria-label="${label}" aria-valuemin="0" aria-valuemax="10">
      <svg viewBox="0 0 100 100" aria-hidden="true">
        <defs><linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#3d7bff"/><stop offset=".55" stop-color="#7b5cff"/><stop offset="1" stop-color="#b25cff"/></linearGradient></defs>
        <g class="ticks"></g>
        <path class="trk" d="${arc(A0, A1, 40)}"/>
        <path class="val" stroke="url(#${id})"/>
        <circle class="cap" cx="50" cy="50" r="29"/>
        <line class="ptr" x1="50" y1="30" x2="50" y2="38"/>
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
  let v = value;
  function paint() {
    const a = A0 + (v / 10) * (A1 - A0), mid = A0 + (def / 10) * (A1 - A0);
    host.querySelector(".val").setAttribute("d", arc(mid, a, 40));
    host.querySelector(".ptr").setAttribute("transform", `rotate(${a.toFixed(1)} 50 50)`);
    host.querySelector(".knob-num").textContent = v.toFixed(1).replace(/\.0$/, "");
    host.querySelector(".knob-sub").textContent = sub(v);
    k.setAttribute("aria-valuenow", v.toFixed(1)); k.setAttribute("aria-valuetext", `${v.toFixed(1)} of 10, ${sub(v)}`);
  }
  function set(nv, fire = true) {
    nv = Math.round(Math.max(0, Math.min(10, nv)) * 10) / 10;
    if (nv === v) return;
    v = nv; paint(); if (fire && onInput) onInput(v);
  }
  // drag: up or right turns it up; 180 px is the whole turn
  let start = null;
  k.addEventListener("pointerdown", (e) => { k.setPointerCapture(e.pointerId); start = { x: e.clientX, y: e.clientY, v }; k.classList.add("on"); e.preventDefault(); });
  k.addEventListener("pointermove", (e) => { if (!start) return; set(start.v + ((start.y - e.clientY) + (e.clientX - start.x) * 0.6) / 18); });
  const end = () => { start = null; k.classList.remove("on"); };
  k.addEventListener("pointerup", end); k.addEventListener("pointercancel", end);
  let lastTap = 0;
  k.addEventListener("pointerup", () => { const t = performance.now(); if (t - lastTap < 300) set(def); lastTap = t; });
  k.addEventListener("wheel", (e) => { e.preventDefault(); set(v - Math.sign(e.deltaY) * 0.5); }, { passive: false });
  k.addEventListener("keydown", (e) => {
    const d = { ArrowUp: 0.5, ArrowRight: 0.5, ArrowDown: -0.5, ArrowLeft: -0.5, PageUp: 1, PageDown: -1 }[e.key];
    if (d) { set(v + d); e.preventDefault(); } else if (e.key === "Home") set(0); else if (e.key === "End") set(10);
  });
  paint();
  return { get value() { return v; }, set: (nv) => set(nv, false) };
}
