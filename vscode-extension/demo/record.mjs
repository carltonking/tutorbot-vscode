// Records the TutorBot demo (stage.html) to images/demo.mp4 and images/demo.gif.
//
//   node demo/gen-dashboard.cjs && node demo/record.mjs
//
// Serves vscode-extension/ to a headless Google Chrome (127.0.0.1, only for the
// recording), captures 2× frames with the DevTools screencast, and assembles
// exactly DURATION seconds from the moment the stage starts its timeline.
import { spawnSync } from "node:child_process";
import { createReadStream, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const EXT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BUILD = join(EXT, "demo", "build");
const FRAMES = join(BUILD, "frames");
const OUT = join(EXT, "images");
const DURATION = 15;
const W = 1280;
const H = 800;
const CHROME = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf", ".svg": "image/svg+xml" };
const server = createServer((req, res) => {
	const file = normalize(join(EXT, decodeURIComponent(new URL(req.url, "http://x").pathname)));
	if (!file.startsWith(EXT) || !existsSync(file) || !statSync(file).isFile()) return res.writeHead(404).end();
	res.writeHead(200, { "content-type": MIME[extname(file)] || "application/octet-stream" });
	createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${server.address().port}/demo/stage.html`;

rmSync(FRAMES, { recursive: true, force: true });
mkdirSync(FRAMES, { recursive: true });
mkdirSync(OUT, { recursive: true });

// The screencast captures the browser window, not the emulated viewport, so the
// window itself is sized to the stage at 2×.
const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: [`--window-size=${W},${H}`, "--force-device-scale-factor=2", "--hide-scrollbars"] });
const page = await browser.newPage({ viewport: null });
page.on("console", (m) => m.type() === "error" && console.error("page:", m.text()));
page.on("pageerror", (e) => console.error("page error:", e.message));

const cdp = await page.context().newCDPSession(page);
const frames = [];
cdp.on("Page.screencastFrame", async ({ data, metadata, sessionId }) => {
	const file = join(FRAMES, `f${String(frames.length).padStart(5, "0")}.jpg`);
	writeFileSync(file, Buffer.from(data, "base64"));
	frames.push({ file, t: metadata.timestamp });
	await cdp.send("Page.screencastFrameAck", { sessionId }).catch(() => {});
});

await page.goto(url);
// The window has some (hidden) browser UI: grow it until the page is W×H.
const { windowId } = await (await page.context().newCDPSession(page)).send("Browser.getWindowForTarget");
for (let i = 0; i < 3; i++) {
	const [iw, ih] = await page.evaluate(() => [innerWidth, innerHeight]);
	if (iw === W && ih === H) break;
	const browserCdp = await browser.newBrowserCDPSession();
	const { bounds } = await browserCdp.send("Browser.getWindowBounds", { windowId });
	await browserCdp.send("Browser.setWindowBounds", { windowId, bounds: { width: bounds.width + W - iw, height: bounds.height + H - ih } });
	await page.waitForTimeout(200);
}
const dims = await page.evaluate(() => [innerWidth, innerHeight, devicePixelRatio]);
if (dims[0] !== W || dims[1] !== H || dims[2] !== 2) throw new Error(`stage is ${dims[0]}×${dims[1]} @${dims[2]}x, expected ${W}×${H} @2x`);
await page.waitForFunction(() => window.__ready || window.__error, null, { timeout: 20000 });
await cdp.send("Page.startScreencast", { format: "jpeg", quality: 95, maxWidth: W * 2, maxHeight: H * 2, everyNthFrame: 1 });
await page.waitForTimeout(300); // let the first frames arrive
await page.evaluate(() => (window.__go = true));
await page.waitForFunction(() => window.__done || window.__error, null, { timeout: 40000 });
const { error, t0wall } = await page.evaluate(() => ({ error: window.__error, t0wall: window.__t0wall }));
await cdp.send("Page.stopScreencast");
await browser.close();
server.close();
if (error) throw new Error(`stage failed: ${error}`);
const t0 = t0wall / 1000; // the stage's t=0, on the same clock as frame timestamps

// Screencast frames arrive only when the page changes: hold each one until the next.
const usable = frames.filter((f) => f.t >= t0 - 0.5);
const list = [];
for (let i = 0; i < usable.length; i++) {
	const start = Math.max(usable[i].t, t0);
	const end = i + 1 < usable.length ? usable[i + 1].t : t0 + DURATION;
	if (end <= t0) continue;
	list.push(`file '${usable[i].file}'\nduration ${Math.max(0.001, end - start).toFixed(4)}`);
}
list.push(`file '${usable[usable.length - 1].file}'`);
writeFileSync(join(BUILD, "frames.txt"), list.join("\n") + "\n");
console.log(`${usable.length} frames captured`);

const ff = (args) => {
	const r = spawnSync("ffmpeg", ["-y", "-loglevel", "error", ...args], { stdio: "inherit" });
	if (r.status !== 0) throw new Error(`ffmpeg failed: ${args.join(" ")}`);
};
const input = ["-f", "concat", "-safe", "0", "-i", join(BUILD, "frames.txt")];
ff([...input, "-vf", `fps=30,scale=${W}:${H}:flags=lanczos,format=yuv420p`, "-t", String(DURATION), "-c:v", "libx264", "-preset", "slow", "-crf", "18", "-movflags", "+faststart", join(OUT, "demo.mp4")]);
ff(["-i", join(OUT, "demo.mp4"), "-vf", "fps=15,scale=960:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle", join(OUT, "demo.gif")]);
const size = (f) => `${(statSync(join(OUT, f)).size / 1e6).toFixed(1)} MB`;
console.log(`images/demo.mp4 (${size("demo.mp4")}), images/demo.gif (${size("demo.gif")})`);
