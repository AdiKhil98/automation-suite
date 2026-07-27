import { describe, expect, it } from 'vitest';
import {
  classificationToStatus,
  classifyReply,
  firstGenuineReply,
  type InboundMessage,
  isSelfMessage,
  safePreview,
} from '../../src/domain/outreach/reply-classification.js';

const OWN = ['outreach@agency.example'];

function msg(over: Partial<InboundMessage>): InboundMessage {
  return {
    messageId: 'm1',
    threadId: 't1',
    fromEmail: 'prospect@clinic.example',
    receivedAtMs: Date.parse('2026-07-20T10:00:00Z'),
    preview: '',
    headers: { fromEmail: 'prospect@clinic.example' },
    ...over,
  };
}

describe('reply classification', () => {
  it('excludes the account own messages', () => {
    expect(isSelfMessage('outreach@agency.example', OWN)).toBe(true);
    expect(isSelfMessage('Outreach@Agency.Example', OWN)).toBe(true);
    expect(isSelfMessage('prospect@clinic.example', OWN)).toBe(false);
  });

  it('detects the first genuine inbound reply after the last outbound', () => {
    const lastOutboundAtMs = Date.parse('2026-07-19T09:00:00Z');
    const messages: InboundMessage[] = [
      msg({ messageId: 'self', fromEmail: 'outreach@agency.example', receivedAtMs: Date.parse('2026-07-20T08:00:00Z') }),
      msg({ messageId: 'old', receivedAtMs: Date.parse('2026-07-18T08:00:00Z') }),
      msg({ messageId: 'reply', receivedAtMs: Date.parse('2026-07-20T10:00:00Z') }),
    ];
    const r = firstGenuineReply(messages, { lastOutboundAtMs, ownEmails: OWN });
    expect(r?.messageId).toBe('reply');
  });

  it('returns null when there is no inbound reply', () => {
    const lastOutboundAtMs = Date.parse('2026-07-19T09:00:00Z');
    const messages = [msg({ messageId: 'self', fromEmail: 'outreach@agency.example', receivedAtMs: Date.parse('2026-07-20T08:00:00Z') })];
    expect(firstGenuineReply(messages, { lastOutboundAtMs, ownEmails: OWN })).toBeNull();
  });

  it('classifies deterministically with suppression-first precedence', () => {
    expect(classifyReply(msg({ preview: 'Please unsubscribe me from this list' }))).toBe('unsubscribe');
    expect(classifyReply(msg({ fromEmail: 'mailer-daemon@googlemail.com', preview: 'Address not found' }))).toBe('bounce');
    expect(classifyReply(msg({ headers: { fromEmail: 'x', contentType: 'multipart/report; report-type=delivery-status' } }))).toBe('bounce');
    expect(classifyReply(msg({ preview: 'We are not interested, thanks' }))).toBe('negative');
    expect(classifyReply(msg({ preview: 'This sounds good, can we book a call?' }))).toBe('positive');
    expect(classifyReply(msg({ preview: 'Received, will look later.' }))).toBe('neutral');
  });

  it('prefers unsubscribe over sentiment', () => {
    // Contains a positive word but explicitly asks to opt out.
    expect(classifyReply(msg({ preview: 'sounds good but please opt out' }))).toBe('unsubscribe');
  });

  it('maps classification to status', () => {
    expect(classificationToStatus('positive')).toBe('REPLIED_POSITIVE');
    expect(classificationToStatus('unsubscribe')).toBe('UNSUBSCRIBED');
    expect(classificationToStatus('bounce')).toBe('BOUNCED');
  });

  it('produces a short single-line safe preview', () => {
    const p = safePreview('line one\n   line two   \t tail', 20);
    expect(p).not.toContain('\n');
    expect(p.length).toBeLessThanOrEqual(20);
  });
});
