import { type LeadFact } from '../lead-facts/lead-fact.js';
import { mailtoHref, sanitizeUrl, telHref } from './sanitize.js';
import { type Cta, type DemoContent, type FactInput } from './demo-types.js';

const current = (facts: LeadFact[], t: string): LeadFact | undefined =>
  facts.find((f) => f.factType === t && f.isCurrent && f.value.trim() !== '');

/**
 * Resolve the demo's factual content from CURRENT verified lead facts only. Every value
 * carries a FactInput (fact id + rendered field) for relational provenance. Unknown
 * values are left null/empty so the template omits the section rather than fabricating.
 */
export function resolveDemoContent(facts: LeadFact[]): DemoContent {
  const factInputs: FactInput[] = [];
  const use = (t: string, field: string): string | null => {
    const f = current(facts, t);
    if (!f) return null;
    factInputs.push({ factId: f.id, factType: f.factType, field });
    return f.value.trim();
  };

  const businessName = use('business_name', 'business_name') ?? '';
  const city = use('city', 'city');
  const officialWebsiteUrlRaw = use('official_website_url', 'official_website_url');
  const officialWebsiteUrl = sanitizeUrl(officialWebsiteUrlRaw);
  const phoneRaw = use('phone', 'contact.phone');
  const phoneTel = telHref(phoneRaw);
  const emailRaw = use('contact_email', 'contact.email');
  const emailMailto = mailtoHref(emailRaw);
  const address = use('formatted_address', 'contact.address');

  const cta = resolveCta(facts, factInputs);

  return {
    businessName,
    city,
    officialWebsiteUrl,
    phoneTel,
    emailMailto,
    address,
    services: [], // no verified services fact type in MVP → section omitted
    cta,
    factInputs,
  };
}

/**
 * Primary CTA resolution (amendment 2). NEVER implies online booking without a verified
 * booking URL. Priority: booking URL → contact page → phone → scroll to #contact.
 */
function resolveCta(facts: LeadFact[], factInputs: FactInput[]): Cta {
  // 1) Verified booking URL (no dedicated fact type in MVP; supported when one exists).
  const booking = current(facts, 'booking_url');
  const bookingHref = booking ? sanitizeUrl(booking.value) : null;
  if (booking && bookingHref) {
    factInputs.push({ factId: booking.id, factType: booking.factType, field: 'cta.href' });
    return { label: 'Book an appointment', href: bookingHref, kind: 'booking' };
  }

  // 2) Verified contact page.
  const contactPage = current(facts, 'contact_form_url');
  const contactHref = contactPage ? sanitizeUrl(contactPage.value) : null;
  if (contactPage && contactHref) {
    factInputs.push({ factId: contactPage.id, factType: contactPage.factType, field: 'cta.href' });
    return { label: 'Contact us', href: contactHref, kind: 'contact' };
  }

  // 3) Verified phone.
  const phone = current(facts, 'phone');
  const tel = phone ? telHref(phone.value) : null;
  if (phone && tel) {
    factInputs.push({ factId: phone.id, factType: phone.factType, field: 'cta.href' });
    return { label: 'Call us', href: tel, kind: 'tel' };
  }

  // 4) No verified destination → scroll to the local demo contact section.
  return { label: 'Get in touch', href: '#contact', kind: 'scroll' };
}
