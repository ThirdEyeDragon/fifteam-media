// Every request to the feed service goes through here. The service lets each phone make 5 requests every 2 seconds and
// refuses the rest (then they have to wait and try again, which is what made pictures slow to appear), so requests are
// paced to stay just under that. What's on screen goes first; work in the background (checking in, the ban list,
// fetching ahead, checking again) waits its turn.
const WINDOW = 2050, MAX = 5;
const sent = [], queues = [[], []];
let timer = 0, holdUntil = 0;

/** fetch(), paced. low: background work, after anything the person is waiting for. */
export function hookFetch(url, opt = {}, low = false) {
  return new Promise((res, rej) => { queues[low ? 1 : 0].push({ url, opt, res, rej }); run(); });
}
/** The service said "slow down" anyway (another tab, say): nothing more until it's ready. */
export function holdFor(ms) { holdUntil = Math.max(holdUntil, Date.now() + ms); run(); }

function run() {
  clearTimeout(timer); timer = 0;
  while (queues[0].length || queues[1].length) {
    const now = Date.now();
    if (now < holdUntil) { timer = setTimeout(run, holdUntil - now + 5); return; }
    while (sent.length && now - sent[0] > WINDOW) sent.shift();
    if (sent.length >= MAX) { timer = setTimeout(run, WINDOW - (now - sent[0]) + 5); return; }
    const job = (queues[0].length ? queues[0] : queues[1]).shift();
    sent.push(now);
    fetch(job.url, job.opt).then(job.res, job.rej);
  }
}
