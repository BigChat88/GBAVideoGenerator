const $ = (id) => document.getElementById(id);

// Must match src/main/encoder/gba.ts
const VBLANK_HZ = 59.7275;
const RESOLUTIONS = [[96, 64], [120, 80], [144, 96], [168, 112], [192, 128], [216, 144], [240, 160]];
const FPS_STEPS = [6, 5, 4, 3, 2, 1]; // VBlanks per frame: 10, 12, 15, 20, 30, 60 fps
const MB = 1024 * 1024;
const MAX_ROM_SIZE = 32 * MB;
const MAX_LARGE_ROM_SIZE = 64 * MB;
const MAX_VIDEOS = 256;
// Typical LZ77 ratio on 8bpp frames, only used for the estimate
const LZ77_RATIO = 0.75;

// { path, name, duration|null, hasAudio, error|null }
let videos = [];
let playerSizes = { player: 12 * 1024, large: 0x42000 };
let lastOutputPath = null;

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

// --- video list ---

function renderVideoList() {
  const list = $("videoList");
  list.textContent = "";
  videos.forEach((v, i) => {
    const li = document.createElement("li");

    const index = document.createElement("span");
    index.className = "index";
    index.textContent = String(i + 1);

    const name = document.createElement("input");
    name.type = "text";
    name.maxLength = 31;
    name.value = v.name;
    name.title = v.path;
    name.addEventListener("input", () => {
      v.name = name.value;
    });
    name.addEventListener("change", () => {
      v.name = asciiName(name.value, 31) || "video";
      name.value = v.name;
    });

    const info = document.createElement("span");
    info.className = "info";
    if (v.error) {
      info.textContent = "unreadable";
      info.classList.add("warn");
      info.title = v.error;
    } else if (v.duration == null) {
      info.textContent = "...";
    } else {
      info.textContent = formatDuration(v.duration) + (v.hasAudio ? "" : " (silent)");
    }

    const buttons = document.createElement("span");
    buttons.className = "buttons";
    const mk = (label, title, disabled, onClick) => {
      const b = document.createElement("button");
      b.textContent = label;
      b.title = title;
      b.disabled = disabled;
      b.addEventListener("click", onClick);
      buttons.appendChild(b);
    };
    mk("↑", "Move up", i === 0, () => moveVideo(i, -1));
    mk("↓", "Move down", i === videos.length - 1, () => moveVideo(i, 1));
    mk("✕", "Remove", false, () => {
      videos.splice(i, 1);
      renderVideoList();
    });

    li.append(index, name, info, buttons);
    list.appendChild(li);
  });

  $("videoListHint").textContent =
    videos.length > 1
      ? `${videos.length} videos: the GBA shows a list menu (L/R switch videos, B back to the list).`
      : "Add one video, or several to get a list menu on the GBA (played in this order).";
  updateEstimate();
}

function moveVideo(i, delta) {
  const j = i + delta;
  if (j < 0 || j >= videos.length) return;
  [videos[i], videos[j]] = [videos[j], videos[i]];
  renderVideoList();
}

$("btnAddVideos").addEventListener("click", async () => {
  const paths = await window.api.selectInputFiles();
  if (!paths.length) return;
  const room = MAX_VIDEOS - videos.length;
  if (paths.length > room) alert(`A ROM holds at most ${MAX_VIDEOS} videos; only the first ${room} were added.`);
  const added = paths.slice(0, room).map((path) => ({
    path,
    name: asciiName(baseNameWithoutExt(path), 31) || "video",
    duration: null,
    hasAudio: true,
    error: null,
  }));
  if (videos.length === 0 && added.length) {
    $("romTitle").value = asciiName(added.length === 1 ? added[0].name : "Videos", 12);
  }
  videos.push(...added);
  renderVideoList();

  for (const v of added) {
    try {
      const info = await window.api.probeVideo(v.path);
      v.duration = info.duration;
      v.hasAudio = info.hasAudio;
      if (!info.hasVideo) v.error = "This file has no video stream.";
    } catch (err) {
      v.error = String(err.message || err);
    }
    renderVideoList();
  }
});

// --- size estimate ---

function updateSliders() {
  const [w, h] = currentResolution();
  $("resolutionValue").textContent = `${w}×${h}`;
  $("fpsValue").textContent = `${Math.round(VBLANK_HZ / currentVpf())} fps`;
  updateEstimate();
}

function updateEstimate() {
  const known = videos.filter((v) => v.duration != null && !v.error);
  if (!known.length) {
    $("sizeValue").textContent = "—";
    $("sizeFill").style.width = "0%";
    $("sizeBar").classList.remove("over");
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
  const seconds = known.reduce((n, v) => n + v.duration, 0);
  const base = playerSizes.player + 16 + 64 * videos.length;
  let total = base + seconds * bytesPerSec;
  const large = allowLarge && total > MAX_ROM_SIZE;
  if (large) total += playerSizes.large - playerSizes.player;

  const limit = allowLarge ? MAX_LARGE_ROM_SIZE : MAX_ROM_SIZE;
  const over = total > limit;
  $("sizeValue").textContent =
    `~${formatMB(total)} for ${formatDuration(seconds)}` + (compress ? " (rough, depends on the content)" : "");
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
    $("sizeNote").textContent = "Over 32 MB: this will be a large ROM that plays in mGBA only.";
  } else {
    $("sizeNote").textContent = `A GBA cartridge holds at most 32 MB${allowLarge ? " (64 MB for mGBA-only large ROMs)" : ""}.`;
  }
  $("sizeNote").classList.toggle("warn", over);
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
renderVideoList();

// --- conversion ---

function collectOptions(outputPath) {
  const [width, height] = currentResolution();
  return {
    videos: videos.map((v) => ({ path: v.path, name: asciiName(v.name, 31) || "video" })),
    outputPath,
    romTitle: $("romTitle").value || "My Video",
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
  $("btnMgba").hidden = true;
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

$("btnMgba").addEventListener("click", async () => {
  if (lastOutputPath) await window.api.openInMgba(lastOutputPath);
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
    lastOutputPath = event.outputPath;
    $("stageLabel").textContent =
      `Done (${formatMB(event.romSize)}${event.large ? ", large ROM: mGBA only" : ""}) — saved to ${event.outputPath}`;
    setProgress(100);
    $("btnMgba").hidden = false;
    finishConvertModal();
  }
});

$("btnConvert").addEventListener("click", async () => {
  if (!videos.length) {
    alert("Add at least one video first.");
    return;
  }
  const bad = videos.find((v) => v.error);
  if (bad) {
    alert(`"${bad.name}" can't be used: ${bad.error}\nRemove it from the list first.`);
    return;
  }
  const suggested = ($("romTitle").value || "video").replace(/[^a-z0-9_-]+/gi, "_") + ".gba";
  const outputPath = await window.api.selectOutputFile(suggested);
  if (!outputPath) return;

  $("btnConvert").disabled = true;
  openConvertModal();

  await window.api.startConversion(collectOptions(outputPath));
});
