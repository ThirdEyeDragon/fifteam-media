// The FifTeam bot, from a PC: setting it up, putting it online, and (if ever wanted) running it here instead.
// The commands themselves are in core.mjs (the list is at the top of it); the online part is worker.mjs.
//
// Setting it up: at https://discord.com/developers/applications make a New Application (e.g. "FifTeam"), open Bot and
// Reset Token (copy it), then run --setup below and open the invite link it prints to add the bot to the server.
//   node tools/bot/fifteam-bot.mjs --setup     asks for the bot's token, keeps it in %APPDATA%\fifteam-bot\bot.json
//                                              (never in the project) and registers the commands
//   node tools/bot/fifteam-bot.mjs --online    puts the bot online on Cloudflare Workers (free: nothing has to run on
//                                              this PC): deploys worker.mjs, gives it the bot's token and key (as
//                                              secrets), keeps the ban reasons there, and points Discord at it.
//                                              Needs a free Cloudflare account, signed in once: npx wrangler@4 login
//   node tools/bot/fifteam-bot.mjs --offline   points Discord back at this PC (then run the bot here, as below)
//   node tools/bot/fifteam-bot.mjs             runs the bot on this PC (over Discord's gateway, a websocket)
import { readFileSync, writeFileSync, mkdirSync, appendFileSync } from "node:fs";
import { join, dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { createInterface } from "node:readline";
import { botKeys } from "./auth.mjs";
import { makeBot, COMMANDS } from "./core.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const HOME = join(process.env.APPDATA || process.env.HOME || HERE, "fifteam-bot");
const API = "https://discord.com/api/v10";

function log(...a) {
  const line = `${new Date().toISOString()} ${a.join(" ")}`;
  console.log(line);
  try { mkdirSync(HOME, { recursive: true }); appendFileSync(join(HOME, "bot.log"), line + "\n"); } catch {}
}
const cfg = JSON.parse(readFileSync(join(ROOT, "social", "config.json"), "utf8"));
// (the ban reasons stay with the bot: every phone reads the ban list, so it holds only the phone ids, names and times)
const NOTES = join(HOME, "ban-notes.json");
const notes = {
  get: async () => { try { return JSON.parse(readFileSync(NOTES, "utf8")); } catch { return {}; } },
  set: async (n) => { mkdirSync(HOME, { recursive: true }); writeFileSync(NOTES, JSON.stringify(n)); },
};
function token() {
  if (process.env.FIFTEAM_BOT_TOKEN) return process.env.FIFTEAM_BOT_TOKEN.trim();
  try { return JSON.parse(readFileSync(join(HOME, "bot.json"), "utf8")).token; } catch { return ""; }
}
export const pcBot = () => makeBot({ cfg, priv: async () => (await botKeys(HOME)).priv, notes, token: token(), log });

async function bot(path, tok, opt = {}) {
  const r = await fetch(API + path, { ...opt, headers: { Authorization: `Bot ${tok}`, "Content-Type": "application/json", ...(opt.headers || {}) } });
  if (r.status === 429) { const j = await r.json().catch(() => ({})); await new Promise((s) => setTimeout(s, (j.retry_after || 1) * 1000 + 100)); return bot(path, tok, opt); }
  if (!r.ok) throw new Error(`${opt.method || "GET"} ${path} ${r.status} ${(await r.text()).slice(0, 200)}`);
  return r.status === 204 ? null : r.json();
}
async function register(tok) {
  const app = await bot("/oauth2/applications/@me", tok);
  const b = pcBot(), w = await b.hook("");
  if (!w.guild_id) throw new Error("the webhook's server wasn't found");
  await bot(`/applications/${app.id}/guilds/${w.guild_id}/commands`, tok, { method: "PUT", body: JSON.stringify(COMMANDS) });
  return { app, guild: w.guild_id };
}

// ---------------------------------------------------------------------------------------------------- on this PC
async function run() {
  const tok = token();
  if (!tok) { log("No bot token. Run: node tools/bot/fifteam-bot.mjs --setup"); process.exit(1); }
  const b = pcBot();
  const reg = async () => { try { const { app, guild } = await register(tok); log(`commands ready for ${app.name} in server ${guild}`); return true; } catch (e) { log("couldn't register the commands yet (is the bot in the server?):", e.message.slice(0, 160)); return false; } };
  if (!(await reg())) { const t = setInterval(async () => { if (await reg()) clearInterval(t); }, 60e3); }
  const links = async () => { try { log(`file links refreshed: ${await b.refreshLinks({ maxReads: 400, pace: 1000 })}`); } catch (e) { log("file links:", e.message); } };
  links(); setInterval(links, 30 * 60e3);
  let wait = 2000;
  for (;;) {
    try { await session(tok, b); wait = 2000; } catch (e) { log("gateway:", e.message); }
    await new Promise((s) => setTimeout(s, wait)); wait = Math.min(60000, wait * 2);
  }
}
async function answer(it, b) {
  const callback = (type, data) => fetch(`${API}/interactions/${it.id}/${it.token}/callback`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type, data }) });
  try {
    if (it.type === 4) { await callback(8, { choices: await b.choices(it) }); return; }
    if (it.type !== 2) return;
    await callback(5, { flags: 64 });            // (the work can take a few seconds: "thinking…" first, then the answer)
    await b.reply(it, await b.run(it));
  } catch (e) { log("answer failed:", e.message); }
}
/** One gateway connection, until it closes. */
async function session(tok, b) {
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
      else if (m.op === 0 && m.t === "INTERACTION_CREATE") answer(m.d, b);
    };
    ws.onclose = (e) => { clearInterval(beat); if (e.code === 4004) { log("Discord refused the token (4004). Run --setup again with a new one."); process.exit(1); } done(); };
    ws.onerror = () => { clearInterval(beat); fail(new Error("connection error")); };
  });
}

