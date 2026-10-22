// Downloads a static LGPL ffmpeg build for this platform into
// resources/tools/<platform>-<arch>/bin/, where the app looks for it first
// (src/main/tools-path.ts) and electron-builder bundles it from.
//   npm run fetch-ffmpeg [-- --force]
//
// Windows / Linux: BtbN/FFmpeg-Builds LGPL release builds (no GPL parts, so
// bundling them only needs the LGPL notice and source pointer shipped next to
// the binary). macOS has no equivalent download: the release workflow builds
// it from source with scripts/build-ffmpeg-macos.sh instead.
import { execFileSync } from "node:child_process";
import { createWriteStream, existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

// FFmpeg release branch: "n8.1-latest" keeps getting point releases
const BRANCH = "8.1";
const BASE = "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest";
const BUILDS = {
  "win32-x64": `ffmpeg-n${BRANCH}-latest-win64-lgpl-${BRANCH}.zip`,
  "win32-arm64": `ffmpeg-n${BRANCH}-latest-winarm64-lgpl-${BRANCH}.zip`,
  "linux-x64": `ffmpeg-n${BRANCH}-latest-linux64-lgpl-${BRANCH}.tar.xz`,
  "linux-arm64": `ffmpeg-n${BRANCH}-latest-linuxarm64-lgpl-${BRANCH}.tar.xz`,
};

const appRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const platform = `${process.platform}-${process.arch}`;
const toolsDir = join(appRoot, "resources", "tools", platform);
const exe = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
const target = join(toolsDir, "bin", exe);

if (existsSync(target) && !process.argv.includes("--force")) {
  console.log(`[fetch-ffmpeg] ${target} already exists (use --force to replace it)`);
  process.exit(0);
}
const asset = BUILDS[platform];
if (!asset) {
  console.error(
    `[fetch-ffmpeg] No prebuilt download for ${platform}.` +
      (process.platform === "darwin" ? " Run scripts/build-ffmpeg-macos.sh instead." : "")
  );
  process.exit(1);
}

const work = await mkdtemp(join(tmpdir(), "gbavideogen-ffmpeg-"));
try {
  const archive = join(work, asset);
  console.log(`[fetch-ffmpeg] downloading ${asset}...`);
  const res = await fetch(`${BASE}/${asset}`);
  if (!res.ok || !res.body) throw new Error(`download failed: HTTP ${res.status}`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(archive));

  // Windows' own tar (bsdtar) reads zip; Git Bash's GNU tar does not
  const tar = process.platform === "win32" ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "tar";
  execFileSync(tar, ["-xf", archive, "-C", work], { stdio: "inherit" });
  const root = (await readdir(work, { withFileTypes: true })).find((d) => d.isDirectory());
  if (!root) throw new Error("unexpected archive layout");

  await mkdir(dirname(target), { recursive: true });
  await copyFile(join(work, root.name, "bin", exe), target);
  await copyFile(join(work, root.name, "LICENSE.txt"), join(toolsDir, "FFMPEG-LICENSE.txt"));
  await writeFile(
    join(toolsDir, "FFMPEG-SOURCE.txt"),
    `bin/${exe} is an unmodified LGPL build of FFmpeg (https://ffmpeg.org) from\n` +
      `https://github.com/BtbN/FFmpeg-Builds (${asset}).\n` +
      `Source code: https://github.com/FFmpeg/FFmpeg/tree/release/${BRANCH} and the build\n` +
      `scripts at https://github.com/BtbN/FFmpeg-Builds. License: FFMPEG-LICENSE.txt.\n`
  );
  if (process.platform !== "win32") execFileSync("chmod", ["+x", target]);
  console.log(`[fetch-ffmpeg] installed ${target}`);
  execFileSync(target, ["-hide_banner", "-version"], { stdio: ["ignore", "inherit", "inherit"] });
} finally {
  await rm(work, { recursive: true, force: true });
}
