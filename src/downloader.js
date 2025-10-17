import { spawn } from "node:child_process";
import { existsSync, createReadStream } from "node:fs";
import fsExtra from "fs-extra";
import { join, resolve, parse as parsePath } from "node:path";
import crypto from "node:crypto";
import { config } from "./config.js";
import { logger } from "./logger.js";

const { ensureDir, readdir, remove, stat, move } = fsExtra;

const COMMON_ARGS = ["--ignore-config", "--no-warnings", "--no-playlist"]; // keep invocations deterministic

function runCommand(command, args, { onStdout, onStderr } = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (data) => {
      const textChunk = data.toString();
      stdout += textChunk;
      onStdout?.(textChunk);
    });

    child.stderr.on("data", (data) => {
      const textChunk = data.toString();
      stderr += textChunk;
      onStderr?.(textChunk);
    });

    child.on("error", (error) => {
      rejectPromise(error);
    });

    child.on("close", (code) => {
      if (code !== 0) {
        const error = new Error(`${command} exited with code ${code}`);
        error.stdout = stdout;
        error.stderr = stderr;
        logger.error(
          {
            command,
            args,
            code,
            stdout: stdout.trim() || undefined,
            stderr: stderr.trim() || undefined,
          },
          "External command failed"
        );
        rejectPromise(error);
      } else {
        resolvePromise({ stdout, stderr });
      }
    });
  });
}

function runYtDlp(args, hooks) {
  if (!existsSync(config.YT_DLP_BINARY_PATH)) {
    const error = new Error(`yt-dlp binary not found at ${config.YT_DLP_BINARY_PATH}`);
    logger.error({ path: config.YT_DLP_BINARY_PATH }, error.message);
    throw error;
  }
  return runCommand(config.YT_DLP_BINARY_PATH, args, hooks);
}

function buildArgs(...additional) {
  const args = [...COMMON_ARGS, ...additional];
  if (config.YT_DLP_COOKIES_PATH && existsSync(config.YT_DLP_COOKIES_PATH)) {
    args.push("--cookies", config.YT_DLP_COOKIES_PATH);
  }
  return args;
}

