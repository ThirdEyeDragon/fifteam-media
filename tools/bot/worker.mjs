// The FifTeam bot, online (Cloudflare Workers, free): nothing runs on a PC. Discord sends each slash command here (the
// application's Interactions Endpoint URL), and Cloudflare runs the file links' refresh every half hour (the cron in
// wrangler.toml). The commands themselves are in core.mjs.
//   Secrets (wrangler secret put, never in the project): BOT_TOKEN (the bot's token), BOT_KEY (the bot's private key,
// as JWK JSON, for the sealed emails). Settings (wrangler.toml): PUBLIC_KEY (the application's public key, for checking
// that a request really comes from Discord), CONFIG_URL (the app's social/config.json). Ban reasons: the NOTES store.
import { makeBot } from "./core.mjs";

const hex = (s) => Uint8Array.from(String(s).match(/.{2}/g) || [], (b) => parseInt(b, 16));
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json" } });

/** Whether Discord signed this request (Ed25519 over the timestamp and the body). */
async function fromDiscord(env, req, body) {
  const sig = req.headers.get("X-Signature-Ed25519"), ts = req.headers.get("X-Signature-Timestamp");
  if (!sig || !ts || !/^[0-9a-f]{128}$/i.test(sig) || !/^[0-9a-f]{64}$/i.test(env.PUBLIC_KEY || "")) return false;
  try {
    const key = await crypto.subtle.importKey("raw", hex(env.PUBLIC_KEY), { name: "Ed25519" }, false, ["verify"]);
    return await crypto.subtle.verify({ name: "Ed25519" }, key, hex(sig), new TextEncoder().encode(ts + body));
  } catch { return false; }
}

let made = null;
/** The bot (made again every ten minutes, so a change to the app's config reaches it). */
async function botFor(env) {
  if (made && Date.now() - made.at < 600e3) return made.bot;
  const r = await fetch(env.CONFIG_URL, { cf: { cacheTtl: 120 } });
  if (!r.ok) throw new Error("config " + r.status);
  const cfg = await r.json();
  let key = null;
  const priv = async () => (key = key || (await crypto.subtle.importKey("jwk", JSON.parse(env.BOT_KEY), { name: "ECDH", namedCurve: "P-256" }, false, ["deriveKey"])));
  const notes = {
    get: async () => (env.NOTES ? JSON.parse((await env.NOTES.get("ban-notes")) || "{}") : {}),
    set: async (n) => { if (env.NOTES) await env.NOTES.put("ban-notes", JSON.stringify(n)); },
  };
  const bot = makeBot({ cfg, priv, notes, token: env.BOT_TOKEN || "", log: (...a) => console.log(...a) });
  made = { at: Date.now(), bot };
  return bot;
}

export default {
  async fetch(req, env, ctx) {
    if (req.method !== "POST") return new Response("FifTeam bot", { status: 200, headers: { "Content-Type": "text/plain" } });
    const body = await req.text();
    if (!(await fromDiscord(env, req, body))) return new Response("invalid request signature", { status: 401 });
    const it = JSON.parse(body);
    if (it.type === 1) return json({ type: 1 });                                   // (Discord checking the address)
    const bot = await botFor(env);
    if (it.type === 4) return json({ type: 8, data: { choices: await bot.choices(it) } });   // autocomplete
    if (it.type === 2) {
      // "thinking…" at once (only the person who typed it sees it), then the answer in its place
      ctx.waitUntil((async () => { await bot.reply(it, await bot.run(it), env.REPLY_API || undefined); await bot.settle(); })().catch((e) => console.log("answer failed:", e.message)));
      return json({ type: 5, data: { flags: 64 } });
    }
    return json({ type: 1 });
  },
  async scheduled(_ev, env, ctx) {
    ctx.waitUntil(botFor(env).then((bot) => bot.refreshLinks()).then((n) => console.log("file links refreshed:", n), (e) => console.log("file links:", e.message)));
  },
};
