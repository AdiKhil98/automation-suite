import { type ProviderDraftEnvelope } from './provider.js';

export interface ParsedKnownDraft {
  providerDraftId: string;
  providerMessageId: string;
  providerThreadId: string | null;
  envelope: ProviderDraftEnvelope;
}

interface GmailDraftJson {
  id?: unknown;
  message?: { id?: unknown; threadId?: unknown; labelIds?: unknown; raw?: unknown };
}

/** Strictly parse one `drafts.get?format=raw` response. Ambiguous MIME fails closed. */
export function parseKnownGmailDraft(value: unknown, expectedDraftId: string): ParsedKnownDraft {
  if (!value || typeof value !== 'object') throw new Error('draft_response_not_object');
  const draft = value as GmailDraftJson;
  if (typeof draft.id !== 'string' || draft.id !== expectedDraftId) throw new Error('draft_identity_mismatch');
  const message = draft.message;
  if (!message || typeof message.id !== 'string' || message.id.length === 0) throw new Error('message_identity_missing');
  if (message.threadId !== undefined && message.threadId !== null && typeof message.threadId !== 'string') throw new Error('thread_identity_invalid');
  if (!Array.isArray(message.labelIds) || !message.labelIds.every((x) => typeof x === 'string') || !message.labelIds.includes('DRAFT')) throw new Error('message_not_in_draft_state');
  if (typeof message.raw !== 'string') throw new Error('raw_message_missing');
  return {
    providerDraftId: draft.id,
    providerMessageId: message.id,
    providerThreadId: typeof message.threadId === 'string' ? message.threadId : null,
    envelope: parseRawMessage(message.raw),
  };
}

export function parseRawMessage(rawBase64Url: string): ProviderDraftEnvelope {
  if (!/^[A-Za-z0-9_-]+={0,2}$/.test(rawBase64Url) || rawBase64Url.length % 4 === 1) throw new Error('raw_message_invalid_base64url');
  const decoded = Buffer.from(rawBase64Url.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
  if (decoded.includes('\0')) throw new Error('raw_message_contains_nul');
  const normalized = decoded.replace(/\r\n/g, '\n');
  const boundary = normalized.indexOf('\n\n');
  if (boundary < 0) throw new Error('raw_message_missing_header_boundary');
  const headers = parseHeaders(normalized.slice(0, boundary));
  const contentType = singleton(headers, 'content-type', true).toLowerCase();
  if (!/^text\/plain(?:\s*;\s*charset=(?:"?(?:utf-8|us-ascii)"?))?$/i.test(contentType)) throw new Error('unsupported_mime_structure');
  if (headers.has('content-disposition') || /(?:name|filename)\s*=/i.test(contentType)) throw new Error('attachment_not_allowed');
  const encoding = singleton(headers, 'content-transfer-encoding', false).toLowerCase() || '7bit';
  const body = decodeBody(normalized.slice(boundary + 2), encoding);
  const from = parseAddress(singleton(headers, 'from', true));
  const to = parseAddresses(singleton(headers, 'to', true)).map((a) => a.email);
  const cc = optionalAddresses(headers, 'cc');
  const bcc = optionalAddresses(headers, 'bcc');
  const replyTo = optionalSingleAddress(headers, 'reply-to');
  if (cc.length > 0) throw new Error('unexpected_cc');
  if (bcc.length > 0) throw new Error('unexpected_bcc');
  return {
    fromName: from.name,
    fromEmail: from.email,
    to,
    cc,
    bcc,
    replyTo,
    subject: decodeHeader(singleton(headers, 'subject', true)),
    body,
    attachmentCount: 0,
  };
}

function optionalSingleAddress(headers: Map<string, string[]>, name: string): string | null {
  const values = headers.get(name) ?? [];
  if (values.length > 1) throw new Error(`duplicate_${name}_header`);
  if (!values[0]) return null;
  const parsed = parseAddresses(values[0]);
  if (parsed.length !== 1) throw new Error(`multiple_${name}_addresses`);
  return parsed[0]?.email ?? null;
}

function parseHeaders(block: string): Map<string, string[]> {
  const unfolded = block.replace(/\n[ \t]+/g, ' ');
  const out = new Map<string, string[]>();
  for (const line of unfolded.split('\n')) {
    const i = line.indexOf(':');
    if (i <= 0) throw new Error('malformed_mime_header');
    const name = line.slice(0, i).trim().toLowerCase();
    if (!/^[a-z0-9-]+$/.test(name)) throw new Error('malformed_mime_header_name');
    const values = out.get(name) ?? [];
    values.push(line.slice(i + 1).trim());
    out.set(name, values);
  }
  return out;
}

function singleton(headers: Map<string, string[]>, name: string, required: boolean): string {
  const values = headers.get(name) ?? [];
  if (values.length > 1) throw new Error(`duplicate_${name}_header`);
  if (required && (values.length !== 1 || !values[0])) throw new Error(`missing_${name}_header`);
  return values[0] ?? '';
}

function optionalAddresses(headers: Map<string, string[]>, name: string): string[] {
  const values = headers.get(name) ?? [];
  if (values.length > 1) throw new Error(`duplicate_${name}_header`);
  return values[0] ? parseAddresses(values[0]).map((a) => a.email) : [];
}

function parseAddresses(value: string): { name: string; email: string }[] {
  if (/[;\r\n]/.test(value)) throw new Error('ambiguous_address_header');
  const parts: string[] = [];
  let quoted = false;
  let current = '';
  for (const ch of value) {
    if (ch === '"') quoted = !quoted;
    if (ch === ',' && !quoted) { parts.push(current); current = ''; } else current += ch;
  }
  if (quoted) throw new Error('ambiguous_address_header');
  parts.push(current);
  if (parts.some((x) => !x.trim())) throw new Error('empty_address');
  return parts.map(parseAddress);
}

function parseAddress(value: string): { name: string; email: string } {
  const angle = value.trim().match(/^(.*?)\s*<([^<>]+)>$/);
  const rawName = angle ? angle[1]?.trim() ?? '' : '';
  const email = (angle ? angle[2] : value).trim().toLowerCase();
  if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email)) throw new Error('invalid_address');
  const unquoted = rawName.startsWith('"') && rawName.endsWith('"') ? rawName.slice(1, -1) : rawName;
  if (unquoted.includes('"')) throw new Error('ambiguous_display_name');
  return { name: decodeHeader(unquoted), email };
}

