import { app, BrowserWindow, dialog, ipcMain } from "electron";
import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { convertToGba, loadPlayerAssets } from "./convert";
import { probeVideo } from "./encoder/ffmpeg";
import { findMgba, resolveFfmpeg } from "./tools-path";
import { ConvertOptions, ProgressEvent } from "./types";

function getResourcesRoot(): string {
  return app.isPackaged ? join(process.resourcesPath, "resources") : join(__dirname, "..", "..", "resources");
}

// Small per-user settings file (currently just the chosen mGBA path)
interface Settings {
  mgbaPath?: string;
}
const settingsPath = () => join(app.getPath("userData"), "settings.json");

async function loadSettings(): Promise<Settings> {
  try {
    return JSON.parse(await readFile(settingsPath(), "utf8"));
  } catch {
    return {};
  }
}

async function saveSettings(settings: Settings): Promise<void> {
  await writeFile(settingsPath(), JSON.stringify(settings, null, 2));
}

let mainWindow: BrowserWindow | null = null;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 760,
    height: 760,
    icon: join(__dirname, "..", "renderer", "icon.png"),
    webPreferences: {
      preload: join(__dirname, "..", "preload", "index.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadFile(join(__dirname, "..", "renderer", "index.html"));
}

app.whenReady().then(() => {
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

ipcMain.handle("dialog:selectInputs", async () => {
  const result = await dialog.showOpenDialog(mainWindow!, {
    title: "Add videos",
    properties: ["openFile", "multiSelections"],
    filters: [
      { name: "Video", extensions: ["mp4", "mov", "mkv", "avi", "webm", "wmv", "flv", "mpg", "mpeg", "m4v", "3gp"] },
      { name: "All files", extensions: ["*"] },
    ],
  });
  return result.canceled ? [] : result.filePaths;
});

ipcMain.handle("dialog:selectOutput", async (_evt, suggestedName: string) => {
  const result = await dialog.showSaveDialog(mainWindow!, {
    title: "Save ROM as",
    defaultPath: suggestedName,
    filters: [{ name: "GBA ROM", extensions: ["gba"] }],
  });
  return result.canceled ? null : result.filePath ?? null;
});

// Duration/audio info for the renderer's video list and size estimate
ipcMain.handle("video:probe", async (_evt, inputPath: string) => {
  return probeVideo(resolveFfmpeg(getResourcesRoot()), inputPath);
});

// Player sizes, for the size estimate (normal and large layouts)
ipcMain.handle("player:sizes", async () => {
  const assets = await loadPlayerAssets(getResourcesRoot());
  return { player: assets.player.length, large: 0x42000 };
});

ipcMain.handle("convert:start", async (evt, options: ConvertOptions) => {
  const emit = (event: ProgressEvent) => {
    evt.sender.send("convert:progress", event);
  };
  try {
    await convertToGba(options, getResourcesRoot(), emit);
  } catch (err) {
    emit({ kind: "error", message: err instanceof Error ? err.message : String(err) });
  }
});

ipcMain.handle("mgba:open", async (_evt, romPath: string) => {
  const settings = await loadSettings();
  let exe = findMgba(settings.mgbaPath);
  if (!exe) {
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: "Locate mGBA",
      properties: ["openFile"],
      filters: process.platform === "win32" ? [{ name: "mGBA", extensions: ["exe"] }] : [],
    });
    if (result.canceled || !result.filePaths[0]) return false;
    exe = result.filePaths[0];
    await saveSettings({ ...settings, mgbaPath: exe });
  }
  const child = spawn(exe, [romPath], { detached: true, stdio: "ignore" });
  child.on("error", () => undefined);
  child.unref();
  return true;
});
