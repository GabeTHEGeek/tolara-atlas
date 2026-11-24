/**
 * social.ts
 * The links in the footer of the landing page and of every generated page
 * (server/seo). One list, so both stay the same.
 */

export const SOCIAL_LINKS: ReadonlyArray<{ label: string; href: string; icon: string }> = [
  {
    label: "X (Twitter)",
    href: "https://x.com/gabe_be_gabe",
    // Simple Icons "x" (CC0)
    icon: "M18.901 1.153h3.68l-8.04 9.19L24 22.846h-7.406l-5.8-7.584-6.638 7.584H.474l8.6-9.83L0 1.154h7.594l5.243 6.932ZM17.61 20.644h2.039L6.486 3.24H4.298Z",
  },
  {
    label: "LinkedIn",
    href: "https://www.linkedin.com/in/gpendleton/",
    // Simple Icons "linkedin" (CC0)
    icon: "M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 0 1-2.063-2.065 2.064 2.064 0 1 1 2.063 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z",
  },
  {
    label: "Website",
    href: "https://gabrielpendleton.me/",
    // A globe, drawn for this footer
    icon: "M12 0a12 12 0 1 0 0 24 12 12 0 0 0 0-24Zm7.93 11h-3.95a17.6 17.6 0 0 0-1.4-6.6A8.02 8.02 0 0 1 19.93 11ZM12 20.9c-.9-1.1-1.86-3.4-2-7.9h4c-.14 4.5-1.1 6.8-2 7.9ZM10 11c.14-4.5 1.1-6.8 2-7.9.9 1.1 1.86 3.4 2 7.9Zm-.58-6.6A17.6 17.6 0 0 0 8.02 11H4.07a8.02 8.02 0 0 1 5.35-6.6ZM4.07 13h3.95a17.6 17.6 0 0 0 1.4 6.6A8.02 8.02 0 0 1 4.07 13Zm10.51 6.6a17.6 17.6 0 0 0 1.4-6.6h3.95a8.02 8.02 0 0 1-5.35 6.6Z",
  },
];
