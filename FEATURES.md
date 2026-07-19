# Features

## Screen-share invisibility
- Overlay window is hidden from Teams, Meet, Zoom, OBS, Windows Snipping Tool, and any other software screen recorder.
- Implemented via Electron's `setContentProtection(true)` — under the hood this calls the Win32 `SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)` API (Windows 10 build 2004+).
- **Limitation:** does not defeat a physical camera pointed at your screen, HDMI capture cards, or hardware KVM recorders. Software-only.

## Landscape overlay window
- Starts centered on your primary display, 900 × 340 pixels.
- Two-column body: **Answer** on the left, **Live transcript** on the right; input row across the bottom.
- Fully resizable — drag any edge / corner.
- Frosted-glass background, always-on-top, floats over full-screen apps and presentations.
- Recenter any time with `Ctrl+Shift+C`.

## Drag anywhere via the title bar (works in click-through mode)
- Grab the `⋮⋮ InHack` bar to move the window.
- Drag is implemented in JS on `mousedown` in the bar (window.moveBy on each mousemove) — not the CSS `-webkit-app-region: drag` trick, which was unreliable when the app was in passthrough mode.
- **Continuous position tracking:** while the app is click-through, the renderer watches every `mousemove` (Electron forwards them via `setIgnoreMouseEvents(true, {forward: true})`). Whenever your cursor is in the top 40 px, inside the input row, or inside the open settings panel, passthrough is turned off so drag / click work. Move away and passthrough returns.
- Toggle full interactive mode with `Ctrl+Shift+I` if you want to click into the answer body or scroll it.

## Collapse / expand
- Click the `–` button in the bar (or press `Ctrl+Shift+K`) to hide the body, transcript, input row, and settings. The window shrinks to just the bar.
- Click the `+` button (same key) to expand again.
- Useful when you're sharing your screen with the overlay hidden from Teams anyway — but you want minimum distraction on your own monitor too.

## Font size and opacity
- `Ctrl+=` / `Ctrl+-` scales font from 70 % to 200 % in 10 % steps.
- `Ctrl+Shift+]` / `Ctrl+Shift+[` adjusts overlay background opacity from 20 % (very transparent) to 100 % (fully opaque) in 5 % steps.
- Both persist across restarts via `localStorage`.
- All text inside the overlay uses `em` units so scaling is consistent across headings, code blocks, and transcript.

## Ask about anything on screen (OCR + LLM)
- `Ctrl+Shift+A` captures your primary display, downscales to 1280 px wide for speed, runs local Tesseract OCR, and feeds the extracted text + your (optional) typed question into the LLM.
- The Tesseract worker is created **once** and cached — first call is ~2 s to load English data, subsequent calls skip that entirely.
- Status pill shows the live pipeline stage: `capturing → shrinking → OCR → thinking → done`.

## Listen to laptop audio (system loopback + microphone)
- `Ctrl+Shift+L` starts capturing:
  - **System audio** — anything your Windows speakers play: YouTube videos, meeting participants, music, sound effects, presentation audio.
  - **Your microphone** — your own voice, if you allow mic access.
- Both streams are mixed and fed into local Whisper for transcription.
- **Pipeline:** raw PCM at 16 kHz mono → 3-second WAV chunks with 0.5 s overlap → **main-process HTTP POST** to whisper.cpp server → dedup step (removes the overlap words) → live transcript pane.
- **Why the main process?** whisper-server.exe doesn't send `Access-Control-Allow-Origin` headers, so a direct `fetch()` from the renderer (running under `file://`) gets blocked by CORS. Routing through the main process (Node) bypasses that entirely.
- **Silence gate:** chunks below an RMS threshold are dropped, so Whisper doesn't hallucinate phantom text on empty audio (a common source of "thank you for watching" noise).
- Nothing is written to disk. Transcript lives in memory only for the duration of the session.

## Configurable model + system prompt
Click the ⚙ button in the top bar to open the settings panel. Settings persist to `localStorage`.

| Setting | Purpose |
|---|---|
| **Model** | Any model you've pulled via Ollama. Dropdown is auto-populated from `ollama list`. Refresh with the ↻ button. |
| **System prompt** | Your "parent prompt" prepended to every LLM call. Steers the assistant's persona and formatting. Example: `You are an expert Kubernetes tutor. Explain concepts as if teaching a junior. Give kubectl examples.` |
| **Ollama URL** | Default `http://127.0.0.1:11434`. Change to point at a remote host or custom port. |
| **Whisper URL** | Default `http://127.0.0.1:9000/inference`. Change to point at a different whisper.cpp server. |

The system prompt applies to **every** answer — typed input, screen-ask (`Ctrl+Shift+A`), and follow-up questions using the transcript.

## Stop / cancel generation
Two ways to abort an in-flight task:
- **Click the Stop button** — the Ask button turns red while streaming; click it to abort.
- **Press `Ctrl+Shift+X`** — global shortcut, works even when the overlay isn't focused.

Cancellation kills:
- Any LLM stream in progress (via `AbortController`).
- Any OCR pipeline mid-stage.

## Reliable hide/show
- Global shortcut tries `Ctrl+Shift+H` first, falls back to `Alt+Shift+H`, then `Ctrl+Shift+Space` — first to bind wins.
- Terminal logs which binding succeeded and which failed. If none bind, you'll see `[hotkey] NO show/hide shortcut available`.
- Show sequence forces the window all the way to the front: `restore` → `show` → re-assert always-on-top → `moveTop` → `focus`. Fixes the "hidden then only partly comes back" edge case that happens with `skipTaskbar + alwaysOnTop`.

## Local-only, no cloud
- **LLM:** Ollama running on `127.0.0.1:11434`. Default model `llama3.2:3b` (~3 GB, CPU-friendly).
- **Transcription:** whisper.cpp HTTP server on `127.0.0.1:9000`. Default model `ggml-base.en.bin` (~140 MB).
- **OCR:** Tesseract.js runs entirely in the renderer process.
- No API keys, no external network calls, no telemetry. Everything runs on your machine.

## Rolling context for follow-ups
- The most recent ~2000 characters of live transcript are automatically prepended to every LLM prompt.
- Same for the most recent ~2000 characters of on-screen text after `Ctrl+Shift+A`.
- So you can hit `Ctrl+Shift+L` in a meeting, then type "summarize what was just said" and it uses the actual conversation as context.
