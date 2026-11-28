// The FifTeam bot's commands and background work, for either place it runs (only web-standard pieces here: fetch,
// Web Crypto, FormData): online, on Cloudflare (worker.mjs: nothing has to be running on a PC), or on a PC (fifteam-bot.mjs).
//   /online            who has FifTeam Media open right now, with their device and app version
//   /ban <user>        bans a phone (by username or phone id) from FifTeam Media until /unban
//   /unban <user>      lifts a ban
//   /bans              the phones banned now
//   /posts, /comments  the latest posts or comments (anyone's, or one user's), with their ids
//   /delete-post, /delete-comment   take one down (a comment goes with its replies)
//   /purge <user>      every post and comment of theirs, gone
//   /clear-profile <user>   their picture, about me and setup removed, and no new picture shown until /allow-picture
//   /devices           every phone that has used the app (the last half year), with its device; the full list as a file
//   /tag-member, /tag-founder, /tag-developer, /tag-advertiser <user>   the gradient tag next to their name (remove: True
//                              takes it off). (FifTeam Premium shows by itself for anyone with Premium.)
//   /tags              who has which tag
//   /listings [user], /delete-listing   Audio Market: the latest listings, and taking one down
//   /premium <user> [remove]   Premium for someone who paid (the $10 one-time unlock); /premiums lists
//                      who has it and who has asked
//   /accounts, /ban-email <email>, /unban-email <email>   FifTeam accounts: every account, online or not, with its
//                      phone. The app keeps the list (social/config.json "accounts"), each email sealed for the bot's key
//                      alone; signing in itself is Google's free sign-in service (Firebase Authentication).
// And every half hour: every post's and profile picture's current file links in one store message (social/config.json
// "links"), so a phone reads one file instead of asking for each post (much faster to load).
// It reads and writes the app's store messages through the same webhook the app uses (social/config.json).
const API = "https://discord.com/api/v10";
const PHONE = /^[a-z0-9]{6,16}$/;
const ONLINE_MS = 5 * 60e3;   // the app checks in every 4 minutes while it's on screen
const sleep = (ms) => new Promise((s) => setTimeout(s, ms));
const unb64u = (s) => Uint8Array.from(atob(String(s).replace(/-/g, "+").replace(/_/g, "/") + "===".slice((String(s).length + 3) % 4)), (c) => c.charCodeAt(0));

/** Something a phone sealed for the bot ({ k: its one-time public key, iv, c }, as JSON text), opened with the bot's
 * private key (an ECDH P-256 CryptoKey). */
export async function openSealed(priv, text) {
  const s = typeof text === "string" ? JSON.parse(text) : text;
  const [x, y] = String(s.k).split(".");
  const pub = await crypto.subtle.importKey("jwk", { kty: "EC", crv: "P-256", x, y, ext: true }, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const key = await crypto.subtle.deriveKey({ name: "ECDH", public: pub }, priv, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
  return new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64u(s.iv) }, key, unb64u(s.c)));
}

export const COMMANDS = [
  { name: "online", description: "Who has FifTeam Media open right now, and on what device", type: 1 },
  { name: "ban", description: "Ban a phone from FifTeam Media until it's unbanned", type: 1, options: [
    { type: 3, name: "user", description: "Their username, or the phone id from /online", required: true, autocomplete: true },
    { type: 3, name: "reason", description: "Why (kept with the bot, shown in /bans)", required: false },
    { type: 5, name: "delete_posts", description: "Also remove all their posts and comments", required: false }] },
  { name: "unban", description: "Lift a FifTeam Media ban", type: 1, options: [{ type: 3, name: "user", description: "Their username or phone id", required: true, autocomplete: true }] },
  { name: "bans", description: "The phones banned from FifTeam Media", type: 1 },
  { name: "posts", description: "The latest FifTeam posts (or one user's), with their ids", type: 1, options: [{ type: 3, name: "user", description: "Only this user's", required: false, autocomplete: true }] },
  { name: "comments", description: "The latest comments (or one user's), with their ids", type: 1, options: [{ type: 3, name: "user", description: "Only this user's", required: false, autocomplete: true }] },
  { name: "delete-post", description: "Take a post down", type: 1, options: [{ type: 3, name: "post", description: "Start typing a name or words from it", required: true, autocomplete: true }] },
  { name: "delete-comment", description: "Take a comment down (and the replies to it)", type: 1, options: [{ type: 3, name: "comment", description: "Start typing a name or words from it", required: true, autocomplete: true }] },
  { name: "purge", description: "Remove every post and comment by a user", type: 1, options: [{ type: 3, name: "user", description: "Their username or phone id", required: true, autocomplete: true }] },
  { name: "clear-profile", description: "Remove a user's profile picture, about me and setup (and block new pictures)", type: 1, options: [{ type: 3, name: "user", description: "Their username or phone id", required: true, autocomplete: true }] },
  { name: "devices", description: "Every phone that has used FifTeam Media, with its device (the full list as a file)", type: 1, options: [{ type: 3, name: "user", description: "Only this user's", required: false, autocomplete: true }] },
  { name: "tag-member", description: "Give someone the FifTeam Member tag (next to their name)", type: 1, options: [{ type: 3, name: "user", description: "Their username or phone id", required: true, autocomplete: true }, { type: 5, name: "remove", description: "Take the tag off instead", required: false }] },
  { name: "tag-founder", description: "Give someone the FifTeam Founder tag", type: 1, options: [{ type: 3, name: "user", description: "Their username or phone id", required: true, autocomplete: true }, { type: 5, name: "remove", description: "Take the tag off instead", required: false }] },
  { name: "tag-developer", description: "Give someone the FifTeam Media Developer tag", type: 1, options: [{ type: 3, name: "user", description: "Their username or phone id", required: true, autocomplete: true }, { type: 5, name: "remove", description: "Take the tag off instead", required: false }] },
  { name: "tag-advertiser", description: "Give someone the FifTeam Advertiser tag", type: 1, options: [{ type: 3, name: "user", description: "Their username or phone id", required: true, autocomplete: true }, { type: 5, name: "remove", description: "Take the tag off instead", required: false }] },
  { name: "tags", description: "Who has which FifTeam tag", type: 1 },
  { name: "accounts", description: "Every FifTeam account: email, username, phone, online or last seen", type: 1 },
  { name: "ban-email", description: "Ban an account by its email (every phone signed in to it)", type: 1, options: [{ type: 3, name: "email", description: "The account's email", required: true, autocomplete: true }] },
  { name: "unban-email", description: "Lift an account's ban", type: 1, options: [{ type: 3, name: "email", description: "The account's email", required: true, autocomplete: true }] },
  { name: "listings", description: "The latest Audio Market listings (or one user's), with their ids", type: 1, options: [{ type: 3, name: "user", description: "Only this user's", required: false, autocomplete: true }] },
  { name: "delete-listing", description: "Take an Audio Market listing down", type: 1, options: [{ type: 3, name: "listing", description: "Start typing its title or the seller", required: true, autocomplete: true }] },
  { name: "premium", description: "Unlock Premium for someone who paid $10 (or take it away)", type: 1, options: [{ type: 3, name: "user", description: "Their username or phone id", required: true, autocomplete: true }, { type: 5, name: "remove", description: "Take it away instead", required: false }] },
  { name: "premiums", description: "Who has Premium, and who has asked for it", type: 1 },
  { name: "allow", description: "Let someone do something in the app", type: 1, options: [
    { type: 1, name: "streaming", description: "Let someone go live in Social (up to 3 people)", options: [
      { type: 3, name: "user", description: "Their username or phone id", required: true, autocomplete: true },
      { type: 5, name: "remove", description: "Take it away (ends their stream if they're live)", required: false }] }] },
  { name: "streamers", description: "Who may go live, and who's live now", type: 1 },
  { name: "allow-picture", description: "Let a user have a profile picture again", type: 1, options: [{ type: 3, name: "user", description: "Their username or phone id", required: true, autocomplete: true }] },
].map((c) => ({ ...c, default_member_permissions: "4", dm_permission: false }));   // (4: Ban Members; admins only)

