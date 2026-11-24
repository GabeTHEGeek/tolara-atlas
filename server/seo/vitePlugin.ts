/**
 * server/seo/vitePlugin.ts
 * Runs the SEO generator (generate.ts) during `vite build` only:
 *  - index.html gets a real title, description, social cards, structured
 *    data, and a pre-rendered copy of the landing page's facts and FAQ
 *    inside #root, which React replaces when the app loads;
 *  - the static pages, sitemap.xml, robots.txt and llms.txt are written
 *    next to the app in the build output.
 *
 * SITE_URL (vite.config.ts) is the public address the pages point to.
 */

import fs from "node:fs";
import path from "node:path";
import type { Plugin, ResolvedConfig } from "vite";
import { generateSeo, type CompanyFile, type SeoOutput } from "./generate.js";
import type { MapData } from "../../src/types.js";

export function seoPages(siteUrl: string, gaId: string | null = null): Plugin {
  let config: ResolvedConfig;
  let out: SeoOutput | null = null;

  const generate = (): SeoOutput | null => {
    if (out) return out;
    const dataDir = path.join(config.publicDir, "data");
    const mapPath = path.join(dataDir, "map-data.json");
    if (!fs.existsSync(mapPath)) {
      config.logger.warn("[seo] public/data/map-data.json is missing; run `npm run export`. Skipping SEO pages.");
      return null;
    }
    const data = JSON.parse(fs.readFileSync(mapPath, "utf8")) as MapData;
    const companies = new Map<string, CompanyFile>();
    const companyDir = path.join(dataDir, "companies");
    for (const file of fs.existsSync(companyDir) ? fs.readdirSync(companyDir) : []) {
      if (!file.endsWith(".json")) continue;
      const parsed = JSON.parse(fs.readFileSync(path.join(companyDir, file), "utf8")) as CompanyFile;
      if (parsed?.company?.slug && Array.isArray(parsed.roles)) companies.set(parsed.company.slug, parsed);
    }
    out = generateSeo({ data, companies, siteUrl, gaId });
    return out;
  };

  return {
    name: "tolara-seo-pages",
    apply: "build",
    configResolved(resolved) {
      config = resolved;
    },
    transformIndexHtml(html) {
      const seo = generate();
      if (!seo) return html;
      const title = seo.homeHead.match(/og:title" content="([^"]*)"/)?.[1];
      return html
        .replace(/<title>[^<]*<\/title>/, title ? `<title>${title}</title>` : "$&")
        .replace("</head>", `    ${seo.homeHead}\n  </head>`)
        .replace('<div id="root"></div>', `<div id="root">${seo.homeBody}</div>`);
    },
    closeBundle() {
      const seo = generate();
      if (!seo) return;
      const outDir = path.resolve(config.root, config.build.outDir);
      for (const [rel, contents] of seo.files) {
        const target = path.join(outDir, rel);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, contents);
      }
      config.logger.info(`[seo] wrote ${seo.pageCount} pages, sitemap.xml, robots.txt and llms.txt for ${siteUrl}`);
    },
  };
}
