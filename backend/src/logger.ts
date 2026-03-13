import pino from "pino";

export const logger = pino({
  transport: {
    target: "pino-pretty",
    options: {
      translateTime: "HH:MM:ss",
      ignore: "pid,hostname",
      singleLine: true,
    },
  },
});
