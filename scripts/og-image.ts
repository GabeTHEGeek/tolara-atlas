/**
 * Renders public/og.png, the 1200x630 preview image shown when a Tolara Scout
 * link is shared (og:image). It carries no live numbers, so it never goes out
 * of date; rerun only when the brand or tagline changes:
 *   npx tsx scripts/og-image.ts
 */
import { chromium } from "playwright";

const html = `<!doctype html><html><head><style>
body{margin:0;width:1200px;height:630px;font-family:Geist,Inter,-apple-system,"Segoe UI",sans-serif;background:#0a2540;color:#f6f9fc;overflow:hidden;position:relative}
.rib{position:absolute;left:-10%;right:-10%;top:560px;height:300px;transform:skewY(-6deg);background:linear-gradient(110deg,#0fb89a,#45c8ff 35%,#7a5af8 68%,#ff8a4c)}
.in{position:relative;padding:72px 80px}
.b{display:flex;align-items:center;gap:16px;font-size:34px;font-weight:700;letter-spacing:-.02em}
.m{width:56px;height:56px;border-radius:14px;background:#f6f9fc;color:#0a2540;display:grid;place-items:center;font-weight:800;font-size:30px}
h1{font-size:92px;line-height:.98;letter-spacing:-.05em;margin:56px 0 0;font-weight:800}
h1 s{color:rgba(246,249,252,.55);text-decoration-thickness:.07em}
p{font-size:30px;margin:26px 0 0;color:rgba(246,249,252,.82)}
</style></head><body><div class="rib"></div><div class="in">
<div class="b"><span class="m">T</span>Tolara Scout</div>
<h1>Every real PM job.<br><s>None of the ghosts.</s></h1>
<p>Every open US product manager role, with the pay. Updated daily.</p>
</div></body></html>`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 630 } });
await page.setContent(html);
await page.screenshot({ path: "public/og.png" });
await browser.close();
console.log("wrote public/og.png");
