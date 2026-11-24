// The FifTeam bot: slash commands in the FifTeam Discord server, for the server's admins (people with Ban Members).
//   /online            who has FifTeam Media open right now, with their device and app version
//   /ban <user>        bans a phone (by username or phone id) from FifTeam Media until /unban
//   /unban <user>      lifts a ban
//   /bans              the phones banned now
//   /posts, /comments  the latest posts or comments (anyone's, or one user's), with their ids
//   /delete-post, /delete-comment   take one down (a comment goes with its replies)
//   /purge <user>      every post and comment of theirs, gone
//   /clear-profile <user>   their picture and about me removed, and no new picture shown until /allow-picture
// It reads and writes the app's store messages through the same webhook the app uses (social/config.json), and talks
// to Discord over the gateway (a websocket), so it needs no web server: it runs on this PC (node 18+, no packages).
//
// Setting it up: at https://discord.com/developers/applications make a New Application (e.g. "FifTeam"), open Bot and
// Reset Token (copy it), then run --setup below and open the invite link it prints to add the bot to the server.
//   node tools/bot/fifteam-bot.mjs --setup     asks for the bot's token, keeps it in %APPDATA%\fifteam-bot\bot.json
//                                              (never in the project), registers the commands, and starts with Windows
//   node tools/bot/fifteam-bot.mjs             runs the bot (what Windows starts)
import { readFileSync, writeFileSync, mkdirSync, appendFileSync, existsSync } from "node:fs";
import { join, dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { createInterface } from "node:readline";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const HOME = join(process.env.APPDATA || process.env.HOME || HERE, "fifteam-bot");
const API = "https://discord.com/api/v10";
const PHONE = /^[a-z0-9]{6,16}$/;
const ONLINE_MS = 5 * 60e3;   // the app checks in every 4 minutes while it's on screen

function log(...a) {
  const line = `${new Date().toISOString()} ${a.join(" ")}`;
  console.log(line);
  try { mkdirSync(HOME, { recursive: true }); appendFileSync(join(HOME, "bot.log"), line + "\n"); } catch {}
}

// ---------------------------------------------------------------------------------------------------- the app's stores
const cfg = JSON.parse(readFileSync(join(ROOT, "social", "config.json"), "utf8"));
const HOOK = `${API}/webhooks/${cfg.hook}/${Buffer.from(cfg.key, "base64").toString().split("").reverse().join("")}`;
async function hook(path, opt = {}) {
  for (let i = 0; i < 5; i++) {
    const r = await fetch(HOOK + path, opt);
    if (r.status === 429) { const j = await r.json().catch(() => ({})); await new Promise((s) => setTimeout(s, (j.retry_after || 1) * 1000 + 100)); continue; }
    if (!r.ok) throw new Error(`store ${opt.method || "GET"} ${r.status}`);
    return r.status === 204 ? null : r.json();
  }
  throw new Error("store busy");
}
export async function readStore(key, file) {
  const m = await hook(`/messages/${cfg[key]}`);
  const a = (m.attachments || []).find((x) => x.filename === file);
  return a ? (await fetch(a.url, { cache: "no-store" })).json() : null;
}
async function writeStore(key, file, content, data) {
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
  for (let i = 0; i < 3; i++) {
    const d = (await readStore(key, file)) || fresh();
    fn(d);
    await writeStore(key, file, label, d);
    await new Promise((s) => setTimeout(s, 1500));          // (a read straight after a write can be a moment old)
    const now = (await readStore(key, file)) || fresh();
    if (check(now)) return now;
  }
  throw new Error("couldn't save the change (the app was busy); try again");
}
const changeMod = (fn, check) => changeStore("mod", "mod.json", MOD_LABEL, () => ({ v: 1, bans: {}, nopic: {} }), (d) => { d.v = 1; d.bans = obj(d.bans); d.nopic = obj(d.nopic); fn(d); }, (d) => check({ bans: obj(d.bans), nopic: obj(d.nopic) }));
const changeFeed = (fn, check) => changeStore("index", "feed.json", FEED_LABEL, () => ({ v: 1, posts: [], profiles: {} }), (d) => { d.posts = Array.isArray(d.posts) ? d.posts : []; d.profiles = obj(d.profiles); for (const q of d.posts) q.comments = Array.isArray(q.comments) ? q.comments : []; fn(d); }, (d) => check({ posts: Array.isArray(d.posts) ? d.posts : [], profiles: obj(d.profiles) }));
const changeMeta = (fn, check) => changeStore("meta", "meta.json", META_LABEL, () => ({ v: 1, votes: {}, follows: {}, about: {} }), (d) => { d.votes = obj(d.votes); d.follows = obj(d.follows); d.about = obj(d.about); fn(d); }, (d) => check({ about: obj(d.about) }));
const changeBans = (fn, check) => changeMod((d) => fn(d.bans), (d) => check(d.bans));

// ---------------------------------------------------------------------------------------------------- the commands
const clean = (s, n = 40) => String(s || "").slice(0, n).replace(/[\\*_~`|>#@<:\[\]()]/g, (c) => "\\" + c) || "(no username)";
const ago = (t) => { const s = Math.max(0, (Date.now() - t) / 1000); return s < 60 ? "just now" : s < 3600 ? `${Math.floor(s / 60)} min ago` : s < 86400 ? `${Math.floor(s / 3600)} h ago` : `${Math.floor(s / 86400)} d ago`; };
/** Everyone the app knows: phone id -> { name, device, v, at } (from the profiles and who's been online). */
async function people() {
  const [feed, pres] = await Promise.all([readStore("index", "feed.json").catch(() => null), readStore("presence", "presence.json").catch(() => null)]);
  const out = {};
  for (const [k, v] of Object.entries((feed && feed.profiles) || {})) if (PHONE.test(k)) out[k] = { name: v.name || "", at: 0, device: "", v: "" };
  for (const [k, v] of Object.entries((pres && pres.on) || {})) if (PHONE.test(k)) out[k] = { ...(out[k] || {}), name: v.n || (out[k] && out[k].name) || "", device: v.d || "", v: v.v || "", at: +v.at || 0 };
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

export async function cmdOnline() {
  const all = await people(), now = Date.now();
  const on = Object.entries(all).filter(([, v]) => now - v.at < ONLINE_MS).sort((a, b) => b[1].at - a[1].at);
  const today = Object.values(all).filter((v) => now - v.at < 86400e3).length;
  if (!on.length) return `Nobody has FifTeam Media open right now. (${today} phone${today === 1 ? "" : "s"} used it in the last 24 hours.)`;
  const lines = on.slice(0, 40).map(([k, v]) => `• **${clean(v.name)}** · ${clean(v.device) || "unknown device"} · v${clean(v.v)} · ${ago(v.at)} · \`${k}\``);
  return [`**${on.length} online now**${on.length > 40 ? " (first 40)" : ""}`, ...lines, `-# ${today} phone${today === 1 ? "" : "s"} in the last 24 hours. Ban with /ban and a username or the id in \`code\`.`].join("\n");
}
// (the reasons stay on this PC: every phone reads the ban list, so it holds only the phone ids, names and times)
const NOTES = join(HOME, "ban-notes.json");
const notes = () => { try { return JSON.parse(readFileSync(NOTES, "utf8")); } catch { return {}; } };
function note(phones, why, by) { const n = notes(); for (const p of phones) { if (why || by) n[p] = { why: String(why || "").slice(0, 200), by: String(by || "") }; else delete n[p]; } try { mkdirSync(HOME, { recursive: true }); writeFileSync(NOTES, JSON.stringify(n)); } catch {} }
export async function cmdBan(target, reason, by) {
  const all = await people(), phones = resolve(target, all);
  if (!phones.length) return `No phone goes by **${clean(target)}**. Try /online for names and ids.`;
  const at = Date.now();
  await changeBans((b) => { for (const p of phones) b[p] = { at, name: (all[p] && all[p].name) || String(target).slice(0, 24) }; }, (b) => phones.every((p) => b[p]));
  note(phones, reason, by);
  return `Banned ${phones.map((p) => `**${clean((all[p] && all[p].name) || target)}** (\`${p}\`)`).join(", ")}. FifTeam Media shuts on ${phones.length === 1 ? "that phone" : "those phones"} the next time it checks (straight away when it's opened, or within 10 minutes), and stays shut until /unban.`;
}
export async function cmdUnban(target) {
  const d = (await readStore("mod", "mod.json")) || { bans: {} };
  const bans = d.bans || {}, t = String(target || "").trim(), low = t.toLowerCase();
  const phones = Object.keys(bans).filter((k) => k === t || (bans[k].name || "").toLowerCase() === low);
  if (!phones.length) return `**${clean(target)}** isn't banned. /bans shows who is.`;
  await changeBans((b) => { for (const p of phones) delete b[p]; }, (b) => phones.every((p) => !b[p]));
  note(phones, "", "");
  return `Unbanned ${phones.map((p) => `**${clean(bans[p].name)}** (\`${p}\`)`).join(", ")}. The app opens again on ${phones.length === 1 ? "that phone" : "those phones"} the next time it checks.`;
}
export async function cmdBans() {
  const d = (await readStore("mod", "mod.json")) || { bans: {} };
  const list = Object.entries(d.bans || {}).sort((a, b) => b[1].at - a[1].at);
  if (!list.length) return "No phones are banned.";
  const n = notes();
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
export async function cmdPosts(user) {
  const f = await feedNow();
  let list = f.posts;
  if (user) { const w = await whoIs(user); list = list.filter(mineTest(w.phones, w.name)); }
  if (!list.length) return user ? `No posts from **${clean(user)}**.` : "No posts.";
  return [`**${user ? `${clean(user)}'s posts` : "Latest posts"}** (${list.length})`, ...list.slice(0, 15).map((p) => `• **${clean(nameIn(f, p))}** · ${ago(p.at)} · ${clean(what(p), 70)} · ♥ ${(p.likes || []).length} · 💬 ${(p.comments || []).length} · \`${p.id}\``),
    "-# /delete-post with the id in `code` takes one down."].join("\n");
}
export async function cmdComments(user) {
  const f = await feedNow();
  let list = [];
  for (const p of f.posts) for (const c of p.comments || []) list.push({ p, c });
  if (user) { const w = await whoIs(user), t = mineTest(w.phones, w.name); list = list.filter((x) => t(x.c)); }
  list.sort((a, b) => (b.c.at || 0) - (a.c.at || 0));
  if (!list.length) return user ? `No comments from **${clean(user)}**.` : "No comments.";
  return [`**${user ? `${clean(user)}'s comments` : "Latest comments"}** (${list.length})`, ...list.slice(0, 15).map(({ p, c }) => `• **${clean(nameIn(f, c))}** on ${clean(nameIn(f, p))}'s post: "${clean(short(c.text || "", 60), 70)}" · ${ago(c.at)} · \`${p.id}:${c.id}\``),
    "-# /delete-comment with the id in `code` takes one down."].join("\n");
}
export async function cmdDeletePost(id) {
  id = String(id || "").trim();
  const f = await feedNow(), p = f.posts.find((x) => x.id === id);
  if (!p) return `There's no post \`${clean(id)}\`. /posts lists them.`;
  await changeFeed((d) => { d.posts = d.posts.filter((x) => x.id !== id); }, (d) => !d.posts.some((x) => x.id === id));
  await hook(`/messages/${id}`, { method: "DELETE" }).catch(() => {});
  return `Deleted **${clean(nameIn(f, p))}**'s post (${clean(what(p), 70)}). It's gone from everyone's feed the next time it refreshes.`;
}
export async function cmdDeleteComment(ref) {
  const [pid, cid] = String(ref || "").trim().split(":");
  const f = await feedNow(), p = f.posts.find((x) => x.id === pid), c = p && (p.comments || []).find((x) => x.id === cid);
  if (!c) return `There's no comment \`${clean(ref)}\`. /comments lists them.`;
  const replies = (p.comments || []).filter((x) => x.re === cid).length;
  await changeFeed((d) => { const q = d.posts.find((x) => x.id === pid); if (q) q.comments = q.comments.filter((x) => x.id !== cid && x.re !== cid); }, (d) => { const q = d.posts.find((x) => x.id === pid); return !q || !q.comments.some((x) => x.id === cid); });
  return `Deleted **${clean(nameIn(f, c))}**'s comment "${clean(short(c.text || "", 60), 70)}"${replies ? ` and the ${replies} repl${replies === 1 ? "y" : "ies"} to it` : ""}.`;
}
export async function cmdPurge(user) {
  const w = await whoIs(user), t = mineTest(w.phones, w.name);
  if (!w.phones.length && !String(user || "").trim()) return "Who? Give a username or phone id.";
  const f = await feedNow();
  const posts = f.posts.filter(t).map((x) => x.id);
  let comments = 0; for (const p of f.posts) if (!posts.includes(p.id)) for (const c of p.comments || []) if (t(c)) comments++;
  if (!posts.length && !comments) return `**${clean(w.name)}** has no posts or comments.`;
  await changeFeed((d) => {
    d.posts = d.posts.filter((x) => !t(x));
    for (const q of d.posts) { const gone = new Set(q.comments.filter(t).map((c) => c.id)); q.comments = q.comments.filter((c) => !gone.has(c.id) && !gone.has(c.re)); }
  }, (d) => !d.posts.some(t) && !d.posts.some((q) => q.comments.some(t)));
  for (const id of posts) await hook(`/messages/${id}`, { method: "DELETE" }).catch(() => {});
  return `Removed ${posts.length} post${posts.length === 1 ? "" : "s"} and ${comments} comment${comments === 1 ? "" : "s"} by **${clean(w.name)}**.`;
}
export async function cmdClearProfile(user) {
  const w = await whoIs(user);
  if (!w.phones.length) return `No phone goes by **${clean(user)}**.`;
  const at = Date.now(), pics = [];
  await changeMod((d) => { for (const p of w.phones) d.nopic[p] = at; }, (d) => w.phones.every((p) => d.nopic[p]));
  await changeMeta((d) => { for (const p of w.phones) delete d.about[p]; }, (d) => w.phones.every((p) => !d.about[p]));
  await changeFeed((d) => { for (const p of w.phones) if (d.profiles[p] && d.profiles[p].av) { pics.push(d.profiles[p].av); d.profiles[p].av = ""; } }, (d) => w.phones.every((p) => !d.profiles[p] || !d.profiles[p].av));
  for (const id of pics) await hook(`/messages/${id}`, { method: "DELETE" }).catch(() => {});
  return `Cleared **${clean(w.name)}**'s profile picture and about me. A new picture from ${w.phones.length === 1 ? "that phone" : "those phones"} won't show until /allow-picture.`;
}
export async function cmdAllowPicture(user) {
  const d = (await readStore("mod", "mod.json")) || {};
  const w = await whoIs(user), phones = w.phones.filter((p) => obj(d.nopic)[p]);
  if (!phones.length) return `**${clean(user)}**'s picture isn't blocked.`;
  await changeMod((x) => { for (const p of phones) delete x.nopic[p]; }, (x) => phones.every((p) => !x.nopic[p]));
  return `**${clean(w.name)}** can have a profile picture again.`;
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
  if (cmd === "unban") {
    const d = (await readStore("mod", "mod.json")) || { bans: {} };
    return Object.entries(d.bans || {}).filter(([k, v]) => !low || k.includes(low) || (v.name || "").toLowerCase().includes(low)).slice(0, 25).map(([k, v]) => ({ name: `${v.name || "(no username)"} · ${k}`.slice(0, 100), value: k }));
  }
  const all = await people();
  return Object.entries(all).filter(([k, v]) => !low || k.includes(low) || (v.name || "").toLowerCase().includes(low)).sort((a, b) => b[1].at - a[1].at)
    .slice(0, 25).map(([k, v]) => ({ name: `${v.name || "(no username)"} · ${v.device || "device unknown"} · ${k}`.slice(0, 100), value: k }));
}

