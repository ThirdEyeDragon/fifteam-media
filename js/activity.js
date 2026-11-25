// FifTeam Social's activity (the bell, top right): who liked or commented on your posts, replied to your comments and
// liked them, newest first, with a count of what's new since you last looked. Worked out from the feed itself; likes
// carry no time, so this phone notes when it first saw each one (on the very first look everything counts as seen).
import { $, openSheet, toast } from "./ui.js";
import { api } from "./social.js";
import { followersOf, followRequests, answerFollow } from "./meta.js";
import { openProfile } from "./profile.js";

const KEY = "fifteam-activity";
let shownRead = 0;   // what counted as new when the list was opened (kept marked while it's open)
const h = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
function stored() { try { const v = JSON.parse(localStorage.getItem(KEY) || "null"); if (v && typeof v === "object" && v.seen) return v; } catch {} return null; }
function save(v) { try { localStorage.setItem(KEY, JSON.stringify(v)); } catch {} }

/** Everything that happened to this phone's posts and comments, newest first: { key, kind, who, name, text, post, at, seen }. */
function items() {
  const S = api.state, me = S.me, out = new Map();
  if (!me || !S.loadedAt) return null;
  const nameOf = (phone, fallback) => (S.profiles[phone] && S.profiles[phone].name) || fallback || "Someone";
  for (const f of followersOf(me)) if (!api.hidden({ by: f })) out.set(`f|${f}`, { kind: "follow", who: f, name: nameOf(f), post: null, at: 0 });
  // (a private account: people asking to follow it, to say yes or no to)
  for (const f of followRequests(me)) if (!api.hidden({ by: f })) out.set(`fr|${f}`, { kind: "freq", who: f, name: nameOf(f), post: null, at: 0 });
  for (const p of S.feed) {
    if (api.hidden(p)) continue;
    const mine = (p.by && p.by === me) || S.mine.has(p.id);
    const myComments = new Set(p.comments.filter((c) => c.by === me).map((c) => c.id));
    if (mine) {
      for (const who of p.likes) if (who !== me && !api.hidden({ by: who })) out.set(`lp|${p.id}|${who}`, { kind: "like", who, name: nameOf(who), post: p, at: 0 });
      for (const who of p.shares || []) if (who !== me && !api.hidden({ by: who })) out.set(`sh|${p.id}|${who}`, { kind: "share", who, name: nameOf(who), post: p, at: 0 });
      for (const c of p.comments) if (c.by !== me && !api.hidden(c) && !(c.re && myComments.has(c.re)))
        out.set(`c|${c.id}`, { kind: "comment", who: c.by, name: nameOf(c.by, c.user), text: c.text, post: p, at: c.at });
    }
    for (const c of p.comments) {
      if (api.hidden(c)) continue;
      if (c.re && myComments.has(c.re) && c.by !== me) out.set(`c|${c.id}`, { kind: "reply", who: c.by, name: nameOf(c.by, c.user), text: c.text, post: p, at: c.at });
      if (c.by === me) for (const who of c.likes) if (who !== me && !api.hidden({ by: who })) out.set(`lc|${c.id}|${who}`, { kind: "clike", who, name: nameOf(who), text: c.text, post: p, at: 0 });
    }
  }
  // when each was first seen here (kept only for what's still on the feed)
  const st = stored(), first = !st, now = Date.now(), seen = {};
  for (const [k, it] of out) { seen[k] = first ? 0 : st.seen[k] != null ? st.seen[k] : now; it.key = k; it.seen = seen[k]; if (!it.at) it.at = seen[k] || (it.post ? it.post.at : 0); }
  save({ read: first ? now : st.read, seen });
  return [...out.values()].sort((a, b) => b.at - a.at);
}
const readAt = () => (stored() || { read: 0 }).read;
const isNew = (it, read) => it.seen > read;

function paintBadge(list) {
  const b = $("act-badge"); if (!b) return;
  const read = readAt(), n = (list || []).filter((it) => isNew(it, read) || it.kind === "freq").length;   // (requests count until answered)
  b.textContent = n > 9 ? "9+" : String(n); b.hidden = !n;
}
/** The feed changed (fetched again, or something sent from here): the count on the bell, and the list if it's open. */
export function activityChanged() {
  const list = items(); if (!list) return;
  paintBadge(list);
  const box = document.querySelector("#sheet.open #sheet-panel .act-list");
  if (box) paintList(box, list, shownRead);
}

