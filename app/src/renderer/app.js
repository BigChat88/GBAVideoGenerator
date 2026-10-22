const $ = (id) => document.getElementById(id);

// Must match src/main/encoder/gba.ts
const VBLANK_HZ = 59.7275;
const RESOLUTIONS = [[96, 64], [120, 80], [144, 96], [168, 112], [192, 128], [216, 144], [240, 160]];
const FPS_STEPS = [6, 5, 4, 3, 2, 1]; // VBlanks per frame: 10, 12, 15, 20, 30, 60 fps
const MB = 1024 * 1024;
const MAX_ROM_SIZE = 32 * MB;
const MAX_LARGE_ROM_SIZE = 64 * MB;
// Typical LZ77 ratio on 8bpp frames, only used for the estimate
const LZ77_RATIO = 0.75;

let inputPath = null;
let probe = null; // { duration, hasVideo, hasAudio }
let playerSizes = { player: 12 * 1024, large: 0x42000 };

window.api.playerSizes().then((s) => {
  playerSizes = s;
  updateEstimate();
});

function baseNameWithoutExt(p) {
  const base = p.split(/[\\/]/).pop() || "";
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(0, dot) : base;
}

// Printable ASCII only, like the GBA font (and the packer)
function asciiName(name, maxLen) {
  return name.replace(/[^\x20-\x7e]/g, " ").replace(/\s+/g, " ").trim().slice(0, maxLen);
}

function currentResolution() {
  return RESOLUTIONS[Number($("resolution").value)];
}

function currentVpf() {
  return FPS_STEPS[Number($("fps").value)];
}

function formatMB(bytes) {
  return `${(bytes / MB).toFixed(1)} MB`;
}

