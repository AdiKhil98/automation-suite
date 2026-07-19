/** The sender-name placeholder the finalized email still carries after Phase 11. */
export const SENDER_NAME_TOKEN = '{{SENDER_NAME}}';

/** Any unresolved handlebar token, e.g. {{DEMO_URL}} or {{SENDER_NAME}}. */
const TOKEN_RE = /\{\{[A-Za-z0-9_]+\}\}/;

/** Replace every {{SENDER_NAME}} with the configured sender name (deterministic, exact). */
export function resolveSenderName(body: string, senderName: string): string {
  return body.split(SENDER_NAME_TOKEN).join(senderName);
}

export function hasUnresolvedTokens(text: string): boolean {
  return TOKEN_RE.test(text);
}

/** base64url (Gmail `message.raw` encoding): base64 with -/_ and no padding. */
export function base64Url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const isAscii = (s: string): boolean => /^[\x20-\x7E]*$/.test(s);

/** RFC 2047 encoded-word for a header value containing non-ASCII (e.g. German umlauts). */
function encodeHeaderWord(value: string): string {
  return isAscii(value) ? value : `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

export interface MimeInput {
  fromName: string;
  fromEmail: string;
  toEmail: string;
  subject: string;
  body: string;
}

/**
 * Build an RFC 5322 plain-text UTF-8 message and return its base64url encoding for
 * users.drafts.create. Non-ASCII display name / subject are RFC 2047 encoded. The body is
 * preserved exactly (only the sender name was substituted upstream).
 */
export function buildRawMessage(m: MimeInput): string {
  const from = `${encodeHeaderWord(m.fromName)} <${m.fromEmail}>`;
  const headers = [
    `From: ${from}`,
    `To: ${m.toEmail}`,
    `Subject: ${encodeHeaderWord(m.subject)}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: 8bit',
  ];
  const message = `${headers.join('\r\n')}\r\n\r\n${m.body}`;
  return base64Url(Buffer.from(message, 'utf8'));
}
