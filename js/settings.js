// Settings (the gear, top right): the app lock, demo mode, and sending the app to a friend.
//   The lock: a password the user picks (kept only as a salted PBKDF2 hash on this phone). Locked, a screen covers the
//   whole app and every touch on it does nothing but reach the password box; the rest of the app is made inert too, so
//   nothing behind can be reached by keyboard. It stays locked through closing and reopening the app. The music keeps
//   playing (and the lock screen / car controls keep working), only the app itself is shut.
import { $, toast, openSheet, closeSheet } from "./ui.js";
import { demo } from "./demo.js";
import { APP_VERSION } from "./app.js";
import { canNotify, notifyWanted, setNotify } from "./dms.js";
import { isIOS } from "./export.js";
import { loadMeta, prefsOf, setPrefs } from "./meta.js";
import { api } from "./social.js";

const K_PW = "fifteam-lock", K_LOCKED = "fifteam-locked", K_AUTO = "fifteam-autolock", K_WAIT = "fifteam-lock-wait", K_FAILS = "fifteam-lock-fails";
const ls = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
  del(k) { try { localStorage.removeItem(k); } catch {} },
};
const canLock = () => !!(window.crypto && crypto.subtle);
const hasPassword = () => !!ls.get(K_PW);

// ---------------------------------------------------------------------------------------------------- the password
const b64 = (u8) => btoa(String.fromCharCode(...u8));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
async function derive(pw, salt, it) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(pw), "PBKDF2", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: it }, key, 256));
}
async function setPassword(pw) {
  const salt = crypto.getRandomValues(new Uint8Array(16)), it = 150000;
  const hash = await derive(pw, salt, it);
  ls.set(K_PW, JSON.stringify({ v: 1, salt: b64(salt), hash: b64(hash), it }));
}
async function checkPassword(pw) {
  try {
    const rec = JSON.parse(ls.get(K_PW) || "null");
    if (!rec) return true;
    const h = await derive(pw, unb64(rec.salt), rec.it), want = unb64(rec.hash);
    if (h.length !== want.length) return false;
    let d = 0; for (let i = 0; i < h.length; i++) d |= h[i] ^ want[i];
    return d === 0;
  } catch { return false; }
}

// ---------------------------------------------------------------------------------------------------- locking
function others() { return [$("app"), $("sheet"), $("toast")].filter(Boolean); }
export function lockNow() {
  if (!hasPassword()) return;
  ls.set(K_LOCKED, "1");
  closeSheet();
  if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
  showLock();
}
function showLock() {
  const L = $("lock");
  L.hidden = false;
  for (const el of others()) { el.inert = true; el.setAttribute("aria-hidden", "true"); }
  $("lock-pw").value = ""; $("lock-err").textContent = "";
  paintWait();
}
function hideLock() {
  $("lock").hidden = true;
  for (const el of others()) { el.inert = false; el.removeAttribute("aria-hidden"); }
}
// a few wrong tries in a row make it wait, a little longer each time
let waitT = 0;
function paintWait() {
  clearInterval(waitT);
  const tick = () => {
    const left = Math.ceil(((+ls.get(K_WAIT) || 0) - Date.now()) / 1000);
    const go = $("lock-go"), pw = $("lock-pw");
    if (left > 0) { go.disabled = true; pw.disabled = true; $("lock-err").textContent = `Too many wrong tries. Try again in ${left} s.`; }
    else { go.disabled = false; pw.disabled = false; if (/Too many/.test($("lock-err").textContent)) $("lock-err").textContent = ""; clearInterval(waitT); }
  };
  tick(); waitT = setInterval(tick, 500);
}
async function tryUnlock(e) {
  e.preventDefault();
  if ((+ls.get(K_WAIT) || 0) > Date.now()) return;
  const pw = $("lock-pw").value;
  if (!pw) { $("lock-pw").focus(); return; }
  $("lock-go").disabled = true;
  const ok = await checkPassword(pw);
  $("lock-go").disabled = false;
  if (ok) { ls.del(K_LOCKED); ls.del(K_FAILS); ls.del(K_WAIT); $("lock-pw").blur(); hideLock(); toast("Unlocked", 1500); return; }
  const fails = (+ls.get(K_FAILS) || 0) + 1;
  ls.set(K_FAILS, String(fails));
  $("lock-pw").value = "";
  $("lock-err").textContent = "Wrong password";
  const box = $("lock-form"); box.classList.remove("shake"); void box.offsetWidth; box.classList.add("shake");
  if (fails >= 5) { ls.set(K_WAIT, String(Date.now() + Math.min(300, 15 * 2 ** (fails - 5)) * 1000)); paintWait(); }
}

