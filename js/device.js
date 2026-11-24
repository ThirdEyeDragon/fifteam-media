// What kind of device this is, in a few words, for the owner's /online list: e.g. "Galaxy S25 Ultra · Android 15",
// "iPhone 15 Pro / 16 · iOS 18.1", "Windows PC · Edge". Android phones say their model; an iPhone doesn't, so its
// screen size gives the family.
const SAMSUNG = {
  "SM-S938": "Galaxy S25 Ultra", "SM-S936": "Galaxy S25+", "SM-S931": "Galaxy S25", "SM-S937": "Galaxy S25 Edge",
  "SM-S928": "Galaxy S24 Ultra", "SM-S926": "Galaxy S24+", "SM-S921": "Galaxy S24", "SM-S721": "Galaxy S24 FE",
  "SM-S918": "Galaxy S23 Ultra", "SM-S916": "Galaxy S23+", "SM-S911": "Galaxy S23", "SM-S711": "Galaxy S23 FE",
  "SM-S908": "Galaxy S22 Ultra", "SM-S906": "Galaxy S22+", "SM-S901": "Galaxy S22",
  "SM-F966": "Galaxy Z Fold7", "SM-F956": "Galaxy Z Fold6", "SM-F946": "Galaxy Z Fold5", "SM-F766": "Galaxy Z Flip7", "SM-F741": "Galaxy Z Flip6", "SM-F731": "Galaxy Z Flip5",
  "SM-A566": "Galaxy A56", "SM-A556": "Galaxy A55", "SM-A366": "Galaxy A36", "SM-A356": "Galaxy A35", "SM-A266": "Galaxy A26", "SM-A256": "Galaxy A25", "SM-A166": "Galaxy A16", "SM-A156": "Galaxy A15",
};
// iPhones by their screen in points (portrait) and pixel ratio
const IPHONES = {
  "440x956@3": "iPhone 16 Pro Max / 17 Pro Max", "430x932@3": "iPhone 14 Pro Max / 15 Plus / 15 Pro Max / 16 Plus", "420x912@3": "iPhone Air",
  "402x874@3": "iPhone 16 Pro / 17 / 17 Pro", "393x852@3": "iPhone 14 Pro / 15 / 15 Pro / 16", "390x844@3": "iPhone 12 / 13 / 14 / 16e",
  "428x926@3": "iPhone 12 Pro Max / 13 Pro Max / 14 Plus", "375x812@3": "iPhone X / XS / 11 Pro / 12 mini / 13 mini",
  "414x896@2": "iPhone XR / 11", "414x896@3": "iPhone XS Max / 11 Pro Max", "375x667@2": "iPhone SE / 8", "414x736@3": "iPhone 8 Plus",
};
const browserOf = (ua) => /EdgA?\//.test(ua) ? "Edge" : /SamsungBrowser/.test(ua) ? "Samsung Internet" : /OPR\//.test(ua) ? "Opera" : /Firefox|FxiOS/.test(ua) ? "Firefox" : /CriOS|Chrome\//.test(ua) ? "Chrome" : /Safari/.test(ua) ? "Safari" : "";

let cached = "";
export async function deviceName() {
  if (cached) return cached;
  const ua = navigator.userAgent || "";
  let out = "";
  const ios = /iP(hone|ad|od)/.exec(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1 ? ["iPad", "ad"] : null);
  if (ios) {
    // (Safari's own version first: from iOS 26 the "OS" number in the user agent stays at 18.x)
    const v = /Version\/(\d+)\.(\d+)/.exec(ua) || /OS (\d+)[_.](\d+)/.exec(ua);
    const w = Math.min(screen.width, screen.height), hgt = Math.max(screen.width, screen.height), r = Math.round(devicePixelRatio || 2);
    const model = ios[1] === "hone" ? IPHONES[`${w}x${hgt}@${r}`] || "iPhone" : ios[1] === "od" ? "iPod" : "iPad";
    out = `${model}${v ? ` · iOS ${v[1]}.${v[2]}` : ""}`;
  } else if (/Android/.test(ua)) {
    let model = "", ver = (/Android (\d+(?:\.\d+)?)/.exec(ua) || [])[1] || "";
    try {
      if (navigator.userAgentData && navigator.userAgentData.getHighEntropyValues) {
        const hv = await navigator.userAgentData.getHighEntropyValues(["model", "platformVersion"]);
        model = hv.model || ""; if (hv.platformVersion) ver = hv.platformVersion.split(".")[0];
      }
    } catch {}
    if (!model) { const m = /Android [^;]*; ([^;)]+?)(?: Build|\))/.exec(ua); if (m && m[1] !== "K") model = m[1].trim(); }
    const sm = /^SM-[A-Z]\d{3}/.exec(model);
    const name = sm && SAMSUNG[sm[0]] ? `${SAMSUNG[sm[0]]} (${model})` : sm ? `Samsung ${model}` : model || "Android phone";
    out = `${name}${ver ? ` · Android ${ver}` : ""}`;
  } else {
    const os = /Windows/.test(ua) ? "Windows PC" : /Mac OS X/.test(ua) ? "Mac" : /CrOS/.test(ua) ? "Chromebook" : /Linux/.test(ua) ? "Linux PC" : "Computer";
    out = `${os}${browserOf(ua) ? ` · ${browserOf(ua)}` : ""}`;
  }
  const standalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone;
  cached = `${out}${standalone ? "" : " (in the browser)"}`.slice(0, 60);
  return cached;
}
