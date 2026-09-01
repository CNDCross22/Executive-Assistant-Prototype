import { pino } from 'pino';
import { env, isProd } from '../config/env.js';

/** Query strings can contain OAuth codes, message ids, or user-entered text. */
export function safeRequestUrl(url: string | undefined): string | undefined {
  return url?.split('?', 1)[0];
}

/**
 * pino-pretty runs in a worker thread, and that worker holds a MessagePort
 * open for the life of the process. Under `node --test` each test file is its
 * own child process, so the first log line written by a test pins that child
 * open forever and the whole run stalls rather than failing.
 *
 * Readable output is a development convenience; correctness of the test run is
 * not. Keep the transport for humans and write plain JSON under test.
 */
const underTest = env.NODE_ENV === 'test' || process.env.NODE_TEST_CONTEXT !== undefined;

export const logger = pino({
  level: env.LOG_LEVEL,
  transport: isProd || underTest
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
