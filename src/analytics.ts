/**
 * analytics.ts
 * Google Analytics 4, on the live site only. The measurement ID comes from
 * VITE_GA_ID, which only the GitHub Pages build sets (.github/workflows/
 * pages.yml), so local development never sends anything. The ID is public:
 * it appears in every page that uses it.
 *
 * The app's pages are #-addresses, which Analytics doesn't see as page
 * changes, so this sends a page_view on every one itself.
 *
 * Events, for the "Generate leads" reports:
 *   generate_lead       a new signup on the landing page or the board preview
 *   login               "Already signed up?" with an email
 *   view_board_preview  someone opened the board before signing up
 * Never put names, emails or other personal details in an event.
 */

const env = (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env ?? {};
export const GA_ID = /^G-[A-Z0-9]+$/.test(env.VITE_GA_ID ?? "") ? env.VITE_GA_ID! : null;

type Gtag = (...args: unknown[]) => void;
declare global {
  interface Window {
    dataLayer?: unknown[];
    gtag?: Gtag;
  }
}

let started = false;

function pageView(): void {
  // "/tolara-atlas/#/jobs?sen=senior" -> "/tolara-atlas/jobs", so reports
  // group by view rather than by every filter combination.
  const route = window.location.hash.replace(/^#/, "").split("?")[0].replace(/\/$/, "");
  const path = route ? window.location.pathname.replace(/\/$/, "") + route : window.location.pathname;
  window.gtag?.("event", "page_view", {
    page_location: window.location.href,
    page_path: path,
    page_title: document.title,
  });
}

/** Loads Analytics once and starts counting page views. Does nothing without GA_ID. */
export function startAnalytics(): void {
  if (!GA_ID || started || typeof window === "undefined") return;
  started = true;
  window.dataLayer = window.dataLayer ?? [];
  window.gtag = function gtag() {
    // gtag.js reads the arguments object itself, not an array.
    // eslint-disable-next-line prefer-rest-params
    window.dataLayer!.push(arguments);
  };
  window.gtag("js", new Date());
  window.gtag("config", GA_ID, { send_page_view: false });
  const script = document.createElement("script");
  script.async = true;
  script.src = `https://www.googletagmanager.com/gtag/js?id=${GA_ID}`;
  document.head.appendChild(script);
  pageView();
  window.addEventListener("hashchange", pageView);
}

export function track(event: "generate_lead" | "login" | "view_board_preview", params: Record<string, string | number> = {}): void {
  window.gtag?.("event", event, params);
}
