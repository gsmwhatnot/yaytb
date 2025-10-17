# YTTelBot

Telegram bot for downloading media (YouTube, Instagram, Facebook, etc.) via `yt-dlp`, repackaged into MP3 or MP4 and delivered back to the chat.

## Features
- Runs on Node.js 22 inside Docker.
- Authorizes usage based on an allowlist of Telegram user IDs.
- Inline keyboards auto-dismiss after each tap, and format buttons use friendly labels such as “MP3 128 kbps (~25MB)” or “MP4 1080p (~300MB)”.
- Download queue with live status updates (Queued → Downloading → Uploading → Done).
- Grabs the exact format selected via `yt-dlp` and ships it straight to Telegram without extra transcoding.
- Optional local Bot API gateway lifts Telegram’s upload ceiling to 2 GB.
- Persists logs, `yt-dlp` binary, and `cookies.txt` via bind-mounted volumes.
- Automatically cleans temporary download directories after each transfer.

## Prerequisites
- Docker & Docker Compose
- `yt-dlp` executable (ELF) placed in `./volumes/yt-dlp/yt-dlp` and marked executable.
- Netscape-format `cookies.txt` placed at `./volumes/cookies.txt` (may be empty if you do not need authenticated downloads).
- Telegram API credentials (`api_id` + `api_hash`) from [my.telegram.org](https://my.telegram.org) when running the optional local Bot API server.

## Configuration
Copy `.env.example` to `.env` and fill in the values:

| Variable | Description |
| --- | --- |
| `TELEGRAM_BOT_TOKEN` | Bot token from BotFather. |
| `AUTHORIZED_USER_IDS` | Comma-separated Telegram user IDs allowed to use the bot. |
| `YT_DLP_BINARY_PATH` | Path to the mounted `yt-dlp` binary inside the container (default `/opt/yt-dlp/yt-dlp`). |
| `YT_DLP_COOKIES_PATH` | Path to the mounted `cookies.txt` inside the container. |
| `LOG_FILE_PATH` | Location for the structured log file (default `/usr/src/app/logs/app.log`). |
| `MAX_CONCURRENT_DOWNLOADS` | Queue concurrency (default `2`). |
| `MAX_FILE_SIZE_MB` | Maximum file size allowed to be uploaded. Defaults to `1900` (just under Telegram’s 2 GB limit when using the local gateway). Reduce this value if you rely on the public Bot API. |
| `DOWNLOAD_TEMP_DIR` | Directory for temporary downloads inside the container. |
| `TELEGRAM_API_ROOT` | Optional override for the Telegram Bot API base URL (set to `http://telegram-bot-api:8081` to use the local gateway). |
| `TELEGRAM_API_ID` | Required by the local Bot API server – your Telegram API ID. |
| `TELEGRAM_API_HASH` | Required by the local Bot API server – your Telegram API hash. |

Adjust the docker-compose volume mounts if you change any of the file paths.

## Running with Docker Compose
```bash
cp .env.example .env
# edit .env accordingly
chmod +x volumes/yt-dlp/yt-dlp   # ensure the binary is executable

docker compose up --build
```

The bot uses long polling by default. Logs are streamed both to stdout and to `logs/app.log` (bind-mounted by default).

## Local Bot API Gateway
The compose stack spins up `ghcr.io/bots-house/docker-telegram-bot-api`, configured with `--local`, so all API calls and uploads stay inside your network. This lifts Telegram’s standard 50 MB limit and lets the bot upload files up to 2 GB.

1. Obtain `TELEGRAM_API_ID` and `TELEGRAM_API_HASH` from [my.telegram.org](https://my.telegram.org) and place them in `.env`.
2. Keep `TELEGRAM_API_ROOT` pointing at `http://telegram-bot-api:8081` (default in `.env.example`).
3. The Bot API container persists its cache under the named volume `telegram-bot-server-data`.
4. The bot waits until the Bot API server passes its health check before starting.
5. Keep `MAX_FILE_SIZE_MB` at or below the actual limit you want to enforce (1900 MB ≈ 1.9 GB).

If you prefer Telegram’s hosted Bot API, leave `TELEGRAM_API_ROOT` empty and remove or disable the `telegram-bot-api` service from the compose file. In that mode you should lower `MAX_FILE_SIZE_MB` to around 48 MB to track Telegram’s cloud limit.

## Bot Usage
1. Send a supported media URL from an authorized Telegram account.
2. Choose whether you want audio (MP3) or video (MP4). The bot removes the prompt right away so double taps do not queue extra jobs.
3. Pick one of the suggested formats. Audio options surface common bitrates (64/96/128/192/256/320 kbps) and video options show resolutions like 720p or 1080p along with size hints.
4. Watch the status updates: the bot downloads the chosen stream and uploads it back named after the source title.
5. If the final file would exceed `MAX_FILE_SIZE_MB` or Telegram rejects the upload, the bot keeps the session open and re-shows the format options so you can choose a smaller variant.

Use `/help` in chat for a quick recap or `/cancel` to abort the current request.

## Cleanup & Storage
- Temporary files live under `DOWNLOAD_TEMP_DIR` and are deleted after every job.
- Persistent files:
  - `logs/app.log` – structured JSON logs.
  - `volumes/yt-dlp/yt-dlp` – mounted `yt-dlp` binary.
  - `volumes/cookies.txt` – authentication cookies for `yt-dlp`.
  - `telegram-bot-server-data` – Bot API cache (format manifests, uploaded files, etc.).

## Development
Install dependencies locally for linting or inspection:
```bash
npm install
```

Run the bot (requires environment variables set locally):
```bash
node src/index.js
```

Remember to keep `yt-dlp`, `cookies.txt`, and (optionally) the Bot API server reachable at the paths declared in your `.env`.