// ---------------------------------------------------------------------------------------------------- the sheet

function el(html) { const t = document.createElement("template"); t.innerHTML = html.trim(); return t.content.firstElementChild; }

export function openSettings() {
  openSheet((p) => {
    p.append(el('<h3>Settings</h3>'));
    const lockSec = el('<div class="set-sec" id="set-lock"></div>');
    p.append(lockSec);
    paintLockSec(lockSec);

    const demoSec = el(`<div class="set-sec">
      <div class="set-head"><svg><use href="#i-spark"/></svg>Demo mode<span class="pill ${demo.on ? "on" : ""}" id="set-demo-pill">${demo.on ? "On" : "Off"}</span></div>
      <label class="switch"><span class="txt">Lava lamp</span><input type="checkbox" id="set-demo" ${demo.on ? "checked" : ""}></label>
    </div>`);
    p.append(demoSec);
    demoSec.querySelector("#set-demo").onchange = (e) => {
      demo.set(e.target.checked);
      const pill = $("set-demo-pill"); pill.textContent = demo.on ? "On" : "Off"; pill.classList.toggle("on", demo.on);
      if (demo.on) { closeSheet(); location.hash = "#player"; toast("Demo mode on. Play a song.", 2200); }
    };

    // privacy: who can message you, and whether your posts are for everyone or only followers you let in
    const pvSec = el(`<div class="set-sec">
      <div class="set-head"><svg><use href="#i-lock"/></svg>Privacy</div>
      <span class="label">Who can message you</span>
      <div class="seg" id="set-dm" role="radiogroup"><button data-v="all">Everyone</button><button data-v="req">Requests</button><button data-v="off">Nobody</button></div>
      <span class="status" id="set-dm-why"></span>
      <label class="switch"><span class="txt">Private account</span><input type="checkbox" id="set-priv"></label>
      <span class="status" id="set-priv-why"></span>
    </div>`);
    p.append(pvSec);
    const paintPv = () => {
      const me = api.state.me, pr = prefsOf(me);
      pvSec.querySelectorAll("#set-dm button").forEach((b) => { b.classList.toggle("on", b.dataset.v === pr.dm); b.setAttribute("aria-checked", String(b.dataset.v === pr.dm)); });
      $("set-dm-why").textContent = pr.dm === "all" ? "Anyone can message you."
        : pr.dm === "req" ? "People ask first, and you say yes or no in Messages. People you follow, and people you've written to, can always message you."
        : "Nobody can message you, and messages sent to you aren't shown.";
      $("set-priv").checked = !!pr.priv;
      $("set-priv-why").textContent = pr.priv ? "Only followers you let in see your posts and your page. New followers ask first; answer them under the bell." : "Everyone sees your posts.";
    };
    paintPv();
    loadMeta(15000).then(paintPv, () => {});
    const savePv = async (next) => {
      if (!api.state.name) { toast("Pick a username in Social first"); paintPv(); return; }
      const job = setPrefs(next); paintPv();
      if (!(await job)) toast("Couldn't save that. Are you online?");
      paintPv();
      api.render();
    };
    pvSec.querySelector("#set-dm").onclick = (e) => { const b = e.target.closest("button"); if (b && b.dataset.v !== prefsOf(api.state.me).dm) savePv({ dm: b.dataset.v }); };
    $("set-priv").onchange = (e) => savePv({ priv: e.target.checked });

    // notifications for new messages
    const ntSec = el(`<div class="set-sec">
      <div class="set-head"><svg><use href="#i-bell"/></svg>Notifications<span class="pill" id="set-nt-pill"></span></div>
      <label class="switch"><span class="txt">New messages</span><input type="checkbox" id="set-nt"></label>
      <span class="status" id="set-nt-why"></span>
    </div>`);
    p.append(ntSec);
    const paintNt = () => {
      const perm = canNotify() ? Notification.permission : "none", on = notifyWanted() && perm === "granted";
      $("set-nt").checked = on;
      const pill = $("set-nt-pill"); pill.textContent = on ? "On" : "Off"; pill.classList.toggle("on", on);
      $("set-nt-why").textContent = perm === "none"
        ? (isIOS() ? "On iPhone, add FifTeam Media to your Home Screen first (Share, then Add to Home Screen), then turn this on from there." : "This browser can't show notifications.")
        : perm === "denied" ? "Notifications are blocked for FifTeam Media. Allow them in your phone's settings, then turn this on."
        : on ? "You'll get a notification when someone messages you while FifTeam Media is open or in the background." : "";
    };
    paintNt();
    $("set-nt").onchange = async (e) => {
      if (!e.target.checked) { setNotify(false); paintNt(); return; }
      if (!canNotify()) { paintNt(); return; }
      let perm = Notification.permission;
      if (perm === "default") { try { perm = await Notification.requestPermission(); } catch { perm = "denied"; } }
      setNotify(perm === "granted");
      paintNt();
      if (perm === "granted") toast("Message notifications on");
    };

    // the bass separator: downloaded on the first rebass and kept (with the last few songs' separated basses)
    const sepSec = el(`<div class="set-sec">
      <div class="set-head"><svg><use href="#i-bass"/></svg>Bass separator<span class="pill" id="set-sep-pill">…</span></div>
      <span class="status">51 MB, kept so rebassing works offline.</span>
      <button class="btn small" id="set-sep-del" hidden>Remove from this phone</button>
      <span class="status" id="set-light" hidden>This phone uses the lighter rebass (a rebass ran out of memory here).</span>
      <button class="btn small" id="set-light-off" hidden>Try the full rebass again</button>
    </div>`);
    p.append(sepSec);
    const paintSep = async () => {
      let on = false;
      try { on = (await (await caches.open("fifteam-sep-1")).keys()).length >= 3; } catch {}
      const pill = $("set-sep-pill"); if (!pill) return;
      pill.textContent = on ? "On this phone" : "Not downloaded"; pill.classList.toggle("on", on);
      $("set-sep-del").hidden = !on;
    };
    paintSep();
    const paintLight = () => {
      let on = false; try { on = localStorage.getItem("fifteam-rebass-light") === "1"; } catch {}
      $("set-light").hidden = $("set-light-off").hidden = !on;
    };
    paintLight();
    sepSec.querySelector("#set-light-off").onclick = () => {
      try { localStorage.removeItem("fifteam-rebass-light"); } catch {}
      toast("The full rebass is back on. It starts with the next song you open.", 3000);
      paintLight();
    };
    sepSec.querySelector("#set-sep-del").onclick = async () => {
      try { await caches.delete("fifteam-sep-1"); } catch {}
      try { indexedDB.deleteDatabase("fifteam-stems"); } catch {}
      paintSep();
      toast("Removed. It downloads again the next time you rebass.", 2600);
    };

    p.append(el(`<p class="set-foot">FifTeam Media ${APP_VERSION}<br>Developed by Levi Newman</p>`));
  });
}

