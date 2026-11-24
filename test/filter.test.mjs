// node test/filter.test.mjs - the slur filter: the hard-R word in its disguises and the other slurs blocked; swearing,
// ordinary words that contain the same letters, and place names let through.
globalThis.atob = (s) => Buffer.from(s, "base64").toString("binary");
const { offensive } = await import("../js/filter.js");
let failed = false;
const n = (s) => s.replace(/\*/g, "g");   // (the test's own copy spelled with * for g)
const blocked = [n("ni**er"), n("NI**ER"), n("n1**3r"), n("n i * * e r"), n("n.i.*.*.e.r"), n("ni***er"), "niqqer", n("ni**ers"), n("you're a ni**er lol"), n("sand ni**er"),
  "chink", "Chinks", "sp1c", "k1ke", "wetback", "g00k", "raghead", "towelheads", "beaner", "zipperhead", "s p i c"];
const allowed = ["fuck this bass", "shit goes hard", "damn bitch", "Niger is a country", "Nigeria", "spicy food", "my bigger sub", "trigger the amp", "snicker", "kicker comp", "Gooking", "Pakistan", "beans", "chinking glasses", "space", "nigga (soft a: not blocked)", "Ohio", "4 12s in a ported box"];
for (const t of blocked) if (!offensive(t)) { failed = true; console.log("  FAIL (should block):", t.replace(/[aeiou]/g, "*")); }
for (const t of allowed) if (offensive(t)) { failed = true; console.log("  FAIL (should allow):", t); }
console.log(`blocked ${blocked.length} disguised slurs, let ${allowed.length} ordinary lines through`);
console.log(failed ? "FAIL" : "PASS");
process.exit(failed ? 1 : 0);
