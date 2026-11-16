// The bass separator in a worker of its own: the rebass worker starts it for one song and closes it when the bass is
// out, so everything the separator holds (hundreds of MB, on the graphics chip and off it) is handed back at once.
import { separate, separatorBackend } from "./separator.js";

onmessage = async (e) => {
  const { chs, sr } = e.data;
  try {
    const out = await separate(chs, sr, { progress: (stage, p, el) => postMessage({ type: "progress", stage, p, el }) });
    postMessage({ type: "done", out, backend: separatorBackend() }, out.map((c) => c.buffer));
  } catch (err) {
    postMessage({ type: "error", message: String((err && err.message) || err) });
  }
};
