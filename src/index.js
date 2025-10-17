import { Telegraf, Markup } from "telegraf";
import { config } from "./config.js";
import { logger } from "./logger.js";
import { SessionStore } from "./session-store.js";
import { DownloadQueue } from "./queue.js";
import { getFormatsByType, listFormats, downloadMedia } from "./downloader.js";

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

function buildFormatKeyboard(formats, type) {
  const buttons = formats.map((format, index) =>
    Markup.button.callback(format.displayLabel, `fmt:${type}:${index}`)
  );
  const rows = [];
  for (let i = 0; i < buttons.length; i += 2) {
    rows.push(buttons.slice(i, i + 2));
  }
  rows.push([Markup.button.callback("Cancel", "cancel")]);
  return Markup.inlineKeyboard(rows);
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
  logger.warn({ userId: ctx.from?.id }, "Unauthorized access attempt");
  if (ctx.chat?.type !== "private") {
    return;
  }
  await ctx.reply("You are not allowed to use this bot.");
}

bot.start(async (ctx) => {
  if (!isAuthorized(ctx.from?.id)) {
    await handleUnauthorized(ctx);
    return;
  }

  await ctx.reply(
    "Send me a video or audio link (YouTube, Instagram, Facebook, etc.) and I'll fetch it for you."
  );
});

bot.help(async (ctx) => {
  if (!isAuthorized(ctx.from?.id)) {
    await handleUnauthorized(ctx);
    return;
  }

  const helpText = [
    "Usage:",
    "1. Send a media link.",
    "2. Pick audio or video.",
    "3. Choose a provided format.",
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

  sessions.delete(ctx.chat.id);
  await ctx.reply("Canceled current request. Send a new link to start over.");
});

bot.on("text", async (ctx) => {
  if (!isAuthorized(ctx.from?.id)) {
    await handleUnauthorized(ctx);
    return;
  }

  const existingSession = sessions.get(ctx.chat.id);
  if (existingSession) {
    if (existingSession.formatMessageId) {
      await ctx.telegram.deleteMessage(ctx.chat.id, existingSession.formatMessageId).catch(() => {});
    }
    if (existingSession.selectionMessageId) {
      await ctx.telegram.deleteMessage(ctx.chat.id, existingSession.selectionMessageId).catch(() => {});
    }
    sessions.delete(ctx.chat.id);
  }

  const url = sanitizeUrl(ctx.message.text);
  if (!url) {
    await ctx.reply("Please send a valid media URL.");
    return;
  }

  sessions.create(ctx.chat.id, {
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
    await ctx.answerCbQuery("Not allowed", { show_alert: true });
    await handleUnauthorized(ctx);
    return;
  }

  const session = sessions.get(chatId);
  if (!session || session.userId !== userId) {
    await ctx.answerCbQuery("No active request. Send a link first.", { show_alert: true });
    return;
  }

  const type = ctx.match[1].toLowerCase();
  const promptMessageId = ctx.callbackQuery?.message?.message_id;
  const selectionMessageId = session.selectionMessageId || promptMessageId;
  await ctx.answerCbQuery();

  if (selectionMessageId) {
    await ctx.telegram.deleteMessage(chatId, selectionMessageId).catch(() => {});
    sessions.update(chatId, { selectionMessageId: null });
  }

  const loadingMessage = await ctx.reply("Fetching available formats...");

  try {
    const { formats, title, webpageUrl, durationSeconds } = await listFormats(session.url);
    const filtered = getFormatsByType(formats, type, { durationSeconds });

    if (!filtered.length) {
      await ctx.reply("No suitable formats found. Try another link or type.");
      return;
    }

    const promptText = type === "audio" ? "Choose an audio bitrate:" : "Choose a video quality:";
    const formatMessage = await ctx.reply(
      promptText,
      buildFormatKeyboard(filtered, type)
    );

    sessions.update(chatId, {
      type,
      title,
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


bot.action(/^fmt:(audio|video):(\d+)$/i, async (ctx) => {
  const chatId = ctx.chat.id;
  const userId = ctx.from?.id;
  if (!isAuthorized(userId)) {
    await ctx.answerCbQuery("Not allowed", { show_alert: true });
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

  if (!selectedFormat) {
    await ctx.answerCbQuery("Unknown format.", { show_alert: true });
    return;
  }

  await ctx.answerCbQuery('Selected ' + selectedFormat.displayLabel);

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

  const job = queue.enqueue(async () => {
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

  if (job.position > 0) {
    await updateStatus('Queued (#' + job.position + '). Waiting for your turn...');
  }

  job.promise
    .then(async (result) => {
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
        const currentSession = sessions.get(chatId);
        if (currentSession?.formats?.length) {
          const promptText = type === 'audio' ? 'Choose another audio bitrate:' : 'Choose another video quality:';
          const retryMessage = await ctx.reply(promptText, buildFormatKeyboard(currentSession.formats, type));
          sessions.update(chatId, { formatMessageId: retryMessage.message_id });
        }
        return;
      }

      sessions.delete(chatId);
    })
    .catch(async (error) => {
      logger.error({ error: error.message, stack: error.stack }, 'Download job failed');
      await updateStatus('Failed. Please try another format or send a new link.');
    });
});

bot.action("cancel", async (ctx) => {
  sessions.delete(ctx.chat.id);
  await ctx.answerCbQuery("Canceled");
  await ctx.reply("Canceled. Send a new link whenever you're ready.");
});

bot.catch((error, ctx) => {
  logger.error({ error: error.message, stack: error.stack }, "Bot encountered an error");
  ctx.reply?.("Something went wrong. Please try again later.");
});

bot.launch().then(() => {
  logger.info("Telegram bot started");
});

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
