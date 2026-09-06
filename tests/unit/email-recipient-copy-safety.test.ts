import { describe, expect, it } from 'vitest';
import { personalNameAllowed, renderEmail, type EmailInputs, type EmailRecipientContext } from '../../src/domain/email/email-render.js';
import { type EmailWriterOutput } from '../../src/domain/email/email-types.js';
import { EMAIL_COPY_FIXTURES } from '../fixtures/email-copy-standard.js';
import { type LeadFact } from '../../src/domain/lead-facts/lead-fact.js';

/**
 * Copy safety: a generic business inbox must never be addressed as if it belonged to a named person.
 * "Hello Dr Richard" sent to info@practice.co.uk asserts an identity nothing verified.
 */

function fact(over: Partial<LeadFact> & Pick<LeadFact, 'factType' | 'value'>): LeadFact {
  return {
    id: `fact-${over.factType}`, leadId: 'lead-1', normalizedValue: over.value, sourceType: 'website',
    sourceUrl: 'https://completedentistry.co.uk/contact', capturedAt: new Date(), confidence: 0.9,
    supersededBy: null, supersededAt: null, isCurrent: true, ...over,
  } as LeadFact;
}

// `contact_name` is the fact the renderer would use for a personal greeting.
const NAME_FACT = fact({ factType: 'contact_name' as LeadFact['factType'], value: 'Dr Richard' });

// Reuse a real, schema-valid writer output; only the greeting path is under test here.
const OUT: EmailWriterOutput = {
  ...EMAIL_COPY_FIXTURES.find((f) => f.name === 'strong English business email')!.writer,
  evidence_ids: [],
};

const GENERIC: EmailRecipientContext = {
  contactType: 'GENERIC_OFFICIAL',
  email: 'info@completedentistry.co.uk',
  intendedDecisionMakers: [{ fullName: 'Dr Richard Clarke-Irons', title: 'Principal Dentist' }],
};
const PERSONAL: EmailRecipientContext = {
  contactType: 'PERSONAL_VERIFIED',
  email: 'richard@completedentistry.co.uk',
  intendedDecisionMakers: [],
};

function render(recipient: EmailRecipientContext | null | undefined): string {
  const inputs: EmailInputs = { facts: [NAME_FACT], findings: [], demo: null, recipient };
  return renderEmail(OUT, inputs).body;
}

describe('personalNameAllowed', () => {
  it('permits a personal name ONLY for an explicitly PERSONAL_VERIFIED recipient', () => {
    expect(personalNameAllowed(PERSONAL)).toBe(true);
    expect(personalNameAllowed(GENERIC)).toBe(false);
  });

  it('fails closed when the recipient contract is absent or null', () => {
    expect(personalNameAllowed(null)).toBe(false);
    expect(personalNameAllowed(undefined)).toBe(false);
  });
});

describe('renderEmail greeting', () => {
  it('NEVER greets a GENERIC_OFFICIAL recipient by name, even when the owner\'s name is a known fact', () => {
    const body = render(GENERIC);
    expect(body).not.toContain('Dr Richard');
    expect(body).not.toContain('Hello Dr');
    expect(body.startsWith('Hello,')).toBe(true);
  });

  it('greets a PERSONAL_VERIFIED recipient by name', () => {
    expect(render(PERSONAL).startsWith('Hello Dr Richard,')).toBe(true);
  });

  it('stays neutral when no recipient contract is supplied — an unproven identity is not a licence to use a name', () => {
    expect(render(null).startsWith('Hello,')).toBe(true);
    expect(render(undefined).startsWith('Hello,')).toBe(true);
  });

  it('records no greeting.name fact input for a generic recipient (nothing claims the name was used)', () => {
    const generic = renderEmail(OUT, { facts: [NAME_FACT], findings: [], demo: null, recipient: GENERIC });
    expect(generic.factInputs.some((f) => f.field === 'greeting.name')).toBe(false);
    const personal = renderEmail(OUT, { facts: [NAME_FACT], findings: [], demo: null, recipient: PERSONAL });
    expect(personal.factInputs.some((f) => f.field === 'greeting.name')).toBe(true);
  });

  it('the recipient contract differentiates the two contact types downstream', () => {
    expect(GENERIC.contactType).toBe('GENERIC_OFFICIAL');
    expect(PERSONAL.contactType).toBe('PERSONAL_VERIFIED');
    // A generic inbox carries forwarding targets; a verified person never does (they ARE the recipient).
    expect(GENERIC.intendedDecisionMakers).toHaveLength(1);
    expect(PERSONAL.intendedDecisionMakers).toEqual([]);
  });
});
