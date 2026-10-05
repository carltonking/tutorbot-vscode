// Renders images/icon.png (128×128, the Marketplace icon): node demo/make-icon.mjs images/icon.png
import { chromium } from "playwright-core";
const out = process.argv[2];
const b = await chromium.launch({ executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" });
const p = await b.newPage({ viewport: { width: 128, height: 128 }, deviceScaleFactor: 1 });
await p.setContent(`<html><body style="margin:0;background:transparent">
<div style="width:128px;height:128px;border-radius:28px;background:linear-gradient(160deg,#2b2b2b,#141414);display:grid;place-items:center">
<svg width="86" height="86" viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 9.5 12 5l10 4.5-10 4.5z"/><path d="M6 11.3V16c0 1.4 2.7 3 6 3s6-1.6 6-3v-4.7"/><path d="M22 9.5v5"/></svg></div></body></html>`);
await p.screenshot({ path: out, omitBackground: true });
await b.close();
