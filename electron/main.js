// electron/main.js
// The whole "downloadable app" wrapper: start the local backend as a child
// process, open a window pointed at it, and make sure the backend actually
// dies when the window closes (no orphaned node process left listening).

const { app, BrowserWindow, ipcMain } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const { fork } = require('child_process');

const PORT = 3131;
let backendProcess = null;
let mainWindow = null;

function startBackend() {
  backendProcess = fork(path.join(__dirname, '..', 'backend', 'server.js'), [], {
    env: { ...process.env, PORT: String(PORT) },
    silent: false,
  });
  backendProcess.on('exit', (code) => {
    if (code !== 0 && code !== null) {
      console.error(`Forge backend exited unexpectedly with code ${code}`);
    }
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    title: 'Forge — STS2 Character Builder',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      // [Round 168] Only exposes the small `window.forgeUpdater` bridge
      // below — see preload.js's own header for exactly what it hands to
      // the page and why.
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  // Small retry loop: the backend needs a moment to bind its port after fork().
  const tryLoad = (attemptsLeft) => {
    mainWindow.loadURL(`http://localhost:${PORT}`).catch(() => {
      if (attemptsLeft > 0) setTimeout(() => tryLoad(attemptsLeft - 1), 200);
    });
  };
  tryLoad(15);
}

// [Round 168] "if the game gets an update that breaks the character
// creator, there should be a prompt to update the application" (Tyler) —
// this half is Forge itself having a newer version available (the OTHER
// half, the installed GAME having updated, is detected entirely in
// backend/gameLocator.js + frontend/index.html and needs no Electron
// involvement at all).
//
// electron-updater's default behavior already does the right thing for a
// desktop app like this: it checks the configured publish target (see
// package.json's `build.publish` — GitHub Releases, wired up once Tyler's
// repo exists) for a version newer than this build's own package.json
// version, downloads it in the background if one exists, and later lets
// the app install it on quit-and-relaunch. What's NOT used here is
// `checkForUpdatesAndNotify()`'s own built-in native OS notification —
// this app has its own fully custom dark-UI banner system
// (#app-update-banner in frontend/index.html) that everything else in
// this app already uses instead of native dialogs, so the two update
// events are forwarded to the renderer via preload.js's bridge instead and
// the renderer decides how to show them. `autoDownload` stays at its
// default (true) — matching this app's existing "the mod compile itself
// is the only thing that ever asks before doing something" pattern, a
// background download of Forge's own update needs no separate
// confirmation, only the final install-and-restart does (the
// "Restart & update" button in the banner).
function wireAutoUpdater() {
  autoUpdater.on('update-available', (info) => {
    if (mainWindow) mainWindow.webContents.send('forge-update-available', { version: info.version });
  });
  autoUpdater.on('update-downloaded', (info) => {
    if (mainWindow) mainWindow.webContents.send('forge-update-downloaded', { version: info.version });
  });
  // Update-check failures (no network, no GitHub release published yet,
  // rate-limited, etc.) are expected and common — logged for anyone
  // running from a terminal, never surfaced to the user as an error. This
  // app already works fully offline (the whole point is a LOCAL compiler
  // against a LOCAL game install) and must keep working exactly the same
  // way whether or not an update check ever succeeds.
  autoUpdater.on('error', (err) => {
    console.error('Forge update check failed (non-fatal):', err && err.message ? err.message : err);
  });
  ipcMain.on('forge-install-update', () => {
    autoUpdater.quitAndInstall();
  });
  autoUpdater.checkForUpdates().catch(() => { /* already logged via the 'error' listener above */ });
}

app.whenReady().then(() => {
  startBackend();
  createWindow();
  wireAutoUpdater();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (backendProcess) backendProcess.kill();
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  if (backendProcess) backendProcess.kill();
});
