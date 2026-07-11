import pino, { type Logger } from 'pino';

/**
 * Structured logger. Secrets are redacted by path so credentials never reach logs
 * even if an object containing them is logged accidentally.
 */
const REDACT_PATHS = [
  'DATABASE_URL',
  '*.DATABASE_URL',
  'apiKey',
  '*.apiKey',
  'password',
  '*.password',
  'authorization',
  '*.authorization',
  'OPENAI_API_KEY',
  '*.OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  '*.ANTHROPIC_API_KEY',
  'GOOGLE_PLACES_API_KEY',
  '*.GOOGLE_PLACES_API_KEY',
  'NETLIFY_AUTH_TOKEN',
  '*.NETLIFY_AUTH_TOKEN',
  'GMAIL_CLIENT_SECRET',
  '*.GMAIL_CLIENT_SECRET',
  'GMAIL_REFRESH_TOKEN',
  '*.GMAIL_REFRESH_TOKEN',
];

export function createLogger(level: string = 'info'): Logger {
  return pino({
    level,
    redact: { paths: REDACT_PATHS, censor: '[redacted]' },
  });
}
