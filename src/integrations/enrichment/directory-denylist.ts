/**
 * Hosts that are directories, social profiles, marketplaces, or aggregators — never
 * an official business website. Matched against the registrable host (suffix match).
 */
const DENYLISTED_HOSTS = [
  'facebook.com',
  'instagram.com',
  'twitter.com',
  'x.com',
  'linkedin.com',
  'tiktok.com',
  'youtube.com',
  'yelp.com',
  'yell.com',
  'tripadvisor.com',
  'tripadvisor.co.uk',
  'google.com',
  'google.co.uk',
  'goo.gl',
  'maps.google.com',
  'g.page',
  'bing.com',
  'foursquare.com',
  'trustpilot.com',
  'thomsonlocal.com',
  'scoot.co.uk',
  'cylex-uk.co.uk',
  'freeindex.co.uk',
  'checkatrade.com',
  'bark.com',
  'nextdoor.com',
  'amazon.com',
  'ebay.com',
  'booking.com',
  'justeat.co.uk',
  'deliveroo.co.uk',
  'wa.me',
  'linktr.ee',
];

export function isDirectoryHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^www\./, '');
  return DENYLISTED_HOSTS.some((d) => h === d || h.endsWith(`.${d}`));
}
