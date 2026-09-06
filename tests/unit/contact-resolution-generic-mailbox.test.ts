import { describe, expect, it } from 'vitest';
import { classifyGenericMailbox } from '../../src/domain/contact-resolution/generic-mailbox.js';

describe('classifyGenericMailbox', () => {
  it('accepts the recognized generic business front doors', () => {
    for (const local of ['info', 'contact', 'hello', 'enquiries', 'reception', 'admin', 'bookings', 'appointments']) {
      expect(classifyGenericMailbox(local), local).toEqual({ kind: 'GENERIC_BUSINESS', normalizedLocalPart: local });
    }
  });

  it('is case- and separator-insensitive, so spelling variants collapse to one token', () => {
    expect(classifyGenericMailbox('Front-Desk')).toEqual({ kind: 'GENERIC_BUSINESS', normalizedLocalPart: 'frontdesk' });
    expect(classifyGenericMailbox('front.desk')).toEqual({ kind: 'GENERIC_BUSINESS', normalizedLocalPart: 'frontdesk' });
    expect(classifyGenericMailbox('NEW_PATIENTS')).toEqual({ kind: 'GENERIC_BUSINESS', normalizedLocalPart: 'newpatients' });
  });

  it('rejects automated/system mailboxes in every spelling', () => {
    for (const local of ['noreply', 'no-reply', 'no.reply', 'NoReply', 'donotreply', 'do-not-reply', 'postmaster', 'mailer-daemon', 'bounces', 'unsubscribe', 'notifications']) {
      expect(classifyGenericMailbox(local), local).toEqual({ kind: 'REJECTED', reason: 'denylisted_system_or_department_mailbox' });
    }
  });

  it('rejects suffixed automated variants via the prefix rule', () => {
    expect(classifyGenericMailbox('noreply2024')).toEqual({ kind: 'REJECTED', reason: 'denylisted_system_or_department_mailbox' });
    expect(classifyGenericMailbox('no-reply-uk')).toEqual({ kind: 'REJECTED', reason: 'denylisted_system_or_department_mailbox' });
  });

  it('rejects privacy/legal, recruitment and finance departments', () => {
    for (const local of ['privacy', 'dpo', 'gdpr', 'legal', 'careers', 'jobs', 'recruitment', 'hr', 'billing', 'accounts', 'invoices', 'payments']) {
      expect(classifyGenericMailbox(local), local).toEqual({ kind: 'REJECTED', reason: 'denylisted_system_or_department_mailbox' });
    }
  });

  it('rejects a PERSONAL mailbox — the classifier is closed by default, so no name can pass as generic', () => {
    for (const local of ['richard', 'r.clarke', 'richard.clarke-irons', 'dr.richard', 'shyam']) {
      expect(classifyGenericMailbox(local), local).toEqual({ kind: 'REJECTED', reason: 'not_a_recognized_generic_business_mailbox' });
    }
  });

  it('rejects an unrecognized-but-harmless-looking mailbox rather than guessing it is generic', () => {
    expect(classifyGenericMailbox('support')).toEqual({ kind: 'REJECTED', reason: 'not_a_recognized_generic_business_mailbox' });
    expect(classifyGenericMailbox('sales')).toEqual({ kind: 'REJECTED', reason: 'not_a_recognized_generic_business_mailbox' });
  });

  it('rejects plus-addressed and empty local parts', () => {
    expect(classifyGenericMailbox('info+web')).toEqual({ kind: 'REJECTED', reason: 'plus_addressed' });
    expect(classifyGenericMailbox('   ')).toEqual({ kind: 'REJECTED', reason: 'empty_local_part' });
    expect(classifyGenericMailbox('...')).toEqual({ kind: 'REJECTED', reason: 'empty_local_part' });
  });

  it('the denylist wins even for a token that would otherwise normalize into the allowlist space', () => {
    // 'admin' is allowed; 'administration' is allowed; but a denied token is never rescued.
    expect(classifyGenericMailbox('accounts')).toEqual({ kind: 'REJECTED', reason: 'denylisted_system_or_department_mailbox' });
    expect(classifyGenericMailbox('admin')).toEqual({ kind: 'GENERIC_BUSINESS', normalizedLocalPart: 'admin' });
  });
});