// ---------------------------------------------------------------------------------------------------- Discord
const COMMANDS = [
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
  { name: "clear-profile", description: "Remove a user's profile picture and about me (and block new pictures)", type: 1, options: [{ type: 3, name: "user", description: "Their username or phone id", required: true, autocomplete: true }] },
  { name: "allow-picture", description: "Let a user have a profile picture again", type: 1, options: [{ type: 3, name: "user", description: "Their username or phone id", required: true, autocomplete: true }] },
].map((c) => ({ ...c, default_member_permissions: "4", dm_permission: false }));   // (4: Ban Members; admins only)

function token() {
  if (process.env.FIFTEAM_BOT_TOKEN) return process.env.FIFTEAM_BOT_TOKEN.trim();
  try { return JSON.parse(readFileSync(join(HOME, "bot.json"), "utf8")).token; } catch { return ""; }
}
async function bot(path, tok, opt = {}) {
  const r = await fetch(API + path, { ...opt, headers: { Authorization: `Bot ${tok}`, "Content-Type": "application/json", ...(opt.headers || {}) } });
  if (r.status === 429) { const j = await r.json().catch(() => ({})); await new Promise((s) => setTimeout(s, (j.retry_after || 1) * 1000 + 100)); return bot(path, tok, opt); }
  if (!r.ok) throw new Error(`${opt.method || "GET"} ${path} ${r.status} ${(await r.text()).slice(0, 200)}`);
  return r.status === 204 ? null : r.json();
}
async function register(tok) {
  const app = await bot("/oauth2/applications/@me", tok);
  const w = await hook("");
  if (!w.guild_id) throw new Error("the webhook's server wasn't found");
  await bot(`/applications/${app.id}/guilds/${w.guild_id}/commands`, tok, { method: "PUT", body: JSON.stringify(COMMANDS) });
  return { app, guild: w.guild_id };
}
async function answer(it, tok) {
  const reply = (type, data) => fetch(`${API}/interactions/${it.id}/${it.token}/callback`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type, data }) });
  const opt = (n) => ((it.data && it.data.options) || []).find((o) => o.name === n);
  try {
    if (it.type === 4) { const f = (it.data.options || []).find((o) => o.focused); await reply(8, { choices: await suggest(it.data.name, f && f.value) }); return; }
    if (it.type !== 2) return;
    // (the work can take a few seconds: "thinking…" first, then the answer)
    await reply(5, { flags: 64 });
    const who = (it.member && it.member.user) || it.user || {};
    const name = it.data.name;
    let text;
    try {
      const v = (n) => (opt(n) ? opt(n).value : undefined);
      text = name === "online" ? await cmdOnline()
        : name === "ban" ? (await cmdBan(v("user"), v("reason"), who.id)) + (v("delete_posts") ? "\n" + (await cmdPurge(v("user"))) : "")
        : name === "unban" ? await cmdUnban(v("user")) : name === "bans" ? await cmdBans()
        : name === "posts" ? await cmdPosts(v("user")) : name === "comments" ? await cmdComments(v("user"))
        : name === "delete-post" ? await cmdDeletePost(v("post")) : name === "delete-comment" ? await cmdDeleteComment(v("comment"))
        : name === "purge" ? await cmdPurge(v("user")) : name === "clear-profile" ? await cmdClearProfile(v("user")) : name === "allow-picture" ? await cmdAllowPicture(v("user"))
        : "Unknown command";
    } catch (e) { text = `Something went wrong: ${e.message}`; }
    log(`/${name} by ${who.username || who.id}`);
    await fetch(`${API}/webhooks/${it.application_id}/${it.token}/messages/@original`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content: text.slice(0, 1990), allowed_mentions: { parse: [] } }) });
  } catch (e) { log("answer failed:", e.message); }
}
async function run() {
  const tok = token();
  if (!tok) { log("No bot token. Run: node tools/bot/fifteam-bot.mjs --setup"); process.exit(1); }
  const reg = async () => { try { const { app, guild } = await register(tok); log(`commands ready for ${app.name} in server ${guild}`); return true; } catch (e) { log("couldn't register the commands yet (is the bot in the server?):", e.message.slice(0, 160)); return false; } };
  if (!(await reg())) { const t = setInterval(async () => { if (await reg()) clearInterval(t); }, 60e3); }
  let wait = 2000;
  for (;;) {
    try { await session(tok); wait = 2000; } catch (e) { log("gateway:", e.message); }
    await new Promise((s) => setTimeout(s, wait)); wait = Math.min(60000, wait * 2);
  }
}
/** One gateway connection, until it closes. */
async function session(tok) {
  const { url } = await bot("/gateway/bot", tok);
  const ws = new WebSocket(`${url}/?v=10&encoding=json`);
  let seq = null, beat = null, acked = true;
  return new Promise((done, fail) => {
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.s != null) seq = m.s;
      if (m.op === 10) {
        const every = m.d.heartbeat_interval;
        setTimeout(() => ws.send(JSON.stringify({ op: 1, d: seq })), Math.random() * every);
        beat = setInterval(() => { if (!acked) { ws.close(4000); return; } acked = false; ws.send(JSON.stringify({ op: 1, d: seq })); }, every);
        ws.send(JSON.stringify({ op: 2, d: { token: tok, intents: 0, properties: { os: "windows", browser: "fifteam-bot", device: "fifteam-bot" } } }));
      } else if (m.op === 11) acked = true;
      else if (m.op === 1) ws.send(JSON.stringify({ op: 1, d: seq }));
      else if (m.op === 7 || m.op === 9) ws.close(4000);
      else if (m.op === 0 && m.t === "READY") log(`online as ${m.d.user.username}`);
      else if (m.op === 0 && m.t === "INTERACTION_CREATE") answer(m.d, tok);
    };
    ws.onclose = (e) => { clearInterval(beat); if (e.code === 4004) { log("Discord refused the token (4004). Run --setup again with a new one."); process.exit(1); } done(); };
    ws.onerror = () => { clearInterval(beat); fail(new Error("connection error")); };
  });
}

