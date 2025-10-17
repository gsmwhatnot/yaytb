import dotenv from "dotenv";
import { dirname, resolve } from "path";
import fsExtra from "fs-extra";
import { existsSync, mkdirSync } from "fs";
const { ensureDirSync } = fsExtra;

dotenv.config();

const requiredEnv = ["TELEGRAM_BOT_TOKEN", "AUTHORIZED_USER_IDS"];
requiredEnv.forEach((name) => {
  if (!process.env[name]) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
});

const parseIds = (value = "") =>
  value
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean)
    .map((id) => Number(id))
    .filter((id) => !Number.isNaN(id));

const parsePositiveInt = (value, fallback) => {
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
};

const parsePositiveNumber = (value, fallback) => {
  const parsed = Number(value);
  if (Number.isNaN(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
};

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const AUTHORIZED_USER_IDS = new Set(parseIds(process.env.AUTHORIZED_USER_IDS));

if (AUTHORIZED_USER_IDS.size === 0) {
  throw new Error("AUTHORIZED_USER_IDS must contain at least one Telegram user ID");
}

const YT_DLP_BINARY_PATH = process.env.YT_DLP_BINARY_PATH || "/opt/yt-dlp/yt-dlp";
const YT_DLP_COOKIES_PATH = process.env.YT_DLP_COOKIES_PATH || "/config/cookies.txt";

const MAX_CONCURRENT_DOWNLOADS = parsePositiveInt(
  process.env.MAX_CONCURRENT_DOWNLOADS,
  2
);

const MAX_FILE_SIZE_MB = parsePositiveNumber(process.env.MAX_FILE_SIZE_MB, 48);
const MAX_FILE_SIZE_BYTES = Math.round(MAX_FILE_SIZE_MB * 1024 * 1024);

const DOWNLOAD_TEMP_DIR = process.env.DOWNLOAD_TEMP_DIR || "/tmp/yttelbot";
ensureDirSync(DOWNLOAD_TEMP_DIR);

const LOG_FILE_PATH = process.env.LOG_FILE_PATH || "/usr/src/app/logs/app.log";
const logDir = dirname(resolve(LOG_FILE_PATH));
if (!existsSync(logDir)) {
  mkdirSync(logDir, { recursive: true });
}

const TELEGRAM_API_ROOT = (process.env.TELEGRAM_API_ROOT || "").replace(/\/+$/, "");
const TELEGRAM_API_ID = process.env.TELEGRAM_API_ID || "";
const TELEGRAM_API_HASH = process.env.TELEGRAM_API_HASH || "";

export const config = {
  TELEGRAM_BOT_TOKEN,
  AUTHORIZED_USER_IDS,
  YT_DLP_BINARY_PATH,
  YT_DLP_COOKIES_PATH,
  MAX_CONCURRENT_DOWNLOADS,
  MAX_FILE_SIZE_BYTES,
  MAX_FILE_SIZE_MB,
  DOWNLOAD_TEMP_DIR,
  LOG_FILE_PATH,
  TELEGRAM_API_ROOT,
  TELEGRAM_API_ID,
  TELEGRAM_API_HASH,
};
