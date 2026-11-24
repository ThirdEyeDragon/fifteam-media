// What people write is checked before it's sent: racial slurs (the hard-R word in any spelling, and the others) are
// refused, everything else (swearing included) goes through. Not a setting: nobody can see, change or turn it off.
// The words are kept encoded, so they aren't sitting in the app's code as plain text.
const RAW = "cmVnZ2luZG5hcyxzeWVrbm9taGNyb3AseWVrbm9taGNyb3Asc2lrYXAsaWthcCxzZ293aWxsb2csZ293aWxsb2csc2Vpbm5pbmFrY2lwLHlubmluYWtjaXAsc2RhZWhyZXBwaXosZGFlaHJlcHBpeixzb29iYWdpaixvb2JhZ2lqLHNyZW5hZWIscmVuYWViLHNkYWVobGV3b3QsZGFlaGxld290LHNkYWVoZ2FyLGRhZWhnYXIsc2tvb2csa29vZyxza2NhYnRldyxrY2FidGV3LHNla2lrLGVraWssc2tjaXBzLGtjaXBzLHNjaXBzLGNpcHMsc2tuaWhjLGtuaWhj";
const WORDS = new Set(atob(RAW).split("").reverse().join("").split(","));
// the hard-R word: n, i, then two or more g, e, r (each letter as written or disguised), spaced out or not
const N = /n+[^a-z]{0,3}[i1!|l]+[^a-z]{0,3}(?:[gq69][^a-z]{0,3}){2,}[e3][^a-z]{0,3}r+/;
const LEET = { "0": "o", "1": "i", "!": "i", "|": "i", "3": "e", "4": "a", "@": "a", "5": "s", "$": "s", "7": "t", "9": "g", "6": "g", "8": "b", "+": "t" };

export const OFFENSIVE = "Unable to post due to profanity that is found to be offensive to others";
/** True when the text has a racial slur in it (in any of the usual disguises). */
export function offensive(...texts) {
  for (const t of texts) {
    if (!t) continue;
    const low = String(t).toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "");
    // the hard-R word, however it's broken up (n.i.g.g.e.r, n1gg3r, n i g g e r, niqqer…)
    const flat = low.replace(/[^a-z0-9!|@$+]/g, "");
    if (N.test(flat) || N.test(low)) return true;
    // the other slurs, word by word (letters and their stand-ins only; doubled letters let through as one)
    for (const raw of low.split(/[^a-z0-9!|@$+]+/)) {
      if (!raw) continue;
      const w = raw.replace(/[0-9!|@$+]/g, (c) => LEET[c] || c).replace(/[^a-z]/g, "");
      if (WORDS.has(w) || WORDS.has(w.replace(/(.)\1+/g, "$1")) || WORDS.has(w.replace(/(.)\1+/g, "$1$1"))) return true;
    }
    // and the same words spaced out letter by letter ("s p i c")
    const spaced = low.match(/(?:\b[a-z0-9!|@$+]\b[\s._-]*){4,}/g) || [];
    for (const s of spaced) { const w = s.replace(/[^a-z0-9!|@$+]/g, "").replace(/[0-9!|@$+]/g, (c) => LEET[c] || c); if (WORDS.has(w)) return true; }
  }
  return false;
}
