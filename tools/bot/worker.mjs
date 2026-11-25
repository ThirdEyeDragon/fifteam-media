// The FifTeam bot and server, online (Cloudflare Workers, free): nothing runs on a PC.
//   /                Discord sends each slash command here (the application's Interactions Endpoint URL); the
//                    commands are in core.mjs
//   /v1/stores       the app's data, any number of stores in one request (hub.mjs keeps them)
//   /v1/store/<k>    a change to one store (with the version it was made on)
//   /v1/files        the current links to posts' files, for many posts at once
//   /v1/live         a live connection: the app hears at once when something changes
//   /v1/push         a phone signing up for notifications (with proof of its account), /v1/push/off to stop
//   /v1/premium      "Unlock unlimited rebassing" tapped: the owner is told
// And on a timer (the crons in wrangler.toml): every minute, anything older apps wrote merged in; every half hour, the
// file links refreshed.
//   Secrets (wrangler secret put, never in the project): BOT_TOKEN, BOT_KEY (the bot's private key, for the sealed
// emails), VAPID_KEY (the notifications' private key). Settings (wrangler.toml): PUBLIC_KEY (the application's public key,
// to check a request really comes from Discord), CONFIG_URL (the app's social/config.json), FIREBASE_JWKS.
import { makeBot } from "./core.mjs";
import { Hub, checkIdToken, STORES } from "./hub.mjs";
export { Hub };

const hex = (s) => Uint8Array.from(String(s).match(/.{2}/g) || [], (b) => parseInt(b, 16));
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, PUT, POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Max-Age": "86400" };
const json = (o, status = 200, cors = false) => new Response(typeof o === "string" ? o : JSON.stringify(o), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...(cors ? CORS : {}) } });

/** Whether Discord signed this request (Ed25519 over the timestamp and the body). */
async function fromDiscord(env, req, body) {
  const sig = req.headers.get("X-Signature-Ed25519"), ts = req.headers.get("X-Signature-Timestamp");
  if (!sig || !ts || !/^[0-9a-f]{128}$/i.test(sig) || !/^[0-9a-f]{64}$/i.test(env.PUBLIC_KEY || "")) return false;
  try {
    const key = await crypto.subtle.importKey("raw", hex(env.PUBLIC_KEY), { name: "Ed25519" }, false, ["verify"]);
    return await crypto.subtle.verify({ name: "Ed25519" }, key, hex(sig), new TextEncoder().encode(ts + body));
  } catch { return false; }
}

const hubOf = (env) => env.HUB.get(env.HUB.idFromName("fifteam"));
let cfgMemo = null;
async function config(env) {
  if (cfgMemo && Date.now() - cfgMemo.at < 300e3) return cfgMemo.c;
  const r = await fetch(env.CONFIG_URL, { cf: { cacheTtl: 60 } });
  if (!r.ok) throw new Error("config " + r.status);
  cfgMemo = { at: Date.now(), c: await r.json() };
  return cfgMemo.c;
}
let made = null;
/** The bot, its stores kept by the hub (made again every ten minutes, so a change to the app's config reaches it). */
async function botFor(env) {
  if (made && Date.now() - made.at < 600e3) return made.bot;
  const cfg = await config(env);
  // (a connection to the hub belongs to one request: a new one each time)
  const hub = new Proxy({}, { get: (_, name) => (...args) => hubOf(env)[name](...args) });
  let key = null;
  const priv = async () => (key = key || (await crypto.subtle.importKey("jwk", JSON.parse(env.BOT_KEY), { name: "ECDH", namedCurve: "P-256" }, false, ["deriveKey"])));
  const notes = {
    get: async () => (env.NOTES ? JSON.parse((await env.NOTES.get("ban-notes")) || "{}") : {}),
    set: async (n) => { if (env.NOTES) await env.NOTES.put("ban-notes", JSON.stringify(n)); },
  };
  const parse = (raw) => { try { return JSON.parse(raw); } catch { return null; } };
  const stores = {
    read: async (k) => parse((await hub.read([k]))[k].raw),
    async change(k, fn) {
      for (let i = 0; i < 6; i++) {
        const r = (await hub.read([k]))[k], d = parse(r.raw) || {};
        fn(d);
        const w = await hub.write(k, r.v, JSON.stringify(d), "bot");
        if (w.status === 200) return d;
      }
      throw new Error("couldn't save the change (busy); try again");
    },
    put: async (k, d) => { await hub.write(k, null, JSON.stringify(d), "bot"); },
    premiumAsks: () => hub.premiumAsks(), premiumDone: (phones) => hub.premiumDone(phones),
  };
  const bot = makeBot({ cfg, priv, notes, stores, token: env.BOT_TOKEN || "", log: (...a) => console.log(...a) });
  made = { at: Date.now(), bot };
  return bot;
}
/** Proof of the phone's account (a Firebase ID token): its phone id. */
async function phoneOf(env, tk) { const c = await config(env); return (await checkIdToken(tk, c.firebase.projectId, env.FIREBASE_JWKS)).phone; }

