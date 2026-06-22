import { spawn } from "node:child_process";
import { existsSync, createReadStream } from "node:fs";
import { writeFile } from "node:fs/promises";
import fsExtra from "fs-extra";
import { join, resolve, parse as parsePath } from "node:path";
import crypto from "node:crypto";
import { config } from "./config.js";
import { logger } from "./logger.js";

const { ensureDir, readdir, remove, stat, move } = fsExtra;

const COMMON_ARGS = ["--ignore-config", "--no-warnings", "--no-playlist"]; // keep invocations deterministic
const AUDIO_OUTPUT_PRESETS = [
  { name: "Podcast", bitrateKbps: 48 },
  { name: "Low", bitrateKbps: 64 },
  { name: "Standard", bitrateKbps: 128 },
  { name: "High", bitrateKbps: 192 },
  { name: "Best", bitrateKbps: 256 },
];
const MAX_THUMBNAIL_BYTES = 8 * 1024 * 1024;

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
  const args = [...COMMON_ARGS];

  if (config.YT_DLP_JS_RUNTIME) {
    args.push("--js-runtimes", config.YT_DLP_JS_RUNTIME);
  }

  for (const component of config.YT_DLP_REMOTE_COMPONENTS) {
    args.push("--remote-components", component);
  }

  args.push(...config.YT_DLP_EXTRA_ARGS, ...additional);

  if (config.YT_DLP_COOKIES_PATH && existsSync(config.YT_DLP_COOKIES_PATH)) {
    args.push("--cookies", config.YT_DLP_COOKIES_PATH);
  }
  return args;
}

export async function getYtDlpVersion() {
  const { stdout } = await runYtDlp(["--version"]);
  return stdout.trim();
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

function cleanMetadataValue(value, maxLength = 4000) {
  if (!value) {
    return "";
  }
  return String(value)
    .replace(/\0/g, "")
    .replace(/\r\n/g, "\n")
    .trim()
    .slice(0, maxLength);
}

function selectThumbnailUrl(info) {
  if (info.thumbnail) {
    return info.thumbnail;
  }

  const thumbnails = Array.isArray(info.thumbnails) ? info.thumbnails : [];
  const sorted = thumbnails
    .filter((thumbnail) => thumbnail?.url)
    .sort((a, b) => ((b.width || 0) * (b.height || 0)) - ((a.width || 0) * (a.height || 0)));

  return sorted[0]?.url || null;
}

async function downloadThumbnail(url, outputPath) {
  if (!url || typeof fetch !== "function") {
    return false;
  }

  const response = await fetch(url, {
    signal: AbortSignal.timeout(15000),
  });

  if (!response.ok) {
    throw new Error(`Thumbnail request failed with status ${response.status}`);
  }

  const contentLength = Number(response.headers.get("content-length"));
  if (contentLength && contentLength > MAX_THUMBNAIL_BYTES) {
    throw new Error("Thumbnail exceeds size limit");
  }

  const arrayBuffer = await response.arrayBuffer();
  if (arrayBuffer.byteLength > MAX_THUMBNAIL_BYTES) {
    throw new Error("Thumbnail exceeds size limit");
  }

  await writeFile(outputPath, Buffer.from(arrayBuffer));
  return true;
}

async function createCoverImage(thumbnailUrl, workingDir) {
  if (!thumbnailUrl) {
    return null;
  }

  const thumbnailPath = join(workingDir, "thumbnail-source");
  const coverPath = join(workingDir, "cover.jpg");

  try {
    await downloadThumbnail(thumbnailUrl, thumbnailPath);
    await runCommand("ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-i",
      thumbnailPath,
      "-frames:v",
      "1",
      coverPath,
    ]);
    return coverPath;
  } catch (error) {
    logger.warn({ error: error.message }, "Failed to prepare MP3 cover art");
    return null;
  }
}

function classifyFormat(format) {
  if (format.meta?.vcodec === "none") {
    return "audio";
  }
  if (format.meta?.acodec === "none") {
    return "video";
  }

  const resolution = format.resolution.toLowerCase();
  const note = format.note.toLowerCase();
  const id = format.id.toLowerCase();

  if (resolution.includes("audio only") || note.includes("audio only") || id.includes("aud")) {
    return "audio";
  }

  return "video";
}

