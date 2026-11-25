// Real car subwoofers and their published Thiele/Small numbers (from each maker's spec pages, or the speaker
// databases that collect them), for the box designer. Each row:
//   [brand, model, coils, size ″, RMS W, Fs Hz, Qts, Qes, Qms, Vas L, Re Ω, Le mH, Sd cm², Xmax mm, cutout ″, depth ″,
//    displacement ft³, where the numbers come from]
// null where the maker doesn't publish it: the designer then uses a typical value for that size, and says so.
// (DD Audio publishes the piston's diameter, not Sd: Sd is that circle's area.)
const pist = (d) => +(Math.PI * (d / 2) ** 2 * 6.4516).toFixed(1);
const S = "sundownaudio.com", D = "ddaudio.com", B = "b2audio.com", R = "rockfordfosgate.com", K = "kicker.com", L = "loudspeakerdatabase.com", X = "speakerboxlite.com";
export const SUB_ROWS = [
  // ---- Skar Audio
  ["Skar Audio", "VXF-15", "D2", 15, 1500, 31.4, 0.36, 0.38, 4.74, 76.8, 3.9, 3.88, 779, 30, 13.86, 9.76, null, L],
  ["Skar Audio", "VXF-12", "D2", 12, 1500, 32.1, 0.32, 0.35, 4.85, 35.4, null, null, 471, 25, null, null, null, L],
  ["Skar Audio", "VVX-15v2", "D2", 15, null, 39.5, 0.54, 0.616, null, 76, 3.6, null, 961, 18, null, null, null, X],
  ["Skar Audio", "ZVX-15v2", "D1", 15, null, 38, 0.47, 0.56, 3.0, 58.5, 1.4, null, 754, 29, null, null, null, L],
  ["Skar Audio", "ZVX-18v2", "D1", 18, null, 26.1, 0.49, 0.52, 5.1, 159.9, null, null, 1164, 29, null, null, null, L],
  ["Skar Audio", "EVL-10", "D2", 10, null, 44, 0.59, 0.66, 5.44, 6.8, null, null, null, 23.5, null, null, null, X],
  ["Skar Audio", "EVL-12", "D2", 12, null, 32.2, 0.461, 0.51, 4.83, 19.1, null, null, null, 23.5, null, null, null, X],
  ["Skar Audio", "EVL-15", "D2", 15, null, 35, 0.63, 0.73, 4.6, 46, null, null, null, null, null, null, null, X],
  ["Skar Audio", "DDX-10", "D2", 10, null, 46, 0.38, 0.412, 4.8, 8.7, null, null, null, 15, null, null, null, X],
  ["Skar Audio", "DDX-12", "D2", 12, null, 39, 0.34, 0.371, null, 24.8, null, null, null, 15, null, null, null, X],
  ["Skar Audio", "DDX-15", "D2", 15, null, 41, 0.39, 0.43, 4.2, 46.7, null, null, null, null, null, null, null, X],
  ["Skar Audio", "SDR-10", "D2", 10, 600, 39, 0.58, 0.63, 6.8, 10.8, null, null, null, null, null, null, null, X],
  ["Skar Audio", "SDR-12", "D2", 12, 600, 32, 0.53, 0.58, 6.76, 36.2, 3.2, null, null, 13.5, null, null, null, L],
  ["Skar Audio", "SDR-15", "D2", 15, null, 29, 0.67, 0.75, 6.3, 84.8, null, null, null, null, null, null, null, X],
  ["Skar Audio", "SVR-15", "D2", 15, null, 33, 0.57, 0.61, 7.7, 74.9, null, null, null, null, null, null, null, X],
  ["Skar Audio", "VD-12", "D2", 12, null, 35.3, 0.55, 0.628, 4.42, 43.5, null, null, null, 11, null, null, null, X],
  ["Skar Audio", "IX-12", "D2", 12, null, 35.4, 0.61, 0.677, 6.14, 66.9, null, null, null, 7, null, null, null, X],
  ["Skar Audio", "SVR-12", "D2", 12, null, 36, 0.52, null, null, 29.2, null, null, null, null, null, null, null, L],
  ["Skar Audio", "VVX-12v3", "D2", 12, null, 33.1, 0.44, null, null, 37.3, null, null, null, 15.5, null, null, null, L],
  ["Skar Audio", "VVX-10v3", "D2", 10, null, 33.7, 0.41, null, null, 17.4, null, null, null, null, null, null, null, X],
  // ---- Sundown Audio
  ["Sundown Audio", "NS v.6 10", "D2", 10, 3500, 43.8, 0.3626, 0.3626, 4.2687, 6.484, 3.61, 3.25, 506.6, 35, 10.1, 12.24, 0.23, S],
  ["Sundown Audio", "NS v.6 12", "D2", 12, 3500, 37.1, 0.405, 0.4388, 5.256, 11.837, 3.34, 3.11, 735.5, 35, 11.19, 12.75, 0.24, S],
  ["Sundown Audio", "NS v.6 15", "D2", 15, 3500, 30.9, 0.3841, 0.4133, 5.4272, 36.06, 3.6, 3.49, 1141.9, 35, 13.93, 13.91, 0.26, S],
  ["Sundown Audio", "NS v.6 18", "D2", 18, 3500, 28.4, 0.3841, 0.4133, 5.4272, 82.932, 3.6, 3.49, 1641.9, 35, 16.69, 16.3, 0.27, S],
  ["Sundown Audio", "Z v.6 12", "D2", 12, 3250, 32.89, 0.358, 0.3829, 5.517, 16, 3.8, 4.06, 735.5, 35, 11.09, 11.75, 0.24, S],
  ["Sundown Audio", "Z v.6 15", "D2", 15, 3250, 28.84, 0.3462, 0.369, 5.6082, 46.69, 3.6, 3.9, 1141.9, 35, 13.93, 12.93, 0.26, S],
  ["Sundown Audio", "Z v.6 18", "D2", 18, 3250, 24.12, 0.397, 0.4265, 5.7355, 116.39, 4.0, 4.35, 1641.9, 35, 16.68, 14.92, 0.27, S],
  ["Sundown Audio", "X v.3 10", "D2", 10, 2500, 39.01, 0.52, 0.6, 4.04, 9.32, 3.2, 2.37, 506.6, 30, 10.01, 9.4, 0.22, S],
  ["Sundown Audio", "X v.3 12", "D2", 12, 2500, 36.06, 0.49, 0.54, 4.82, 15.75, 3.25, 2.6, 735.5, 30, 11.09, 9.67, 0.23, S],
  ["Sundown Audio", "X v.3 15", "D2", 15, 2500, 31.423, 0.468, 0.561, 2.801, 45.924, 3.2, null, null, 30, 13.93, 10.85, 0.26, S],
  ["Sundown Audio", "U v.2 12", "D2", 12, 2000, 41.3, 0.44, 0.48, 4.74, 14.76, 3.84, 3.18, 735.5, 30, 11.2, 8.43, 0.19, S],
  ["Sundown Audio", "U v.2 15", "D2", 15, 2000, 37.2, 0.49, 0.54, 5.4, 43.5, 3.82, 3.41, 1141.9, 30, 14.1, 9.0, 0.24, S],
  ["Sundown Audio", "SA v.3 8", "D2", 8, 600, 38.3, 0.309, 0.324, 6.31, 6.88, 3.36, 2.08, 344.8, 16, 7.375, 6.625, 0.08, S],
  ["Sundown Audio", "SA v.3 10", "D2", 10, 1500, 36, 0.413, 0.501, 2.341, 10.286, 3.4, 3.52, 506.6, 22, 9.5, 8.11, 0.17, S],
  ["Sundown Audio", "SA v.3 12", "D2", 12, 1500, 35, 0.428, 0.525, 2.308, 22.188, 3.4, null, 735.5, 22, 11.2, 8.4, 0.18, S],
  ["Sundown Audio", "SA v.3 15", "D2", 15, 1500, 35, 0.509, 0.625, 2.73, 44.002, 3.4, 3.63, 1141.9, 22, 14.1, 8.65, 0.22, S],
  ["Sundown Audio", "SA v.2 12", "D2", 12, 1250, 38.89, 0.4558, 0.507, 4.5133, 26.29, 3.91, 3.18, 735.5, 19, 11.01, 7.5, 0.11, S],
  ["Sundown Audio", "SA v.2 15", "D2", 15, 1250, 36.84, 0.5245, 0.5847, 5.1005, 51.94, 3.89, 3.63, 1141.9, 19, 14.01, 9.0, 0.16, S],
  ["Sundown Audio", "SD v.4 12", "D2", 12, 600, 26.04, 0.5554, 0.6187, 5.4253, 63.51, 3.93, 6.28, 735.5, 14.5, 10.5, 4.9, 0.10, S],
  // ---- DD Audio
  ["DD Audio", "9912c", "D2", 12, 3200, 31.63, 0.352, 0.377, 5.398, 23.63, null, null, pist(11), 32, 12.19, 9.69, 0.33, D],
  ["DD Audio", "9510L (ESP)", "D2", 10, 2500, 34.32, 0.3693, 0.3982, 5.093, 20.3, null, null, pist(9.25), 32, 10.1875, 8.8125, 0.24, D],
  ["DD Audio", "812f", "D2", 12, 2500, 35, 0.403, 0.431, 6.07, 17.77, null, null, pist(10.25), 31, 11.34, 10, null, D],
  ["DD Audio", "712g", "D2", 12, 2000, 32, 0.428, 0.474, 4.382, 25.44, null, null, pist(10.25), 30, 11.375, 9.625, 0.18, D],
  ["DD Audio", "4508", "D2", 8, 2000, 32, 0.52, 0.634, 2.93, 9.72, null, null, pist(7.25), 32, 8, 7.5, 0.1, D],
  ["DD Audio", "2508g (ESP)", "D2", 8, 1200, 42, 0.56, 0.62, 5.88, 4.64, null, null, pist(7.25), 20, 8, 6.69, 0.08, D],
  ["DD Audio", "1506b", "D2", 6.5, 1100, 35.5, 0.419, 0.505, 2.47, 5.8, null, null, pist(5.5), 25, 6.31, 6.875, 0.06, D],
  ["DD Audio", "612f", "D2", 12, 1000, 31, 0.4075, 0.4432, 5.06, 81.16, null, null, pist(10.25), 22, 11.5, 7.375, 0.1, D],
  ["DD Audio", "610f", "D2", 10, 1000, 34, 0.416, 0.454, 5.047, 33.91, null, null, pist(8.5), 22, 9.39, 7.25, 0.08, D],
  ["DD Audio", "608f", "D2", 8, 1000, 38, 0.46, 0.5, 7.76, 7.4, null, null, pist(6.5), 18, 7.37, 6.5, 0.07, D],
  ["DD Audio", "606d", "D2", 6.5, 600, 43.74, 0.501, 0.558, 4.907, 4.395, null, null, pist(5.375), 9, 5.875, 4.5, 0.04, D],
  ["DD Audio", "512e", "D2", 12, 700, 33, 0.64, 0.73, 4.88, 30.16, null, null, pist(10), 18, 11.02, 6.5, 0.08, D],
  ["DD Audio", "510e", "D2", 10, 700, 38, 0.65, 0.76, 4.96, 37.1, null, null, pist(8), 18, 8.93, 6, 0.07, D],
  ["DD Audio", "508e", "D2", 8, 500, 44, 0.71, 0.82, 5.01, 4.19, null, null, pist(6.25), 14, 7.125, 4.875, 0.04, D],
  // ---- B2 Audio (dual 2 Ω)
  ["B2 Audio", "RAMPAGE 18 Elite", "D2", 18, null, 26, 0.34, 0.36, 7.87, 99, null, 4.7, 1224.6, 40, null, null, 0.728, B],
  ["B2 Audio", "RAMPAGE 15 Elite", "D2", 15, null, 27.2, 0.36, 0.38, 7.11, 39, null, 4.7, 748.2, 40, null, null, 0.62, B],
  ["B2 Audio", "RAMPAGE 12", "D2", 12, null, 33.8, 0.47, 0.5, 7.59, 10.1, null, 2.5, 477.1, 40, null, null, 0.361, B],
  ["B2 Audio", "RAMPAGE 10", "D2", 10, null, 38.8, 0.57, 0.65, 4.97, 8.5, null, 2.9, 315.8, 30, null, null, 0.241, B],
  ["B2 Audio", "RAMPAGE 8", "D2", 8, null, 37.5, 0.46, 0.5, 6.16, 5.2, null, 2.5, 195, 20, null, null, 0.115, B],
  ["B2 Audio", "RAGE XL 15", "D2", 15, null, 27, 0.65, 0.74, 5.5, 56.4, null, 2.1, 765.1, 30, null, null, 0.445, B],
  ["B2 Audio", "RAGE XL 12", "D2", 12, null, 31, 0.59, 0.66, 5.99, 22.2, null, 2.1, 472.6, 30, null, null, 0.314, B],
  ["B2 Audio", "RAGE 15", "D2", 15, null, 26.2, 0.4, 0.43, 6.57, 60, null, 3.02, 776.9, 20, null, null, 0.377, B],
  ["B2 Audio", "RAGE 12", "D2", 12, null, 26.9, 0.34, 0.36, 5.58, 19.8, null, 2.9, 464.7, 20, null, null, 0.268, B],
  ["B2 Audio", "RIOT 15", "D2", 15, null, 31, 0.72, 0.8, 7.5, 60.1, null, 0.65, 839.8, 18, null, null, 0.26, B],
  ["B2 Audio", "RIOT 12", "D2", 12, null, 29.9, 0.55, 0.61, 6.55, 34.9, null, 2.39, 527.7, 18, null, null, 0.19, B],
  ["B2 Audio", "RIOT 10", "D2", 10, null, 28.3, 0.55, 0.61, 5.62, 19.3, null, 2.39, 328.9, 18, null, null, 0.13, B],
  // ---- Resilient Sounds
  ["Resilient Sounds", "Platinum 15", "D2", 15, 2000, 27.8, 0.26, 0.27, null, 61.0, null, null, null, 30, null, null, null, "skyhighcaraudio.com"],
  ["Resilient Sounds", "Gold 15", "D2", 15, 1000, 29.4, 0.57, 0.64, null, 77.9, null, null, null, 28, null, null, null, "skyhighcaraudio.com"],
  ["Resilient Sounds", "Gold 12", "D4", 12, 1000, 26.7, 0.45, 0.49, 5.2, 54.9, null, null, null, 28, null, null, null, X],
  ["Resilient Sounds", "Team 15", "D1", 15, 5000, 29.3, 0.32, null, null, 70.9, null, null, null, 38, null, null, null, "resilientsounds.com"],
  ["Resilient Sounds", "Team 18", "D1", 18, null, 25.5, 0.3, null, null, 163, null, null, null, 38, null, null, null, X],
  ["Resilient Sounds", "RS 12", "D4", 12, 500, 27.1, 0.36, null, null, 58.9, null, null, null, 17, null, null, null, "resilientsounds.com"],
  ["Resilient Sounds", "RS 15", "D4", 15, 500, 27.3, 0.64, null, null, 142.2, null, null, null, 17, null, null, null, "resilientsounds.com"],
  // ---- Rockford Fosgate
  ["Rockford Fosgate", "Power T1D215", "D2", 15, 1000, 26.3, 0.43, 0.46, 6.5, 102, 3.25, 1.6, 845, 16.4, 13.9375, 8.39, 0.191, R],
  ["Rockford Fosgate", "Punch P3D2-15", "D2", 15, 600, 21.7, 0.54, 0.58, 7.2, 155.8, 3.2, 4.06, 894, 15.2, 13.94, 7.58, 0.148, R],
  ["Rockford Fosgate", "Punch P3D2-12", "D2", 12, 600, 26.5, 0.49, 0.53, 6.7, 57.7, 3.2, 4.25, 570, 15.2, 11.25, 6.66, 0.106, R],
  ["Rockford Fosgate", "Punch P2D2-15", "D2", 15, 400, 20, 0.62, 0.69, 6.4, 219.6, 3.3, 3.4, 894, 13.3, 13.9, 7.34, 0.134, R],
  ["Rockford Fosgate", "Punch P1S4-15", "S4", 15, 250, 23, 0.55, 0.62, 3.2, 191.5, 3.6, 3.14, 876, 9, 13.85, 6.98, 0.148, R],
  // ---- Kicker
  ["Kicker", "CompR 12 (48CWR124)", "D4", 12, 500, 30.25, 0.6025, 0.634, 12.282, 58.38, 6.975, null, 506.71, 17.5, null, 5.75, null, K],
  ["Kicker", "CompVR 12 (52CVR124)", "D4", 12, null, 28.5, 0.653, 0.7045, 8.9665, 67.01, 7.06, null, 530.93, 16.5, null, 6.375, null, K],
  // ---- American Bass
  ["American Bass", "Godfather 15", "", 15, null, 35.6, 0.32, null, null, 65.6, null, null, null, null, null, null, null, X],
  ["American Bass", "Godfather 18 (GF1811)", "", 18, null, 29.6, 0.34, null, null, 157.553, null, null, null, null, null, null, null, X],
  ["American Bass", "HD 18", "D2", 18, null, 35.7, 0.47, null, null, 145.8, null, null, null, null, null, null, null, X],
  ["American Bass", "HD 15", "D2", 15, null, 31.7, 0.38, null, null, 62.3, null, null, null, null, null, null, null, X],
  ["American Bass", "HD 12", "D2", 12, null, 33.3, 0.35, null, null, 28.5, null, null, null, null, null, null, null, X],
  ["American Bass", "HD 10", "D1", 10, null, 41, 0.35, null, null, 9.2, null, null, null, null, null, null, null, X],
  ["American Bass", "XFL 1244", "D4", 12, null, 33.6, 0.44, null, null, 31.9, null, null, null, null, null, null, null, X],
  // ---- Alpine
  ["Alpine", "Type-R R-W12D2", "D2", 12, null, 27, 0.49, null, null, 51, null, null, null, null, null, null, null, X],
  ["Alpine", "Type-R R-W10D2", "D2", 10, null, 30, 0.47, null, null, 20.98, null, null, null, null, null, null, null, X],
  ["Alpine", "Type-S S-W12D4", "D4", 12, null, 31, 0.52, null, null, 46.4, null, null, null, null, null, null, null, X],
  ["Alpine", "Type-S S-W10D2", "D2", 10, null, 33, 0.44, null, null, 24.3, null, null, null, null, null, null, null, X],
  ["Alpine", "SWR-12D2", "D2", 12, null, 27, 0.44, null, null, 46, null, null, null, null, null, null, null, X],
  ["Alpine", "SWR-10D2", "D2", 10, null, 31, 0.51, null, null, 18, null, null, null, null, null, null, null, X],
];

