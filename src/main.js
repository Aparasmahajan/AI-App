const { app, BrowserWindow, globalShortcut, ipcMain, desktopCapturer, screen, session, systemPreferences } = require('electron');
const path = require('path');

let overlay = null;
let clickThrough = true;

function createOverlay() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;

  overlay = new BrowserWindow({
    width: 420,
    height: 560,
    x: width - 440,
    y: 40,
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

  // The critical bit: hide from screen capture (Teams / Meet / Zoom / OBS).
  // Maps to Win32 SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE) on Windows 10 2004+.
  overlay.setContentProtection(true);

  // Float above fullscreen apps (including presentations).
  overlay.setAlwaysOnTop(true, 'screen-saver');
  overlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  // Start in click-through so mouse events pass to the app behind. Toggle with Ctrl+Shift+I.
  overlay.setIgnoreMouseEvents(clickThrough, { forward: true });

  overlay.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

function registerHotkeys() {
  // Show / hide overlay
  globalShortcut.register('CommandOrControl+Shift+H', () => {
    if (!overlay) return;
    overlay.isVisible() ? overlay.hide() : overlay.show();
  });

  // Toggle click-through (so you can actually click buttons in the overlay)
  globalShortcut.register('CommandOrControl+Shift+I', () => {
    if (!overlay) return;
    clickThrough = !clickThrough;
    overlay.setIgnoreMouseEvents(clickThrough, { forward: true });
    overlay.webContents.send('interactive-mode', !clickThrough);
  });

  // Ask AI about what's on screen right now (OCR + LLM)
  globalShortcut.register('CommandOrControl+Shift+A', () => {
    overlay?.webContents.send('trigger-screen-ask');
  });

  // Start / stop listening to meeting audio
  globalShortcut.register('CommandOrControl+Shift+L', () => {
    overlay?.webContents.send('toggle-listen');
  });
}

// IPC: renderer asks main for a desktop screenshot (used for OCR).
ipcMain.handle('capture-screen', async () => {
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: 1920, height: 1080 },
  });
  const primary = sources[0];
  return primary ? primary.thumbnail.toDataURL() : null;
});

// IPC: renderer asks for loopback audio source (system audio for transcription).
ipcMain.handle('get-audio-sources', async () => {
  const sources = await desktopCapturer.getSources({ types: ['screen'] });
  return sources.map((s) => ({ id: s.id, name: s.name }));
});

app.whenReady().then(() => {
  // Allow mic + media access without prompt (Electron blocks by default).
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    if (['media', 'display-capture', 'audioCapture', 'videoCapture'].includes(permission)) {
      return callback(true);
    }
    callback(false);
  });

  // Handle getDisplayMedia in the renderer — provide the primary screen source
  // and enable 'loopback' audio so system/meeting audio is captured (Windows only).
  session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
    desktopCapturer.getSources({ types: ['screen'] }).then((sources) => {
      callback({ video: sources[0], audio: 'loopback' });
    });
  });

  createOverlay();
  registerHotkeys();
});

app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => app.quit());