const what = (p) => p.text ? `“${p.text.length > 40 ? p.text.slice(0, 40) + "…" : p.text}”` : p.song ? p.song.title : p.video ? "your video" : p.image ? "your picture" : "your post";
function paintList(box, list, read) {
  box.replaceChildren();
  if (!list.length) { box.append(h("p", "status", "Nothing yet. When people like or comment on your posts, it shows up here.")); return; }
  for (const it of list.slice(0, 100)) {
    if (it.kind === "freq") {
      const row = h("div", "dm-row act-row act-req" + (isNew(it, read) ? " unread" : ""));
      const av = api.avatarEl(42, "", it.name); api.showPicture(av, { by: it.who, user: it.name, id: "" });
      av.classList.add("tap"); av.onclick = () => openProfile({ by: it.who, user: it.name });
      const mid = h("span", "dm-mid"), top = h("span", "act-what"); top.append(h("b", "", it.name), document.createTextNode(" wants to follow you"));
      mid.append(top);
      const yes = h("button", "btn small primary", "Accept"), no = h("button", "btn small", "Decline");
      const go = (ok) => async () => { yes.disabled = no.disabled = true; if (!(await answerFollow(it.who, ok))) toast("Couldn't save that. Try again."); else toast(ok ? `${it.name} follows you now` : "Declined"); activityChanged(); };
      yes.onclick = go(true); no.onclick = go(false);
      row.append(av, mid, yes, no);
      box.append(row);
      continue;
    }
    const row = h("button", "dm-row act-row" + (isNew(it, read) ? " unread" : ""));
    const av = api.avatarEl(42, "", it.name); api.showPicture(av, { by: it.who, user: it.name, id: "" });
    const mid = h("span", "dm-mid"), top = h("span", "act-what");
    const q = (t) => `“${t.length > 60 ? t.slice(0, 60) + "…" : t}”`;
    top.append(h("b", "", it.name), document.createTextNode(
      it.kind === "follow" ? " started following you" : it.kind === "like" ? " liked your post" : it.kind === "share" ? " shared your post" : it.kind === "comment" ? ` commented: ${q(it.text)}` : it.kind === "reply" ? ` replied to your comment: ${q(it.text)}` : ` liked your comment ${q(it.text)}`));
    mid.append(top, h("small", "", it.kind === "follow" ? "tap to see their page" : it.kind === "like" || it.kind === "comment" || it.kind === "share" ? `${it.kind === "share" ? "" : "on "}${what(it.post)}` : `on ${it.post.user === api.state.name ? "your post" : `${it.post.user}'s post`}`));
    row.append(av, mid, h("span", "dm-time", api.ago(it.at)));
    row.onclick = () => go(it);
    box.append(row);
  }
}
/** Where it happened: their page (a follow), the post's comments, or (a like on the post) the post itself. */
function go(it) {
  if (it.kind === "follow") { openProfile({ by: it.who, user: it.name }); return; }
  if (it.kind === "like" || it.kind === "share") { api.showPost(it.post.id); return; }
  location.hash = "#social";
  api.openComments(it.post.id);
}
export function openActivity() {
  const list = items(), read = readAt();
  shownRead = read;
  openSheet((p) => {
    p.classList.add("dm-panel");
    p.append(h("h3", "", "Activity"));
    const box = h("div", "dm-list act-list"); p.append(box);
    if (list) paintList(box, list, read); else box.append(h("p", "status", "Loading…"));
  });
  // seen now (the rows stay marked until the next look)
  const st = stored(); if (st) save({ ...st, read: Date.now() });
  paintBadge(items() || []);
  if (!list) api.ensureProfiles().then(() => { const l = items(); const box = document.querySelector("#sheet.open #sheet-panel .act-list"); if (l && box) paintList(box, l, read); save({ ...(stored() || { seen: {} }), read: Date.now() }); paintBadge(l); }).catch(() => {
    const box = document.querySelector("#sheet.open #sheet-panel .act-list"); if (box) box.replaceChildren(h("p", "status", "Couldn't load. Are you online?"));
  });
}
export function initActivity() {
  const btn = $("btn-activity");
  if (btn) btn.onclick = () => openActivity();
}
