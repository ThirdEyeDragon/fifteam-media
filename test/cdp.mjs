// A headless Edge driven through the DevTools protocol (no third-party packages), for the tests that need a browser.
//   const b = await browser(); await b.open(url); await b.ev("1 + 1"); b.close();
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function browser({ flags = [], profile } = {}) {
  const port = 9600 + Math.floor(Math.random() * 300);
  const prof = profile || mkdtempSync(join(tmpdir(), "ft-"));
  const proc = spawn(EDGE, ["--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${prof}`, "--no-first-run", "--enable-automation",
    "--autoplay-policy=no-user-gesture-required", "--window-size=390,844", ...flags, "about:blank"], { stdio: "ignore" });
  let page;
  for (let i = 0; i < 80 && !page; i++) { await sleep(200); try { page = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((t) => t.type === "page"); } catch {} }
  if (!page) { proc.kill(); throw new Error("Edge didn't start"); }
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener("open", r));
  let id = 0; const pend = new Map(); const errors = []; const listeners = [];
  ws.addEventListener("message", (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); return; }
    if (m.method === "Runtime.exceptionThrown") errors.push("page: " + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
    if (m.method === "Runtime.consoleAPICalled" && /error|warn/.test(m.params.type)) errors.push(`console(${m.params.type}): ` + m.params.args.map((a) => a.value || a.description).join(" ").slice(0, 300));
    if (m.method === "Target.attachedToTarget") {
      // (workers too, and the workers they start)
      const sid = m.params.sessionId;
      send("Runtime.enable", {}, sid);
      send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, sid);
      send("Runtime.runIfWaitingForDebugger", {}, sid);
    }
    for (const l of listeners) l(m);
  });
  const send = (method, params = {}, sessionId) => new Promise((res) => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params, ...(sessionId ? { sessionId } : {}) })); });
  const ev = async (expr) => {
    const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true });
    if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text);
    return r.result?.result?.value;
  };
  await send("Page.enable"); await send("Runtime.enable");
  await send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
  await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
  return {
    send, ev, errors, sleep, on: (f) => listeners.push(f),
    async open(url, wait = 2500) { await send("Page.navigate", { url }); await sleep(wait); },
    close() { try { ws.close(); } catch {} proc.kill(); },
  };
}
