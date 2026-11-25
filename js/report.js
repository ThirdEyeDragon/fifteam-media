// Reporting someone (from their page) or one of their posts (from the post's ⋯ menu): what for, and a message in your
// own words. It goes to the FifTeam team (the server passes it on); the person reported isn't told who reported them.
import { toast, openSheet, closeSheet } from "./ui.js";
import { hubReport } from "./hub.js";

const REASONS = [
  ["spam", "Spam"], ["harass", "Harassment or bullying"], ["hate", "Hate speech or slurs"], ["sexual", "Nudity or sexual content"],
  ["violence", "Violence or threats"], ["scam", "Scam or fraud"], ["fake", "Pretending to be someone else"], ["underage", "May be under 13"], ["other", "Something else"],
];
const h = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

/** The report sheet. who: their phone id; name: their username; post / comment: what's being reported, if not them. */
export function openReport({ who, name, post = "", comment = "" }) {
  if (!who) { toast("Can't report them yet: they need to open FifTeam Media once more."); return; }
  let pick = "";
  openSheet((p) => {
    p.classList.add("rp-panel");
    p.append(h("h3", "", post ? (comment ? "Report comment" : "Report post") : `Report ${name}`));
    p.append(h("p", "status", "Why are you reporting this? Only the FifTeam team sees reports, and they don't say who sent them."));
    const list = h("div", "rp-list");
    for (const [k, label] of REASONS) {
      const b = h("button", "rp-reason", label); b.type = "button"; b.dataset.k = k;
      b.onclick = () => { pick = k; list.querySelectorAll(".rp-reason").forEach((x) => x.classList.toggle("on", x === b)); err.textContent = ""; };
      list.append(b);
    }
    const t = h("textarea", "input rp-text"); t.rows = 3; t.maxLength = 600; t.placeholder = "Tell us what happened (optional)"; t.setAttribute("aria-label", "Your message");
    const err = h("p", "set-err"), go = h("button", "btn primary block rp-send", "Send report");
    go.onclick = async () => {
      if (!pick) { err.textContent = "Pick a reason."; return; }
      go.disabled = true; go.textContent = "Sending…";
      try {
        await hubReport({ who, reason: pick, text: t.value.trim(), ...(post ? { post } : {}), ...(comment ? { comment } : {}) });
        closeSheet(); toast("Thanks. The FifTeam team will look at it.", 3000);
      } catch (e) { err.textContent = e.message || "Couldn't send the report. Try again."; go.disabled = false; go.textContent = "Send report"; }
    };
    p.append(list, t, err, go);
  });
}