/** The bot, for one place it runs.
 *   cfg       social/config.json
 *   priv      () => the bot's private key (CryptoKey, ECDH P-256) for the sealed emails
 *   notes     { get(): {phone: {why, by}}, set(obj) }  why each ban was made (kept with the bot, never in a store)
 *   token     the bot's token (renews file links in bulk; optional)
 *   log       (...text)
 *   stores    (online) the server's stores: { read(k), change(k, fn), put(k, d), premiumAsks(), premiumDone(phones) };
 *             without it, the store messages are read and written directly */
export function makeBot({ cfg, priv, notes, token = "", log = () => {}, stores = null }) {
  const HOOK = `${API}/webhooks/${cfg.hook}/${atob(cfg.key).split("").reverse().join("")}`;
  async function hook(path, opt = {}) {
    for (let i = 0; i < 5; i++) {
      const r = await fetch(HOOK + path, opt);
      if (r.status === 429) { const j = await r.json().catch(() => ({})); await sleep((j.retry_after || 1) * 1000 + 100); continue; }
      if (!r.ok) throw new Error(`store ${opt.method || "GET"} ${r.status}`);
      return r.status === 204 ? null : r.json();
    }
    throw new Error("store busy");
  }
  async function readStore(key, file) {
    if (stores) return stores.read(key);
    if (!cfg[key]) return null;
    const m = await hook(`/messages/${cfg[key]}`);
    const a = (m.attachments || []).find((x) => x.filename === file);
    return a ? (await fetch(a.url, { cache: "no-store" })).json() : null;
  }
  async function writeStore(key, file, content, data) {
    if (stores) return stores.put(key, data);
    const f = new FormData();
    f.append("payload_json", JSON.stringify({ content, attachments: [{ id: 0, filename: file }], allowed_mentions: { parse: [] } }));
    f.append("files[0]", new Blob([JSON.stringify(data)], { type: "application/json" }), file);
    await hook(`/messages/${cfg[key]}`, { method: "PATCH", body: f });
  }
  const MOD_LABEL = "FifTeam bans (kept by the FifTeam bot; please don't delete it)";
  const FEED_LABEL = "FifTeam Social feed (the app keeps this message up to date; please don't delete it)";
  const META_LABEL = "FifTeam votes, follows and about (the app keeps this message up to date; please don't delete it)";
  const obj = (x) => (x && typeof x === "object" && !Array.isArray(x) ? x : {});
  async function changeStore(key, file, label, fresh, fn, check) {
    // (through the server: each change is taken only on the copy it was made on, so it needs no checking after)
    if (stores) return stores.change(key, (d) => { if (!Object.keys(d).length) Object.assign(d, fresh()); fn(d); });
    for (let i = 0; i < 3; i++) {
      const d = (await readStore(key, file)) || fresh();
      fn(d);
      await writeStore(key, file, label, d);
      await sleep(1500);          // (a read straight after a write can be a moment old)
      const now = (await readStore(key, file)) || fresh();
      if (check(now)) return now;
    }
    throw new Error("couldn't save the change (the app was busy); try again");
  }
  const changeMod = (fn, check) => changeStore("mod", "mod.json", MOD_LABEL, () => ({ v: 1, bans: {}, nopic: {}, badges: {} }), (d) => { d.v = 1; d.bans = obj(d.bans); d.nopic = obj(d.nopic); d.badges = obj(d.badges); fn(d); }, (d) => check({ bans: obj(d.bans), nopic: obj(d.nopic), badges: obj(d.badges), emails: obj(d.emails) }));
  const changeFeed = (fn, check) => changeStore("index", "feed.json", FEED_LABEL, () => ({ v: 1, posts: [], profiles: {} }), (d) => { d.posts = Array.isArray(d.posts) ? d.posts : []; d.profiles = obj(d.profiles); for (const q of d.posts) q.comments = Array.isArray(q.comments) ? q.comments : []; fn(d); }, (d) => check({ posts: Array.isArray(d.posts) ? d.posts : [], profiles: obj(d.profiles) }));
  const changeMeta = (fn, check) => changeStore("meta", "meta.json", META_LABEL, () => ({ v: 1, votes: {}, follows: {}, about: {} }), (d) => { d.votes = obj(d.votes); d.follows = obj(d.follows); d.about = obj(d.about); fn(d); }, (d) => check({ about: obj(d.about) }));
  const changeBans = (fn, check) => changeMod((d) => fn(d.bans), (d) => check(d.bans));

  // ---------------------------------------------------------------------------------------------------- the commands
  const clean = (s, n = 40) => String(s || "").slice(0, n).replace(/[\\*_~`|>#@<:\[\]()]/g, (c) => "\\" + c) || "(no username)";
  const ago = (t) => { const s = Math.max(0, (Date.now() - t) / 1000); return s < 60 ? "just now" : s < 3600 ? `${Math.floor(s / 60)} min ago` : s < 86400 ? `${Math.floor(s / 3600)} h ago` : `${Math.floor(s / 86400)} d ago`; };
  /** Test phones (automated browsers say so when they check in; and the test usernames): never in the lists. */
  const isTest = (v) => !!(v && (v.t || /^FifTeam Test/i.test(v.n || v.name || "")));
  /** Everyone the app knows: phone id -> { name, device, v, at } (from the profiles and who's been online). */
  async function people() {
    const [feed, pres] = await Promise.all([readStore("index", "feed.json").catch(() => null), readStore("presence", "presence.json").catch(() => null)]);
    const out = {};
    const tests = new Set(Object.entries((pres && pres.on) || {}).filter(([, v]) => isTest(v)).map(([k]) => k));
    for (const [k, v] of Object.entries((feed && feed.profiles) || {})) if (PHONE.test(k) && !tests.has(k) && !isTest(v)) out[k] = { name: v.name || "", at: 0, device: "", v: "" };
    for (const [k, v] of Object.entries((pres && pres.on) || {})) if (PHONE.test(k) && !tests.has(k)) out[k] = { ...(out[k] || {}), name: v.n || (out[k] && out[k].name) || "", device: v.d || "", v: v.v || "", at: +v.at || 0 };
    return out;
  }
  /** The phones a /ban or /unban means: a phone id, or every phone that goes by that username. */
  function resolve(target, all) {
    const t = String(target || "").trim();
    if (PHONE.test(t) && all[t]) return [t];
    const low = t.toLowerCase();
    const hits = Object.keys(all).filter((k) => (all[k].name || "").toLowerCase() === low);
    if (hits.length) return hits;
    return PHONE.test(t) ? [t] : [];
  }

  async function cmdOnline() {
    const all = await people(), now = Date.now();
    const on = Object.entries(all).filter(([, v]) => now - v.at < ONLINE_MS).sort((a, b) => b[1].at - a[1].at);
    const today = Object.values(all).filter((v) => now - v.at < 86400e3).length;
    if (!on.length) return `Nobody has FifTeam Media open right now. (${today} phone${today === 1 ? "" : "s"} used it in the last 24 hours.)`;
    const lines = on.slice(0, 40).map(([k, v]) => `• **${clean(v.name)}** · ${clean(v.device) || "unknown device"} · v${clean(v.v)} · ${ago(v.at)} · \`${k}\``);
    return [`**${on.length} online now**${on.length > 40 ? " (first 40)" : ""}`, ...lines, `-# ${today} phone${today === 1 ? "" : "s"} in the last 24 hours. Ban with /ban and a username or the id in \`code\`.`].join("\n");
  }
  async function note(phones, why, by) {
    const n = (await notes.get().catch(() => ({}))) || {};
    for (const p of phones) { if (why || by) n[p] = { why: String(why || "").slice(0, 200), by: String(by || "") }; else delete n[p]; }
    await notes.set(n).catch((e) => log("ban notes:", e.message));
  }
  async function cmdBan(target, reason, by) {
    const all = await people(), phones = resolve(target, all);
    if (!phones.length) return `No phone goes by **${clean(target)}**. Try /online for names and ids.`;
    const at = Date.now();
    await changeBans((b) => { for (const p of phones) b[p] = { at, name: (all[p] && all[p].name) || String(target).slice(0, 24) }; }, (b) => phones.every((p) => b[p]));
    await note(phones, reason, by);
    await accountsBan(phones, true);
    return `Banned ${phones.map((p) => `**${clean((all[p] && all[p].name) || target)}** (\`${p}\`)`).join(", ")}. FifTeam Media shuts on ${phones.length === 1 ? "that phone" : "those phones"} the next time it checks (straight away when it's opened, or within 10 minutes), and stays shut until /unban.`;
  }
  async function cmdUnban(target) {
    const d = (await readStore("mod", "mod.json")) || { bans: {} };
    const bans = d.bans || {}, t = String(target || "").trim(), low = t.toLowerCase();
    const phones = Object.keys(bans).filter((k) => k === t || (bans[k].name || "").toLowerCase() === low);
    if (!phones.length) return `**${clean(target)}** isn't banned. /bans shows who is.`;
    await changeBans((b) => { for (const p of phones) delete b[p]; }, (b) => phones.every((p) => !b[p]));
    await note(phones, "", "");
    await accountsBan(phones, false);
    return `Unbanned ${phones.map((p) => `**${clean(bans[p].name)}** (\`${p}\`)`).join(", ")}. The app opens again on ${phones.length === 1 ? "that phone" : "those phones"} the next time it checks.`;
  }
  async function cmdBans() {
    const d = (await readStore("mod", "mod.json")) || { bans: {} };
    const list = Object.entries(d.bans || {}).sort((a, b) => b[1].at - a[1].at);
    if (!list.length) return "No phones are banned.";
    const n = (await notes.get().catch(() => ({}))) || {};
    return [`**${list.length} banned**`, ...list.slice(0, 40).map(([k, v]) => `• **${clean(v.name)}** · \`${k}\` · ${ago(v.at)}${n[k] && n[k].why ? ` · ${clean(n[k].why)}` : ""}`)].join("\n");
  }
  // ---------------------------------------------------------------------------------------------------- moderating
  const feedNow = async () => { const f = (await readStore("index", "feed.json")) || {}; return { posts: Array.isArray(f.posts) ? f.posts : [], profiles: obj(f.profiles) }; };
  const nameIn = (f, x) => (x.by && f.profiles[x.by] && f.profiles[x.by].name) || x.user || "someone";
  const short = (t, n = 50) => (t.length > n ? t.slice(0, n) + "…" : t);
  const what = (p) => (p.text ? `"${short(p.text)}"` : p.song ? `song: ${p.song.title || "a rebass"}` : p.video ? "a video" : p.image ? "a picture" : "a post");
  /** A user's posts and comments: by their phones, and (older posts, which don't say which phone) by their username. */
  function mineTest(phones, name) { const low = String(name || "").toLowerCase(); return (x) => (x.by && phones.includes(x.by)) || (!x.by && low && (x.user || "").toLowerCase() === low); }
  async function whoIs(target) {
    const all = await people(), phones = resolve(target, all);
    const name = phones.length ? (all[phones[0]] && all[phones[0]].name) || String(target) : String(target);
    return { phones, name, all };
  }
  // A phone that sent something in the last few seconds checks it again shortly after (in case another phone's copy of
  // the list landed on top of it) and puts it back if it's missing; so a removal is checked again a little later too.
  const pending = new Set();
  function again(fn) { const p = sleep(12000).then(fn).catch((e) => log("second pass:", e.message)); pending.add(p); p.finally(() => pending.delete(p)); }
  async function cmdPosts(user) {
    const f = await feedNow();
    let list = f.posts;
    if (user) { const w = await whoIs(user); list = list.filter(mineTest(w.phones, w.name)); }
    if (!list.length) return user ? `No posts from **${clean(user)}**.` : "No posts.";
    return [`**${user ? `${clean(user)}'s posts` : "Latest posts"}** (${list.length})`, ...list.slice(0, 15).map((p) => `• **${clean(nameIn(f, p))}** · ${ago(p.at)} · ${clean(what(p), 70)} · ♥ ${(p.likes || []).length} · 💬 ${(p.comments || []).length} · \`${p.id}\``),
      "-# /delete-post with the id in `code` takes one down."].join("\n");
  }
  async function cmdComments(user) {
    const f = await feedNow();
    let list = [];
    for (const p of f.posts) for (const c of p.comments || []) list.push({ p, c });
    if (user) { const w = await whoIs(user), t = mineTest(w.phones, w.name); list = list.filter((x) => t(x.c)); }
    list.sort((a, b) => (b.c.at || 0) - (a.c.at || 0));
    if (!list.length) return user ? `No comments from **${clean(user)}**.` : "No comments.";
    return [`**${user ? `${clean(user)}'s comments` : "Latest comments"}** (${list.length})`, ...list.slice(0, 15).map(({ p, c }) => `• **${clean(nameIn(f, c))}** on ${clean(nameIn(f, p))}'s post: "${clean(short(c.text || "", 60), 70)}" · ${ago(c.at)} · \`${p.id}:${c.id}\``),
      "-# /delete-comment with the id in `code` takes one down."].join("\n");
  }
  async function cmdDeletePost(id) {
    id = String(id || "").trim();
    const f = await feedNow(), p = f.posts.find((x) => x.id === id);
    if (!p) return `There's no post \`${clean(id)}\`. /posts lists them.`;
    const gone = (d) => { d.posts = d.posts.filter((x) => x.id !== id); }, ok = (d) => !d.posts.some((x) => x.id === id);
    await changeFeed(gone, ok);
    await hook(`/messages/${id}`, { method: "DELETE" }).catch(() => {});
    for (const it of (p.playlist && Array.isArray(p.playlist.items) ? p.playlist.items : [])) await hook(`/messages/${it.id}`, { method: "DELETE" }).catch(() => {});
    again(async () => { if (!ok(await feedNow())) await changeFeed(gone, ok); });
    return `Deleted **${clean(nameIn(f, p))}**'s post (${clean(what(p), 70)}). It's gone from everyone's feed the next time it refreshes.`;
  }
  async function cmdDeleteComment(ref) {
    const [pid, cid] = String(ref || "").trim().split(":");
    const f = await feedNow(), p = f.posts.find((x) => x.id === pid), c = p && (p.comments || []).find((x) => x.id === cid);
    if (!c) return `There's no comment \`${clean(ref)}\`. /comments lists them.`;
    const replies = (p.comments || []).filter((x) => x.re === cid).length;
    const gone = (d) => { const q = d.posts.find((x) => x.id === pid); if (q) q.comments = q.comments.filter((x) => x.id !== cid && x.re !== cid); };
    const ok = (d) => { const q = d.posts.find((x) => x.id === pid); return !q || !(q.comments || []).some((x) => x.id === cid); };
    await changeFeed(gone, ok);
    again(async () => { if (!ok(await feedNow())) await changeFeed(gone, ok); });
    return `Deleted **${clean(nameIn(f, c))}**'s comment "${clean(short(c.text || "", 60), 70)}"${replies ? ` and the ${replies} repl${replies === 1 ? "y" : "ies"} to it` : ""}.`;
  }
  async function cmdPurge(user) {
    const w = await whoIs(user), t = mineTest(w.phones, w.name);
    if (!w.phones.length && !String(user || "").trim()) return "Who? Give a username or phone id.";
    const f = await feedNow();
    const posts = f.posts.filter(t).flatMap((x) => [x.id, ...(x.playlist && Array.isArray(x.playlist.items) ? x.playlist.items.map((it) => it.id) : [])]);
    let comments = 0; for (const p of f.posts) if (!posts.includes(p.id)) for (const c of p.comments || []) if (t(c)) comments++;
    if (!posts.length && !comments && !(await marketNow().catch(() => ({ items: [] }))).items.some(t)) return `**${clean(w.name)}** has no posts, comments or listings.`;
    const purge = (d) => {
      d.posts = d.posts.filter((x) => !t(x));
      for (const q of d.posts) { const gone = new Set(q.comments.filter(t).map((c) => c.id)); q.comments = q.comments.filter((c) => !gone.has(c.id) && !gone.has(c.re)); }
    };
    const ok = (d) => !d.posts.some(t) && !d.posts.some((q) => (q.comments || []).some(t));
    await changeFeed(purge, ok);
    for (const id of posts) await hook(`/messages/${id}`, { method: "DELETE" }).catch(() => {});
    again(async () => { if (!ok(await feedNow())) await changeFeed(purge, ok); });
    // (and their Audio Market listings)
    const mk = await marketNow().catch(() => ({ items: [] })), gone = mk.items.filter(t).map((x) => x.id);
    if (gone.length) {
      await changeStore("market", "market.json", MARKET_LABEL, () => ({ v: 1, items: [] }), (m) => { m.items = (m.items || []).filter((x) => !t(x)); }, (m) => !(m.items || []).some(t));
      for (const id of gone) await hook(`/messages/${id}`, { method: "DELETE" }).catch(() => {});
    }
    return `Removed ${f.posts.filter(t).length} post${f.posts.filter(t).length === 1 ? "" : "s"}, ${comments} comment${comments === 1 ? "" : "s"}${gone.length ? ` and ${gone.length} Audio Market listing${gone.length === 1 ? "" : "s"}` : ""} by **${clean(w.name)}**.`;
  }
  async function cmdClearProfile(user) {
    const w = await whoIs(user);
    if (!w.phones.length) return `No phone goes by **${clean(user)}**.`;
    const at = Date.now(), pics = [];
    await changeMod((d) => { for (const p of w.phones) d.nopic[p] = at; }, (d) => w.phones.every((p) => d.nopic[p]));
    await changeMeta((d) => { d.setup = obj(d.setup); for (const p of w.phones) { delete d.about[p]; delete d.setup[p]; } }, (d) => w.phones.every((p) => !d.about[p] && !obj(d.setup)[p]));
    await changeFeed((d) => { for (const p of w.phones) if (d.profiles[p] && d.profiles[p].av) { pics.push(d.profiles[p].av); d.profiles[p].av = ""; } }, (d) => w.phones.every((p) => !d.profiles[p] || !d.profiles[p].av));
    for (const id of pics) await hook(`/messages/${id}`, { method: "DELETE" }).catch(() => {});
    return `Cleared **${clean(w.name)}**'s profile picture and about me. A new picture from ${w.phones.length === 1 ? "that phone" : "those phones"} won't show until /allow-picture.`;
  }
  async function cmdAllowPicture(user) {
    const d = (await readStore("mod", "mod.json")) || {};
    const w = await whoIs(user), phones = w.phones.filter((p) => obj(d.nopic)[p]);
    if (!phones.length) return `**${clean(user)}**'s picture isn't blocked.`;
    await changeMod((x) => { for (const p of phones) delete x.nopic[p]; }, (x) => phones.every((p) => !x.nopic[p]));
    return `**${clean(w.name)}** can have a profile picture again.`;
  }
  // ---------------------------------------------------------------------------------------------------- devices and tags
  const kindOf = (d) => (/^iPhone|^iPad|^iPod/.test(d) ? "iPhone / iPad" : /Android|Galaxy|Pixel|Samsung/.test(d) ? "Android" : d ? "Computer" : "Unknown (hasn't opened 2.4 or later yet)");
  async function cmdDevices(user) {
    const all = await people(), now = Date.now();
    let list = Object.entries(all);
    if (user) { const ph = resolve(user, all); list = list.filter(([k]) => ph.includes(k)); if (!list.length) return `No phone goes by **${clean(user)}**.`; }
    list.sort((a, b) => b[1].at - a[1].at);
    const kinds = {};
    for (const [, v] of list) kinds[kindOf(v.device)] = (kinds[kindOf(v.device)] || 0) + 1;
    const week = list.filter(([, v]) => now - v.at < 7 * 86400e3).length, day = list.filter(([, v]) => now - v.at < 86400e3).length;
    const lines = list.slice(0, 12).map(([k, v]) => `• **${clean(v.name)}** · ${v.device ? clean(v.device, 60) : "device unknown"}${v.v ? ` · v${clean(v.v)}` : ""} · ${v.at ? ago(v.at) : "not seen since 2.4"} · \`${k}\``);
    const text = [`**${list.length} phone${list.length === 1 ? "" : "s"}** ${user ? `for ${clean(user)}` : "have used FifTeam Media"} · ${day} today · ${week} this week`,
      Object.entries(kinds).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}: ${n}`).join(" · "), ...lines,
      list.length > 12 ? `-# …and ${list.length - 12} more in the attached list.` : "-# The full list is attached."].join("\n");
    const rows = [["Username", "Device", "App version", "Last seen", "Phone id"].join("\t"), ...list.map(([k, v]) => [v.name || "(no username)", v.device || "unknown", v.v || "", v.at ? new Date(v.at).toISOString().replace("T", " ").slice(0, 16) + " UTC" : "before 2.4", k].join("\t"))];
    return { text, file: { name: "fifteam-devices.txt", data: rows.join("\n") + "\n" } };
  }
  const TAG_NAMES = { member: "FifTeam Member", founder: "FifTeam Founder", dev: "FifTeam Media Developer", advertiser: "FifTeam Advertiser" };
  async function cmdTag(kind, user, remove) {
    const w = await whoIs(user);
    if (!w.phones.length) return `No phone goes by **${clean(user)}**.`;
    const on = !remove;
    await changeMod((d) => { for (const p of w.phones) { const l = (Array.isArray(d.badges[p]) ? d.badges[p] : []).filter((x) => x !== kind); if (on) l.push(kind); if (l.length) d.badges[p] = l; else delete d.badges[p]; } },
      (d) => w.phones.every((p) => (Array.isArray(d.badges[p]) && d.badges[p].includes(kind)) === on));
    return on ? `**${clean(w.name)}** has the **${TAG_NAMES[kind]}** tag now. It shows next to their name the next time each phone checks (within 10 minutes, or when the app is opened).`
      : `Took the **${TAG_NAMES[kind]}** tag off **${clean(w.name)}**.`;
  }
  async function cmdTags() {
    const d = (await readStore("mod", "mod.json")) || {}, all = await people();
    const list = Object.entries(obj(d.badges)).filter(([, v]) => Array.isArray(v) && v.length);
    if (!list.length) return "Nobody has a tag yet. Give one with /tag-member, /tag-founder, /tag-developer or /tag-advertiser.";
    return [`**Tags** (${list.length})`, ...list.map(([k, v]) => `• **${clean((all[k] && all[k].name) || k)}** · ${v.map((t) => TAG_NAMES[t] || t).join(", ")} · \`${k}\``)].join("\n");
  }
  async function suggestPosts(low) {
    const f = await feedNow();
    return f.posts.filter((p) => !low || p.id.includes(low) || nameIn(f, p).toLowerCase().includes(low) || (p.text || "").toLowerCase().includes(low)).slice(0, 25)
      .map((p) => ({ name: `${nameIn(f, p)} · ${ago(p.at)} · ${what(p)}`.slice(0, 100), value: p.id }));
  }
  async function suggestComments(low) {
    const f = await feedNow(), list = [];
    for (const p of f.posts) for (const c of p.comments || []) list.push({ p, c });
    list.sort((a, b) => (b.c.at || 0) - (a.c.at || 0));
    return list.filter(({ c }) => !low || nameIn(f, c).toLowerCase().includes(low) || (c.text || "").toLowerCase().includes(low)).slice(0, 25)
      .map(({ p, c }) => ({ name: `${nameIn(f, c)}: ${c.text || ""} (${ago(c.at)})`.slice(0, 100), value: `${p.id}:${c.id}` }));
  }
  async function suggest(cmd, typed) {
    const low = String(typed || "").toLowerCase();
    if (cmd === "delete-post") return suggestPosts(low);
    if (cmd === "delete-comment") return suggestComments(low);
    if (cmd === "ban-email" || cmd === "unban-email") {
      const emails = [...new Set((await allAccounts()).map((a) => a.email))], mod = (await readStore("mod", "mod.json")) || {}, banned = obj(mod.emails);
      const out = [];
      for (const e of emails) if ((cmd === "ban-email" ? !banned[await fingerprint(e)] : banned[await fingerprint(e)]) && (!low || e.includes(low))) out.push({ name: e.slice(0, 100), value: e });
      return out.slice(0, 25);
    }
    if (cmd === "delete-listing") { const d = await marketNow(); return d.items.filter((x) => !low || `${x.title} ${x.user} ${x.place}`.toLowerCase().includes(low)).slice(0, 25).map((x) => ({ name: `${x.title} · ${money(x.price)} · ${x.user}`.slice(0, 100), value: x.id })); }
    if (cmd === "unban") {
      const d = (await readStore("mod", "mod.json")) || { bans: {} };
      return Object.entries(d.bans || {}).filter(([k, v]) => !low || k.includes(low) || (v.name || "").toLowerCase().includes(low)).slice(0, 25).map(([k, v]) => ({ name: `${v.name || "(no username)"} · ${k}`.slice(0, 100), value: k }));
    }
    const all = await people();
    return Object.entries(all).filter(([k, v]) => !low || k.includes(low) || (v.name || "").toLowerCase().includes(low)).sort((a, b) => b[1].at - a[1].at)
      .slice(0, 25).map(([k, v]) => ({ name: `${v.name || "(no username)"} · ${v.device || "device unknown"} · ${k}`.slice(0, 100), value: k }));
  }

  // ---------------------------------------------------------------------------------------------------- accounts
  // The account list the app keeps (each email sealed for the bot's key), with any phone whose check-in carries a
  // sealed email but isn't on it yet. Each account's phone id links it to its username and device (from the check-ins).
  const fingerprint = async (email) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(email || "").trim().toLowerCase()))), (b) => b.toString(16).padStart(2, "0")).join("");
  const opened = new Map();   // (sealed text -> email: each opened once)
  async function unseal(text) {
    if (opened.has(text)) return opened.get(text);
    const e = (await openSealed(await priv(), text)).trim().toLowerCase();
    opened.set(text, e);
    return e;
  }
  async function allAccounts() {
    const [d, pres] = await Promise.all([readStore("accounts", "accounts.json").catch(() => null), readStore("presence", "presence.json").catch(() => null)]);
    const byEmail = new Map();
    let failed = 0;
    for (const v of Object.values(obj(d && d.a))) {
      if (!v || typeof v.e !== "string") continue;
      let email; try { email = await unseal(v.e); } catch { failed++; continue; }
      const a = { email, verified: !!v.ok, disabled: false, uid: PHONE.test(v.u || "") ? v.u : "", created: +v.c || 0, last: +v.at || 0 };
      const was = byEmail.get(email);
      byEmail.set(email, was ? { ...was, verified: was.verified || a.verified, uid: a.uid || was.uid, created: Math.min(was.created || a.created, a.created || was.created), last: Math.max(was.last, a.last) } : a);
    }
    for (const [ph, v] of Object.entries(obj(pres && pres.on))) {
      if (!PHONE.test(ph) || !v || typeof v.e !== "string" || isTest(v)) continue;
      let email; try { email = await unseal(v.e); } catch { continue; }
      const was = byEmail.get(email);
      if (!was) byEmail.set(email, { email, verified: true, disabled: false, uid: ph, created: 0, last: +v.at || 0 });
      else if (!was.uid) was.uid = ph;
    }
    if (failed) log(`accounts: ${failed} sealed email${failed === 1 ? "" : "s"} couldn't be opened (is BOT_KEY the bot's key?)`);
    return [...byEmail.values()];
  }
  /** Each phone's account email. */
  async function emailsByPhone() {
    const out = {};
    for (const a of await allAccounts().catch(() => [])) if (a.uid) out[a.uid] = a.email;
    return out;
  }
  /** A ban (or its end) for these phones reaches their accounts' emails too (so a new sign-in doesn't get round it). */
  async function accountsBan(phones, on) {
    const byPhone = await emailsByPhone().catch(() => ({}));
    const hashes = [...new Set(await Promise.all(phones.map((p) => byPhone[p]).filter(Boolean).map(fingerprint)))];
    if (!hashes.length) return;
    await changeMod((d) => { d.emails = obj(d.emails); for (const x of hashes) { if (on) d.emails[x] = { at: Date.now() }; else delete d.emails[x]; } }, () => true);
  }
  /** Every account (newest first): email, username, the phone it's on, app version, online or last seen, confirmed or not, banned. */
  async function cmdAccounts() {
    const list = (await allAccounts()).sort((a, b) => (b.created || 0) - (a.created || 0));
    if (!list.length) return "No accounts yet.";
    const all = await people(), mod = (await readStore("mod", "mod.json")) || {}, banned = obj(mod.emails);
    const rows = [];
    for (const a of list) {
      const p = (a.uid && all[a.uid]) || {};
      rows.push({ a, name: p.name || "(no username yet)", device: p.device || (a.uid ? "device not seen yet" : "hasn't finished signing in on a phone yet"), v: p.v || "", seen: p.at || 0, ban: !!banned[await fingerprint(a.email)] || a.disabled });
    }
    const now = Date.now();
    const waiting = rows.filter((r) => !r.a.verified).length, on = rows.filter((r) => now - r.seen < ONLINE_MS).length;
    const when = (r) => (r.seen ? (now - r.seen < ONLINE_MS ? "**online now**" : `seen ${ago(r.seen)}`) : r.a.last ? `signed in ${ago(r.a.last)}` : "not seen yet");
    const lines = rows.slice(0, 15).map((r) => `• ${clean(r.a.email, 60)} · **${clean(r.name)}** · ${clean(r.device, 60)}${r.v ? ` · v${clean(r.v)}` : ""} · ${when(r)}${r.a.created ? ` · joined ${ago(r.a.created)}` : ""}${r.a.verified ? "" : " · **email not confirmed yet**"}${r.ban ? " · **banned**" : ""}${r.a.uid ? ` · \`${r.a.uid}\`` : ""}`);
    const text = [`**${rows.length} account${rows.length === 1 ? "" : "s"}** · ${on} online now${waiting ? ` · ${waiting} haven't confirmed their email yet` : ""}`, ...lines, rows.length > 15 ? `-# …and ${rows.length - 15} more in the attached list.` : "-# The full list is attached."].join("\n");
    const iso = (t) => (t ? new Date(t).toISOString().replace("T", " ").slice(0, 16) + " UTC" : "");
    const file = [["Email", "Username", "Device", "App version", "Last seen", "Joined", "Email confirmed", "Banned", "Phone id"].join("\t"),
      ...rows.map((r) => [r.a.email, r.name, r.device, r.v, iso(r.seen || r.a.last), iso(r.a.created), r.a.verified ? "yes" : "no", r.ban ? "yes" : "", r.a.uid].join("\t"))].join("\n") + "\n";
    return { text: text.length > 1990 ? text.slice(0, text.lastIndexOf("\n", 1900)) + "\n-# …the rest are in the attached list." : text, file: { name: "fifteam-accounts.txt", data: file } };
  }
  async function cmdBanEmail(email, ban, by) {
    email = String(email || "").trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return "That isn't an email address.";
    const fp = await fingerprint(email), byPhone = await emailsByPhone().catch(() => ({})), all = await people();
    const phones = Object.keys(byPhone).filter((p) => byPhone[p] === email);
    await changeMod((d) => { d.emails = obj(d.emails); if (ban) d.emails[fp] = { at: Date.now() }; else delete d.emails[fp]; }, () => true);
    if (phones.length) {
      if (ban) { await changeBans((b) => { for (const p of phones) b[p] = { at: Date.now(), name: (all[p] && all[p].name) || email.split("@")[0] }; }, (b) => phones.every((p) => b[p])); await note(phones, "banned by email", by); }
      else { await changeBans((b) => { for (const p of phones) delete b[p]; }, (b) => phones.every((p) => !b[p])); await note(phones, "", ""); }
    }
    return ban ? `Banned **${clean(email, 60)}**${phones.length ? ` (${clean((all[phones[0]] || {}).name || "")})` : ""}. The app shuts on every phone signed in to it, and it can't sign in or sign up again until /unban-email.`
      : `Unbanned **${clean(email, 60)}**. It can sign in again.`;
  }

  // ---------------------------------------------------------------------------------------------------- premium
  async function cmdPremium(user, remove, by) {
    const w = await whoIs(user);
    if (!w.phones.length) return `No phone goes by **${clean(user)}**. Try /premiums for who has asked.`;
    const on = !remove, at = Date.now();
    await changeMod((d) => { d.premium = obj(d.premium); for (const p of w.phones) { if (on) d.premium[p] = { at, name: (w.all[p] && w.all[p].name) || String(user).slice(0, 24) }; else delete d.premium[p]; } }, () => true);
    if (on && stores && stores.premiumDone) await stores.premiumDone(w.phones).catch(() => {});
    // (a record in #payments)
    if (stores && stores.tellPayments) await stores.tellPayments(on ? `✅ Unlocked Premium for **${clean(w.name)}**${by ? ` (by <@${by}>)` : ""}.` : `↩️ Took Premium away from **${clean(w.name)}**${by ? ` (by <@${by}>)` : ""}.`).catch(() => {});
    return on ? `**${clean(w.name)}** has Premium now (unlimited rebassing and downloads, 4th and 6th-order boxes). It unlocks on their phone the next time it checks (straight away if the app is open, or when it's opened).`
      : `Took Premium away from **${clean(w.name)}**.`;
  }
  async function cmdPremiums() {
    const d = (await readStore("mod", "mod.json")) || {}, paid = Object.entries(obj(d.premium)).sort((a, b) => b[1].at - a[1].at);
    // (an ask: when, and (newer apps) how they're paying, their name there, and their account's email)
    const when = (x) => (x && typeof x === "object" ? +x.at || 0 : +x || 0);
    const asks = stores && stores.premiumAsks ? Object.entries(obj(await stores.premiumAsks().catch(() => ({})))).filter(([k]) => !obj(d.premium)[k]).sort((a, b) => when(b[1]) - when(a[1])) : [];
    const all = asks.length ? await people() : {};
    const lines = [`**Premium** · ${paid.length} paid${asks.length ? ` · ${asks.length} asked (check PayPal and Cash App for $10 from the name they gave)` : ""}`];
    for (const [k, v] of paid.slice(0, 25)) lines.push(`• **${clean(v.name)}** · since ${ago(v.at)} · \`${k}\``);
    for (const [k, x] of asks.slice(0, 15)) {
      const how = x && typeof x === "object" && x.pay ? ` · ${x.method === "cash" ? "Cash App" : "PayPal"}: **${clean(x.pay, 60)}**${x.email ? ` · ${clean(x.email, 80)}` : ""}` : "";
      lines.push(`• asked: **${clean((all[k] && all[k].name) || k)}**${how} · ${ago(when(x))} · \`${k}\` (unlock with /premium)`);
    }
    if (!paid.length && !asks.length) lines.push("Nobody yet.");
    return lines.join("\n");
  }

  // ---------------------------------------------------------------------------------------------------- live streaming
  const MAX_STREAMERS = 3;
  async function cmdAllowStreaming(user, remove) {
    const w = await whoIs(user);
    if (!w.phones.length) return `No phone goes by **${clean(user)}**.`;
    const d = (await readStore("mod", "mod.json")) || {}, now = obj(d.stream);
    // (people, not phones: one person's phones count once)
    const people_ = new Set(Object.values(now).map((v) => String(v.name || "").toLowerCase()));
    const already = w.phones.some((p) => now[p]);
    if (!remove && !already && people_.size >= MAX_STREAMERS) return `${MAX_STREAMERS} people can already go live: ${Object.values(now).map((v) => `**${clean(v.name)}**`).filter((x, i, a) => a.indexOf(x) === i).join(", ")}. Take one away first (/allow streaming user remove: True).`;
    const at = Date.now();
    await changeMod((m) => { m.stream = obj(m.stream); for (const p of w.phones) { if (remove) delete m.stream[p]; else m.stream[p] = { at, name: (w.all[p] && w.all[p].name) || String(user).slice(0, 24) }; } }, () => true);
    if (remove && stores && stores.endStreamsOf) await stores.endStreamsOf(w.phones).catch(() => {});
    return remove ? `**${clean(w.name)}** can't go live any more${already ? " (their stream, if any, has ended)" : ""}.`
      : `**${clean(w.name)}** can go live now: a **Go live** button shows in Social on their phone (the next time it checks: straight away if the app is open).`;
  }
  async function cmdStreamers() {
    const d = (await readStore("mod", "mod.json")) || {}, list = Object.entries(obj(d.stream));
    const live = stores && stores.streams ? await stores.streams().catch(() => []) : [];
    const lines = [`**Streaming** · ${new Set(list.map(([, v]) => v.name)).size} of ${MAX_STREAMERS} allowed${live.length ? ` · ${live.length} live now` : ""}`];
    for (const [k, v] of list) { const on = live.find((s) => s.by === k); lines.push(`• **${clean(v.name)}** · since ${ago(v.at)} · \`${k}\`${on ? ` · 🔴 live now (${on.viewers} watching, ${on.likes} likes)` : ""}`); }
    if (!list.length) lines.push("Nobody yet. /allow streaming lets someone go live.");
    return lines.join("\n");
  }

  // ---------------------------------------------------------------------------------------------------- Audio Market
  const MARKET_LABEL = "FifTeam Audio Market (the app keeps this message up to date; please don't delete it)";
  const marketNow = async () => { const d = (await readStore("market", "market.json")) || {}; return { items: Array.isArray(d.items) ? d.items : [] }; };
  const money = (p) => (+p ? "$" + (+p).toLocaleString("en-US") : "Free");
  async function cmdListings(user) {
    const d = await marketNow(), f = await feedNow();
    let list = d.items;
    if (user) { const w = await whoIs(user), t = mineTest(w.phones, w.name); list = list.filter(t); }
    if (!list.length) return user ? `No listings from **${clean(user)}**.` : "Nothing on Audio Market yet.";
    return [`**${user ? `${clean(user)}'s listings` : "Audio Market"}** (${list.length})`, ...list.slice(0, 15).map((x) => `• **${clean(x.title, 50)}** · ${money(x.price)}${x.sold ? " · sold" : ""} · ${clean(nameIn(f, x))} · ${clean(x.place || "", 30)} · ${ago(x.at)} · \`${x.id}\``),
      "-# /delete-listing with the id in `code` takes one down."].join("\n");
  }
  async function cmdDeleteListing(id) {
    id = String(id || "").trim();
    const d = await marketNow(), x = d.items.find((y) => y.id === id);
    if (!x) return `There's no listing \`${clean(id)}\`. /listings lists them.`;
    const gone = (m) => { m.items = (Array.isArray(m.items) ? m.items : []).filter((y) => y.id !== id); }, ok = (m) => !(m.items || []).some((y) => y.id === id);
    await changeStore("market", "market.json", MARKET_LABEL, () => ({ v: 1, items: [] }), gone, ok);
    await hook(`/messages/${id}`, { method: "DELETE" }).catch(() => {});
    again(async () => { const now = (await readStore("market", "market.json")) || { items: [] }; if (!ok(now)) await changeStore("market", "market.json", MARKET_LABEL, () => ({ v: 1, items: [] }), gone, ok); });
    return `Took down **${clean(x.title, 50)}** (${money(x.price)}) by **${clean(x.user)}**.`;
  }

  // ---------------------------------------------------------------------------------------------------- file links
  // File links expire after about a day and each post's are read from its own message; keeping them all, fresh, in
  // one store saves every phone that work (phones still read any post that's missing or expired). Links already in the
  // store are renewed in bulk (fifty at a time, with the bot's token); only new posts' messages are read one by one.
  const LINKS_LABEL = "FifTeam file links (kept fresh by the FifTeam bot; please don't delete it)";
  const expiry = (url) => { try { return parseInt(new URL(url).searchParams.get("ex") || "0", 16) * 1000; } catch { return 0; } };
  async function refreshLinks({ maxReads = 30, pace = 400 } = {}) {
    if (!cfg.links) return 0;
    const [f, mk, had] = await Promise.all([feedNow(), marketNow().catch(() => ({ items: [] })), readStore("links", "links.json").catch(() => null)]);
    const ids = [...new Set([...f.posts.filter((p) => p.image || p.video || p.song || p.avatar || (Array.isArray(p.media) && p.media.length) || p.playlist).map((p) => p.id), ...Object.values(f.profiles).map((v) => v && v.av).filter((x) => /^\d{5,25}$/.test(x || "")), ...mk.items.filter((x) => !x.sold).map((x) => x.id)])];
    const old = obj(had && had.links), links = {}, soon = Date.now() + 8 * 3600e3, renew = [];
    for (const id of ids) {
      const a = Array.isArray(old[id]) ? old[id] : null;
      if (a && a.length && a.every((x) => expiry(x.url) > soon)) links[id] = a;
      else if (a && a.length) renew.push(id);
    }
    // in bulk: the links that are in the store already, but expire within eight hours
    if (token && renew.length) {
      const urls = renew.flatMap((id) => old[id].map((x) => x.url));
      for (let i = 0; i < urls.length; i += 50) {
        try {
          const r = await fetch(`${API}/attachments/refresh-urls`, { method: "POST", headers: { Authorization: `Bot ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ attachment_urls: urls.slice(i, i + 50) }) });
          if (!r.ok) { log("renewing links:", r.status); break; }
          const map = new Map(((await r.json()).refreshed_urls || []).map((x) => [x.original, x.refreshed]));
          for (const id of renew) if (!links[id] && old[id].every((x) => map.has(x.url) && expiry(map.get(x.url)) > soon)) links[id] = old[id].map((x) => ({ filename: x.filename, url: map.get(x.url) }));
        } catch (e) { log("renewing links:", e.message); break; }
      }
    }
    // one by one: new posts (and anything the bulk renewal missed), a few each time
    let reads = 0;
    for (const id of ids) {
      if (links[id]) continue;
      if (reads >= maxReads) { if (Array.isArray(old[id])) links[id] = old[id]; continue; }
      reads++;
      try { const m = await hook(`/messages/${id}`); const a = (m.attachments || []).map(({ filename, url }) => ({ filename, url })); if (a.length) links[id] = a; } catch {}
      await sleep(pace);
    }
    await writeStore("links", "links.json", LINKS_LABEL, { v: 1, at: Date.now(), links });
    return Object.keys(links).length;
  }

  // ---------------------------------------------------------------------------------------------------- answering
  /** A slash command's answer: text, or { text, file: { name, data } }. */
  async function run(it) {
    // (a subcommand, like /allow streaming: its own options)
    const top = (it.data && it.data.options) || [], sub = top.length && top[0].type === 1 ? top[0] : null;
    const opt = (n) => ((sub ? sub.options : top) || []).find((o) => o.name === n);
    const v = (n) => (opt(n) ? opt(n).value : undefined);
    const who = (it.member && it.member.user) || it.user || {};
    const name = it.data.name;
    try {
      return name === "online" ? await cmdOnline()
        : name === "ban" ? (await cmdBan(v("user"), v("reason"), who.id)) + (v("delete_posts") ? "\n" + (await cmdPurge(v("user"))) : "")
        : name === "unban" ? await cmdUnban(v("user")) : name === "bans" ? await cmdBans()
        : name === "posts" ? await cmdPosts(v("user")) : name === "comments" ? await cmdComments(v("user"))
        : name === "delete-post" ? await cmdDeletePost(v("post")) : name === "delete-comment" ? await cmdDeleteComment(v("comment"))
        : name === "devices" ? await cmdDevices(v("user")) : name === "tags" ? await cmdTags()
        : name === "accounts" ? await cmdAccounts() : name === "ban-email" ? await cmdBanEmail(v("email"), true, who.id) : name === "unban-email" ? await cmdBanEmail(v("email"), false)
        : name === "listings" ? await cmdListings(v("user")) : name === "delete-listing" ? await cmdDeleteListing(v("listing"))
        : name === "tag-member" ? await cmdTag("member", v("user"), v("remove")) : name === "tag-founder" ? await cmdTag("founder", v("user"), v("remove")) : name === "tag-developer" ? await cmdTag("dev", v("user"), v("remove"))
        : name === "tag-advertiser" ? await cmdTag("advertiser", v("user"), v("remove"))
        : name === "premium" ? await cmdPremium(v("user"), v("remove"), who.id) : name === "premiums" ? await cmdPremiums()
        : name === "allow" && sub && sub.name === "streaming" ? await cmdAllowStreaming(v("user"), v("remove")) : name === "streamers" ? await cmdStreamers()
        : name === "purge" ? await cmdPurge(v("user")) : name === "clear-profile" ? await cmdClearProfile(v("user")) : name === "allow-picture" ? await cmdAllowPicture(v("user"))
        : "Unknown command";
    } catch (e) { log(`/${name} failed:`, e.message); return `Something went wrong: ${e.message}`; }
    finally { log(`/${name} by ${who.username || who.id || "?"}`); }
  }
  /** Autocomplete: the choices for the option being typed. */
  async function choices(it) {
    const top = (it.data && it.data.options) || [], f = [...top, ...top.flatMap((o) => o.options || [])].find((o) => o.focused);
    try { return await suggest(it.data.name, f && f.value); } catch (e) { log("autocomplete:", e.message); return []; }
  }
  /** The answer, in place of "thinking…" (base: where Discord's interaction replies go). */
  async function reply(it, answer, base = API) {
    const url = `${base}/webhooks/${it.application_id}/${it.token}/messages/@original`;
    let r;
    if (answer && typeof answer === "object") {
      const f = new FormData();
      f.append("payload_json", JSON.stringify({ content: String(answer.text).slice(0, 1990), allowed_mentions: { parse: [] }, attachments: [{ id: 0, filename: answer.file.name }] }));
      f.append("files[0]", new Blob([answer.file.data], { type: "text/plain" }), answer.file.name);
      r = await fetch(url, { method: "PATCH", body: f });
    } else r = await fetch(url, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content: String(answer).slice(0, 1990), allowed_mentions: { parse: [] } }) });
    if (!r.ok) log("reply failed:", r.status);
  }
  /** Everything left running (the second looks after a removal), finished. */
  const settle = () => Promise.all([...pending]);

  return { run, choices, reply, settle, refreshLinks, readStore, hook, allAccounts, cmdAccounts, cmdOnline };
}
