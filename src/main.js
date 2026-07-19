const { app, BrowserWindow, globalShortcut, ipcMain, desktopCapturer, screen, session, safeStorage } = require('electron');
const path = require('path');
const http = require('http');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const { URL } = require('url');

// Bundled whisper-cli.exe + model. These paths are hardcoded to your addon/ tree.
const WHISPER_CLI = path.join(__dirname, '..', 'addon', 'whisper-blas-bin-x64', 'Release', 'whisper-cli.exe');
const WHISPER_MODEL = path.join(__dirname, '..', 'addon', 'ggml-base.en.bin');

// Persist config (including API keys) to a JSON file in Electron's userData dir.
// API-key values are encrypted with safeStorage (OS keychain: DPAPI on Windows)
// so config.json can be safely inspected even if leaked — keys look like base64
// blobs, un-decryptable without your Windows login. Non-key fields stay plain.
function configPath() { return path.join(app.getPath('userData'), 'config.json'); }

function encryptString(plain) {
  if (!plain) return '';
  try {
    if (safeStorage.isEncryptionAvailable()) {
      return 'enc:' + safeStorage.encryptString(String(plain)).toString('base64');
    }
  } catch (e) { console.warn('encrypt failed:', e.message); }
  return 'b64:' + Buffer.from(String(plain), 'utf8').toString('base64'); // fallback
}
function decryptString(stored) {
  if (!stored) return '';
  try {
    if (stored.startsWith('enc:')) {
      return safeStorage.decryptString(Buffer.from(stored.slice(4), 'base64'));
    }
    if (stored.startsWith('b64:')) {
      return Buffer.from(stored.slice(4), 'base64').toString('utf8');
    }
    return stored; // plain (legacy / migrated on next save)
  } catch (e) { console.warn('decrypt failed:', e.message); return ''; }
}

function encryptCfg(cfg) {
  const out = { ...cfg };
  if (cfg.apiKeys) {
    out.apiKeys = {};
    for (const k of Object.keys(cfg.apiKeys)) out.apiKeys[k] = encryptString(cfg.apiKeys[k]);
  }
  return out;
}
function decryptCfg(cfg) {
  const out = { ...cfg };
  if (cfg.apiKeys) {
    out.apiKeys = {};
    for (const k of Object.keys(cfg.apiKeys)) out.apiKeys[k] = decryptString(cfg.apiKeys[k]);
  }
  return out;
}

function loadConfigFromDisk() {
  const p = configPath();
  try {
    if (fs.existsSync(p)) {
      const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
      const cfg = decryptCfg(raw);
      console.log(`[config] loaded from ${p} (keys: ${Object.keys(cfg.apiKeys || {}).join(', ') || 'none'})`);
      return cfg;
    }
    console.log(`[config] no file at ${p} — starting fresh`);
  } catch (e) { console.warn(`[config] load failed at ${p}:`, e.message); }
  return {};
}
function saveConfigToDisk(cfg) {
  const p = configPath();
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(encryptCfg(cfg), null, 2), 'utf8');
    console.log(`[config] saved to ${p} (keys: ${Object.keys(cfg.apiKeys || {}).join(', ') || 'none'})`);
    return true;
  } catch (e) { console.warn(`[config] save failed at ${p}:`, e.message); return false; }
}

// Cache in memory; exposed synchronously to the renderer via preload.
let cachedConfig = null;
ipcMain.on('config-get-sync', (e) => {
  if (!cachedConfig) cachedConfig = loadConfigFromDisk();
  e.returnValue = cachedConfig;
});
ipcMain.handle('config-save', (_e, next) => {
  cachedConfig = next;
  return saveConfigToDisk(next);
});
ipcMain.handle('config-path', () => configPath());
ipcMain.handle('config-encryption', () => {
  try { return safeStorage.isEncryptionAvailable(); } catch { return false; }
});

const WIN_W = 900; 
const WIN_H = 600; 
const BAR_HEIGHT = 46;         // top zone that becomes interactive on hover (bar + 6 px gutter)
const CURSOR_POLL_MS = 33;     // ~30 Hz — smooth enough for drag, cheap

let overlay = null;
let userClickThrough = true;   // what user last set via Ctrl+Shift+I
let currentPassthrough = true; // what the window is actually in right now
let cursorPollTimer = null;

