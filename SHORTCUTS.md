# Keyboard Shortcuts

All shortcuts are **global** — they work anywhere on Windows, even when another app has focus.

## Window control

| Shortcut | Action | Notes |
|---|---|---|
| `Ctrl+Shift+H` | Show / hide the overlay | Fallback if another app owns this: `Alt+Shift+H`, then `Ctrl+Shift+Space`. Whichever binds first wins — check the terminal on startup for `[hotkey] show/hide bound to <accel>`. |
| `Ctrl+Shift+I` | Toggle interactive mode | Off = click-through (mouse events pass to the app behind). On = you can click buttons inside the overlay. **You don't need this to drag** — the top 40 px of the window is always interactive on hover. |
| `Ctrl+Shift+K` | Collapse / expand | Collapses everything to just the title bar. Great for staying out of the way but keeping the overlay reachable. |
| `Ctrl+Shift+C` | Recenter the window | Moves the overlay to the center of your primary display and brings it to the front. Handy if you drag it off-screen. |

## Appearance

| Shortcut | Action |
|---|---|
| `Ctrl+=` or `Ctrl++` | Increase font size (steps of 10 %, range 70 %–200 %) |
| `Ctrl+-` | Decrease font size |
| `Ctrl+Shift+]` | Increase background opacity (steps of 5 %, range 20 %–100 %) |
| `Ctrl+Shift+[` | Decrease background opacity (make more transparent) |

Font size and opacity persist across restarts.

## Assistant actions

| Shortcut | Action |
|---|---|
| `Ctrl+Shift+A` | Ask about what's on screen (OCR + LLM) |
| `Ctrl+Shift+L` | Start / stop listening to audio |
| `Ctrl+Shift+X` | Stop / cancel current task (same as the red **Stop** button) |

## In-app controls (mouse)

| Action | Where |
|---|---|
| **Drag window** | Grab anywhere in the top bar. Auto-works in click-through mode (the top 40 px auto-becomes interactive on hover). |
| **Collapse / expand** | Click the `–` / `+` button in the bar. |
| **Open settings** | Click the ⚙ button in the bar. |
| **Ask typed question** | Type in the bottom input, press `Enter` or click **Ask**. |
| **Stop a generation** | The Ask button turns red **Stop** during streaming — click it. |
| **Save settings** | Settings panel → **Save**. Persists to `localStorage`. |
| **Reset settings** | Settings panel → **Reset to defaults** (resets model, prompt, URLs, font, opacity). |

## Diagnosing a stuck shortcut

1. Look at the terminal running `npm start` — every failed registration is logged, e.g. `[hotkey] 'CommandOrControl+Shift+H' could not be registered — another app owns it`.
2. Common thieves: **Microsoft Teams**, **Snipping Tool**, **VS Code**, **Chrome / Edge**, **GitHub Desktop**, **Notion**.
3. Either quit the offender, or use whichever fallback shortcut did bind.
