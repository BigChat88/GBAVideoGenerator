import { app, BrowserWindow, dialog, ipcMain } from "electron";
import { join } from "node:path";
import { convertToGba, loadPlayerAssets } from "./convert";
import { probeVideo } from "./encoder/ffmpeg";
import { resolveFfmpeg } from "./tools-path";
import { ConvertOptions, ProgressEvent } from "./types";

function getResourcesRoot(): string {
  return app.isPackaged ? join(process.resourcesPath, "resources") : join(__dirname, "..", "..", "resources");
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

ipcMain.handle("dialog:selectInput", async () => {
  const result = await dialog.showOpenDialog(mainWindow!, {
    title: "Pick a video",
    properties: ["openFile"],
    filters: [
      { name: "Video", extensions: ["mp4", "mov", "mkv", "avi", "webm", "wmv", "flv", "mpg", "mpeg", "m4v", "3gp"] },
      { name: "All files", extensions: ["*"] },
    ],
  });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle("dialog:selectOutput", async (_evt, suggestedName: string) => {
  const result = await dialog.showSaveDialog(mainWindow!, {
    title: "Save ROM as",
    defaultPath: suggestedName,
    filters: [{ name: "GBA ROM", extensions: ["gba"] }],
  });
  return result.canceled ? null : result.filePath ?? null;
});

// Duration/audio info for the renderer's size estimate
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