function createOverlay() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;

  overlay = new BrowserWindow({
    width: WIN_W,
    height: WIN_H,
    x: Math.round((width - WIN_W) / 2),
    y: Math.round((height - WIN_H) / 2),
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: false,   // OS resize cursors would appear at edges otherwise
    skipTaskbar: true,
    focusable: true,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  overlay.setContentProtection(true);
  overlay.setAlwaysOnTop(true, 'screen-saver');
  overlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  setPassthrough(true);

  overlay.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  startCursorPoll();
  overlay.on('closed', stopCursorPoll);
}

function setPassthrough(v) {
  if (!overlay || v === currentPassthrough) return;
  currentPassthrough = v;
  overlay.setIgnoreMouseEvents(v, { forward: true });
}

// Poll cursor position in main process — bypasses any renderer event-timing
// weirdness. When the pointer is over the top bar (or bottom input row) of the
// overlay, we make the window interactive so drag/click work.
function startCursorPoll() {
  stopCursorPoll();
  cursorPollTimer = setInterval(() => {
    if (!overlay || overlay.isDestroyed() || !overlay.isVisible()) return;

    // Active resize: adjust window bounds based on cursor delta since drag start.
    if (resizeState) {
      const c = screen.getCursorScreenPoint();
      const dx = c.x - resizeState.startX;
      const dy = c.y - resizeState.startY;
      overlay.setBounds({
        x: resizeState.winX,
        y: resizeState.winY,
        width: Math.max(500, resizeState.startW + dx),
        height: Math.max(160, resizeState.startH + dy),
      });
      return; // don't touch passthrough while resizing
    }

    if (!userClickThrough) return;

    const b = overlay.getBounds();
    const c = screen.getCursorScreenPoint();
    const insideWin = c.x >= b.x && c.x <= b.x + b.width && c.y >= b.y && c.y <= b.y + b.height;
    if (!insideWin) { setPassthrough(true); return; }

    const relY = c.y - b.y;
    const overTopBar = relY < BAR_HEIGHT;
    const overBottom = relY > b.height - 166;
    setPassthrough(!(overTopBar || overBottom));
  }, CURSOR_POLL_MS);
}
function stopCursorPoll() {
  if (cursorPollTimer) { clearInterval(cursorPollTimer); cursorPollTimer = null; }
}

function showOverlay() {
  if (!overlay) return;
  if (overlay.isMinimized()) overlay.restore();
  overlay.show();
  overlay.setAlwaysOnTop(true, 'screen-saver');
  overlay.moveTop();
  overlay.focus();
}
function toggleOverlay() {
  if (!overlay) return;
  if (overlay.isVisible() && !overlay.isMinimized()) overlay.hide();
  else showOverlay();
}

function tryRegister(accel, handler) {
  const ok = globalShortcut.register(accel, handler);
  if (!ok) console.warn(`[hotkey] '${accel}' could not be registered — another app owns it`);
  return ok;
}

function registerHotkeys() {
  const showHideAccels = ['CommandOrControl+Shift+H', 'Alt+Shift+H', 'CommandOrControl+Shift+Space'];
  let bound = false;
  for (const a of showHideAccels) {
    if (tryRegister(a, toggleOverlay)) { bound = true; console.log(`[hotkey] show/hide bound to ${a}`); break; }
  }
  if (!bound) console.error('[hotkey] NO show/hide shortcut available');

  tryRegister('CommandOrControl+Shift+I', () => {
    if (!overlay) return;
    userClickThrough = !userClickThrough;
    setPassthrough(userClickThrough);
    overlay.webContents.send('interactive-mode', !userClickThrough);
  });

  tryRegister('CommandOrControl+Shift+A', () => overlay?.webContents.send('trigger-screen-ask'));
  tryRegister('CommandOrControl+Shift+L', () => overlay?.webContents.send('toggle-listen'));
  tryRegister('CommandOrControl+Shift+X', () => overlay?.webContents.send('cancel-all'));
  tryRegister('CommandOrControl+Shift+K', () => overlay?.webContents.send('toggle-collapse'));

  tryRegister('CommandOrControl+=', () => overlay?.webContents.send('font-delta', +1));
  tryRegister('CommandOrControl+Plus', () => overlay?.webContents.send('font-delta', +1));
  tryRegister('CommandOrControl+Shift+=', () => overlay?.webContents.send('font-delta', +1));
  tryRegister('CommandOrControl+-', () => overlay?.webContents.send('font-delta', -1));
  tryRegister('CommandOrControl+Shift+-', () => overlay?.webContents.send('font-delta', -1));

  tryRegister('CommandOrControl+Shift+]', () => overlay?.webContents.send('opacity-delta', +0.05));
  tryRegister('CommandOrControl+Shift+[', () => overlay?.webContents.send('opacity-delta', -0.05));

  tryRegister('CommandOrControl+Alt+C', () => {
    if (!overlay) return;
    const { width, height } = screen.getPrimaryDisplay().workAreaSize;
    const [w, h] = overlay.getSize();
    overlay.setPosition(Math.round((width - w) / 2), Math.round((height - h) / 2));
    showOverlay();
  });
}

// Real window opacity — affects the whole window at the OS level.
ipcMain.on('set-window-opacity', (_e, value) => {
  overlay?.setOpacity(Math.max(0.2, Math.min(1.0, value)));
});

// Collapse: shrink the OS window to bar-only. Expand: restore previous size.
let preCollapseSize = null;
ipcMain.on('set-collapsed', (_e, collapsed) => {
  if (!overlay) return;
  const b = overlay.getBounds();
  if (collapsed) {
    preCollapseSize = { w: b.width, h: b.height };
    overlay.setBounds({ x: b.x, y: b.y, width: b.width, height: 58 }); // bar + 6+6 gutter
  } else if (preCollapseSize) {
    overlay.setBounds({ x: b.x, y: b.y, width: preCollapseSize.w, height: preCollapseSize.h });
    preCollapseSize = null;
  }
});

// Grow the window downward by `delta` px when the transcript appears; shrink
// back when it hides. Answer area stays untouched.
ipcMain.on('grow-window', (_e, delta) => {
  if (!overlay) return;
  const b = overlay.getBounds();
  overlay.setBounds({ x: b.x, y: b.y, width: b.width, height: Math.max(160, b.height + delta) });
});

// Manual resize driven entirely from main using OS cursor position — reliable
// even when the cursor is dragged outside the window bounds.
let resizeState = null;
ipcMain.on('start-resize', () => {
  if (!overlay) return;
  const c = screen.getCursorScreenPoint();
  const b = overlay.getBounds();
  resizeState = { startX: c.x, startY: c.y, startW: b.width, startH: b.height, winX: b.x, winY: b.y };
});
ipcMain.on('end-resize', () => { resizeState = null; });

ipcMain.handle('capture-screen', async () => {
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: 1920, height: 1080 },
  });
  return sources[0]?.thumbnail.toDataURL() || null;
});

