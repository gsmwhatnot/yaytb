import { Telegraf, Markup } from "telegraf";
import { existsSync, statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { config } from "./config.js";
import { logger } from "./logger.js";
import { SessionStore } from "./session-store.js";
import { DownloadQueue } from "./queue.js";
import { getAudioLanguages, getAudioQualityOptions, getFormatsByType, getYtDlpVersion, listFormats, downloadMedia } from "./downloader.js";

const telegrafOptions = {};
if (config.TELEGRAM_API_ROOT) {
  telegrafOptions.telegram = {
    apiRoot: config.TELEGRAM_API_ROOT,
  };
}

const bot = new Telegraf(config.TELEGRAM_BOT_TOKEN, telegrafOptions);
const sessions = new SessionStore();
const queue = new DownloadQueue(config.MAX_CONCURRENT_DOWNLOADS);

if (config.TELEGRAM_API_ROOT) {
  logger.info({ apiRoot: config.TELEGRAM_API_ROOT }, "Using custom Telegram Bot API root");
}

const TELEGRAM_FILE_LIMIT_BYTES = config.MAX_FILE_SIZE_BYTES;

function isAbortError(error) {
  return error?.name === "AbortError";
}

function isAuthorized(userId) {
  if (config.AUTHORIZED_USER_IDS.size === 0) {
    return false;
  }
  return config.AUTHORIZED_USER_IDS.has(Number(userId));
}

function sanitizeUrl(text) {
  const urlRegex = /(https?:\/\/[^\s]+)/i;
  const match = text.match(urlRegex);
  return match ? match[1] : null;
}

function createStatusUpdater(chatId, messageId) {
  return async (text) => {
    try {
      await bot.telegram.editMessageText(chatId, messageId, undefined, text);
    } catch (error) {
      logger.debug({ chatId, messageId, text, error: error.message }, "Failed to update status message");
    }
  };
}

function logRequest(ctx, extra = {}) {
  logger.info({ userId: ctx.from?.id, chatId: ctx.chat?.id, ...extra }, "Incoming request");
}

function logUnauthorized(ctx) {
  logger.warn({ userId: ctx.from?.id, chatId: ctx.chat?.id }, "Unauthorized access attempt");
}

function buildFormatKeyboard(formats, type) {
  const buttons = formats.map((format, index) =>
    Markup.button.callback(format.displayLabel, `fmt:${type}:${index}`)
  );
  const rows = [];
  for (let i = 0; i < buttons.length; i += 2) {
    rows.push(buttons.slice(i, i + 2));
  }
  if (type === "audio") {
    rows.push([
      Markup.button.callback("Back", "back:audio-language"),
      Markup.button.callback("Cancel", "cancel"),
    ]);
  } else {
    rows.push([Markup.button.callback("Cancel", "cancel")]);
  }
  return Markup.inlineKeyboard(rows);
}

function buildLanguageKeyboard(languages) {
  const buttons = languages.map((language, index) => {
    const suffix = language.count > 1 ? ` (${language.count})` : "";
    return Markup.button.callback(`${language.label}${suffix}`, `lang:${index}`);
  });
  const rows = [];
  for (let i = 0; i < buttons.length; i += 2) {
    rows.push(buttons.slice(i, i + 2));
  }
  rows.push([Markup.button.callback("Cancel", "cancel")]);
  return Markup.inlineKeyboard(rows);
}

function formatDuration(seconds) {
  if (!seconds) {
    return null;
  }
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  }
  return `${minutes}:${String(secs).padStart(2, "0")}`;
}

function buildMediaSummary(session) {
  const title = session.title ? `Title: ${session.title}` : null;
  const duration = formatDuration(session.durationSeconds);
  return [title, duration ? `Duration: ${duration}` : null].filter(Boolean).join("\n");
}

async function deleteSessionMessages(ctx, session) {
  const chatId = ctx.chat.id;
  const messageIds = [
    session?.selectionMessageId,
    session?.languageMessageId,
    session?.formatMessageId,
  ].filter(Boolean);

  await Promise.all(messageIds.map((messageId) =>
    ctx.telegram.deleteMessage(chatId, messageId).catch(() => {})
  ));
}

