// Picking a cover image: any photo or picture, cropped to the centre square, turned the right way up, saved as a
// 1024 px JPEG.
export function pickImage() {
  return new Promise((res) => {
    const inp = document.createElement("input");
    inp.type = "file"; inp.accept = "image/*";
    inp.onchange = async () => {
      const f = inp.files && inp.files[0];
      if (!f) { res(null); return; }
      try { res(await squareJpeg(f, 1024)); } catch { res(null); }
    };
    inp.addEventListener("cancel", () => res(null));
    inp.click();
  });
}

export async function squareJpeg(file, size) {
  let src;
  try { src = await createImageBitmap(file, { imageOrientation: "from-image" }); }
  catch {
    src = await new Promise((ok, bad) => { const i = new Image(); i.onload = () => ok(i); i.onerror = bad; i.src = URL.createObjectURL(file); });
  }
  const w = src.width, h = src.height, s = Math.min(w, h);
  const c = document.createElement("canvas"); c.width = c.height = Math.min(size, s);
  const g = c.getContext("2d");
  g.imageSmoothingQuality = "high";
  g.drawImage(src, (w - s) / 2, (h - s) / 2, s, s, 0, 0, c.width, c.height);
  return await new Promise((ok) => c.toBlob((b) => ok(b), "image/jpeg", 0.9));
}

/** A picture for a post: turned the right way up, at most `max` px on its longest side, as a JPEG. */
export async function fitJpeg(file, max) {
  let src;
  try { src = await createImageBitmap(file, { imageOrientation: "from-image" }); }
  catch {
    src = await new Promise((ok, bad) => { const i = new Image(); i.onload = () => ok(i); i.onerror = bad; i.src = URL.createObjectURL(file); });
  }
  const k = Math.min(1, max / Math.max(src.width, src.height));
  const c = document.createElement("canvas"); c.width = Math.max(1, Math.round(src.width * k)); c.height = Math.max(1, Math.round(src.height * k));
  const g = c.getContext("2d"); g.imageSmoothingQuality = "high"; g.drawImage(src, 0, 0, c.width, c.height);
  return await new Promise((ok, bad) => c.toBlob((b) => (b ? ok(b) : bad(new Error("image"))), "image/jpeg", 0.86));
}
