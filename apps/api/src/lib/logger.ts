import { pino } from 'pino';
import { env, isProd } from '../config/env.js';

export const logger = pino({
  level: env.LOG_LEVEL,
  transport: isProd
    ? undefined
    : { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss' } },
  redact: {
    paths: [
      'req.headers.cookie',
      'req.headers.authorization',
      'accessToken',
      'refreshToken',
      '*.accessToken',
      '*.refreshToken',
      'client_secret',
    ],
    censor: '[redacted]',
  },
});

export type Logger = typeof logger;