async function cancelSession(ctx, { userId, notify = true } = {}) {
  const chatId = ctx.chat.id;
  const session = sessions.get(chatId);

  if (!session) {
    if (notify) {
      await ctx.reply("No active request to cancel.");
    }
    return false;
  }

  if (userId && session.userId !== userId) {
    return false;
  }

  await deleteSessionMessages(ctx, session);

  if (session.activeJob) {
    session.activeJob.cancelQueued?.();
    session.activeJob.controller?.abort();
    if (session.activeJob.statusMessageId) {
      await ctx.telegram.editMessageText(
        chatId,
        session.activeJob.statusMessageId,
        undefined,
        "Canceled."
      ).catch(() => {});
    }
  }

  sessions.delete(chatId);
  if (notify) {
    await ctx.reply("Canceled current request. Send a new link to start over.");
  }
  return true;
}

function getCookieStatus() {
  if (!config.YT_DLP_COOKIES_PATH) {
    return "disabled";
  }
  if (!existsSync(config.YT_DLP_COOKIES_PATH)) {
    return "missing";
  }
  try {
    const stats = statSync(config.YT_DLP_COOKIES_PATH);
    return stats.size > 0 ? "present" : "empty";
  } catch {
    return "unreadable";
  }
}

function isTelegramEntityTooLarge(error) {
  if (!error) {
    return false;
  }
  const code = error?.response?.error_code ?? error?.code;
  if (code === 413) {
    return true;
  }
  const description = error?.response?.description || error?.description || error?.message;
  return typeof description === "string" && description.toLowerCase().includes("request entity too large");
}

async function handleUnauthorized(ctx) {
  logUnauthorized(ctx);
}

bot.start(async (ctx) => {
  if (!isAuthorized(ctx.from?.id)) {
    await handleUnauthorized(ctx);
    return;
  }

  logRequest(ctx, { command: 'start' });

  await ctx.reply(
    "Send me a video or audio link (YouTube, Instagram, Facebook, etc.) and I'll fetch it for you."
  );
});

bot.help(async (ctx) => {
  if (!isAuthorized(ctx.from?.id)) {
    await handleUnauthorized(ctx);
    return;
  }

  logRequest(ctx, { command: 'help' });

  const helpText = [
    "Usage:",
    "1. Send a media link.",
    "2. Pick audio or video.",
    "3. For audio, choose the language.",
    "4. Choose a provided format.",
    "",
    "Commands:",
    "/status - Show queue and current request.",
    "/ytdlp - Show downloader diagnostics.",
    "/cancel - Stop the current request.",
    "I'll download, convert to MP3/MP4, and send it back.",
    `Files larger than ${config.MAX_FILE_SIZE_MB} MB are skipped.`,
  ].join("\n");

  await ctx.reply(helpText);
});

bot.command("cancel", async (ctx) => {
  if (!isAuthorized(ctx.from?.id)) {
    await handleUnauthorized(ctx);
    return;
  }

  logRequest(ctx, { command: 'cancel' });
  await cancelSession(ctx, { userId: ctx.from.id });
});

bot.command("status", async (ctx) => {
  if (!isAuthorized(ctx.from?.id)) {
    await handleUnauthorized(ctx);
    return;
  }

  const session = sessions.get(ctx.chat.id);
  const stats = queue.stats;
  const lines = [
    `Active downloads: ${stats.active}/${stats.concurrency}`,
    `Queued downloads: ${stats.queued}`,
  ];

  if (session) {
    lines.push(`Current request: ${session.stage || "waiting"}`);
    const summary = buildMediaSummary(session);
    if (summary) {
      lines.push(summary);
    }
  } else {
    lines.push("Current request: none");
  }

  await ctx.reply(lines.join("\n"));
});

bot.command("ytdlp", async (ctx) => {
  if (!isAuthorized(ctx.from?.id)) {
    await handleUnauthorized(ctx);
    return;
  }

  try {
    const version = await getYtDlpVersion();
    await ctx.reply([
      `yt-dlp: ${version}`,
      `Path: ${config.YT_DLP_BINARY_PATH}`,
      `JS runtime: ${config.YT_DLP_JS_RUNTIME || "default"}`,
      `Remote components: ${config.YT_DLP_REMOTE_COMPONENTS.join(", ") || "none"}`,
      `Extra args: ${config.YT_DLP_EXTRA_ARGS.join(" ") || "none"}`,
      `Cookies: ${getCookieStatus()}`,
    ].join("\n"));
  } catch (error) {
    logger.error({ error: error.message }, "Failed to inspect yt-dlp");
    await ctx.reply(`yt-dlp check failed: ${error.message}`);
  }
});

