import { describe, expect, it } from 'vitest';
import {
  cleanPage,
  confirmsCategory,
  extractEvidence,
  findPersonNames,
  MAX_EVIDENCE_CHARS_PER_PAGE,
} from '../../src/domain/decision-makers/evidence-extraction.js';

const NAV = `<nav><a href="/">Home</a><a href="/treatments">Treatments</a><a href="/fees">Fees</a>
  <a href="/about-us">About</a><a href="/team">Team</a><a href="/contact">Contact</a></nav>`;

describe('cleanPage', () => {
  it('strips navigation and footer boilerplate from the text used for evidence', () => {
    const html = `<html><body>${NAV}<main><p>Dr Bobby Bandlish, Principal Dentist and Owner.</p>
      <p>${'We are a well-established family practice serving the local community. '.repeat(5)}</p></main>
      <footer>Privacy policy. Sitemap. Cookies.</footer></body></html>`;
    const { text } = cleanPage(html);
    expect(text).toContain('Dr Bobby Bandlish, Principal Dentist and Owner.');
    expect(text).not.toContain('Sitemap');
    expect(text).not.toContain('Treatments');
  });

  it('falls back to minimally-cleaned text when boilerplate removal would empty the page', () => {
    // Some sites wrap their whole page in a nav/menu container; stripping it must not yield nothing.
    const body = `<p>Our team at Norwood Dental Clinic. ${'Laura Carranza is a dentist here. '.repeat(20)}</p>`;
    const { text } = cleanPage(`<html><body><nav>${body}</nav></body></html>`);
    expect(text).toContain('Our team at Norwood Dental Clinic');
  });

  it('extracts a named in-page section, climbing to the container that holds its content', () => {
    const html = `<html><body>${NAV}<section id="practice-team"><h2>Our team at Norwood Dental Clinic</h2>
      <p>Laura Carranza Dentist. Laura Carranza joined in 2019. GDC No. 204516.</p></section></body></html>`;
    const { sectionText } = cleanPage(html, 'practice-team');
    expect(sectionText).toContain('Our team at Norwood Dental Clinic');
    expect(sectionText).toContain('GDC No. 204516');
  });

  it('returns null section text for an unknown fragment', () => {
    expect(cleanPage(`<html><body>${NAV}</body></html>`, 'nope').sectionText).toBeNull();
  });
});

describe('findPersonNames', () => {
  it('finds honorific and plain names', () => {
    const names = findPersonNames('Dr Masih Sage is here, and Mena Williams runs the practice.');
    expect(names.map((n) => n.value)).toEqual(expect.arrayContaining(['Dr Masih Sage', 'Mena Williams']));
  });

  it('does not read capitalised role words as a person', () => {
    // Real complaints-procedure sentence: it names a role, but nobody holds it in the text.
    const names = findPersonNames('please write to the Practice Manager or the Clinical Director, who will contact you');
    expect(names).toHaveLength(0);
  });

  it('does not read a corporate entity as a person', () => {
    const names = findPersonNames('Our majority owner is Jacobs Holding AG, part of Jacobs Capital.');
    expect(names).toHaveLength(0);
  });
});