function isAllowedFormat(fmt, type) {
  const allowedExtensions = type === "audio"
    ? ["m4a", "mp3", "webm", "opus", "mp4", "ogg"]
    : ["mp4", "webm", "mkv"];

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
}

function normalizeLanguageCode(value) {
  if (!value || value === "und" || value === "unknown") {
    return null;
  }
  return String(value).trim().toLowerCase();
}

function createLanguageLabel(languageCode) {
  if (!languageCode) {
    return "Default / Original";
  }

  try {
    const displayNames = new Intl.DisplayNames(["en"], { type: "language" });
    const displayName = displayNames.of(languageCode);
    if (displayName && displayName.toLowerCase() !== languageCode) {
      return displayName;
    }
  } catch {
    // Fall back to the code when Intl cannot describe yt-dlp's language tag.
  }

  return languageCode.toUpperCase();
}

function getAudioLanguageId(format) {
  return normalizeLanguageCode(format.meta?.language) || "default";
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

function computeApproxSize(format) {
  return format.meta?.filesize ?? format.meta?.filesize_approx ?? parseSizeFromNote(format.note);
}

function createResolution(format) {
  if (format.vcodec === "none") {
    return "audio only";
  }
  if (format.resolution && format.resolution !== "audio only") {
    return format.resolution;
  }
  if (format.height) {
    return `${format.height}p`;
  }
  if (format.width && format.height) {
    return `${format.width}x${format.height}`;
  }
  return format.format_note || "video";
}

function createFormatNote(format) {
  return [
    format.format_note,
    format.language,
    format.acodec && format.acodec !== "none" ? `audio:${format.acodec}` : null,
    format.vcodec && format.vcodec !== "none" ? `video:${format.vcodec}` : null,
    format.abr ? `${Math.round(format.abr)}kbps` : null,
    format.tbr ? `${Math.round(format.tbr)}kbps` : null,
  ].filter(Boolean).join(" | ");
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

function createAudioLabel({ name, bitrateKbps, sizeBytes }) {
  const nameText = name ? `${name} ` : "";
  const bitrateText = bitrateKbps ? `${bitrateKbps} kbps` : "MP3";
  const sizeText = sizeBytes ? ` (~${formatBytes(sizeBytes)})` : "";
  return `${nameText}MP3 ${bitrateText}${sizeText}`.trim();
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
  const filtered = formats.filter((fmt) => isAllowedFormat(fmt, type));

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

function pickBestAudioSource(formats) {
  const audioFormats = formats
    .filter((fmt) => isAllowedFormat(fmt, "audio"))
    .sort((a, b) => {
      const bitrateA = a.meta?.abr || a.meta?.tbr || extractBitrateFromNote(a.note) || 0;
      const bitrateB = b.meta?.abr || b.meta?.tbr || extractBitrateFromNote(b.note) || 0;
      if (bitrateB !== bitrateA) {
        return bitrateB - bitrateA;
      }
      return (b.approxSize || 0) - (a.approxSize || 0);
    });

  return audioFormats[0] || null;
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
  const args = buildArgs("--dump-json", "--skip-download", "--ignore-no-formats-error", url);
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

  const info = await fetchInfo(url);

  const formats = (info.formats || [])
    .filter((format) => format.format_id && format.ext)
    .map((format) => {
      const entry = {
        id: format.format_id,
        extension: format.ext,
        resolution: createResolution(format),
        note: createFormatNote(format),
        raw: format.format || format.format_id,
        meta: format,
      };

      return {
        ...entry,
        approxSize: computeApproxSize(entry),
        type: classifyFormat(entry),
      };
    });

  logger.info(
    {
      url,
      formatCount: formats.length,
      audioLanguageCount: getAudioLanguages(formats).length,
    },
    "Listed available formats"
  );

  return {
    title: info.title,
    description: info.description || "",
    thumbnailUrl: selectThumbnailUrl(info),
    webpageUrl: info.webpage_url,
    durationSeconds: info.duration || null,
    formats,
  };
}

export function getFormatsByType(formats, type, options = {}) {
  const scopedFormats = type === "audio" && options.languageId
    ? formats.filter((format) => getAudioLanguageId(format) === options.languageId)
    : formats;
  return filterWellKnownFormats(scopedFormats, type, options);
}

export function getAudioQualityOptions(formats, { durationSeconds, languageId } = {}) {
  const scopedFormats = languageId
    ? formats.filter((format) => getAudioLanguageId(format) === languageId)
    : formats;
  const sourceFormat = pickBestAudioSource(scopedFormats);

  if (!sourceFormat) {
    return [];
  }

  return AUDIO_OUTPUT_PRESETS.map((preset) => {
    const estimatedSize = estimateAudioSize(durationSeconds, preset.bitrateKbps);
    return {
      ...sourceFormat,
      id: sourceFormat.id,
      sourceFormatId: sourceFormat.id,
      outputAudioBitrateKbps: preset.bitrateKbps,
      estimatedSizeBytes: estimatedSize || null,
      displayLabel: createAudioLabel({
        name: preset.name,
        bitrateKbps: preset.bitrateKbps,
        sizeBytes: estimatedSize,
      }),
      targetFileName: `${sourceFormat.id}-audio-${preset.bitrateKbps}k`,
    };
  });
}

export function getAudioLanguages(formats) {
  const groups = new Map();

  for (const format of formats) {
    if (!isAllowedFormat(format, "audio")) {
      continue;
    }

    const id = getAudioLanguageId(format);
    const existing = groups.get(id);
    groups.set(id, {
      id,
      label: createLanguageLabel(id === "default" ? null : id),
      count: (existing?.count || 0) + 1,
    });
  }

  return [...groups.values()].sort((a, b) => {
    if (a.id === "default") {
      return -1;
    }
    if (b.id === "default") {
      return 1;
    }
    return a.label.localeCompare(b.label);
  });
}

export async function downloadMedia({
  url,
  formatId,
  type,
  expectedTitle,
  onStatus,
  targetFileName,
  outputAudioBitrateKbps,
  description,
  thumbnailUrl,
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
  const safeBase = type === "audio" && outputAudioBitrateKbps
    ? baseTitle
    : sanitizeFileName(targetFileName || randomName);
  const finalExt = type === "audio" && outputAudioBitrateKbps ? ".mp3" : originalExt;
  const finalFileName = `${safeBase}${finalExt}`;
  const finalPath = join(workingDir, finalFileName);

  if (type === "audio" && outputAudioBitrateKbps) {
    onStatus?.(`Converting to MP3 ${outputAudioBitrateKbps} kbps...`);
    const coverPath = await createCoverImage(thumbnailUrl, workingDir);
    const ffmpegArgs = [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-i",
      downloadedPath,
    ];

    if (coverPath) {
      ffmpegArgs.push(
        "-i",
        coverPath,
        "-map",
        "1:v:0"
      );
    } else {
      ffmpegArgs.push("-vn");
    }

    ffmpegArgs.push(
      "-map",
      "0:a:0",
      "-codec:a",
      "libmp3lame",
      "-b:a",
      `${outputAudioBitrateKbps}k`,
      "-id3v2_version",
      "3",
      "-metadata",
      `title=${cleanMetadataValue(displayTitle, 255)}`
    );

    if (description) {
      ffmpegArgs.push("-metadata", `comment=${cleanMetadataValue(description)}`);
    }

    if (coverPath) {
      ffmpegArgs.push(
        "-codec:v",
        "mjpeg",
        "-disposition:v",
        "attached_pic",
        "-metadata:s:v",
        "title=Album cover",
        "-metadata:s:v",
        "comment=Cover (front)"
      );
    }

    ffmpegArgs.push(finalPath);

    await runCommand("ffmpeg", ffmpegArgs);
    await remove(downloadedPath);
  } else if (downloadedPath !== finalPath) {
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
