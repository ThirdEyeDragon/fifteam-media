// A tiny static server for trying the app on this computer: node test/serve.mjs [port]
// (localhost counts as secure, so the service worker, motion and sharing APIs behave as they will once hosted on https)
import http from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const port = +(process.argv[2] || 8123);
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".webmanifest": "application/manifest+json", ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml", ".wav": "audio/wav", ".mp3": "audio/mpeg" };

http.createServer(async (req, res) => {
  try {
    let p = decodeURIComponent(new URL(req.url, "http://x").pathname);
    if (p.endsWith("/")) p += "index.html";
    const f = normalize(join(root, p));
    if (!f.startsWith(normalize(root))) { res.writeHead(403); res.end(); return; }
    await stat(f);
    res.writeHead(200, { "Content-Type": TYPES[extname(f)] || "application/octet-stream", "Cache-Control": "no-cache" });
    res.end(await readFile(f));
  } catch { res.writeHead(404); res.end("Not found"); }
}).listen(port, "127.0.0.1", () => console.log(`FifTeam Media on http://localhost:${port}/`));