ipcMain.handle('list-ollama-models', async () => {
  try {
    const res = await fetch('http://127.0.0.1:11434/api/tags');
    if (!res.ok) return [];
    const j = await res.json();
    return (j.models || []).map((m) => m.name);
  } catch { return []; }
});

ipcMain.handle('whisper-test', async () => {
  if (!fs.existsSync(WHISPER_CLI)) return { ok: false, error: `cli not found: ${WHISPER_CLI}` };
  if (!fs.existsSync(WHISPER_MODEL)) return { ok: false, error: `model not found: ${WHISPER_MODEL}` };
  // Real end-to-end test: 3s of quiet silence WAV through whisper-cli.
  const sampleRate = 16000, samples = sampleRate * 3;
  const buf = Buffer.alloc(44 + samples * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + samples * 2, 4);
  buf.write('WAVE', 8); buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24); buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(samples * 2, 40);
  const r = await runWhisperCli(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  if (r.error) return { ok: false, error: r.error };
  return { ok: true, status: 200 };
});

// Build a multipart/form-data body as a single Buffer so we can send it with
// an explicit Content-Length header (no chunked transfer encoding). cpp-httplib
// (inside whisper-server.exe) chokes on Transfer-Encoding: chunked and resets
// the connection — that was the root cause of the ECONNRESET errors.
function buildMultipart(wavBuffer) {
  const boundary = '----ovBoundary' + Math.random().toString(36).slice(2);
  const CRLF = '\r\n';
  const parts = [];
  parts.push(Buffer.from(
    `--${boundary}${CRLF}` +
    `Content-Disposition: form-data; name="file"; filename="chunk.wav"${CRLF}` +
    `Content-Type: audio/wav${CRLF}${CRLF}`
  ));
  parts.push(Buffer.from(wavBuffer));
  parts.push(Buffer.from(
    `${CRLF}--${boundary}${CRLF}` +
    `Content-Disposition: form-data; name="temperature"${CRLF}${CRLF}0` +
    `${CRLF}--${boundary}${CRLF}` +
    `Content-Disposition: form-data; name="response_format"${CRLF}${CRLF}json` +
    `${CRLF}--${boundary}--${CRLF}`
  ));
  return { body: Buffer.concat(parts), boundary };
}

