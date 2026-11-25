// The rules and legal terms (Settings > Rules and legal).
import { openSheet } from "./ui.js";

export const TERMS_DATE = "November 25, 2026";
const SECTIONS = [
  ["We don't provide music", [
    "FifTeam Media doesn't provide, sell or license any music. Every song in the app is one you bring yourself, from your own phone.",
    "You're responsible for having the right to use the music you put into the app. Rebassing a song doesn't give you any rights to it.",
  ]],
  ["What you make is for you", [
    "Rebasses, tones and anything else you make with FifTeam Media are for your own personal listening.",
    "Distributing or selling the music you make with the app is against the rules: no uploading it to streaming services, stores or other sites, and no selling it or charging for it in any way.",
  ]],
  ["Posting on FifTeam Social", [
    "Only post rebasses you made yourself. Posting music made by other rebass DJs (their rebasses, remixes, edits or bass boosts), or passing anyone else's work off as yours, is against the rules.",
    "Don't post music, pictures or videos you don't have the right to share. We take content down when its owner asks, and people who keep breaking this rule are banned.",
    "If you see something that breaks the rules, tap Report on the post or on the person's page.",
  ]],
  ["Leave the app as it is", [
    "Editing, modifying, copying, reverse engineering or tampering with FifTeam Media in any way is grounds for a ban. That includes getting around the rebass limit, a ban, the sign-in or payments, and using bots, scripts or other tools to use the app or its service.",
  ]],
  ["Be decent", [
    "No slurs, hate speech, harassment, bullying, threats, nudity or sexual content, scams, spam, or pretending to be someone else.",
    "You must be 13 or older to use FifTeam Media.",
  ]],
  ["Bans", [
    "The FifTeam team can remove anything posted in the app, and ban accounts and phones, for breaking these rules or to keep other people safe, at any time and without warning.",
  ]],
  ["Unlimited rebassing", [
    "Unlimited rebassing is a one-time $10 payment through PayPal. It unlocks unlimited rebassing for your account once the payment is confirmed.",
    "It's a digital unlock: once it's given, the payment is final, except where the law says otherwise. An account banned for breaking these rules loses the unlock.",
  ]],
  ["Your information", [
    "To run the app we keep your account's email (sign-in is through Google's Firebase), your username, picture and about me, what you post, comment and like, who you follow, and your phone's model and app version.",
    "Private messages are encrypted on the phones: only the two people talking can read them.",
    "Your location is only used for Audio Market listings, and only shared as the town and a spot rounded to about 3 miles.",
  ]],
  ["Look after your ears and speakers", [
    "Deep bass and test tones played loud can damage your hearing and your speakers. Start quiet, and turn it up slowly.",
  ]],
  ["No guarantees", [
    "FifTeam Media is provided as it is, without any guarantee that it will always work or be free of mistakes. As far as the law allows, FifTeam Media isn't responsible for any loss or damage from using it.",
  ]],
  ["Changes", [
    "These rules can change. When they do, the date at the top changes too, and using the app after that means you accept the new version.",
  ]],
];

/** The full terms, in a panel. */
export function openTerms() {
  openSheet((p) => {
    p.classList.add("lg-panel");
    const h = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
    p.append(h("h3", "", "Terms of Use and Rules"));
    p.append(h("p", "status", `FifTeam Media · last updated ${TERMS_DATE}. By using FifTeam Media you agree to these.`));
    for (const [title, paras] of SECTIONS) {
      const sec = h("section", "lg-sec");
      sec.append(h("h4", "", title));
      for (const t of paras) sec.append(h("p", "selectable", t));
      p.append(sec);
    }
  });
}