const IN = 0.0254, FT3 = 0.0283168466;
const NAMES = { qes: "Qes", re: "Re", le: "Le", sd: "Sd", xmax: "Xmax", pe: "RMS power", cutout: "cutout", depth: "mounting depth", disp: "displacement" };
/** A sub from the list, ready for the designer (SI units), and the numbers its maker doesn't publish (filled with
 * values typical for its size). */
export function subFrom(row) {
  const [brand, model, coils, size, rms, fs, qts, qes0, qms, vas, re, le, sd, xmax, cut, dep, disp] = row;
  const est = [];
  // Qes: published; or from Qts and Qms; or (only Qts published) with a typical sub's Qms of 8
  let qes = qes0 > qts * 1.001 ? qes0 : null;
  if (qes == null && qms > qts) qes = (qts * qms) / (qms - qts);
  if (qes == null) { qes = (qts * 8) / (8 - qts); est.push("qes"); }
  const pick = (v, typical, key) => { if (v == null || !(v > 0)) { est.push(key); return typical; } return v; };
  const sdCm = pick(sd, Math.PI * (0.415 * size * 2.54) ** 2, "sd");
  const depthIn = pick(dep, Math.max(4.5, 0.52 * size + 0.6), "depth");
  const drv = {
    fs, qts, qes, vas: vas * 1e-3,
    re: pick(re, coils === "D1" ? 1.8 : coils === "D4" || coils === "S4" ? 3.6 : 3.4, "re"),
    le: pick(le != null && le < 15 ? le : null, 3, "le") * 1e-3,
    sd: sdCm * 1e-4,
    xmax: pick(xmax, size >= 15 ? 18 : size >= 12 ? 16 : 13, "xmax") * 1e-3,
    pe: pick(rms, Math.round(size * size * 6 / 50) * 50, "pe"),
    size: size * IN,
    cutout: pick(cut, size * 0.925, "cutout") * IN,
    depth: depthIn * IN,
    disp: pick(disp, 0.0011 * size * size * depthIn / 12, "disp") * FT3,
  };
  return { drv, est: est.filter((k) => k !== "le"), estNames: est.filter((k) => k !== "le").map((k) => NAMES[k]) };
}
export const SUBS = SUB_ROWS.map((r, i) => ({ id: i, brand: r[0], model: r[1], coils: r[2], size: r[3], rms: r[4], fs: r[5], qts: r[6], vas: r[9], src: r[17], row: r, full: r[7] != null || r[8] != null }));
export const subName = (s) => `${s.brand} ${s.model}${s.coils ? " " + s.coils : ""}`;
/** The id kept in a design: brand and model (rows can move). */
export const subKey = (s) => `${s.brand}|${s.model}`;
export const findSub = (key) => SUBS.find((s) => subKey(s) === key) || null;