function sanitizeFileName(name) {
  if (!name) {
    return "output";
  }
  return name
    .replace(/[\\/:*?"<>|]+/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180) || "output";
}

function parseFormatList(output) {
  const lines = output.split(/\r?\n/);
  const results = [];

  for (const line of lines) {
    if (!line || !line.trim()) {
      continue;
    }

    const trimmed = line.trimEnd();
    if (/^[-=]+$/.test(trimmed) || /^(id|format)\b/i.test(trimmed)) {
      continue;
    }

    const segments = trimmed.split("|").map((segment) => segment.trim());
    const left = segments.shift();
    if (!left) {
      continue;
    }

    const parts = left.split(/\s+/).filter(Boolean);
    if (parts.length < 2) {
      continue;
    }

    const formatId = parts.shift();
    if (!formatId || /(pass)/i.test(trimmed)) {
      continue;
    }

    const extension = parts.shift() || "";
    const resolution = parts.join(" ").trim();
    const note = segments.filter(Boolean).join(" | ");

    results.push({
      id: formatId,
      extension,
      resolution,
      note,
      raw: trimmed,
    });
  }

  return results;
}

function classifyFormat(entry) {
  const resolution = entry.resolution.toLowerCase();
  const note = entry.note.toLowerCase();
  const id = entry.id.toLowerCase();

  if (resolution.includes("audio only") || note.includes("audio only") || id.includes("aud")) {
    return "audio";
  }
  return "video";
}

function parseSizeFromNote(note) {
  const sizeMatch = note.match(/(~?)(\d+(?:\.\d+)?)\s*(KiB|MiB|GiB|KB|MB|GB)/i);
  if (!sizeMatch) {
    return null;
  }
  const value = Number.parseFloat(sizeMatch[2]);
  const unit = sizeMatch[3].toUpperCase();
  const base = unit.includes("I") ? 1024 : 1000;
  const power = unit.startsWith("K") ? 1 : unit.startsWith("M") ? 2 : 3;
  return Math.round(value * base ** power);
}

function formatBytes(bytes) {
  if (!bytes || Number.isNaN(bytes)) {
    return null;
  }
  const units = ["B", "KB", "MB", "GB", "TB"];
  let index = 0;
  let value = bytes;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(value >= 10 || index === 0 ? 0 : 1)}${units[index]}`;
}

function computeApproxSize(formatEntry, formatMap) {
  const parts = formatEntry.id.split("+");
  let total = 0;
  let hasSize = false;
  for (const part of parts) {
    const info = formatMap.get(part);
    if (info) {
      const sizeCandidate = info.filesize ?? info.filesize_approx;
      if (sizeCandidate) {
        total += sizeCandidate;
        hasSize = true;
      }
    }
  }
  if (hasSize) {
    return total;
  }
  return parseSizeFromNote(formatEntry.note);
}

function parseResolutionHeight(value) {
  const match = value?.match(/(\d{3,4})[pP]/);
  if (match) {
    return Number.parseInt(match[1], 10);
  }
  const resMatch = value?.match(/\b(\d{3,4})x(\d{3,4})\b/);
  if (resMatch) {
    return Number.parseInt(resMatch[2], 10);
  }
  return 0;
}


function extractBitrateFromNote(note) {
  const match = note.match(/(\d{2,4})\s*(?:kbps|kb|k\b)/i);
  if (match) {
    return Number.parseInt(match[1], 10);
  }
  return null;
}

function nearestAudioBitrate(kbps) {
  if (!kbps) {
    return null;
  }
  const presets = [64, 96, 128, 160, 192, 224, 256, 320];
  return presets.reduce((previous, current) => (
    Math.abs(current - kbps) < Math.abs(previous - kbps) ? current : previous
  ));
}

function estimateAudioSize(durationSeconds, bitrateKbps) {
  if (!durationSeconds || !bitrateKbps) {
    return null;
  }
  return Math.round((durationSeconds * bitrateKbps * 1000) / 8);
}

function determineAudioBitrateKbps(format) {
  const raw = format.meta?.abr || format.meta?.tbr || extractBitrateFromNote(format.note);
  if (!raw) {
    return null;
  }
  return nearestAudioBitrate(Math.round(raw));
}

function createAudioLabel({ bitrateKbps, sizeBytes }) {
  const bitrateText = bitrateKbps ? `${bitrateKbps} kbps` : "MP3";
  const sizeText = sizeBytes ? ` (~${formatBytes(sizeBytes)})` : "";
  return `MP3 ${bitrateText}${sizeText}`.trim();
}

function createVideoLabel({ height, sizeBytes }) {
  const quality = height ? `${height}p` : "Video";
  const sizeText = sizeBytes ? ` (~${formatBytes(sizeBytes)})` : "";
  return ('MP4 ' + quality + sizeText).trim();
}

function preferenceScore(format, type) {
  const note = format.note.toLowerCase();
  let score = 0;

  if (note.includes("default") || note.includes("original")) {
    score += 10;
  }

  if (/(english|\ben\b|en-us|en-gb)/.test(note)) {
    score += 5;
  }

  if (type === "audio") {
    score += Math.min((format.approxSize || 0) / (5 * 1024 * 1024), 5);
  } else {
    score += Math.min(parseResolutionHeight(format.resolution) / 200, 5);
  }

  return score;
}

function filterWellKnownFormats(formats, type, { durationSeconds } = {}) {
  const allowedExtensions = type === "audio"
    ? ["m4a", "mp3", "webm", "opus", "mp4", "ogg"]
    : ["mp4", "webm", "mkv"];

  const filtered = formats.filter((fmt) => {
    if (fmt.type !== type) {
      return false;
    }
    if (!allowedExtensions.includes(fmt.extension.toLowerCase())) {
      return false;
    }
    if (type === "video") {
      const lowerNote = fmt.note.toLowerCase();
      if (lowerNote.includes("video only") && !fmt.id.includes("+")) {
        return false;
      }
    }
    return true;
  });

  if (type === "audio") {
    filtered.sort((a, b) => (b.meta?.abr || b.meta?.tbr || b.approxSize || 0) - (a.meta?.abr || a.meta?.tbr || a.approxSize || 0));
  } else {
    filtered.sort((a, b) => parseResolutionHeight(b.resolution) - parseResolutionHeight(a.resolution));
  }

  const deduped = [];
  const keyToIndex = new Map();

  for (const fmt of filtered) {
    const bitrateKey = determineAudioBitrateKbps(fmt);
    const key = type === "audio" ? `audio-${bitrateKey || fmt.id}` : fmt.resolution || fmt.id;
    if (!keyToIndex.has(key)) {
      keyToIndex.set(key, deduped.length);
      deduped.push(fmt);
      continue;
    }

    const idxExisting = keyToIndex.get(key);
    const existing = deduped[idxExisting];
    const candidateScore = preferenceScore(fmt, type);
    const existingScore = preferenceScore(existing, type);

    if (candidateScore > existingScore || (
      candidateScore === existingScore && (fmt.approxSize || 0) > (existing.approxSize || 0)
    )) {
      deduped[idxExisting] = fmt;
    }
  }

  return deduped.slice(0, 6).map((fmt) => {
    if (type === "audio") {
      const bitrateKbps = determineAudioBitrateKbps(fmt) || 192;
      const estimatedSize = estimateAudioSize(durationSeconds, bitrateKbps) || fmt.approxSize;
      return {
        ...fmt,
        estimatedSizeBytes: estimatedSize || null,
        displayLabel: createAudioLabel({ bitrateKbps, sizeBytes: estimatedSize || fmt.approxSize }),
        targetFileName: `${fmt.id}-audio`,
      };
    }

    const height = parseResolutionHeight(fmt.resolution) || fmt.meta?.height || 0;
    return {
      ...fmt,
      estimatedSizeBytes: fmt.approxSize || null,
      displayLabel: createVideoLabel({ height: height || null, sizeBytes: fmt.approxSize }),
      targetFileName: `${fmt.id}-video`,
    };
  });
}

function pickDownloadedFile(files) {
  return files.find((file) => {
    if (file.startsWith(".")) {
      return false;
    }
    const lower = file.toLowerCase();
    return !lower.endsWith(".part") && !lower.endsWith(".ytdl") && !lower.endsWith(".info.json");
  });
}

async function fetchInfo(url) {
  const args = buildArgs("--dump-json", "--skip-download", url);
  const { stdout } = await runYtDlp(args);
  const line = stdout
    .split(/\r?\n/)
    .map((str) => str.trim())
    .filter(Boolean)[0];
  if (!line) {
    throw new Error("Unable to parse yt-dlp metadata output");
  }
  return JSON.parse(line);
}

export async function listFormats(url) {
  logger.info({ url }, "Listing available formats");

  const listArgs = buildArgs("--list-formats", url);

  const [{ stdout: listOutput }, info] = await Promise.all([
    runYtDlp(listArgs),
    fetchInfo(url),
  ]);

  const parsed = parseFormatList(listOutput);
  const formatMap = new Map();
  info.formats?.forEach((fmt) => {
    if (fmt.format_id) {
      formatMap.set(fmt.format_id, fmt);
    }
  });

  const formats = parsed.map((entry) => {
    const approxSize = computeApproxSize(entry, formatMap);
    const meta = formatMap.get(entry.id) || null;
    return {
      id: entry.id,
      extension: entry.extension,
      resolution: entry.resolution,
      note: entry.note,
      approxSize,
      type: classifyFormat(entry),
      raw: entry.raw,
      meta,
    };
  });

  return {
    title: info.title,
    webpageUrl: info.webpage_url,
    durationSeconds: info.duration || null,
    formats,
  };
}

export function getFormatsByType(formats, type, options = {}) {
  return filterWellKnownFormats(formats, type, options);
}

export async function downloadMedia({
  url,
  formatId,
  type,
  expectedTitle,
  onStatus,
  targetFileName,
}) {
  const jobId = crypto.randomUUID();
  const workingDir = resolve(config.DOWNLOAD_TEMP_DIR, jobId);
  await ensureDir(workingDir);

  const outputTemplate = join(workingDir, "%(id)s.%(ext)s");

  const args = buildArgs(
    "--no-progress",
    "--output",
    outputTemplate,
    "-f",
    formatId,
    url
  );

  onStatus?.("Downloading source...");
  await runYtDlp(args);

  const files = await readdir(workingDir);
  const downloadedFile = pickDownloadedFile(files);
  if (!downloadedFile) {
    throw new Error("Downloaded file not found");
  }

  const downloadedPath = join(workingDir, downloadedFile);
  const baseTitle = sanitizeFileName(expectedTitle || parsePath(downloadedFile).name);
  const displayTitle = expectedTitle || baseTitle;
  const originalExt = parsePath(downloadedFile).ext || (type === "audio" ? ".mp3" : ".mp4");
  const randomName = crypto.randomUUID();
  const safeBase = sanitizeFileName(targetFileName || randomName);
  const finalFileName = `${safeBase}${originalExt}`;
  const finalPath = join(workingDir, finalFileName);

  if (downloadedPath !== finalPath) {
    await move(downloadedPath, finalPath, { overwrite: true });
  }

  const fileStats = await stat(finalPath);

  const cleanup = async () => {
    await remove(workingDir);
  };

  return {
    filePath: finalPath,
    fileName: finalFileName,
    title: displayTitle,
    size: fileStats.size,
    stream: () => createReadStream(finalPath),
    cleanup,
  };
}
