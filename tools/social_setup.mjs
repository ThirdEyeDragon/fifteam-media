// Switch FifTeam Social on: node tools/social_setup.mjs <Discord webhook URL>
// Checks the webhook, posts the feed message the app keeps up to date (the "index"), and writes social/config.json.
// (Publish the app afterwards. The webhook's key is stored reversed and base64'd: not secret, just not a plain
// Discord link, so robots that scan code for Discord links to spam them don't find it.)
import { writeFileSync } from "node:fs";

const url = process.argv[2] || "";
const m = /^https:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/api(?:\/v\d+)?\/webhooks\/(\d+)\/([\w-]+)\/?$/.exec(url.trim());
if (!m) { console.log("That isn't a Discord webhook link (https://discord.com/api/webhooks/<number>/<key>)."); process.exit(1); }
const [, hook, token] = m, base = `https://discord.com/api/v10/webhooks/${hook}/${token}`;
const w = await fetch(base);
if (!w.ok) { console.log("Discord didn't accept that webhook:", w.status, (await w.text()).slice(0, 200)); process.exit(1); }
const info = await w.json();
console.log(`webhook "${info.name}" in channel ${info.channel_id}`);
const f = new FormData();
f.append("payload_json", JSON.stringify({ content: "FifTeam Social feed (the app keeps this message up to date; please don't delete it)", username: "FifTeam", attachments: [{ id: 0, filename: "feed.json" }], allowed_mentions: { parse: [] } }));
f.append("files[0]", new Blob([JSON.stringify({ v: 1, posts: [] })], { type: "application/json" }), "feed.json");
const r = await fetch(base + "?wait=true", { method: "POST", body: f });
if (!r.ok) { console.log("Couldn't post the feed message:", r.status, (await r.text()).slice(0, 200)); process.exit(1); }
const msg = await r.json();
// and the private messages' store (encrypted on the phones; see js/social.js)
const g = new FormData();
g.append("payload_json", JSON.stringify({ content: "FifTeam messages (the app keeps this message up to date; please don't delete it)", username: "FifTeam", attachments: [{ id: 0, filename: "dm.json" }], allowed_mentions: { parse: [] } }));
g.append("files[0]", new Blob([JSON.stringify({ v: 1, msgs: [] })], { type: "application/json" }), "dm.json");
const r2 = await fetch(base + "?wait=true", { method: "POST", body: g });
if (!r2.ok) { console.log("Couldn't post the messages' store:", r2.status); process.exit(1); }
const cfg = { hook, key: Buffer.from(token.split("").reverse().join("")).toString("base64"), index: msg.id, dm: (await r2.json()).id };
// votes / follows / about, who's online, and bans (written by tools/bot/fifteam-bot.mjs)
for (const [k, content, file, data] of [
  ["meta", "FifTeam votes, follows and about (the app keeps this message up to date; please don't delete it)", "meta.json", { v: 1, votes: {}, follows: {}, about: {} }],
  ["presence", "FifTeam who's online (the app keeps this message up to date; please don't delete it)", "presence.json", { v: 1, on: {} }],
  ["mod", "FifTeam bans (kept by the FifTeam bot; please don't delete it)", "mod.json", { v: 1, bans: {} }],
]) {
  const g2 = new FormData();
  g2.append("payload_json", JSON.stringify({ content, username: "FifTeam", attachments: [{ id: 0, filename: file }], allowed_mentions: { parse: [] } }));
  g2.append("files[0]", new Blob([JSON.stringify(data)], { type: "application/json" }), file);
  const r3 = await fetch(base + "?wait=true", { method: "POST", body: g2 });
  if (!r3.ok) { console.log(`Couldn't post the ${k} store:`, r3.status); process.exit(1); }
  cfg[k] = (await r3.json()).id;
}
writeFileSync(new URL("../social/config.json", import.meta.url), JSON.stringify(cfg, null, 2) + "\n");
console.log("feed message", msg.id, "posted; social/config.json written. Publish the app to switch Social on.");
