import pino from "pino";
import { config } from "./config.js";

const level = process.env.LOG_LEVEL || "info";

const streams = [
  { stream: process.stdout },
  {
    stream: pino.destination({
      dest: config.LOG_FILE_PATH,
      append: true,
      sync: false,
    }),
  },
];

export const logger = pino({ level }, pino.multistream(streams));