// Post via node:http to guarantee Content-Length instead of chunked encoding.
function postMultipart(url, wavBuffer) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(url); } catch (e) { return resolve({ error: `bad URL: ${e.message}` }); }
    const { body, boundary } = buildMultipart(wavBuffer);
    const req = http.request({
      hostname: u.hostname,
      port: u.port || 80,
      path: u.pathname + u.search,
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': body.length,
        'Connection': 'close',
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return resolve({ error: `HTTP ${res.statusCode} — ${text.slice(0, 200)}` });
        }
        try {
          const j = JSON.parse(text);
          resolve({ text: (j.text || '').trim() });
        } catch {
          resolve({ text: text.trim() });
        }
      });
    });
    req.on('error', (e) => resolve({ error: `${e.code || 'ERR'} ${e.message}` }));
    req.write(body);
    req.end();
  });
}

// Whisper via whisper-cli.exe subprocess. The bundled whisper-server.exe is
// unreliable — it drops POST bodies or resets connections. whisper-cli reads a
// WAV file and writes a .txt file. Slower per call (~2-4s) since the model
// reloads each time, but it actually returns real transcriptions.
let whisperBusy = false;

function runWhisperCli(wavBuffer) {
  return new Promise((resolve) => {
    if (!fs.existsSync(WHISPER_CLI)) return resolve({ error: `whisper-cli not found at ${WHISPER_CLI}` });
    if (!fs.existsSync(WHISPER_MODEL)) return resolve({ error: `model not found at ${WHISPER_MODEL}` });

    const tmpBase = path.join(os.tmpdir(), `sw-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    const wavPath = tmpBase + '.wav';
    const txtPath = tmpBase + '.txt';
    try { fs.writeFileSync(wavPath, Buffer.from(wavBuffer)); }
    catch (e) { return resolve({ error: `writeFile: ${e.message}` }); }

    // -nt no timestamps, -nfa no flash-attn, -l en, -otxt write transcript to file, -of base path.
    const args = [
      '-m', WHISPER_MODEL,
      '-f', wavPath,
      '-otxt', '-of', tmpBase,
      '-nt', '-nfa', '-l', 'en',
      '-t', '4', // threads
    ];
    const child = spawn(WHISPER_CLI, args, { windowsHide: true });

    let stderrBuf = '';
    child.stderr.on('data', (d) => { stderrBuf += d.toString(); });
    child.on('error', (e) => {
      cleanup();
      resolve({ error: `spawn ${e.code || ''}: ${e.message}` });
    });
    child.on('close', (code) => {
      let text = '';
      try { text = fs.readFileSync(txtPath, 'utf8').trim(); } catch {}
      cleanup();
      if (code !== 0 && !text) {
        return resolve({ error: `whisper-cli exit ${code}: ${stderrBuf.slice(-200).trim()}` });
      }
      resolve({ text });
    });

    function cleanup() {
      try { fs.unlinkSync(wavPath); } catch {}
      try { fs.unlinkSync(txtPath); } catch {}
    }
  });
}

ipcMain.handle('whisper-transcribe', async (_e, { wavBuffer }) => {
  if (whisperBusy) return { error: 'busy: previous chunk still processing (dropped)' };
  whisperBusy = true;
  try {
    return await runWhisperCli(wavBuffer);
  } finally {
    whisperBusy = false;
  }
});

app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    if (['media', 'display-capture', 'audioCapture', 'videoCapture'].includes(permission)) return callback(true);
    callback(false);
  });
  session.defaultSession.setDisplayMediaRequestHandler((_req, callback) => {
    desktopCapturer.getSources({ types: ['screen'] }).then((sources) => {
      callback({ video: sources[0], audio: 'loopback' });
    });
  });

  createOverlay();
  registerHotkeys();
});

app.on('will-quit', () => { globalShortcut.unregisterAll(); stopCursorPoll(); });
app.on('window-all-closed', () => app.quit());