bot.on("text", async (ctx) => {
  if (!isAuthorized(ctx.from?.id)) {
    await handleUnauthorized(ctx);
    return;
  }

  logRequest(ctx, { message: 'text' });

  const existingSession = sessions.get(ctx.chat.id);
  if (existingSession) {
    if (existingSession.userId !== ctx.from.id) {
      await ctx.reply("Another user has an active request in this chat. Ask them to /cancel it first.");
      return;
    }
    await cancelSession(ctx, { userId: ctx.from.id, notify: false });
  }

  const url = sanitizeUrl(ctx.message.text);
  if (!url) {
    await ctx.reply("Please send a valid media URL.");
    return;
  }

  sessions.create(ctx.chat.id, {
    requestId: randomUUID(),
    stage: "choosing type",
    url,
    userId: ctx.from.id,
  });

  const selectionMessage = await ctx.reply(
    "What would you like to download?",
    Markup.inlineKeyboard([
      [Markup.button.callback("Audio", "type:audio"), Markup.button.callback("Video", "type:video")],
      [Markup.button.callback("Cancel", "cancel")],
    ])
  );

  sessions.update(ctx.chat.id, {
    selectionMessageId: selectionMessage.message_id,
    formatMessageId: null,
  });
});

bot.action(/^type:(audio|video)$/i, async (ctx) => {
  const chatId = ctx.chat.id;
  const userId = ctx.from?.id;
  if (!isAuthorized(userId)) {
    await ctx.answerCbQuery();
    await handleUnauthorized(ctx);
    return;
  }

  logRequest(ctx, { action: 'choose-type', chosenType: ctx.match[1] });

  const session = sessions.get(chatId);
  if (!session || session.userId !== userId) {
    await ctx.answerCbQuery("No active request. Send a link first.", { show_alert: true });
    return;
  }

  const type = ctx.match[1].toLowerCase();
  const requestId = session.requestId;
  const promptMessageId = ctx.callbackQuery?.message?.message_id;
  const selectionMessageId = session.selectionMessageId || promptMessageId;
  await ctx.answerCbQuery();

  if (selectionMessageId) {
    await ctx.telegram.deleteMessage(chatId, selectionMessageId).catch(() => {});
    sessions.update(chatId, { selectionMessageId: null });
  }

  const loadingMessage = await ctx.reply("Fetching available formats...");
  sessions.update(chatId, { stage: `fetching ${type} formats` });

  try {
    const { formats, title, description, thumbnailUrl, webpageUrl, durationSeconds } = await listFormats(session.url);
    const currentSession = sessions.get(chatId);
    if (!currentSession || currentSession.requestId !== requestId) {
      return;
    }

    if (type === "audio") {
      const languages = getAudioLanguages(formats);

      if (!languages.length) {
        await ctx.reply("No suitable audio formats found. Try another link.");
        return;
      }

      const summary = buildMediaSummary({ title, durationSeconds });
      const languageMessage = await ctx.reply(
        [summary, "Choose audio language:"].filter(Boolean).join("\n\n"),
        buildLanguageKeyboard(languages)
      );

      sessions.update(chatId, {
        type,
        stage: "choosing audio language",
        title,
        description,
        thumbnailUrl,
        webpageUrl,
        durationSeconds,
        sourceFormats: formats,
        audioLanguages: languages,
        languageMessageId: languageMessage.message_id,
        formatMessageId: null,
        selectionMessageId: null,
      });
      return;
    }

    const filtered = getFormatsByType(formats, type, { durationSeconds });

    if (!filtered.length) {
      await ctx.reply("No suitable formats found. Try another link or type.");
      return;
    }

    const promptText = type === "audio" ? "Choose an audio bitrate:" : "Choose a video quality:";
    const summary = buildMediaSummary({ title, durationSeconds });
    const formatMessage = await ctx.reply(
      [summary, promptText].filter(Boolean).join("\n\n"),
      buildFormatKeyboard(filtered, type)
    );

    sessions.update(chatId, {
      type,
      stage: "choosing video quality",
      title,
      description,
      thumbnailUrl,
      webpageUrl,
      durationSeconds,
      formats: filtered,
      formatMessageId: formatMessage.message_id,
      selectionMessageId: null,
    });
  } catch (error) {
    logger.error({ error: error.message, stack: error.stack }, "Failed to list formats");
    await ctx.reply("Could not retrieve formats. Please try again later.");
  } finally {
    try {
      await ctx.deleteMessage(loadingMessage.message_id);
    } catch (error) {
      logger.debug({ error: error.message }, "Failed to delete loading message");
    }
  }
});