// ---------------------------------------------------------------------------------------------------- online
const wrangler = (args, input) => execFileSync("npx", ["-y", "wrangler@4", ...args], { cwd: HERE, shell: true, input, encoding: "utf8", stdio: [input == null ? "inherit" : "pipe", "pipe", "pipe"], timeout: 180000 });
/** The bot on Cloudflare Workers, and Discord sending its commands there. */
async function online() {
  const tok = token();
  if (!tok) throw new Error("no bot token yet: run --setup first");
  const app = await bot("/applications/@me", tok);
  // the settings: the application's public key, and a store for the ban reasons
  const toml = join(HERE, "wrangler.toml");
  let t = readFileSync(toml, "utf8").replace(/^PUBLIC_KEY = ".*"$/m, `PUBLIC_KEY = "${app.verify_key}"`);
  if (!/\[\[kv_namespaces\]\]/.test(t)) {
    const out = wrangler(["kv", "namespace", "create", "NOTES"]);
    const id = (/"id":\s*"([0-9a-f]{32})"/.exec(out) || /id = "([0-9a-f]{32})"/.exec(out) || [])[1];
    if (!id) throw new Error("couldn't make the ban-reasons store: " + out.slice(-300));
    t += `\n[[kv_namespaces]]\nbinding = "NOTES"\nid = "${id}"\n`;
  }
  writeFileSync(toml, t);
  console.log("Deploying…");
  const dep = wrangler(["deploy"]);
  const url = (/https:\/\/fifteam-bot\.[a-z0-9-]+\.workers\.dev/.exec(dep) || [])[0];
  if (!url) throw new Error("couldn't find the bot's address in: " + dep.slice(-400));
  // the secrets: put in through the tool's input (never on a command line, never in a file here)
  wrangler(["secret", "put", "BOT_TOKEN"], tok);
  wrangler(["secret", "put", "BOT_KEY"], readFileSync(join(HOME, "auth-key.json"), "utf8"));
  // the ban reasons made on this PC so far go up too
  const n = await notes.get();
  if (Object.keys(n).length) wrangler(["kv", "key", "put", "--binding=NOTES", "--remote", "ban-notes", JSON.stringify(n)]);
  // Discord checks the address (a signed test, and a badly signed one) before it takes it
  await new Promise((s) => setTimeout(s, 4000));
  await bot("/applications/@me", tok, { method: "PATCH", body: JSON.stringify({ interactions_endpoint_url: url }) });
  await register(tok);
  console.log(`The bot is online at ${url}: Discord sends its commands there, and the file links refresh every half hour. Nothing needs to run on this PC.`);
}
async function offline() {
  const tok = token();
  await bot("/applications/@me", tok, { method: "PATCH", body: JSON.stringify({ interactions_endpoint_url: null }) });
  console.log("Discord sends the commands over the gateway again: run the bot on this PC (node tools/bot/fifteam-bot.mjs).");
}

// ---------------------------------------------------------------------------------------------------- setup
async function setup() {
  const given = process.argv.find((a) => a.startsWith("--token="));
  let tok = given ? given.slice(8) : process.env.FIFTEAM_BOT_TOKEN || "";
  if (!tok) { const rl = createInterface({ input: process.stdin, output: process.stdout }); tok = await new Promise((r) => rl.question("Paste the bot's token: ", (a) => { rl.close(); r(a.trim()); })); }
  const me = await bot("/users/@me", tok);
  mkdirSync(HOME, { recursive: true });
  writeFileSync(join(HOME, "bot.json"), JSON.stringify({ token: tok }), { mode: 0o600 });
  await botKeys(HOME);
  const app = await bot("/oauth2/applications/@me", tok);
  console.log(`Token kept in ${join(HOME, "bot.json")} for ${me.username}.`);
  try { const { guild } = await register(tok); console.log(`Commands registered in server ${guild}.`); }
  catch { console.log("The commands go in once the bot is in the server."); }
  console.log(`Invite link: https://discord.com/oauth2/authorize?client_id=${app.id}&scope=bot%20applications.commands&permissions=0`);
  console.log("Then put it online (nothing running on this PC): node tools/bot/fifteam-bot.mjs --online");
}

if (process.argv[1] && resolvePath(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const fail = (e) => { console.log("Failed:", e.message); process.exit(1); };
  if (process.argv.includes("--setup")) setup().catch(fail);
  else if (process.argv.includes("--online")) online().catch(fail);
  else if (process.argv.includes("--offline")) offline().catch(fail);
  else run();
}