function paintLockSec(sec) {
  const on = hasPassword();
  sec.innerHTML = `<div class="set-head"><svg><use href="#i-lock"/></svg>Lock app<span class="pill ${on ? "on" : ""}">${on ? "Password set" : "Off"}</span></div>`;
  const add = (h) => { const n = el(h); sec.append(n); return n; };
  if (!canLock()) { add('<span class="status">Not available here.</span>'); return; }
  const err = () => sec.querySelector(".set-err");
  if (!on) {
    const a = add('<input class="input" type="password" placeholder="New password (4+ characters)" autocomplete="new-password" aria-label="New password">');
    const b = add('<input class="input" type="password" placeholder="Type it again" autocomplete="new-password" aria-label="Type the password again">');
    add('<p class="set-err"></p>');
    const save = add('<button class="btn primary block"><svg><use href="#i-lock"/></svg>Set password</button>');
    save.onclick = async () => {
      if (a.value.length < 4) { err().textContent = "Use at least 4 characters."; a.focus(); return; }
      if (a.value !== b.value) { err().textContent = "The two don't match."; b.value = ""; b.focus(); return; }
      save.disabled = true;
      await setPassword(a.value);
      toast("Password set. Tap Lock now whenever you want.", 2600);
      paintLockSec(sec);
    };
    add('<span class="status">Keep your password somewhere safe. It can\'t be recovered.</span>');
    return;
  }
  const lock = add('<button class="btn primary block"><svg><use href="#i-lock"/></svg>Lock now</button>');
  lock.onclick = lockNow;
  const auto = add(`<label class="switch"><span class="txt">Lock when I leave the app</span><input type="checkbox" ${ls.get(K_AUTO) === "1" ? "checked" : ""}></label>`);
  auto.querySelector("input").onchange = (e) => (e.target.checked ? ls.set(K_AUTO, "1") : ls.del(K_AUTO));
  const row = add('<div class="row"><button class="btn small grow" data-a="change">Change password</button><button class="btn small grow" data-a="off">Remove lock</button></div>');
  row.onclick = (e) => {
    const b = e.target.closest("button"); if (!b) return;
    // either needs the current password first
    row.remove(); sec.querySelectorAll(".set-confirm").forEach((n) => n.remove());
    const box = add('<div class="set-confirm field"></div>');
    const cur = el('<input class="input" type="password" placeholder="Current password" autocomplete="current-password" aria-label="Current password">');
    box.append(cur);
    let n1, n2;
    if (b.dataset.a === "change") {
      n1 = el('<input class="input" type="password" placeholder="New password (4+ characters)" autocomplete="new-password" aria-label="New password">');
      n2 = el('<input class="input" type="password" placeholder="Type the new one again" autocomplete="new-password" aria-label="Type the new password again">');
      box.append(n1, n2);
    }
    const msg = el('<p class="set-err"></p>'); box.append(msg);
    const r = el(`<div class="row"><button class="btn small grow" data-x="cancel">Cancel</button><button class="btn small primary grow" data-x="ok">${b.dataset.a === "change" ? "Change" : "Remove lock"}</button></div>`);
    box.append(r);
    cur.focus();
    r.onclick = async (ev) => {
      const x = ev.target.closest("button"); if (!x) return;
      if (x.dataset.x === "cancel") { paintLockSec(sec); return; }
      if (!(await checkPassword(cur.value))) { msg.textContent = "That's not the current password."; cur.value = ""; cur.focus(); return; }
      if (b.dataset.a === "off") { ls.del(K_PW); ls.del(K_AUTO); ls.del(K_LOCKED); toast("Lock removed", 1800); paintLockSec(sec); return; }
      if (n1.value.length < 4) { msg.textContent = "Use at least 4 characters."; n1.focus(); return; }
      if (n1.value !== n2.value) { msg.textContent = "The new ones don't match."; n2.value = ""; n2.focus(); return; }
      await setPassword(n1.value);
      toast("Password changed", 1800); paintLockSec(sec);
    };
  };
}

export function initSettings() {
  $("btn-settings").onclick = openSettings;
  $("lock-form").addEventListener("submit", tryUnlock);
  // every touch on the lock screen stops there (only the password box and the button do anything)
  const L = $("lock");
  for (const ev of ["click", "pointerdown", "touchstart", "contextmenu", "wheel"])
    L.addEventListener(ev, (e) => { if (!e.target.closest("input, button")) { e.stopPropagation(); if (ev !== "touchstart" && ev !== "pointerdown") e.preventDefault(); } }, { passive: false });
  if (ls.get(K_LOCKED) === "1") { if (hasPassword()) showLock(); else { ls.del(K_LOCKED); hideLock(); } }
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden" && ls.get(K_AUTO) === "1" && hasPassword() && $("lock").hidden) lockNow();
  });
}
