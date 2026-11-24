# FifTeam Media

A music app for Android and iPhone that runs from the web and installs to the home screen like a normal app:

- **Player**: your own music, copied into the app so it is there every time (works offline). The cover art tilts the way you tilt the phone, with a blurred glow and motion blur. Lock-screen controls, shuffle, repeat, up next. BASS, MIDS and HIGHS knobs: each one changes its own band and nothing else (a band turned up that would clip is held back on its own, never the others). The lock beside them stops accidental touches.
- **Rebass**: takes the song's own bass out completely and puts clean, loud sine notes in its place, inside the range you pick (two handles: whichever is higher is the top; put both on the same frequency and every bass note plays on that one frequency), at the level you pick (0 dB to −7.5 dB, −5 dB to start with). The bass is separated from everything else by Demucs v4 (an AI source separator) running on the phone itself, on its graphics chip (WebGPU) when it has one; its notes are found on that clean bass alone, so a voice or a guitar can't become a bass note, and the vocals and drums are left as they were. The song and its vocals keep exactly their own level; the chosen range belongs to the new bass (the song's own content below its top, up to 90 Hz, comes out), so those notes are the main thing down there. Each new note is full while the original note sounds, with the original's own timing, gaps and re-hits. Zero clipping is guaranteed: a look-ahead gain that is proven to stay under the ceiling, then a true-peak (between-samples) check. A live graph shows the bass being added. Drag along the whole-song strip to move through it. The Intro switch puts the FifTeam Production tag (`media/intro.wav`) at the start. Name it, then save it to the phone, share it (a file too big for the share sheet goes as an MP3), or keep it in the library. WAV 16/24-bit or MP3 320.
- **Social**: pictures, videos and rebassed songs from everyone using the app, with likes and comments (open them with a post's comments button; reply to a comment, like one). Tap someone's picture to send them a private message; all your conversations are behind the messages button next to Settings, and Settings can switch on notifications for new messages (shown while the app is open or in the background). The bell shows your activity: who liked or commented on your posts, and who replied to or liked your comments; tap one to go to it. Messages are encrypted on the phones, so only the two people talking can read them. Rebassed songs can be voted for (🔥 Vote); the one with the most votes from the last seven days sits on top as **Rebass of the week**. Tap anyone's picture or name for their page: followers and who they follow, their about me, Follow and Message, and their posts in two tabs (pictures and videos, rebassed songs). Your own page (your picture in the top bar, on every screen) changes your picture, username and about me; a new username shows on your older posts too. Their page also shows the likes on all their posts and comments, and has Block (you won't see each other, and they can't message or follow you; unblock there or in Settings > Privacy). Settings > Privacy: who can message you (everyone, by request, or nobody), and a private account (only followers you let in see your posts; new followers ask first, under the bell). No accounts: pick a username and a profile picture, post. Pull the feed down to refresh it. Posts are kept on the FifTeam feed (`social/config.json`, set up with `tools/social_setup.mjs`).
- **Library categories**: in Rebassed, make categories with names and cover pictures of your choosing, and put each rebass in as many as you like (a rebass's menu > Add to a category).
- **Tones**: test tones from 1 Hz to 20 kHz, square/triangle/saw, white and pink noise, level in dBFS, left/right/both, polarity flip, log or linear sweeps; save tones as files too.
- On Android you can also share a song from any app (Files, a downloader, a chat) straight to FifTeam Media.

**Get it: https://thirdeyedragon.github.io** (the download page, `get/`)

## Put it on your phone

- **Android (Chrome)**: open the link above and tap **Install** (top of the Library screen, or the browser menu > Install app).
- **iPhone (Safari)**: open the link, tap **Share > Add to Home Screen**. Open it from the home screen; the first time on the Player, tap **Turn on tilt** to allow motion.

Saving on iPhone goes through the share sheet: choose **Save to Files**. Only rebassed songs are shared from the app (a file, a locked file, or a rebass code).

## The FifTeam bot

`tools/bot/fifteam-bot.mjs` gives the FifTeam server's admins four commands: `/online` (who has the app open now, with their device and app version), `/ban <user>` (shuts the app on that phone until `/unban`; a username bans every phone using it), `/unban <user>` and `/bans`, plus moderating: `/posts` and `/comments` (the latest, or one user's), `/delete-post`, `/delete-comment`, `/purge <user>` (all their posts and comments) and `/clear-profile <user>` (their picture and about me; `/allow-picture` lets a picture back); `/devices` (every phone that has used the app in the last half year, with its device, the full list as a file); and the gradient tags next to a name: `/tag-member`, `/tag-founder`, `/tag-developer` (with `remove` to take one off) and `/tags`. Set it up once with `node tools/bot/fifteam-bot.mjs --setup` (the steps are at the top of that file). A ban is tied to the phone's app data: someone who clears FifTeam Media's data (or reinstalls) comes back as a new phone.

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
- `node test/eq.test.mjs`: the player's knobs measured in headless Edge: each knob moves only its own band, and a band turned up on a loud song is held back alone, never over full scale.
- `node test/social.test.mjs`: FifTeam Social against a stand-in feed service (username, feed, posting a picture and a rebass, playing and keeping someone's song, deleting, a post deleted on the service, markup in a post, no pings) and the knob lock.
- `node test/sep.test.mjs`: the bass separator's own maths (spectrogram, segments, resampling), the clean-up of the old bass's traces, and the note finder on a bass alone.
- `node test/make-songs.mjs <dir>` then `node test/serve.mjs` and `node test/e2e.mjs http://localhost:8123/ <dir> <out>`: drives the whole app in headless Edge at phone size (import, play, tilt, rebass, save WAV and MP3, tones) and checks the saved files.

## Updating

After changing any file, raise `VERSION` in `sw.js` (for example `fifteam-v2`) so installed copies pick up the change.

## Credits

MP3 encoding: LAME via lamejs (LGPL), loaded from cdnjs when you first save an MP3 and kept for offline use. Fonts: Inter and Sora (Google Fonts).
Bass separation: Demucs v4 by Meta AI (htdemucs_ft, its bass model; MIT license, see `models/`), run with ONNX Runtime Web (Microsoft, MIT license, see `vendor/ort/`). Downloaded the first time you rebass (about 51 MB) and kept for offline use; Settings can remove it.
