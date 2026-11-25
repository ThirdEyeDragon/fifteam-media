// The FifTeam bot's key: the app seals each phone's account email with its public half (social/config.json "auth"), so
// only the bot can read whose phone is whose (for /accounts and bans by email). Accounts themselves (passwords, the
// confirmation emails) are Google's free sign-in service (Firebase Authentication): nothing here has to be running.
//   The private half: %APPDATA%\fifteam-bot\auth-key.json (never in the project, never online).
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const { subtle } = globalThis.crypto;
export const HOME = join(process.env.APPDATA || process.env.HOME || ".", "fifteam-bot");
const unb64u = (s) => new Uint8Array(Buffer.from(String(s), "base64url"));

/** The bot's key pair (made once). */
export async function botKeys(dir = HOME) {
  const file = join(dir, "auth-key.json");
  let jwk = null;
  try { jwk = JSON.parse(readFileSync(file, "utf8")); } catch {}
  if (!jwk) {
    const kp = await subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveKey"]);
    jwk = await subtle.exportKey("jwk", kp.privateKey);
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, JSON.stringify(jwk), { mode: 0o600 });
  }
  const priv = await subtle.importKey("jwk", jwk, { name: "ECDH", namedCurve: "P-256" }, false, ["deriveKey"]);
  return { priv, pub: `${jwk.x}.${jwk.y}` };
}
/** Something a phone sealed for the bot ({ k: its one-time public key, iv, c }, as JSON text), opened. */
export async function openSealed(keys, text) {
  const s = typeof text === "string" ? JSON.parse(text) : text;
  const [x, y] = String(s.k).split(".");
  const pub = await subtle.importKey("jwk", { kty: "EC", crv: "P-256", x, y, ext: true }, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const key = await subtle.deriveKey({ name: "ECDH", public: pub }, keys.priv, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
  return new TextDecoder().decode(await subtle.decrypt({ name: "AES-GCM", iv: unb64u(s.iv) }, key, unb64u(s.c)));
}