function decodeHeader(value: string): string {
  if (!value.includes('=?')) return value;
  let invalid = false;
  const decoded = value.replace(/=\?UTF-8\?([BQ])\?([^?]+)\?=/gi, (_all, kind: string, data: string) => {
    try {
      if (kind.toUpperCase() === 'B') return Buffer.from(data, 'base64').toString('utf8');
      return decodeQuotedPrintable(data.replace(/_/g, ' '));
    } catch { invalid = true; return ''; }
  });
  if (invalid || decoded.includes('=?')) throw new Error('unsupported_encoded_header');
  return decoded;
}

function decodeBody(body: string, encoding: string): string {
  if (encoding === '7bit' || encoding === '8bit') return body;
  if (encoding === 'base64') {
    if (!/^[A-Za-z0-9+/=\s]*$/.test(body)) throw new Error('invalid_base64_body');
    return Buffer.from(body.replace(/\s/g, ''), 'base64').toString('utf8');
  }
  if (encoding === 'quoted-printable') return decodeQuotedPrintable(body);
  throw new Error('unsupported_transfer_encoding');
}

function decodeQuotedPrintable(value: string): string {
  const compact = value.replace(/=\r?\n/g, '');
  if (/=(?![0-9A-Fa-f]{2})/.test(compact)) throw new Error('invalid_quoted_printable');
  const bytes: number[] = [];
  for (let i = 0; i < compact.length; i += 1) {
    if (compact[i] === '=') { bytes.push(Number.parseInt(compact.slice(i + 1, i + 3), 16)); i += 2; }
    else bytes.push(Buffer.from(compact[i] ?? '', 'utf8')[0] ?? 0);
  }
  return Buffer.from(bytes).toString('utf8');
}
