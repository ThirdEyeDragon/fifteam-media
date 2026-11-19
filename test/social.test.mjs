// node test/social.test.mjs - FifTeam Social in headless Edge against a stand-in for GitHub (answered here, through the
// DevTools protocol: api.github.com and raw.githubusercontent.com never see these requests). Joining, the feed, likes,
// comments, posting a picture and a rebass, adding someone's song to the library, deleting, hiding, a wrong key, and
// someone trying to sneak markup or odd file paths in. Also the knob lock on the Player.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { browser } from "./cdp.mjs";

const port = 8400 + Math.floor(Math.random() * 400);
const server = spawn(process.execPath, [new URL("./serve.mjs", import.meta.url).pathname.replace(/^\/(\w:)/, "$1"), String(port)], { stdio: "ignore" });
let failed = false;
const check = (ok, what) => { if (!ok) { failed = true; console.log("  FAIL:", what); } };

// ------------------------------------------------------------------------------------------- the stand-in GitHub
const TOKENS = { "github_pat_alice": "alice", "github_pat_bob": "bob" };
const repos = new Map();   // "login" -> Map(path -> Buffer)
const sha = (b) => createHash("sha1").update(b).digest("hex");
const tinyJpeg = Buffer.from("/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/yQALCAABAAEBAREA/8wABgAQEAX/2gAIAQEAAD8A0s8g/9k=", "base64");
repos.set("alice", new Map());
repos.set("bob", new Map([
  ["media/aaaaaaaaaaaaaaaaaaaaaaaa.jpg", tinyJpeg],
  ["media/bbbbbbbbbbbbbbbbbbbbbbbb.mp3", Buffer.alloc(4000, 0xff)],
  ["fifteam.json", Buffer.from(JSON.stringify({
    app: "fifteam-social", v: 1, updated: Date.now(),
    profile: { name: 'Bob <img src=x onerror="window.__pwned=1">', bio: "Bass head", avatar: "media/../../evil.jpg" },
    posts: [
      { id: "bobpost1", at: Date.now() - 3600e3, text: "My first rebass <script>window.__pwned=1</script>", image: "media/aaaaaaaaaaaaaaaaaaaaaaaa.jpg",
        song: { file: "media/bbbbbbbbbbbbbbbbbbbbbbbb.mp3", title: "Night Drive (Rebass)", artist: "Bob", note: "25–45 Hz · −3 dB", duration: 42 } },
      { id: "bobpost2", at: Date.now() - 7200e3, text: "", image: "https://evil.example/x.jpg" },
    ],
    likes: {}, comments: [],
  }))],
]));
const json = (o, status = 200) => ({ status, type: "application/json", body: Buffer.from(JSON.stringify(o)) });
function github(method, url, headers, body) {
  const u = new URL(url), auth = (headers.Authorization || headers.authorization || "").replace(/^Bearer /, ""), who = TOKENS[auth];
  if (u.host === "raw.githubusercontent.com") {
    const [, login, repo, branch, ...rest] = u.pathname.split("/"), f = repos.get(login) && repos.get(login).get(rest.join("/"));
    if (repo !== "fifteam-social" || branch !== "main" || !f) return { status: 404, type: "text/plain", body: Buffer.from("404") };
    const p = rest.join("/");
    return { status: 200, type: p.endsWith(".json") ? "text/plain" : p.endsWith(".jpg") ? "image/jpeg" : "audio/mpeg", body: f };
  }
  if (auth && !who) return json({ message: "Bad credentials" }, 401);
  let m;
  if (u.pathname === "/user") return who ? json({ login: who, name: who }) : json({ message: "Requires authentication" }, 401);
  if (u.pathname === "/search/repositories") return json({ total_count: repos.size, items: [...repos.keys()].map((l) => ({ name: "fifteam-social", fork: false, owner: { login: l }, default_branch: "main" })) });
  if ((m = /^\/repos\/([^/]+)\/fifteam-social$/.exec(u.pathname))) return repos.has(m[1]) ? json({ default_branch: "main", private: false }) : json({ message: "Not Found" }, 404);
  if ((m = /^\/repos\/([^/]+)\/fifteam-social\/contents\/(.+)$/.exec(u.pathname))) {
    const files = repos.get(m[1]), path = m[2];
    if (!files) return json({ message: "Not Found" }, 404);
    if (method === "GET") { const f = files.get(path); return f ? json({ sha: sha(f), content: f.toString("base64") }) : json({ message: "Not Found" }, 404); }
    if (who !== m[1]) return json({ message: "Resource not accessible by personal access token" }, 403);
    const b = JSON.parse(body || "{}"), cur = files.get(path);
    if (cur && b.sha !== sha(cur)) return json({ message: "sha does not match" }, 409);
    if (method === "DELETE") { files.delete(path); return json({}); }
    files.set(path, Buffer.from(b.content, "base64"));
    return json({ content: { sha: sha(files.get(path)) } }, cur ? 200 : 201);
  }
  return json({ message: "Not Found" }, 404);
}