function formatDuration(sec) {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

$("btnPickInput").addEventListener("click", async () => {
  const path = await window.api.selectInputFile();
  if (!path) return;
  inputPath = path;
  probe = null;
  $("inputPath").value = path;
  const title = asciiName(baseNameWithoutExt(path), 12);
  if (title) $("romTitle").value = title;
  $("videoInfo").textContent = "Reading the video...";
  $("videoInfo").classList.remove("warn");
  updateEstimate();
  try {
    probe = await window.api.probeVideo(path);
    $("videoInfo").textContent = probe.hasVideo
      ? `${formatDuration(probe.duration)}${probe.hasAudio ? "" : " — no audio track (the ROM will be silent)"}`
      : "This file has no video stream.";
    $("videoInfo").classList.toggle("warn", !probe.hasVideo);
  } catch (err) {
    probe = null;
    $("videoInfo").textContent = `Could not read the video: ${err.message || err}`;
    $("videoInfo").classList.add("warn");
  }
  updateEstimate();
});

// --- size estimate ---

function updateSliders() {
  const [w, h] = currentResolution();
  $("resolutionValue").textContent = `${w}×${h}`;
  $("fpsValue").textContent = `${Math.round(VBLANK_HZ / currentVpf())} fps`;
  updateEstimate();
}

function updateEstimate() {
  if (!probe || !probe.hasVideo) {
    $("sizeValue").textContent = "—";
    $("sizeFill").style.width = "0%";
    $("sizeBar").classList.remove("over", "large");
    $("sizeNote").textContent = "A GBA cartridge holds at most 32 MB.";
    $("sizeNote").classList.remove("warn");
    return;
  }
  const [w, h] = currentResolution();
  const vpf = currentVpf();
  const spv = Number($("audioSpv").value);
  const fps = VBLANK_HZ / vpf;
  const allowLarge = $("allowLarge").checked;
  const compress = $("compress").checked;

  const frameBytes = 512 + w * h * (compress ? LZ77_RATIO : 1);
  // The audio track is always stored (silence when audio is off)
  const audioBytes = vpf * ($("audioCodec").value === "adpcm" ? 4 + spv / 2 : spv);
  const bytesPerSec = (frameBytes + audioBytes) * fps;
  const base = playerSizes.player + 16 + 64;
  let total = base + probe.duration * bytesPerSec;
  const large = allowLarge && total > MAX_ROM_SIZE;
  if (large) total += playerSizes.large - playerSizes.player;

  const limit = allowLarge ? MAX_LARGE_ROM_SIZE : MAX_ROM_SIZE;
  const over = total > limit;
  $("sizeValue").textContent = `~${formatMB(total)}` + (compress ? " (rough, depends on the content)" : "");
  $("sizeFill").style.width = `${Math.min(100, (total / limit) * 100)}%`;
  $("sizeBar").classList.toggle("over", over);
  $("sizeBar").classList.toggle("large", large && !over);

  if (over) {
    const fits = (limit - base) / bytesPerSec;
    $("sizeNote").textContent =
      `Too big (${allowLarge ? "64 MB max for large ROMs" : "32 MB max for a GBA cartridge"}). With these settings ` +
      `about ${formatDuration(fits)} of video fits: lower the resolution or frame rate, enable compression or ` +
      `ADPCM${allowLarge ? "" : ", or allow large ROMs"}.`;
  } else if (large) {
    $("sizeNote").textContent =
      "Over 32 MB: this will be a large ROM, which is not compatible with all devices " +
      "(it won't run on flashcarts or most emulators).";
  } else {
    $("sizeNote").textContent = "A GBA cartridge holds at most 32 MB.";
  }
  $("sizeNote").classList.toggle("warn", over || large);
}

$("resolution").addEventListener("input", updateSliders);
$("fps").addEventListener("input", updateSliders);
for (const id of ["compress", "audioSpv", "audioCodec", "allowLarge"]) {
  $(id).addEventListener("change", updateEstimate);
}
$("audioEnabled").addEventListener("change", () => {
  const on = $("audioEnabled").checked;
  $("audioSpv").disabled = !on;
  $("audioCodec").disabled = !on;
});
updateSliders();

// --- conversion ---

function collectOptions(outputPath) {
  const [width, height] = currentResolution();
  const romTitle = $("romTitle").value || "My Video";
  return {
    videos: [{ path: inputPath, name: asciiName(baseNameWithoutExt(inputPath), 31) || "video" }],
    outputPath,
    romTitle,
    width,
    height,
    vblanksPerFrame: currentVpf(),
    dither: $("dither").value,
    compress: $("compress").checked,
    audioMode: $("audioEnabled").checked ? "source" : "none",
    audioSpv: Number($("audioSpv").value),
    audioCodec: $("audioCodec").value,
    allowLarge: $("allowLarge").checked,
  };
}

function appendLog(line) {
  const log = $("log");
  log.textContent += line + "\n";
  log.scrollTop = log.scrollHeight;
}

// Overall progress: frame encoding is nearly all of the work
const STAGE_FLOOR = { probe: 1, frames: 3, pack: 96, done: 100 };
const FRAMES_SPAN = [3, 95];

let shownPct = 0;

function setProgress(pct) {
  const clamped = Math.max(0, Math.min(100, pct));
  if (clamped < shownPct) return;
  shownPct = clamped;
  $("progressFill").style.width = `${clamped}%`;
  $("progressPct").textContent = `${Math.round(clamped)}%`;
}

function openConvertModal() {
  $("log").textContent = "";
  $("stageLabel").textContent = "Starting...";
  $("progressBar").classList.remove("error");
  $("progressBar").classList.add("working");
  shownPct = 0;
  $("progressFill").style.width = "0%";
  $("progressPct").textContent = "0%";
  $("btnCloseModal").disabled = true;
  $("convertModal").hidden = false;
}

function finishConvertModal() {
  $("progressBar").classList.remove("working");
  $("btnCloseModal").disabled = false;
  $("btnConvert").disabled = false;
}

$("btnCloseModal").addEventListener("click", () => {
  $("convertModal").hidden = true;
});

window.api.onProgress((event) => {
  if (event.kind === "stage") {
    $("stageLabel").textContent = event.label;
    appendLog(`\n=== ${event.label} ===`);
    if (STAGE_FLOOR[event.stage] != null) setProgress(STAGE_FLOOR[event.stage]);
  } else if (event.kind === "progress") {
    const [lo, hi] = FRAMES_SPAN;
    setProgress(lo + event.fraction * (hi - lo));
  } else if (event.kind === "log") {
    appendLog(event.line);
  } else if (event.kind === "error") {
    $("stageLabel").textContent = `Error: ${event.message}`;
    appendLog(`ERROR: ${event.message}`);
    $("progressBar").classList.add("error");
    finishConvertModal();
  } else if (event.kind === "success") {
    $("stageLabel").textContent =
      `Done (${formatMB(event.romSize)}${event.large ? ", large ROM: not compatible with all devices" : ""}) ` +
      `— saved to ${event.outputPath}`;
    setProgress(100);
    finishConvertModal();
  }
});

$("btnConvert").addEventListener("click", async () => {
  if (!inputPath) {
    alert("Pick an input video first.");
    return;
  }
  if (probe && !probe.hasVideo) {
    alert("The selected file has no video stream.");
    return;
  }
  const suggested = ($("romTitle").value || "video").replace(/[^a-z0-9_-]+/gi, "_") + ".gba";
  const outputPath = await window.api.selectOutputFile(suggested);
  if (!outputPath) return;

  $("btnConvert").disabled = true;
  openConvertModal();

  await window.api.startConversion(collectOptions(outputPath));
});
