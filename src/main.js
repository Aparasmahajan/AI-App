const { app, BrowserWindow, globalShortcut, ipcMain, desktopCapturer, screen, session, net } = require('electron');
const path = require('path');

const WIN_W = 900;
const WIN_H = 340;

let overlay = null;
let clickThrough = true;

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
    resizable: true,
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
  overlay.setIgnoreMouseEvents(clickThrough, { forward: true });

  overlay.loadFile(path.join(__dirname, 'renderer', 'index.html'));
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
    clickThrough = !clickThrough;
    overlay.setIgnoreMouseEvents(clickThrough, { forward: true });
    overlay.webContents.send('interactive-mode', !clickThrough);
  });

  tryRegister('CommandOrControl+Shift+A', () => overlay?.webContents.send('trigger-screen-ask'));
  tryRegister('CommandOrControl+Shift+L', () => overlay?.webContents.send('toggle-listen'));
  tryRegister('CommandOrControl+Shift+X', () => overlay?.webContents.send('cancel-all'));
  tryRegister('CommandOrControl+Shift+K', () => overlay?.webContents.send('toggle-collapse'));

  // Font size: Ctrl+= / Ctrl+- (also register Shift variants because keyboards vary)
  tryRegister('CommandOrControl+=', () => overlay?.webContents.send('font-delta', +1));
  tryRegister('CommandOrControl+Plus', () => overlay?.webContents.send('font-delta', +1));
  tryRegister('CommandOrControl+Shift+=', () => overlay?.webContents.send('font-delta', +1));
  tryRegister('CommandOrControl+-', () => overlay?.webContents.send('font-delta', -1));
  tryRegister('CommandOrControl+Shift+-', () => overlay?.webContents.send('font-delta', -1));

  // Opacity: Ctrl+Shift+] increase, Ctrl+Shift+[ decrease
  tryRegister('CommandOrControl+Shift+]', () => overlay?.webContents.send('opacity-delta', +0.05));
  tryRegister('CommandOrControl+Shift+[', () => overlay?.webContents.send('opacity-delta', -0.05));

  tryRegister('CommandOrControl+Shift+C', () => {
    if (!overlay) return;
    const { width, height } = screen.getPrimaryDisplay().workAreaSize;
    const [w, h] = overlay.getSize();
    overlay.setPosition(Math.round((width - w) / 2), Math.round((height - h) / 2));
    showOverlay();
  });
}

// Renderer streams pointer position; here we flip passthrough based on whether
// the pointer is inside an interactive region (bar / input / settings).
ipcMain.on('set-mouse-passthrough', (_e, passthrough) => {
  overlay?.setIgnoreMouseEvents(passthrough, { forward: true });
});

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

// Transcribe from main process — bypasses renderer CORS. whisper-server.exe
// doesn't send Access-Control-Allow-Origin, so renderer fetch() gets blocked.
ipcMain.handle('whisper-transcribe', async (_e, { url, wavBuffer }) => {
  try {
    // Manually build multipart/form-data — Node's FormData + fetch works but
    // we want to keep this dependency-free.
    const boundary = '----ovBoundary' + Math.random().toString(36).slice(2);
    const preamble = Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="chunk.wav"\r\n` +
      `Content-Type: audio/wav\r\n\r\n`
    );
    const middle = Buffer.from(
      `\r\n--${boundary}\r\n` +
      `Content-Disposition: form-data; name="temperature"\r\n\r\n0` +
      `\r\n--${boundary}\r\n` +
      `Content-Disposition: form-data; name="response_format"\r\n\r\njson`
    );
    const closing = Buffer.from(`\r\n--${boundary}--\r\n`);
    const body = Buffer.concat([preamble, Buffer.from(wavBuffer), middle, closing]);

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
      body,
    });
    if (!res.ok) throw new Error(`whisper HTTP ${res.status}`);
    const j = await res.json();
    return { text: (j.text || '').trim() };
  } catch (e) {
    return { error: e.message };
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

app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => app.quit());