const b = await browser({ profile: mkdtempSync(join(tmpdir(), "ft-so-")) });
const { ev, send, sleep } = b;
const CORS = [{ name: "Access-Control-Allow-Origin", value: "*" }, { name: "Access-Control-Allow-Headers", value: "Authorization, Content-Type, Accept, X-GitHub-Api-Version" },
  { name: "Access-Control-Allow-Methods", value: "GET, PUT, DELETE, POST, OPTIONS" }, { name: "Access-Control-Expose-Headers", value: "X-RateLimit-Remaining" }];
let seen = 0;
b.on(async (m) => {
  if (m.method !== "Fetch.requestPaused") return;
  const { requestId, request } = m.params;
  seen++;
  if (request.method === "OPTIONS") { await send("Fetch.fulfillRequest", { requestId, responseCode: 204, responseHeaders: CORS }, m.sessionId); return; }
  let body = request.postData;
  if (!body && request.postDataEntries) body = request.postDataEntries.map((e) => Buffer.from(e.bytes || "", "base64").toString()).join("");
  const r = github(request.method, request.url, request.headers, body);
  await send("Fetch.fulfillRequest", { requestId, responseCode: r.status, responseHeaders: [...CORS, { name: "Content-Type", value: r.type }], body: r.body.toString("base64") }, m.sessionId);
});
await send("Fetch.enable", { patterns: [{ urlPattern: "https://api.github.com/*" }, { urlPattern: "https://raw.githubusercontent.com/*" }] });
const until = async (expr, ms, what) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(expr).catch(() => false)) return true; await sleep(200); } check(false, "timed out waiting for " + what); return false; };
const shot = async (name) => { if (!process.env.SHOTS) return; const r = await send("Page.captureScreenshot", { format: "png" }); writeFileSync(join(process.env.SHOTS, name + ".png"), Buffer.from(r.result.data, "base64")); };
const text = (sel) => ev(`[...document.querySelectorAll(${JSON.stringify(sel)})].map(e => e.textContent).join(' | ')`);