bot.action(/^lang:(\d+)$/i, async (ctx) => {
  const chatId = ctx.chat.id;
  const userId = ctx.from?.id;
  if (!isAuthorized(userId)) {
    await ctx.answerCbQuery();
    await handleUnauthorized(ctx);
    return;
  }

  const session = sessions.get(chatId);
  if (!session || session.userId !== userId || session.type !== "audio") {
    await ctx.answerCbQuery("No active audio request. Send a link first.", { show_alert: true });
    return;
  }

  const index = Number.parseInt(ctx.match[1], 10);
  const selectedLanguage = session.audioLanguages?.[index];

  if (!selectedLanguage) {
    await ctx.answerCbQuery("Unknown language.", { show_alert: true });
    return;
  }

  await ctx.answerCbQuery(`Selected ${selectedLanguage.label}`);

  logRequest(ctx, {
    action: 'choose-audio-language',
    audioLanguageId: selectedLanguage.id,
    audioLanguageLabel: selectedLanguage.label,
  });

  const languageMessageId = session.languageMessageId || ctx.callbackQuery?.message?.message_id;
  if (languageMessageId) {
    await ctx.telegram.deleteMessage(chatId, languageMessageId).catch(() => {});
    sessions.update(chatId, { languageMessageId: null });
  }

  const filtered = getAudioQualityOptions(session.sourceFormats || [], {
    durationSeconds: session.durationSeconds,
    languageId: selectedLanguage.id,
  });

  if (!filtered.length) {
    await ctx.reply("No suitable formats found for that language. Try another link.");
    return;
  }

  const formatMessage = await ctx.reply(
    [buildMediaSummary(session), "Choose an audio bitrate:"].filter(Boolean).join("\n\n"),
    buildFormatKeyboard(filtered, "audio")
  );

  sessions.update(chatId, {
    selectedAudioLanguageId: selectedLanguage.id,
    selectedAudioLanguageLabel: selectedLanguage.label,
    stage: "choosing audio quality",
    formats: filtered,
    formatMessageId: formatMessage.message_id,
    languageMessageId: null,
  });
});

bot.action("back:audio-language", async (ctx) => {
  const chatId = ctx.chat.id;
  const userId = ctx.from?.id;
  if (!isAuthorized(userId)) {
    await ctx.answerCbQuery();
    await handleUnauthorized(ctx);
    return;
  }

  const session = sessions.get(chatId);
  if (!session || session.userId !== userId || session.type !== "audio" || !session.audioLanguages?.length) {
    await ctx.answerCbQuery("No active audio request.", { show_alert: true });
    return;
  }

  await ctx.answerCbQuery();

  const formatMessageId = session.formatMessageId || ctx.callbackQuery?.message?.message_id;
  if (formatMessageId) {
    await ctx.telegram.deleteMessage(chatId, formatMessageId).catch(() => {});
  }

  const languageMessage = await ctx.reply(
    [buildMediaSummary(session), "Choose audio language:"].filter(Boolean).join("\n\n"),
    buildLanguageKeyboard(session.audioLanguages)
  );

  sessions.update(chatId, {
    stage: "choosing audio language",
    selectedAudioLanguageId: null,
    selectedAudioLanguageLabel: null,
    formats: null,
    formatMessageId: null,
    languageMessageId: languageMessage.message_id,
  });
});


