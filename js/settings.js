// Settings (the gear, top right): the account (and signing out), privacy, notifications and demo mode.
import { $, toast, closeSheet, openSheet } from "./ui.js";
import { demo } from "./demo.js";
import { APP_VERSION } from "./app.js";
import { canNotify, notifyWanted, setNotify } from "./dms.js";
import { isIOS } from "./export.js";
import { account, signOut } from "./account.js";
import { loadMeta, prefsOf, setPrefs, blocksOf, setBlock } from "./meta.js";
import { api } from "./social.js";

// (the app lock is gone: anything it left on a phone is cleared, so nobody stays locked out)
for (const k of ["fifteam-lock", "fifteam-locked", "fifteam-autolock", "fifteam-lock-wait", "fifteam-lock-fails"]) { try { localStorage.removeItem(k); } catch {} }

// ---------------------------------------------------------------------------------------------------- the sheet

function el(html) { const t = document.createElement("template"); t.innerHTML = html.trim(); return t.content.firstElementChild; }

export function openSettings() {
  openSheet((p) => {
    p.append(el('<h3>Settings</h3>'));
    // the account this phone is signed in to, and signing out of it
    const acc = account();
    const accSec = el(`<div class="set-sec" id="set-account">
      <div class="set-head"><svg><use href="#i-key"/></svg>Account</div>
      <span class="status set-email"></span>
      <button class="btn block danger" id="set-signout">Sign out</button>
    </div>`);
    accSec.querySelector(".set-email").textContent = acc ? `Signed in as ${acc.email}` : "Not signed in";
    p.append(accSec);
    accSec.querySelector("#set-signout").onclick = () => { if (confirm("Sign out of FifTeam Media on this phone? You'll need your email and password to sign in again.")) signOut(); };

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
      <div id="set-blocked"></div>
    </div>`);
    p.append(pvSec);
    const paintPv = () => {
      if (!$("set-dm-why")) return;   // (Settings closed meanwhile)
      const me = api.state.me, pr = prefsOf(me);
      pvSec.querySelectorAll("#set-dm button").forEach((b) => { b.classList.toggle("on", b.dataset.v === pr.dm); b.setAttribute("aria-checked", String(b.dataset.v === pr.dm)); });
      $("set-dm-why").textContent = pr.dm === "all" ? "Anyone can message you."
        : pr.dm === "req" ? "People ask first, and you say yes or no in Messages. People you follow, and people you've written to, can always message you."
        : "Nobody can message you, and messages sent to you aren't shown.";
      $("set-priv").checked = !!pr.priv;
      // the people this phone has blocked: unblock from here (or from their page)
      const bx = $("set-blocked"); bx.replaceChildren();
      const bl = blocksOf(me);
      if (bl.length) {
        const lab = document.createElement("span"); lab.className = "label"; lab.textContent = "Blocked people"; bx.append(lab);
        for (const ph of bl) {
          const row = document.createElement("div"); row.className = "set-blockrow";
          const nm = document.createElement("span"); nm.textContent = (api.state.profiles[ph] && api.state.profiles[ph].name) || "Someone";
          const un = document.createElement("button"); un.className = "btn small"; un.textContent = "Unblock";
          un.onclick = async () => { un.disabled = true; if (!(await setBlock(ph, false))) toast("Couldn't save that. Try again."); paintPv(); api.render(); };
          row.append(nm, un); bx.append(row);
        }
      }
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

    p.append(el(`<p class="set-foot">FifTeam Media ${APP_VERSION}<br>Developed by Levi Newman</p>`));
  });
}

export function initSettings() {
  $("btn-settings").onclick = openSettings;
}
