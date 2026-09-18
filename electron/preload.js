// electron/preload.js
// [Round 168] The renderer (frontend/index.html) runs with
// contextIsolation:true and nodeIntegration:false (main.js) — it has NO
// direct access to Node or Electron's IPC. This preload script is the only
// bridge, and it exposes exactly three things, all read-only or one-way:
// two subscribe-to-an-event callbacks and one "go ahead and install"
// action. Nothing else from Electron/Node is exposed. The page detects
// whether it's running inside the packaged app at all just by checking
// `window.forgeUpdater` — this script only runs there, so a plain browser
// (this project's own dev/test pipeline included) never sees it, and the
// frontend code that reads it is written to treat that as a normal,
// silent "not available" case (see frontend/index.html's own
// app-update-banner wiring).

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('forgeUpdater', {
  onUpdateAvailable: (callback) => {
    ipcRenderer.on('forge-update-available', (_event, info) => callback(info));
  },
  onUpdateDownloaded: (callback) => {
    ipcRenderer.on('forge-update-downloaded', (_event, info) => callback(info));
  },
  installUpdate: () => ipcRenderer.send('forge-install-update'),
});
