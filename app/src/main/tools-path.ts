import { existsSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

function exeName(tool: string): string {
  return process.platform === "win32" ? `${tool}.exe` : tool;
}

function commandExists(cmd: string): boolean {
  try {
    execFileSync(process.platform === "win32" ? "where" : "which", [cmd], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** Where scripts/fetch-ffmpeg.mjs (and the release workflow) put the bundled ffmpeg. */
export function bundledToolsDir(resourcesRoot: string): string {
  return join(resourcesRoot, "tools", `${process.platform}-${process.arch}`, "bin");
}

/**
 * ffmpeg is the only external tool. Release builds bundle it under
 * `resources/tools/<platform>-<arch>/bin/`; a development checkout without it
 * falls back to the system PATH.
 */
export function resolveFfmpeg(resourcesRoot: string): string {
  const bundled = join(bundledToolsDir(resourcesRoot), exeName("ffmpeg"));
  if (existsSync(bundled)) return bundled;
  if (!commandExists("ffmpeg")) {
    throw new Error(
      "ffmpeg was not found. Release builds include it; for a development checkout run " +
        "`npm run fetch-ffmpeg` (or install FFmpeg on your PATH) and restart the app."
    );
  }
  return "ffmpeg";
}

const MGBA_CANDIDATES =
  process.platform === "win32"
    ? ["C:\\Program Files\\mGBA\\mGBA.exe", "C:\\Program Files (x86)\\mGBA\\mGBA.exe"]
    : process.platform === "darwin"
      ? ["/Applications/mGBA.app/Contents/MacOS/mGBA"]
      : ["/usr/bin/mgba-qt", "/usr/local/bin/mgba-qt"];

/** mGBA from the user's saved choice, PATH or a default install location. */
export function findMgba(saved: string | undefined): string | null {
  if (saved && existsSync(saved)) return saved;
  for (const cmd of ["mGBA", "mgba-qt", "mgba"]) {
    if (commandExists(cmd)) return cmd;
  }
  return MGBA_CANDIDATES.find((p) => existsSync(p)) ?? null;
}