bot.action(/^fmt:(audio|video):(\d+)$/i, async (ctx) => {
  const chatId = ctx.chat.id;
  const userId = ctx.from?.id;
  if (!isAuthorized(userId)) {
    await ctx.answerCbQuery();
    await handleUnauthorized(ctx);
    return;
  }

  const session = sessions.get(chatId);
  if (!session || session.userId !== userId) {
    await ctx.answerCbQuery("Request expired. Send the link again.", { show_alert: true });
    return;
  }

  const type = ctx.match[1].toLowerCase();
  const index = Number.parseInt(ctx.match[2], 10);
  const selectedFormat = session.formats?.[index];
  const requestId = session.requestId;

  if (!selectedFormat) {
    await ctx.answerCbQuery("Unknown format.", { show_alert: true });
    return;
  }

  await ctx.answerCbQuery('Selected ' + selectedFormat.displayLabel);

  logRequest(ctx, {
    action: 'choose-format',
    formatId: selectedFormat.id,
    formatLabel: selectedFormat.displayLabel,
    outputAudioBitrateKbps: selectedFormat.outputAudioBitrateKbps,
  });

  if (session.formatMessageId) {
    await ctx.telegram.deleteMessage(chatId, session.formatMessageId).catch(() => {});
    sessions.update(chatId, { formatMessageId: null });
  }

  sessions.update(chatId, { title: session.title });

  const estimatedSize = selectedFormat.estimatedSizeBytes || selectedFormat.approxSize || null;
  if (estimatedSize && estimatedSize > TELEGRAM_FILE_LIMIT_BYTES) {
    await ctx.reply(
      'Selected option is larger than ' + config.MAX_FILE_SIZE_MB + ' MB. Please pick a smaller choice.'
    );
    const currentFormats = session.formats || [];
    if (currentFormats.length) {
      const promptText = type === 'audio' ? 'Pick a smaller audio bitrate:' : 'Pick a smaller video quality:';
      const retryMessage = await ctx.reply(promptText, buildFormatKeyboard(currentFormats, type));
      sessions.update(chatId, { formatMessageId: retryMessage.message_id });
    }
    return;
  }

  const statusMessage = await ctx.reply('Queued...');
  const updateStatus = createStatusUpdater(chatId, statusMessage.message_id);
  const controller = new AbortController();

  const job = queue.enqueue(async () => {
    if (controller.signal.aborted) {
      return { success: false, reason: "canceled" };
    }

    sessions.update(chatId, {
      stage: type === "audio" ? "downloading audio" : "downloading video",
    });
    await updateStatus('Preparing download...');

    let download;

    try {
      download = await downloadMedia({
        url: session.url,
        formatId: selectedFormat.id,
        type,
        expectedTitle: session.title,
        onStatus: async (text) => {
          await updateStatus(text);
        },
        targetFileName: selectedFormat.targetFileName,
        outputAudioBitrateKbps: selectedFormat.outputAudioBitrateKbps,
        description: session.description,
        thumbnailUrl: session.thumbnailUrl,
        signal: controller.signal,
      });

      if (download.size > TELEGRAM_FILE_LIMIT_BYTES) {
        logger.warn(
          { size: download.size, limit: TELEGRAM_FILE_LIMIT_BYTES, chatId, formatId: selectedFormat.id },
          'Downloaded file exceeds configured size limit'
        );
        await updateStatus('Download complete, but file exceeds size limit. Please pick a smaller option.');
        return { success: false, reason: 'file-too-large', keepSession: true };
      }

      await updateStatus('Uploading...');

      try {
        if (type === 'audio') {
          const lowerFile = download.fileName.toLowerCase();
          const isMp3 = lowerFile.endsWith('.mp3');
          const isM4a = lowerFile.endsWith('.m4a');

          if (isMp3 || isM4a) {
            await ctx.telegram.sendAudio(
              chatId,
              { source: download.stream(), filename: download.fileName },
              {
                title: download.title,
              }
            );
          } else {
            await ctx.telegram.sendDocument(
              chatId,
              { source: download.stream(), filename: download.fileName },
              {
                caption: download.title,
              }
            );
          }
        } else {
          await ctx.telegram.sendVideo(
            chatId,
            { source: download.stream() },
            {
              caption: download.title,
              supports_streaming: true,
            }
          );
        }
      } catch (error) {
        if (isTelegramEntityTooLarge(error)) {
          logger.warn(
            { error: error.message, chatId, size: download.size },
            'Telegram rejected upload: entity too large'
          );
          await updateStatus('Telegram rejected the upload because it exceeds their file size limit. Please choose a smaller format.');
          return { success: false, reason: 'telegram-file-too-large', keepSession: true };
        }
        throw error;
      }

      await updateStatus('Done ✅');
      return { success: true };
    } finally {
      if (download) {
        try {
          await download.cleanup();
        } catch (cleanupError) {
          logger.warn(
            { error: cleanupError.message },
            'Failed to delete temporary download directory'
          );
        }
      }
    }
  });

  sessions.update(chatId, {
    stage: job.position > 0 ? `queued #${job.position}` : "queued",
    activeJob: {
      requestId,
      controller,
      cancelQueued: job.cancel,
      statusMessageId: statusMessage.message_id,
    },
  });

  if (job.position > 0) {
    await updateStatus('Queued (#' + job.position + '). Waiting for your turn...');
  }

  job.promise
    .then(async (result) => {
      const currentSession = sessions.get(chatId);
      if (!currentSession || currentSession.requestId !== requestId) {
        return;
      }

      if (result?.reason === "canceled") {
        sessions.delete(chatId);
        return;
      }

      if (result?.success) {
        sessions.delete(chatId);
        setTimeout(() => {
          ctx.telegram.deleteMessage(chatId, statusMessage.message_id).catch((error) => {
            logger.debug({ error: error.message }, 'Failed to delete status message');
          });
        }, 15000);
        return;
      }

      if (result?.keepSession) {
        if (currentSession?.formats?.length) {
          const promptText = type === 'audio' ? 'Choose another audio bitrate:' : 'Choose another video quality:';
          const retryMessage = await ctx.reply(promptText, buildFormatKeyboard(currentSession.formats, type));
          sessions.update(chatId, {
            activeJob: null,
            stage: type === "audio" ? "choosing audio quality" : "choosing video quality",
            formatMessageId: retryMessage.message_id,
          });
        }
        return;
      }

      sessions.delete(chatId);
    })
    .catch(async (error) => {
      const currentSession = sessions.get(chatId);
      if (!currentSession || currentSession.requestId !== requestId) {
        return;
      }

      if (isAbortError(error)) {
        logger.info({ chatId, requestId }, 'Download job canceled');
        sessions.delete(chatId);
        await updateStatus('Canceled.');
        return;
      }

      logger.error({ error: error.message, stack: error.stack }, 'Download job failed');
      sessions.update(chatId, { activeJob: null, stage: "failed" });
      await updateStatus('Failed. Please try another format or send a new link.');
    });
});

