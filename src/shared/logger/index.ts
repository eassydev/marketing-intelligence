import pino from 'pino';

export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  formatters: {
    level(label) {
      return { level: label };
    },
  },
  redact: {
    paths: [
      'req.headers.authorization',
      '*.password',
      '*.access_token',
      '*.accessToken',
      '*.api_key',
      '*.apiKey',
      '*.app_secret',
      '*.appSecret',
      '*.token',
      '*.refresh_token',
      '*.refreshToken',
    ],
    censor: '[REDACTED]',
  },
  timestamp: pino.stdTimeFunctions.isoTime,
});

export function createChildLogger(bindings: Record<string, unknown>) {
  return logger.child(bindings);
}