try {
  await b.open(`http://127.0.0.1:${port}/#social`, 3000);
  await until(`document.querySelectorAll('#so-body .so-post').length > 0`, 15000, "the feed");
  const feed = await text("#so-body .so-post");
  console.log("feed:", feed.slice(0, 220));
  check(/My first rebass/.test(feed) && /Night Drive/.test(feed), "bob's post in the feed");
  check((await ev(`document.querySelectorAll('#so-body .so-post').length`)) === 1, "the post with an outside picture link (not allowed) is dropped");
  check(!(await ev(`!!window.__pwned`)) && !(await ev(`!!document.querySelector('#so-body img[src="x"], #so-body script')`)), "markup in a profile or post stays text");
  await shot("s1_feed");
  console.log("bob's name shown as text:", await text("#so-body .so-name b"));
  console.log("avatar with an odd path:", await ev(`document.querySelector('#so-body .so-av').style.backgroundImage.slice(0, 30)`), "(the placeholder)");
  check(await ev(`document.querySelector('#so-body .so-img').naturalWidth > 0`), "the picture loads from the space");

  // joining: a wrong key, then the right one
  await ev(`document.querySelector('#so-seg button[data-k="me"]').click(), 1`); await sleep(300);
  const fill = (k, n, bio) => ev(`(() => { const i = document.querySelectorAll('#so-body form input'); i[0].value = ${JSON.stringify(k)}; i[1].value = ${JSON.stringify(n)}; i[2].value = ${JSON.stringify(bio)}; document.querySelector('#so-body form button[type=submit]').click(); return 1; })()`);
  await shot("s2_join");
  await ev(`document.getElementById('view-social').scrollTop = 99999, 1`); await sleep(200); await shot("s2b_join_form");
  await fill("github_pat_wrong", "Alice", "");
  await until(`document.querySelector('#so-body .set-err').textContent.length > 0`, 8000, "the wrong-key message");
  console.log("wrong key:", await text("#so-body .set-err"));
  await fill("github_pat_alice", "Alice", "Rebass everything");
  await until(`!!document.querySelector('#so-body .so-profile')`, 10000, "alice's profile");
  console.log("joined:", await text("#so-body .so-pname"));
  await ev(`document.getElementById('view-social').scrollTop = 0, 1`); await sleep(200); await shot("s3_profile");
  const aliceFile = () => JSON.parse(repos.get("alice").get("fifteam.json").toString());
  check(aliceFile().profile.name === "Alice" && aliceFile().profile.bio === "Rebass everything", "alice's space written");
  check((await ev(`JSON.parse(localStorage.getItem('fifteam-social-account')).login`)) === "alice", "signed in on this phone");

  // a like and a comment on bob's post
  await ev(`document.querySelector('#so-seg button[data-k="feed"]').click(), 1`); await sleep(400);
  await until(`document.querySelectorAll('#so-body .so-post').length > 0`, 8000, "the feed again");
  await ev(`document.querySelector('#so-body .so-post .so-act').click(), 1`);
  await until(`(document.querySelector('#so-body .so-post .so-act').textContent || '').includes('1')`, 8000, "the like");
  for (let i = 0; i < 40 && !aliceFile().likes["bob/bobpost1"]; i++) await sleep(200);   // (shown at once, saved just after)
  check(!!aliceFile().likes["bob/bobpost1"], "the like is in alice's space");
  await ev(`document.querySelectorAll('#so-body .so-post .so-act')[1].click(), 1`); await sleep(300);
  await ev(`(() => { const f = document.querySelector('#so-body .so-cform'); f.querySelector('input').value = 'Hard!'; f.requestSubmit(); return 1; })()`);
  await until(`[...document.querySelectorAll('#so-body .so-comment')].some(c => c.textContent.includes('Hard!'))`, 8000, "the comment");
  await shot("s4_like_comment");
  console.log("like + comment:", await text("#so-body .so-post .so-bar"), "|", await text("#so-body .so-comment"));
  check(aliceFile().comments.some((c) => c.on === "bob/bobpost1" && c.text === "Hard!"), "the comment is in alice's space");

  // bob's song into the library
  await ev(`document.querySelector('#so-body .so-song .so-add').click(), 1`);
  await until(`import('./js/library.js').then(m => m.library.all().some(t => t.from === 'social'))`, 10000, "the song in the library");
  console.log("from bob into the library:", await ev(`import('./js/library.js').then(m => m.library.all().filter(t => t.from === 'social').map(t => t.title + ' / ' + t.note + ' / ' + t.size + ' bytes').join(''))`));

  // a post with a picture and a rebass from the library
  await ev(`(async () => {
    const lib = await import('./js/library.js'), store = await import('./js/store.js'), { encodeWav } = await import('./js/dsp.js');
    const n = 48000 * 2, x = new Float32Array(n); for (let i = 0; i < n; i++) x[i] = 0.3 * Math.sin(2 * Math.PI * 40 * i / 48000);
    const f = new File([encodeWav([x, x], 48000, 16)], 'Test Rebass.wav', { type: 'audio/wav' });
    await lib.library.add({ id: store.newId(), kind: 'rebass', title: 'Test Rebass', artist: 'Alice', note: '25–45 Hz · −3 dB', duration: 2, size: f.size, type: f.type, fileName: f.name, added: Date.now(), hasArt: false }, f, null);
    return 1; })()`);
  await ev(`document.querySelector('#so-body .so-top .btn.primary').click(), 1`); await sleep(400);
  await ev(`(() => { document.querySelector('#sheet-panel textarea').value = 'Fresh one'; return 1; })()`);
  await send("Page.setInterceptFileChooserDialog", { enabled: true });
  const chooser = new Promise((res) => b.on((m) => { if (m.method === "Page.fileChooserOpened") res(m.params); }));
  await ev(`[...document.querySelectorAll('#sheet-panel .btn')].find(b => b.textContent.includes('Picture')).click(), 1`);
  const fc = await chooser;
  const png = join(mkdtempSync(join(tmpdir(), "ft-img-")), "pic.png");
  writeFileSync(png, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP4z8DAwMDAxMDAwMDAAAANHQEDK+mmyAAAAABJRU5ErkJggg==", "base64"));
  await send("DOM.setFileInputFiles", { backendNodeId: fc.backendNodeId, files: [png] });
  await send("Page.setInterceptFileChooserDialog", { enabled: false });
  await until(`!!document.querySelector('#sheet-panel .so-img')`, 8000, "the picture in the new post");
  await ev(`[...document.querySelectorAll('#sheet-panel .btn')].find(b => b.textContent.includes('Rebassed song')).click(), 1`); await sleep(300);
  await ev(`[...document.querySelectorAll('#sheet-panel .item')].find(i => i.textContent.includes('Test Rebass')).click(), 1`); await sleep(500);
  await shot("s5_new_post");
  console.log("new post before sending:", await ev(`document.querySelector('#sheet-panel textarea').value + ' | picture ' + !!document.querySelector('#sheet-panel .so-img') + ' | song ' + (document.querySelector('#sheet-panel .so-song b') || {}).textContent`));
  await ev(`[...document.querySelectorAll('#sheet-panel .btn')].find(b => b.textContent === 'Post').click(), 1`);
  await until(`[...document.querySelectorAll('#so-body .so-post')].some(p => p.textContent.includes('Fresh one'))`, 30000, "alice's post in the feed");
  const ap = aliceFile().posts[0];
  console.log("alice's post in her space:", JSON.stringify({ text: ap.text, image: ap.image, song: ap.song && { file: ap.song.file, title: ap.song.title, bytes: repos.get("alice").get(ap.song.file).length, mp3: repos.get("alice").get(ap.song.file).subarray(0, 3).toString() } }));
  check(ap.text === "Fresh one" && repos.get("alice").has(ap.image) && ap.song && repos.get("alice").has(ap.song.file), "picture and song uploaded with the post");
  check(/^(ID3|\xff)/.test(repos.get("alice").get(ap.song.file).subarray(0, 3).toString("latin1")), "the WAV rebass went up as an MP3");

  // deleting it, and hiding bob
  await ev(`(() => { window.confirm = () => true; const p = [...document.querySelectorAll('#so-body .so-post')].find(p => p.textContent.includes('Fresh one')); p.querySelector('.so-more').click(); return 1; })()`); await sleep(300);
  await ev(`[...document.querySelectorAll('#sheet-panel .menu-item')].find(b => b.textContent.includes('Delete')).click(), 1`);
  await until(`![...document.querySelectorAll('#so-body .so-post')].some(p => p.textContent.includes('Fresh one'))`, 10000, "the post deleted");
  await sleep(800);
  check(aliceFile().posts.length === 0 && !repos.get("alice").has(ap.song.file), "the post and its song gone from her space");
  await ev(`(() => { [...document.querySelectorAll('#so-body .so-post')][0].querySelector('.so-more').click(); return 1; })()`); await sleep(300);
  await ev(`[...document.querySelectorAll('#sheet-panel .menu-item')].find(b => b.textContent.includes('Hide')).click(), 1`); await sleep(400);
  console.log("after hiding bob:", (await ev(`document.querySelectorAll('#so-body .so-post').length`)) + " posts |", await text("#so-body .so-empty"));
  check((await ev(`document.querySelectorAll('#so-body .so-post').length`)) === 0, "bob hidden");

  // the knob lock
  await ev(`location.hash = '#player'`); await sleep(500);
  const knob = () => ev(`document.querySelector('#kn-mids .knob').getAttribute('aria-valuenow')`);
  const turn = () => ev(`(() => { const k = document.querySelector('#kn-mids .knob'); k.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true })); return 1; })()`);
  await ev(`document.getElementById('np-knob-lock').click(), 1`);
  await ev(`(() => { const v = document.getElementById('view-player'); v.scrollTop = v.scrollHeight; return 1; })()`); await sleep(300); await shot("s6_knobs_locked");
  const v0 = await knob(); await turn(); const v1 = await knob();
  await ev(`document.getElementById('np-knob-lock').click(), 1`);
  await turn(); const v2 = await knob();
  await ev(`(() => { const k = document.querySelector('#kn-mids .knob'); k.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })); return 1; })()`);
  console.log(`knob lock: locked ${v0} -> ${v1} (no change), unlocked -> ${v2}`);
  check(v0 === v1 && v2 !== v1, "the lock holds the knobs");
  console.log("requests answered by the stand-in GitHub:", seen);
  console.log(b.errors.length ? "ERRORS:\n" + b.errors.join("\n") : "errors: none");
  check(!b.errors.filter((e) => !/Failed to load resource/.test(e)).length, "browser errors");
} finally { b.close(); server.kill(); }
console.log(failed ? "FAIL" : "PASS");
process.exit(failed ? 1 : 0);
