// Updates: the installed Hatch checks GitHub Releases for a newer version, downloads it in the
// background, and installs it when the user restarts (or the next time Hatch closes).
// Running from source (npm start) never updates itself.
import { app } from 'electron';
import updaterPkg from 'electron-updater';

const { autoUpdater } = updaterPkg;
const CHECK_EVERY = 4 * 3600e3;

let status = { state: app.isPackaged ? 'idle' : 'source' };
let notify = () => {};

function set(next) {
  status = { ...next, at: Date.now() };
  notify(status);
}

export const getStatus = () => status;

export function start(onChange) {
  notify = onChange;
  if (!app.isPackaged) return;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('checking-for-update', () => set({ state: 'checking' }));
  autoUpdater.on('update-not-available', () => set({ state: 'latest' }));
  autoUpdater.on('update-available', info => set({ state: 'downloading', version: info.version, percent: 0 }));
  autoUpdater.on('download-progress', p => set({ state: 'downloading', version: status.version, percent: Math.floor(p.percent) }));
  autoUpdater.on('update-downloaded', info => set({ state: 'ready', version: info.version }));
  autoUpdater.on('error', err => set({ state: 'error', message: String(err?.message || err).split('\n')[0] }));
  setTimeout(check, 10000);   // not right at startup, so it doesn't slow Hatch down
  setInterval(check, CHECK_EVERY);
}

export function check() {
  if (!app.isPackaged) return Promise.resolve(status);
  if (['checking', 'downloading', 'ready'].includes(status.state)) return Promise.resolve(status);
  return autoUpdater.checkForUpdates().then(() => status, err => {
    set({ state: 'error', message: String(err?.message || err).split('\n')[0] });
    return status;
  });
}

// Closes Hatch, runs the new installer quietly, and opens the new version.
export function install() {
  if (status.state === 'ready') autoUpdater.quitAndInstall(true, true);
}