describe('extractEvidence + confirmsCategory', () => {
  it('TEAM: confirms a real roster and centres snippets on the qualifying titles', () => {
    const text = `${'Filler about our welcoming environment. '.repeat(40)}Founder Dr Lalit Bandlish Founder. `
      + 'Dr Bobby Bandlish Principal Dentist / Owner GDC: 71012. Dr Gita Auplish Co-Founder GDC 71011.';
    const { snippets, signals } = extractEvidence(text);
    expect(confirmsCategory(signals, 'TEAM')).toBe(true);
    expect(signals.namesNearDecisionRole).toBeGreaterThanOrEqual(2);
    expect(snippets.join(' ')).toContain('Dr Bobby Bandlish Principal Dentist / Owner');
    // The evidence sits ~1600 chars in — past the window the old first-N-chars serialization sent.
    expect(text.indexOf('Bobby Bandlish')).toBeGreaterThan(1500);
  });

  it('TEAM: confirms a roster of clinical staff even when nobody qualifies as a decision-maker', () => {
    const text = 'Our team at Norwood Dental Clinic. Laura Carranza Dentist. Laura Carranza joined in 2019. '
      + 'Lic Odont Catalan 2010 - GDC No. 204516. Laura qualified from the International University of Catalonia.';
    const { signals } = extractEvidence(text);
    expect(confirmsCategory(signals, 'TEAM')).toBe(true);
    expect(signals.namesNearDecisionRole).toBe(0); // correctly yields no decision-maker downstream
  });

  it('TEAM: does NOT confirm a complaints procedure that only names roles', () => {
    const text = 'If you are unhappy about any aspect of the treatment you received, please write to the '
      + 'Practice Manager or the Clinical Director, who will contact you within five working days.';
    const { signals } = extractEvidence(text);
    expect(signals.namesNearDecisionRole).toBe(0);
    expect(confirmsCategory(signals, 'TEAM')).toBe(false);
    expect(confirmsCategory(signals, 'ABOUT_OWNERSHIP')).toBe(false);
  });

  it('TEAM: does NOT confirm a careers listing', () => {
    const text = 'Work for LDA. Practice Manager. Apprentice. Trainee Dental Nurse. Apply now to join our team.';
    const { signals } = extractEvidence(text);
    expect(confirmsCategory(signals, 'TEAM')).toBe(false);
  });

  it('ABOUT: confirms named ownership stated in prose', () => {
    for (const text of [
      'London Dental Arts, Cosmetic and Implant Clinic in Forest Hill owned and operated by Dr. Arman Barfeie, offers modern dental care.',
      'In 1994, Shahin Lalani joined the team, and her passion for patient care inspired her to take ownership in 1997.',
      'The practice was opened by Dr Richard Clarke-Irons in 2004, originally as Warlingham Green Dental Clinic.',
      'In 2012 Abhijeet Godbole joined our team, and in 2018 he entered into a partnership with Shahin.',
    ]) {
      const { signals, snippets } = extractEvidence(text);
      expect(signals.namedOwnershipStatements, text).toBeGreaterThanOrEqual(1);
      expect(confirmsCategory(signals, 'ABOUT_OWNERSHIP'), text).toBe(true);
      expect(snippets.length).toBeGreaterThan(0);
    }
  });

  it('ABOUT: does NOT confirm ownership language addressed to the reader', () => {
    const text = 'We understand what it takes to run a busy dental practice. As the owner of your practice, '
      + 'the decision to sell can be an extremely difficult one, so choosing the right partner matters.';
    const { signals } = extractEvidence(text);
    expect(signals.namedOwnershipStatements).toBe(0);
    expect(confirmsCategory(signals, 'ABOUT_OWNERSHIP')).toBe(false);
  });

  it('ABOUT: does NOT confirm corporate ownership by a holding company', () => {
    const text = 'Our majority owner is Jacobs Holding AG, part of Jacobs Capital – a global investment firm '
      + 'based in Zurich, Switzerland, and London, UK.';
    const { signals } = extractEvidence(text);
    expect(confirmsCategory(signals, 'ABOUT_OWNERSHIP')).toBe(false);
  });

  it('does not treat review/testimonial authors as staff evidence', () => {
    // One surveyed site publishes seven schema.org Person objects that are all Review.author. JSON-LD is
    // never parsed for people, and visible testimonial blocks are stripped before extraction.
    const html = `<html><body><script type="application/ld+json">
      {"@type":"Review","reviewBody":"Great service","author":{"@type":"Person","name":"John Trimnell"}}
      </script><div class="testimonials"><p>"Excellent care" — Dawn Blacker, Owner of a happy smile</p></div>
      <main><p>${'Our practice has served the Croydon community for over 55 years. '.repeat(5)}</p></main></body></html>`;
    const { text } = cleanPage(html);
    expect(text).not.toContain('John Trimnell');
    expect(text).not.toContain('Dawn Blacker');
    expect(confirmsCategory(extractEvidence(text).signals, 'TEAM')).toBe(false);
  });

  it('caps assembled evidence per page', () => {
    const text = `${'Dr Test Person Principal Dentist GDC: 12345. '.repeat(400)}`;
    const { snippets } = extractEvidence(text);
    expect(snippets.join(' … ').length).toBeLessThanOrEqual(MAX_EVIDENCE_CHARS_PER_PAGE + 10);
  });
});
