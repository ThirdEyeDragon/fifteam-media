// Someone's page on FifTeam Social (a tap on their picture or name): their picture, username, followers and who they
// follow, their "about me", Follow and Message, and what they've posted, in two tabs: pictures and videos, and
// rebassed songs. Your own page has Change picture, Change username and Edit about me instead.
import { toast, openSheet } from "./ui.js";
import { api } from "./social.js";
import { openChat } from "./dms.js";
import { loadMeta, followersOf, followingOf, aboutOf, setFollow, setAbout, votesOf } from "./meta.js";

const PHONE = /^[a-z0-9]{6,16}$/;
const h = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const P = { phone: "", user: "", tab: "media", editing: false };

export function openProfile({ by, user }) {
  P.phone = by && PHONE.test(by) ? by : api.findPhone(user);
  P.user = user || ""; P.tab = "media"; P.editing = false;
  openSheet((panel) => { panel.classList.add("pf-panel"); panel.append(h("div", "pf-body")); });
  paint();
  // the latest followers and abouts (and the feed, if it hasn't been read yet)
  Promise.all([loadMeta(20000), api.state.loadedAt ? null : api.ensureProfiles()]).then(paint, paint);
}
const nameNow = () => (P.phone && api.state.profiles[P.phone] && api.state.profiles[P.phone].name) || P.user || "Someone";
function postsOf() {
  const S = api.state, name = nameNow();
  return S.feed.filter((x) => !S.gone.has(x.id) && !api.hidden(x) && (P.phone ? x.by === P.phone || (!x.by && x.user === name) : x.user === P.user));
}

