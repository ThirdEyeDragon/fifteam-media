// Someone's page on FifTeam Social (a tap on their picture or name): their picture, username, followers and who they
// follow, their "about me", Follow and Message, and what they've posted, in two tabs: pictures and videos, and
// rebassed songs. Your own page has Change picture, Change username and Edit about me instead.
import { toast, openSheet } from "./ui.js";
import { api } from "./social.js";
import { openChat, talkedWith } from "./dms.js";
import { offensive, OFFENSIVE } from "./filter.js";
import { loadMeta, followersOf, followingOf, aboutOf, setFollow, setAbout, votesOf, followState, setFollowRequest, canSee, prefsOf, dmState, requestDm, blocksOf, blocked, setBlock } from "./meta.js";

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
  const title = h("h3", "pf-name"); title.append(api.nameLine(name, P.phone));
  head.append(av, title);
  if (P.phone && prefsOf(P.phone).priv) head.append(h("span", "pf-private", "🔒 Private account"));
  if (P.phone) {
    const fol = followersOf(P.phone).filter((x) => !api.hidden({ by: x })), ing = followingOf(P.phone);
    const counts = h("div", "pf-counts");
    const a = h("button", "pf-count"); a.append(h("b", "", String(fol.length)), document.createTextNode(fol.length === 1 ? " follower" : " followers"));
    a.onclick = () => people(`${name}'s followers`, fol);
    const b = h("button", "pf-count"); b.append(h("b", "", String(ing.length)), document.createTextNode(" following"));
    b.onclick = () => people(`${name} follows`, ing);
    counts.append(a, h("span", "pf-dot", "·"), b);
    head.append(counts);
    // the likes they've received on their posts, from other people (not their own; not their comments)
    let likes = 0;
    const from = (l) => l.filter((w) => w !== P.phone).length;
    for (const x of S.feed) {
      if (S.gone.has(x.id)) continue;
      if (x.by === P.phone || (!x.by && x.user === name)) likes += from(x.likes);
    }
    const lk = h("div", "pf-likes"); lk.append(h("b", "", String(likes)), document.createTextNode(likes === 1 ? " like" : " likes"));
    head.append(lk);
  }
  // about me
  const about = P.phone ? aboutOf(P.phone) : "";
  if (self && P.editing) {
    const f = h("form", "pf-aboutform");
    const t = h("textarea", "input"); t.rows = 3; t.maxLength = 160; t.value = about; t.placeholder = "A line or two about you"; t.setAttribute("aria-label", "About me");
    const row = h("div", "row"), save = h("button", "btn small primary", "Save"), cancel = h("button", "btn small", "Cancel");
    save.type = "submit"; cancel.type = "button"; cancel.onclick = () => { P.editing = false; paint(); };
    row.append(save, cancel); f.append(t, row);
    f.onsubmit = async (e) => { e.preventDefault(); if (offensive(t.value)) { toast(OFFENSIVE, 3500); return; } P.editing = false; const job = setAbout(t.value); paint(); if (!(await job)) toast("Couldn't save that. Try again."); paint(); };
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
    // Follow (a private account: a request, until they let you in)
    const st = followState(S.me, P.phone), priv = !!prefsOf(P.phone).priv;
    const fo = h("button", "btn small pf-follow" + (st ? "" : " primary"), st === "following" ? "Following" : st === "requested" ? "Requested" : "Follow");
    fo.setAttribute("aria-pressed", String(!!st));
    fo.onclick = async () => {
      if (!S.name) { toast("Pick a username in Social first"); return; }
      const job = st === "requested" || (!st && priv) ? setFollowRequest(P.phone, !st) : setFollow(P.phone, !st);
      paint();
      if (!(await job)) toast("Couldn't save that. Try again.");
      else if (!st && priv) toast(`Asked ${name}. You'll see their posts once they say yes.`);
      paint();
    };
    // Message (or ask to, or not at all: their choice in Settings)
    const ms = dmState(S.me, P.phone, talkedWith(P.phone));
    const msg = h("button", "btn small pf-msg"); msg.append(api.icon("i-chat"), ms === "ok" ? "Message" : ms === "request" ? "Ask to message" : ms === "requested" ? "Asked to message" : "Not taking messages");
    msg.disabled = ms === "requested" || ms === "off";
    msg.onclick = async () => {
      if (ms === "ok") { openChat(P.phone); return; }
      if (!S.name) { toast("Pick a username in Social first"); return; }
      msg.disabled = true;
      if (await requestDm(P.phone)) toast(`Asked ${name}. You can message them once they say yes.`); else toast("Couldn't send that. Try again.");
      paint();
    };
    // blocking (either way keeps them apart)
    const iBlocked = blocksOf(S.me).includes(P.phone), theyBlocked = !iBlocked && blocked(S.me, P.phone);
    if (theyBlocked) { fo.disabled = true; }
    const bl = h("button", "btn small pf-block" + (iBlocked ? "" : " danger"), iBlocked ? "Unblock" : "Block");
    bl.onclick = async () => {
      if (!iBlocked && !confirm(`Block ${name}? You won't see each other's posts or comments, and they can't message you or follow you.`)) return;
      const job = setBlock(P.phone, !iBlocked); paint();
      if (!(await job)) toast("Couldn't save that. Try again.");
      else toast(iBlocked ? `Unblocked ${name}` : `Blocked ${name}`);
      paint(); api.render();
    };
    if (iBlocked) { btns.append(bl); head.append(h("p", "pf-about dim", `You've blocked ${name}. They can't see your posts or message you.`)); }
    else btns.append(fo, msg, bl);
  }
  if (btns.childElementCount) head.append(btns);
  box.append(head);
  // what they've posted (a private account: only for the followers it has let in)
  if (P.phone && blocked(S.me, P.phone)) { box.append(h("p", "status pf-none", "No posts to show.")); return; }
  if (P.phone && !canSee(S.me, P.phone)) {
    const lock = h("div", "pf-locked"); lock.append(h("b", "", "🔒 This account is private"), h("p", "status", followState(S.me, P.phone) === "requested" ? "You've asked to follow. Their posts show here once they say yes." : "Follow them to ask to see their posts."));
    box.append(lock);
    return;
  }
  const posts = postsOf(), media = posts.filter((x) => x.image || x.video || (x.media && x.media.length)), songs = posts.filter((x) => x.song || x.playlist);
  const seg = h("div", "seg pf-seg");
  const t1 = h("button", P.tab === "media" ? "on" : "", `Pics & videos · ${media.length}`), t2 = h("button", P.tab === "songs" ? "on" : "", `Rebassed songs · ${songs.length}`);
  t1.onclick = () => { P.tab = "media"; paint(); }; t2.onclick = () => { P.tab = "songs"; paint(); };
  seg.append(t1, t2); box.append(seg);
  if (P.tab === "media") {
    if (!media.length) { box.append(h("p", "status pf-none", self ? "Pictures and videos you post show up here." : "No pictures or videos yet.")); return; }
    const grid = h("div", "pf-grid");
    for (const x of media) {
      const many = x.media && x.media.length > 1;
      const tile = h("button", "pf-tile" + (x.video || (many && x.media[0] !== "i") ? " vid" : "") + (x.music ? " mus" : "") + (many ? " many" : "")); tile.setAttribute("aria-label", x.text ? x.text.slice(0, 60) : x.video ? "A video" : "A picture");
      tile.onclick = () => api.openViewer({ post: x });   // (watched right here, over their page)
      const still = many ? (x.media[0] === "i" ? "m0.jpg" : "m0.poster.jpg") : x.video ? "poster.jpg" : "picture.jpg";
      api.message(x.id).then((m) => { const f = api.fileOf(m, still); if (f) tile.style.backgroundImage = `url("${f.url}")`; }).catch(() => {});
      grid.append(tile);
    }
    box.append(grid);
  } else {
    if (!songs.length) { box.append(h("p", "status pf-none", self ? "Rebassed songs you post show up here." : "No rebassed songs yet.")); return; }
    const list = h("div", "pf-songs");
    for (const x of songs) {
      if (x.playlist) {
        const row = h("button", "dm-row pf-plrow"); const cov = h("span", "dm-lph");
        api.message(x.id).then((m) => { const c = api.fileOf(m, "cover.jpg"); if (c) cov.style.backgroundImage = `url("${c.url}")`; }).catch(() => {});
        const t = h("span", "dm-mid"); t.append(h("small", "dm-mktag", "Playlist"), h("b", "", x.playlist.name), h("small", "", `${x.playlist.items.length} songs · ${api.ago(x.at)}`));
        row.append(cov, t); row.onclick = () => api.showPost(x.id);
        list.append(row);
        continue;
      }
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
