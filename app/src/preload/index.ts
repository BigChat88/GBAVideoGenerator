import { contextBridge, ipcRenderer } from "electron";
import type { ConvertOptions, ProgressEvent } from "../main/types";

contextBridge.exposeInMainWorld("api", {
  selectInputFiles: (): Promise<string[]> => ipcRenderer.invoke("dialog:selectInputs"),
  selectOutputFile: (suggestedName: string): Promise<string | null> =>
    ipcRenderer.invoke("dialog:selectOutput", suggestedName),
  probeVideo: (inputPath: string) => ipcRenderer.invoke("video:probe", inputPath),
  playerSizes: () => ipcRenderer.invoke("player:sizes"),
  startConversion: (options: ConvertOptions): Promise<void> => ipcRenderer.invoke("convert:start", options),
  openInMgba: (romPath: string): Promise<boolean> => ipcRenderer.invoke("mgba:open", romPath),
  onProgress: (callback: (event: ProgressEvent) => void): void => {
    ipcRenderer.on("convert:progress", (_evt, event: ProgressEvent) => callback(event));
  },
});