bot.action("cancel", async (ctx) => {
  const userId = ctx.from?.id;
  if (!isAuthorized(userId)) {
    await ctx.answerCbQuery();
    await handleUnauthorized(ctx);
    return;
  }

  const canceled = await cancelSession(ctx, { userId, notify: false });
  if (!canceled) {
    await ctx.answerCbQuery("This is not your active request.", { show_alert: true });
    return;
  }

  await ctx.answerCbQuery("Canceled");
  await ctx.reply("Canceled. Send a new link whenever you're ready.");
});

bot.catch((error, ctx) => {
  logger.error({ error: error.message, stack: error.stack }, "Bot encountered an error");
  ctx.reply?.("Something went wrong. Please try again later.");
});

bot.launch().then(async () => {
  logger.info("Telegram bot started");
  try {
    const ytDlpVersion = await getYtDlpVersion();
    logger.info(
      {
        path: config.YT_DLP_BINARY_PATH,
        version: ytDlpVersion,
        jsRuntime: config.YT_DLP_JS_RUNTIME || undefined,
        remoteComponents: config.YT_DLP_REMOTE_COMPONENTS,
        extraArgs: config.YT_DLP_EXTRA_ARGS,
        cookies: getCookieStatus(),
      },
      "yt-dlp ready"
    );
    const cookieStatus = getCookieStatus();
    if (cookieStatus !== "present") {
      logger.warn(
        { path: config.YT_DLP_COOKIES_PATH, status: cookieStatus },
        "yt-dlp cookies are not ready"
      );
    }
  } catch (error) {
    logger.error(
      {
        path: config.YT_DLP_BINARY_PATH,
        error: error.message,
      },
      "yt-dlp startup check failed"
    );
  }
});

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
