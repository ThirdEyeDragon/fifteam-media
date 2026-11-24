// The FifTeam bot: slash commands in the FifTeam Discord server, for the server's admins (people with Ban Members).
//   /online            who has FifTeam Media open right now, with their device and app version
//   /ban <user>        bans a phone (by username or phone id) from FifTeam Media until /unban
//   /unban <user>      lifts a ban
//   /bans              the phones banned now
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
async function changeBans(fn, check) {
  for (let i = 0; i < 3; i++) {
    const d = (await readStore("mod", "mod.json")) || { v: 1, bans: {} };
    d.bans = d.bans && typeof d.bans === "object" ? d.bans : {};
    fn(d.bans);
    await writeStore("mod", "mod.json", MOD_LABEL, { v: 1, bans: d.bans });
    await new Promise((s) => setTimeout(s, 1500));          // (a read straight after a write can be a moment old)
    const now = (await readStore("mod", "mod.json")) || { bans: {} };
    if (check(now.bans || {})) return now.bans;
  }
  throw new Error("couldn't save the ban list");
}

// ---------------------------------------------------------------------------------------------------- the commands
const clean = (s) => String(s || "").replace(/[\\*_~`|>#@<:\[\]()]/g, (c) => "\\" + c).slice(0, 40) || "(no username)";
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
async function suggest(cmd, typed) {
  const low = String(typed || "").toLowerCase();
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
    { type: 3, name: "reason", description: "Why (kept with the bot, shown in /bans)", required: false }] },
  { name: "unban", description: "Lift a FifTeam Media ban", type: 1, options: [{ type: 3, name: "user", description: "Their username or phone id", required: true, autocomplete: true }] },
  { name: "bans", description: "The phones banned from FifTeam Media", type: 1 },
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
      text = name === "online" ? await cmdOnline() : name === "ban" ? await cmdBan(opt("user") && opt("user").value, opt("reason") && opt("reason").value, who.id)
        : name === "unban" ? await cmdUnban(opt("user") && opt("user").value) : name === "bans" ? await cmdBans() : "Unknown command";
    } catch (e) { text = `Something went wrong: ${e.message}`; }
    log(`/${name} by ${who.username || who.id}`);
    await fetch(`${API}/webhooks/${it.application_id}/${it.token}/messages/@original`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content: text.slice(0, 1990), allowed_mentions: { parse: [] } }) });
  } catch (e) { log("answer failed:", e.message); }
}
async function run() {
  const tok = token();
  if (!tok) { log("No bot token. Run: node tools/bot/fifteam-bot.mjs --setup"); process.exit(1); }
  try { const { app, guild } = await register(tok); log(`commands ready for ${app.name} in server ${guild}`); } catch (e) { log("couldn't register the commands:", e.message); }
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
  const { app, guild } = await register(tok);
  console.log(`Token kept in ${join(HOME, "bot.json")}. Commands registered for ${me.username} in server ${guild}.`);
  console.log(`(If the commands don't show in the server, invite the bot: https://discord.com/oauth2/authorize?client_id=${app.id}&scope=bot%20applications.commands&permissions=0)`);
  if (process.platform === "win32") {
    // start with Windows, out of sight
    const vbs = join(HOME, "start-bot.vbs");
    writeFileSync(vbs, `CreateObject("WScript.Shell").Run """${process.execPath}"" ""${fileURLToPath(import.meta.url)}""", 0, False\r\n`);
    execFileSync("schtasks", ["/Create", "/F", "/TN", "FifTeam bot", "/SC", "ONLOGON", "/TR", `wscript.exe "${vbs}"`], { stdio: "inherit" });
    execFileSync("schtasks", ["/Run", "/TN", "FifTeam bot"], { stdio: "inherit" });
    console.log("The bot starts with Windows and is running now. Its log: " + join(HOME, "bot.log"));
  }
}

if (process.argv[1] && resolvePath(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--setup")) setup().catch((e) => { console.log("Setup failed:", e.message); process.exit(1); });
  else run();
}
