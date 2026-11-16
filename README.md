# FifTeam Media

A music app for Android and iPhone that runs from the web and installs to the home screen like a normal app:

- **Player**: your own music, copied into the app so it is there every time (works offline). The cover art tilts the way you tilt the phone, with a blurred glow and motion blur. Lock-screen controls, shuffle, repeat, up next.
- **Rebass**: takes the song's own bass out completely and puts clean, loud sine notes in its place, inside the range you pick (lowest to highest Hz), at the level you pick (0 dB to −7.5 dB). The bass is separated from everything else by Demucs v4 (an AI source separator) running on the phone itself, on its graphics chip (WebGPU) when it has one; its notes are found on that clean bass alone, so a voice or a guitar can't become a bass note, and the vocals and drums are left as they were. Each new note is full while the original note sounds, with the original's own timing, gaps and re-hits. Zero clipping is guaranteed: a look-ahead gain that is proven to stay under the ceiling, then a true-peak (between-samples) check. A live graph shows the bass being added. Name it, then save it to the phone, share it, or keep it in the library. WAV 16/24-bit or MP3 320.
- **Tones**: test tones from 1 Hz to 20 kHz, square/triangle/saw, white and pink noise, level in dBFS, left/right/both, polarity flip, log or linear sweeps; save tones as files too.
- On Android you can also share a song from any app (Files, a downloader, a chat) straight to FifTeam Media.

**Open it: https://thirdeyedragon.github.io/fifteam-media/**

## Put it on your phone

- **Android (Chrome)**: open the link above and tap **Install** (top of the Library screen, or the browser menu > Install app).
- **iPhone (Safari)**: open the link, tap **Share > Add to Home Screen**. Open it from the home screen; the first time on the Player, tap **Turn on tilt** to allow motion.

Saving on iPhone goes through the share sheet: choose **Save to Files**. To send it to a friend, tap the share button at the top of the app.

## Hosting your own copy

This copy is already live at the link above. To host another one: the app has to be on an `https://` address for phones to install it (and to allow the tilt sensor and sharing). Any free static host works. Upload **everything in this folder except `test/` and `tools/`** (including `models/` and `vendor/`: the bass separator).

**GitHub Pages (free, about 5 minutes)**
1. Make a free account at github.com, then a new public repository, for example `fifteam-media`.
2. On the repository page choose **Add file > Upload files** and drag in the contents of this folder (index.html, manifest.webmanifest, sw.js, and the css, js and icons folders). Commit.
3. **Settings > Pages**: Source **Deploy from a branch**, branch **main**, folder **/ (root)**. Save.
4. After a minute it is live at `https://<your-name>.github.io/fifteam-media/`.

**Netlify**: sign in at app.netlify.com, then drag this folder onto the "deploy manually" drop area.


## Try it on this computer

```
node test/serve.mjs
```
then open http://localhost:8123/ in Chrome or Edge.

## Tests

- `node test/dsp.test.mjs`: the rebass engine on a made-up song mastered to the ceiling: pitch accuracy, range, and zero clipping at 0, −3 and −7.5 dB.
- `node test/bass.test.mjs`: the bass-note finder, the mapping, the new bass and the mastering, on made-up songs with a known bass line.
- `node test/sep.test.mjs`: the bass separator's own maths (spectrogram, segments, resampling), the clean-up of the old bass's traces, and the note finder on a bass alone.
- `node test/make-songs.mjs <dir>` then `node test/serve.mjs` and `node test/e2e.mjs http://localhost:8123/ <dir> <out>`: drives the whole app in headless Edge at phone size (import, play, tilt, rebass, save WAV and MP3, tones) and checks the saved files.

## Updating

After changing any file, raise `VERSION` in `sw.js` (for example `fifteam-v2`) so installed copies pick up the change.

## Credits

MP3 encoding: LAME via lamejs (LGPL), loaded from cdnjs when you first save an MP3 and kept for offline use. Fonts: Inter and Sora (Google Fonts).
Bass separation: Demucs v4 by Meta AI (htdemucs_ft, its bass model; MIT license, see `models/`), run with ONNX Runtime Web (Microsoft, MIT license, see `vendor/ort/`). Downloaded the first time you rebass (about 51 MB) and kept for offline use; Settings can remove it.
