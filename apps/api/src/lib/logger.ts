import { pino } from 'pino';
import { env, isProd } from '../config/env.js';

/** Query strings can contain OAuth codes, message ids, or user-entered text. */
export function safeRequestUrl(url: string | undefined): string | undefined {
  return url?.split('?', 1)[0];
}

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
  serializers: {
    req(request) {
      // Allowlist metadata instead of serializing the whole request: parsed
      // query values can contain OAuth codes and Microsoft message ids.
      return {
        id: request.id,
        method: request.method,
        url: safeRequestUrl(request.url),
        host: request.headers?.host,
        remoteAddress: request.remoteAddress,
        remotePort: request.remotePort,
      };
    },
  },
});

export type Logger = typeof logger;
