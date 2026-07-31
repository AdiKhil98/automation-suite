import { describe, expect, it } from 'vitest';
import {
  classifyDeliveryPermanence,
  correlateDsn,
  extractSmtpCode,
  isDeliveryNotification,
  parseDeliveryStatus,
  parseDsn,
  permanenceToDeliveryStatus,
  rejectionCode,
  type ParsedDsn,
  type RawDeliveryNotification,
  type TrackedOutbound,
} from '../../src/domain/outreach/delivery.js';

const OUTBOUND: TrackedOutbound = {
  outreachRecordId: 'rec-1',
  outreachMessageId: 'msg-1',
  gmailMessageId: 'gm-out-1',
  gmailThreadId: 'thr-out-1',
  contactEmail: 'prospect@clinic.example',
  rfcMessageId: '<out-1@mail.scaleflow>',
};

function dsn(over: Partial<ParsedDsn> = {}): ParsedDsn {
  return {
    dsnGmailMessageId: 'dsn-1',
    dsnGmailThreadId: 'thr-dsn-sep',
    receivedAtMs: Date.parse('2026-07-21T10:00:00Z'),
    fromEmail: 'mailer-daemon@googlemail.com',
    subject: 'Delivery Status Notification (Failure)',
    contentType: 'multipart/report; report-type=delivery-status',
    finalRecipient: 'prospect@clinic.example',
    originalRecipient: null,
    action: 'failed',
    status: '5.7.1',
    diagnosticCode: 'smtp; 550 5.7.1 The message was rejected as likely unsolicited mail',
    xFailedRecipients: null,
    referencedMessageIds: [],
    preview: 'Address rejected',
    ...over,
  };
}

describe('isDeliveryNotification', () => {
  it('recognizes a multipart/report content type', () => {
    expect(isDeliveryNotification({ fromEmail: 'x@y.com', subject: 'hi', contentType: 'multipart/report; report-type=delivery-status' })).toBe(true);
  });
  it('recognizes a mailer-daemon / postmaster sender', () => {
    expect(isDeliveryNotification({ fromEmail: 'MAILER-DAEMON@googlemail.com', subject: 'hi' })).toBe(true);
    expect(isDeliveryNotification({ fromEmail: 'postmaster@corp.example', subject: 'hi' })).toBe(true);
  });
  it('recognizes an X-Failed-Recipients header or a DSN subject', () => {
    expect(isDeliveryNotification({ fromEmail: 'x@y.com', subject: 'anything', hasXFailedRecipients: true })).toBe(true);
    expect(isDeliveryNotification({ fromEmail: 'x@y.com', subject: 'Mail Delivery Subsystem' })).toBe(true);
  });
  it('does NOT classify an ordinary mailbox message', () => {
    expect(isDeliveryNotification({ fromEmail: 'dr@clinic.example', subject: 'Re: your email', contentType: 'text/plain' })).toBe(false);
  });
});

describe('parseDeliveryStatus (RFC 3464 fields)', () => {
  it('extracts action/status/diagnostic/recipients and strips the rfc822; prefix', () => {
    const block = [
      'Reporting-MTA: dns; googlemail.com',
      'Final-Recipient: rfc822; prospect@clinic.example',
      'Original-Recipient: rfc822;prospect@clinic.example',
      'Action: failed',
      'Status: 5.7.1',
      'Diagnostic-Code: smtp; 550 5.7.1 unsolicited mail',
    ].join('\n');
    const p = parseDeliveryStatus(block);
    expect(p.action).toBe('failed');
    expect(p.status).toBe('5.7.1');
    expect(p.finalRecipient).toBe('prospect@clinic.example');
    expect(p.originalRecipient).toBe('prospect@clinic.example');
    expect(p.diagnosticCode).toContain('550 5.7.1');
  });
  it('returns all-null for empty input', () => {
    expect(parseDeliveryStatus(null)).toEqual({ action: null, status: null, diagnosticCode: null, finalRecipient: null, originalRecipient: null });
  });
});

describe('classifyDeliveryPermanence', () => {
  it('classifies a 5.x.x enhanced status / 550 SMTP code as PERMANENT', () => {
    expect(classifyDeliveryPermanence({ status: '5.7.1' })).toBe('PERMANENT');
    expect(classifyDeliveryPermanence({ diagnosticCode: 'smtp; 550 5.7.1 rejected' })).toBe('PERMANENT');
  });
  it('classifies a 4.x.x enhanced status / 4xx SMTP code as TEMPORARY', () => {
    expect(classifyDeliveryPermanence({ status: '4.2.2' })).toBe('TEMPORARY');
    expect(classifyDeliveryPermanence({ diagnosticCode: 'smtp; 452 4.2.2 mailbox full' })).toBe('TEMPORARY');
    expect(classifyDeliveryPermanence({ action: 'delayed' })).toBe('TEMPORARY');
  });
  it('is UNKNOWN when nothing proves permanence (fail closed)', () => {
    expect(classifyDeliveryPermanence({ action: 'failed' })).toBe('UNKNOWN');
    expect(classifyDeliveryPermanence({})).toBe('UNKNOWN');
    expect(classifyDeliveryPermanence({ status: '2.0.0' })).toBe('UNKNOWN');
  });
});