// ---------------------------------------------------------------------------------------------------- setup
async function setup() {
  const given = process.argv.find((a) => a.startsWith("--token="));
  let tok = given ? given.slice(8) : process.env.FIFTEAM_BOT_TOKEN || "";
  if (!tok) { const rl = createInterface({ input: process.stdin, output: process.stdout }); tok = await new Promise((r) => rl.question("Paste the bot's token: ", (a) => { rl.close(); r(a.trim()); })); }
  const me = await bot("/users/@me", tok);
  mkdirSync(HOME, { recursive: true });
  writeFileSync(join(HOME, "bot.json"), JSON.stringify({ token: tok }), { mode: 0o600 });
  const app = await bot("/oauth2/applications/@me", tok);
  console.log(`Token kept in ${join(HOME, "bot.json")} for ${me.username}.`);
  try { const { guild } = await register(tok); console.log(`Commands registered in server ${guild}.`); }
  catch (e) { console.log("The commands go in once the bot is in the server (it keeps trying every minute)."); }
  console.log(`Invite link: https://discord.com/oauth2/authorize?client_id=${app.id}&scope=bot%20applications.commands&permissions=0`);
  if (process.platform === "win32") {
    // start with Windows, out of sight
    const vbs = join(HOME, "start-bot.vbs");
    writeFileSync(vbs, `CreateObject("WScript.Shell").Run """${process.execPath}"" ""${fileURLToPath(import.meta.url)}""", 0, False\r\n`);
    // (the Startup folder: no administrator rights needed, unlike a scheduled task that runs at logon)
    writeFileSync(join(process.env.APPDATA, "Microsoft", "Windows", "Start Menu", "Programs", "Startup", "FifTeam bot.vbs"), readFileSync(vbs));
    execFileSync("wscript.exe", [vbs]);
    console.log("The bot starts with Windows and is running now. Its log: " + join(HOME, "bot.log"));
  }
}

if (process.argv[1] && resolvePath(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--setup")) setup().catch((e) => { console.log("Setup failed:", e.message); process.exit(1); });
  else run();
}
