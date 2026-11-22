/**
 * ingestion/payOnCompanySite.ts
 * Companies that publish a role's pay band only on their own careers page,
 * not in the posting text their job board (Greenhouse) serves. Stripe is
 * the case that found this: its Greenhouse posting ends at the
 * requirements, while stripe.com/careers/listing/... adds "The annual US
 * base salary range for this role is $214,300 - $321,500."
 *
 * fetchDescriptions.ts reads the band from that page for roles without
 * one, and sync.ts keeps it afterwards: the board's own text saying
 * nothing about pay doesn't mean the pay is gone.
 *
 * Only hosts confirmed to serve the band in the page's HTML belong here
 * (not loaded later by JavaScript), so a nightly fetch actually finds it.
 */

const HOSTS = ["stripe.com"];

/**
 * Boards whose listing never carries pay, which fetchDescriptions.ts then
 * reads from each posting's own page: Meta's public_compensation field and
 * Apple's "Pay & Benefits" footer. Their listing text is a real summary,
 * often over 200 characters, so sync.ts can't tell from its length alone
 * that the band came from elsewhere.
 */
export const PAY_FROM_DETAIL_PAGE = ["meta", "apple"];

/** True when a role's posting URL is on a careers site that carries the pay its board's text leaves out. */
export function paysOnCompanySite(url: string | null | undefined): boolean {
  if (!url) return false;
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    return HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
  } catch {
    return false;
  }
}