async function app(req, env, url) {
  const hub = hubOf(env), path = url.pathname;
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (path === "/v1/live") return hub.fetch(req);
  if (path === "/v1/stores" && req.method === "GET") {
    const keys = String(url.searchParams.get("k") || "").split(",").filter((k) => STORES[k]);
    const have = Object.fromEntries(String(url.searchParams.get("have") || "").split(",").map((x) => x.split(":")).filter(([k, v]) => STORES[k] && /^\d+$/.test(v || "")).map(([k, v]) => [k, +v]));
    const got = await hub.read(keys, have);
    // (the stores' JSON as it is, not read and written again)
    return json(`{"s":{${Object.entries(got).map(([k, x]) => `"${k}":{"v":${x.v}${x.raw != null ? `,"d":${x.raw}` : ""}}`).join(",")}}}`, 200, true);
  }
  const m = /^\/v1\/store\/([a-z]+)$/.exec(path);
  if (m && req.method === "PUT") {
    const v = url.searchParams.get("v");
    const r = await hub.write(m[1], v == null ? null : +v, await req.text(), "phone");
    return json(r.status === 200 ? { v: r.v } : r.status === 409 ? { conflict: true, v: r.v } : { error: r.status }, r.status, true);
  }
  if (path === "/v1/files" && req.method === "POST") {
    const { ids } = await req.json().catch(() => ({}));
    return json({ files: await hub.files(Array.isArray(ids) ? ids.map(String) : [], env.BOT_TOKEN || "") }, 200, true);
  }
  if (path === "/v1/push" && req.method === "POST") {
    const b = await req.json().catch(() => ({}));
    let phone; try { phone = await phoneOf(env, b.tk); } catch (e) { return json({ error: "account: " + e.message }, 401, true); }
    try { await hub.subscribe(phone, b.sub, b.prefs); } catch (e) { return json({ error: e.message }, 400, true); }
    return json({ ok: true }, 200, true);
  }
  if (path === "/v1/push/off" && req.method === "POST") {
    const b = await req.json().catch(() => ({}));
    if (typeof b.endpoint === "string") await hub.unsubscribe(b.endpoint);
    return json({ ok: true }, 200, true);
  }
  if (path === "/v1/premium" && req.method === "POST") {
    const b = await req.json().catch(() => ({}));
    let phone; try { phone = await phoneOf(env, b.tk); } catch (e) { return json({ error: "account: " + e.message }, 401, true); }
    await hub.premiumAsk(phone);
    return json({ ok: true }, 200, true);
  }
  return json({ error: "not here" }, 404, true);
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/v1/")) { try { return await app(req, env, url); } catch (e) { console.log(url.pathname, e.message); return json({ error: "server: " + e.message }, 503, true); } }
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
  async scheduled(ev, env, ctx) {
    ctx.waitUntil((async () => {
      // every minute: what apps from before the server wrote, merged in; every half hour: the file links refreshed
      try { await hubOf(env).sync(); } catch (e) { console.log("sync:", e.message); }
      if (ev.cron !== "* * * * *") { try { console.log("file links refreshed:", await (await botFor(env)).refreshLinks()); } catch (e) { console.log("file links:", e.message); } }
    })());
  },
};