function paint() {
  const box = document.querySelector("#sheet.open #sheet-panel.pf-panel .pf-body");
  if (!box) return;
  const S = api.state, self = !!P.phone && P.phone === S.me, name = nameNow();
  box.replaceChildren();
  // who
  const head = h("div", "pf-head");
  const av = api.avatarEl(92, self ? S.avatarUrl : "", name); api.showPicture(av, { by: P.phone, user: name, id: "" });
  head.append(av, h("h3", "pf-name", name));
  if (P.phone) {
    const fol = followersOf(P.phone).filter((x) => !api.hidden({ by: x })), ing = followingOf(P.phone);
    const counts = h("div", "pf-counts");
    const a = h("button", "pf-count"); a.append(h("b", "", String(fol.length)), document.createTextNode(fol.length === 1 ? " follower" : " followers"));
    a.onclick = () => people(`${name}'s followers`, fol);
    const b = h("button", "pf-count"); b.append(h("b", "", String(ing.length)), document.createTextNode(" following"));
    b.onclick = () => people(`${name} follows`, ing);
    counts.append(a, h("span", "pf-dot", "·"), b);
    head.append(counts);
  }
  // about me
  const about = P.phone ? aboutOf(P.phone) : "";
  if (self && P.editing) {
    const f = h("form", "pf-aboutform");
    const t = h("textarea", "input"); t.rows = 3; t.maxLength = 160; t.value = about; t.placeholder = "A line or two about you"; t.setAttribute("aria-label", "About me");
    const row = h("div", "row"), save = h("button", "btn small primary", "Save"), cancel = h("button", "btn small", "Cancel");
    save.type = "submit"; cancel.type = "button"; cancel.onclick = () => { P.editing = false; paint(); };
    row.append(save, cancel); f.append(t, row);
    f.onsubmit = async (e) => { e.preventDefault(); P.editing = false; const job = setAbout(t.value); paint(); if (!(await job)) toast("Couldn't save that. Try again."); paint(); };
    head.append(f);
    setTimeout(() => t.focus(), 50);
  } else if (about) head.append(h("p", "pf-about", about));
  else if (self) head.append(h("p", "pf-about dim", "Nothing about you yet."));
  // the buttons
  const btns = h("div", "pf-btns");
  if (self) {
    const pic = h("button", "btn small", "Change picture"); pic.onclick = async () => { await api.pickAvatar(); paint(); };
    const nm = h("button", "btn small", "Change username"); nm.onclick = () => api.editName();
    const ab = h("button", "btn small", about ? "Edit about me" : "Add about me"); ab.onclick = () => { P.editing = true; paint(); };
    btns.append(pic, nm, ab);
  } else if (P.phone) {
    const on = followingOf(S.me).includes(P.phone);
    const fo = h("button", "btn small pf-follow" + (on ? "" : " primary"), on ? "Following" : "Follow");
    fo.setAttribute("aria-pressed", String(on));
    fo.onclick = async () => {
      if (!S.name) { toast("Pick a username in Social first"); return; }
      const job = setFollow(P.phone, !on); paint();
      if (!(await job)) toast("Couldn't save that. Try again.");
      paint();
    };
    const msg = h("button", "btn small"); msg.append(api.icon("i-chat"), "Message"); msg.onclick = () => openChat(P.phone);
    btns.append(fo, msg);
  }
  if (btns.childElementCount) head.append(btns);
  box.append(head);
  // what they've posted
  const posts = postsOf(), media = posts.filter((x) => x.image || x.video), songs = posts.filter((x) => x.song);
  const seg = h("div", "seg pf-seg");
  const t1 = h("button", P.tab === "media" ? "on" : "", `Pics & videos · ${media.length}`), t2 = h("button", P.tab === "songs" ? "on" : "", `Rebassed songs · ${songs.length}`);
  t1.onclick = () => { P.tab = "media"; paint(); }; t2.onclick = () => { P.tab = "songs"; paint(); };
  seg.append(t1, t2); box.append(seg);
  if (P.tab === "media") {
    if (!media.length) { box.append(h("p", "status pf-none", self ? "Pictures and videos you post show up here." : "No pictures or videos yet.")); return; }
    const grid = h("div", "pf-grid");
    for (const x of media) {
      const tile = h("button", "pf-tile" + (x.video ? " vid" : "")); tile.setAttribute("aria-label", x.text ? x.text.slice(0, 60) : x.video ? "A video" : "A picture");
      tile.onclick = () => api.showPost(x.id);
      api.message(x.id).then((m) => { const f = api.fileOf(m, x.video ? "poster.jpg" : "picture.jpg"); if (f) tile.style.backgroundImage = `url("${f.url}")`; }).catch(() => {});
      grid.append(tile);
    }
    box.append(grid);
  } else {
    if (!songs.length) { box.append(h("p", "status pf-none", self ? "Rebassed songs you post show up here." : "No rebassed songs yet.")); return; }
    const list = h("div", "pf-songs");
    for (const x of songs) {
      const b = api.songBlock(x);
      api.message(x.id).then((m) => { const c = api.fileOf(m, "cover.jpg"); if (c) b.querySelector(".so-cover").style.backgroundImage = `url("${c.url}")`; }).catch(() => {});
      const v = votesOf(x.id).length;
      const line = h("button", "pf-songline", `${v ? `🔥 ${v} vote${v === 1 ? "" : "s"} · ` : ""}${x.likes.length ? `♥ ${x.likes.length} · ` : ""}${api.ago(x.at)} · see the post`);
      line.onclick = () => api.showPost(x.id);
      const w = h("div", "pf-song"); w.append(b, line);
      list.append(w);
    }
    box.append(list);
  }
}
/** A list of people (followers, or who someone follows): each opens their page. */
function people(title, list) {
  const S = api.state;
  openSheet((panel) => {
    panel.classList.add("dm-panel");
    panel.append(h("h3", "", title));
    const box = h("div", "dm-list"); panel.append(box);
    if (!list.length) { box.append(h("p", "status", "Nobody yet.")); return; }
    for (const ph of list) {
      const nm = (S.profiles[ph] && S.profiles[ph].name) || "Someone";
      const row = h("button", "dm-row");
      const av = api.avatarEl(42, "", nm); api.showPicture(av, { by: ph, user: nm, id: "" });
      const mid = h("span", "dm-mid"); mid.append(h("b", "", nm));
      row.append(av, mid);
      row.onclick = () => openProfile({ by: ph, user: nm });
      box.append(row);
    }
  });
}