describe('rejectionCode / extractSmtpCode / permanenceToDeliveryStatus', () => {
  it('combines SMTP + enhanced status', () => {
    expect(rejectionCode({ status: '5.7.1', diagnosticCode: 'smtp; 550 5.7.1 rejected' })).toBe('550 5.7.1');
    expect(extractSmtpCode('smtp; 550 5.7.1 rejected')).toBe('550');
    expect(rejectionCode({})).toBeNull();
  });
  it('maps permanence to the delivery status', () => {
    expect(permanenceToDeliveryStatus('PERMANENT')).toBe('BOUNCED');
    expect(permanenceToDeliveryStatus('TEMPORARY')).toBe('DELIVERY_UNKNOWN');
    expect(permanenceToDeliveryStatus('UNKNOWN')).toBe('DELIVERY_UNKNOWN');
  });
});

describe('correlateDsn (fail-closed, exactly-one)', () => {
  it('correlates by Gmail thread id when the DSN is in the same thread', () => {
    const res = correlateDsn(dsn({ dsnGmailThreadId: 'thr-out-1', finalRecipient: null }), [OUTBOUND]);
    expect(res).toEqual({ kind: 'matched', outbound: OUTBOUND, signal: 'THREAD_ID' });
  });

  it('correlates by RFC Message-ID reference even in a SEPARATE thread with a non-matching recipient', () => {
    const res = correlateDsn(
      dsn({ dsnGmailThreadId: 'thr-dsn-sep', finalRecipient: 'noise@else.example', referencedMessageIds: ['<out-1@mail.scaleflow>'] }),
      [OUTBOUND],
    );
    expect(res.kind).toBe('matched');
    if (res.kind === 'matched') expect(res.signal).toBe('RFC_MESSAGE_ID');
  });

  it('correlates by failed recipient when the DSN is in a SEPARATE thread (no thread/rfc signal)', () => {
    const res = correlateDsn(dsn({ dsnGmailThreadId: 'thr-dsn-sep', referencedMessageIds: [] }), [OUTBOUND]);
    expect(res.kind).toBe('matched');
    if (res.kind === 'matched') expect(res.signal).toBe('RECIPIENT');
  });

  it('ignores a DSN whose failed recipient matches no tracked outbound (wrong recipient)', () => {
    const res = correlateDsn(dsn({ dsnGmailThreadId: 'thr-dsn-sep', finalRecipient: 'someone@else.example', referencedMessageIds: [] }), [OUTBOUND]);
    expect(res).toEqual({ kind: 'none' });
  });

  it('ignores an unrelated DSN (no thread, rfc, or recipient signal)', () => {
    const res = correlateDsn(dsn({ dsnGmailThreadId: 'thr-x', finalRecipient: null, originalRecipient: null, xFailedRecipients: null, referencedMessageIds: [] }), [OUTBOUND]);
    expect(res).toEqual({ kind: 'none' });
  });

  it('rejects an AMBIGUOUS correlation (two tracked outbounds share the failed recipient)', () => {
    const second: TrackedOutbound = { ...OUTBOUND, outreachRecordId: 'rec-2', outreachMessageId: 'msg-2', gmailMessageId: 'gm-out-2', gmailThreadId: 'thr-out-2', rfcMessageId: null };
    const res = correlateDsn(dsn({ dsnGmailThreadId: 'thr-dsn-sep', referencedMessageIds: [] }), [OUTBOUND, second]);
    expect(res.kind).toBe('ambiguous');
    if (res.kind === 'ambiguous') expect(res.matchedRecordIds.sort()).toEqual(['rec-1', 'rec-2']);
  });
});

describe('parseDsn (raw → ParsedDsn)', () => {
  it('assembles the parsed DSN from the raw reader fields', () => {
    const raw: RawDeliveryNotification = {
      gmailMessageId: 'dsn-9',
      gmailThreadId: 'thr-dsn-9',
      receivedAtMs: 111,
      fromEmail: 'MAILER-DAEMON@googlemail.com',
      subject: 'Delivery Status Notification (Failure)',
      contentType: 'multipart/report; report-type=delivery-status',
      xFailedRecipients: 'prospect@clinic.example',
      referencedMessageIds: ['<out-1@mail.scaleflow>', '<out-1@mail.scaleflow>'],
      deliveryStatusText: 'Action: failed\nStatus: 5.7.1\nFinal-Recipient: rfc822; prospect@clinic.example\nDiagnostic-Code: smtp; 550 5.7.1 rejected',
      snippet: '   Address rejected as likely unsolicited mail   ',
    };
    const p = parseDsn(raw);
    expect(p.fromEmail).toBe('mailer-daemon@googlemail.com');
    expect(p.status).toBe('5.7.1');
    expect(p.finalRecipient).toBe('prospect@clinic.example');
    expect(p.referencedMessageIds).toEqual(['<out-1@mail.scaleflow>']); // de-duplicated
    expect(p.preview).toBe('Address rejected as likely unsolicited mail');
  });
});
