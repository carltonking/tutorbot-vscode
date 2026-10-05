import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, join, relative } from "node:path";
import { promisify } from "node:util";

// ────────────────────────────────────────────────────────────────────────────
// resources — makes the learner's class folders searchable.
//
// Every supported file is converted to plain text once and cached under
// Tutor/.data/index/ (re-extracted only when the file's mtime/size changes).
// PDFs keep page boundaries so search hits can cite "file, p. 12". Search is a
// simple, dependency-free term-frequency ranking over ~1,200-char chunks —
// good enough to find the lecture/slide/handout that covers a concept.
// ────────────────────────────────────────────────────────────────────────────

const run = promisify(execFile);

const TEXT_EXT = new Set([".md", ".txt", ".tex", ".java", ".py", ".js", ".ts", ".c", ".cpp", ".h", ".csv", ".html", ".htm", ".json", ".r", ".sql", ".m"]);
const DOC_EXT = new Set([".docx", ".doc", ".rtf", ".rtfd", ".odt", ".pages"]);
const SUPPORTED = new Set([...TEXT_EXT, ...DOC_EXT, ".pdf", ".pptx", ".ipynb"]);
const SKIP_DIRS = new Set(["node_modules", ".git", ".obsidian", ".trash", "__pycache__", ".venv", ".data"]);
const MAX_FILE_BYTES = 60 * 1024 * 1024;
const CHUNK = 1200;

export interface IndexedFile {
	path: string;
	mtimeMs: number;
	size: number;
	cache: string; // cache file name inside the index dir
	pages: number;
	error?: string;
}

interface Manifest {
	files: Record<string, IndexedFile>;
	builtAt?: string;
}

export interface SearchHit {
	path: string;
	page?: number;
	score: number;
	snippet: string;
}

export class ResourceIndex {
	readonly dir: string;
	private manifestPath: string;

	constructor(dataDir: string) {
		this.dir = join(dataDir, "index");
		mkdirSync(this.dir, { recursive: true });
		this.manifestPath = join(this.dir, "manifest.json");
	}

	private loadManifest(): Manifest {
		try {
			return JSON.parse(readFileSync(this.manifestPath, "utf8"));
		} catch {
			return { files: {} };
		}
	}

	private saveManifest(m: Manifest): void {
		writeFileSync(this.manifestPath, JSON.stringify(m));
	}

	listFiles(folders: string[]): string[] {
		const out: string[] = [];
		const walk = (d: string, depth: number) => {
			if (depth > 12) return;
			let entries;
			try {
				entries = readdirSync(d, { withFileTypes: true });
			} catch {
				return;
			}
			for (const e of entries) {
				if (e.name.startsWith(".") || SKIP_DIRS.has(e.name)) continue;
				const p = join(d, e.name);
				if (e.isDirectory()) walk(p, depth + 1);
				else if (SUPPORTED.has(extname(e.name).toLowerCase())) out.push(p);
			}
		};
		for (const f of folders) walk(f, 0);
		return out;
	}

	// Build or refresh the index. Unchanged files are skipped, so re-running is cheap.
	async build(folders: string[], onProgress?: (done: number, total: number, file: string) => void, signal?: AbortSignal) {
		const manifest = this.loadManifest();
		const files = this.listFiles(folders);
		const seen = new Set<string>();
		let extracted = 0;
		let failed = 0;
		for (let i = 0; i < files.length; i++) {
			if (signal?.aborted) break;
			const path = files[i];
			seen.add(path);
			let st;
			try {
				st = statSync(path);
			} catch {
				continue;
			}
			const prev = manifest.files[path];
			if (prev && prev.mtimeMs === st.mtimeMs && prev.size === st.size && !prev.error) continue;
			onProgress?.(i + 1, files.length, path);
			const cache = `${createHash("sha1").update(path).digest("hex")}.txt`;
			const entry: IndexedFile = { path, mtimeMs: st.mtimeMs, size: st.size, cache, pages: 1 };
			try {
				if (st.size > MAX_FILE_BYTES) throw new Error("file too large");
				const pages = await extractPages(path);
				entry.pages = pages.length;
				// Pages are separated by form feeds in the cache file.
				writeFileSync(join(this.dir, cache), pages.join("\f"));
				extracted++;
			} catch (e) {
				entry.error = (e as Error).message.slice(0, 200);
				failed++;
			}
			manifest.files[path] = entry;
		}
		// Drop files that were deleted or whose folder was removed from the config.
		for (const p of Object.keys(manifest.files)) if (!seen.has(p)) delete manifest.files[p];
		manifest.builtAt = new Date().toISOString();
		this.saveManifest(manifest);
		const total = Object.values(manifest.files).filter((f) => !f.error).length;
		return { total, extracted, failed, scanned: files.length };
	}

	stats() {
		const m = this.loadManifest();
		const files = Object.values(m.files);
		return { builtAt: m.builtAt, files: files.filter((f) => !f.error).length, errors: files.filter((f) => f.error).length };
	}

	readPages(path: string, from?: number, to?: number): { text: string; pages: number } | undefined {
		const m = this.loadManifest();
		const f = m.files[path] ?? Object.values(m.files).find((x) => x.path.endsWith(path) || basename(x.path) === path);
		if (!f || f.error) return undefined;
		const pages = readFileSync(join(this.dir, f.cache), "utf8").split("\f");
		const a = Math.max(1, from ?? 1);
		const b = Math.min(pages.length, to ?? a + 4);
		const text = pages
			.slice(a - 1, b)
			.map((p, i) => (pages.length > 1 ? `── page ${a + i} ──\n${p.trim()}` : p.trim()))
			.join("\n\n");
		return { text, pages: pages.length };
	}

	// Indexed (readable) files under the given folders.
	indexedFiles(folders: string[]): IndexedFile[] {
		return Object.values(this.loadManifest().files).filter((f) => !f.error && folders.some((dir) => f.path.startsWith(dir)));
	}

	search(query: string, folders: string[], limit = 8, pathFilter?: string | RegExp): SearchHit[] {
		const terms = tokenize(query);
		if (!terms.length) return [];
		const m = this.loadManifest();
		const hits: SearchHit[] = [];
		const filter = typeof pathFilter === "string" ? pathFilter.toLowerCase() : undefined;
		const filterRe = pathFilter instanceof RegExp ? pathFilter : undefined;
		for (const f of Object.values(m.files)) {
			if (f.error) continue;
			if (!folders.some((dir) => f.path.startsWith(dir))) continue;
			if (filter && !f.path.toLowerCase().includes(filter)) continue;
			if (filterRe && !filterRe.test(f.path)) continue;
			let pages: string[];
			try {
				pages = readFileSync(join(this.dir, f.cache), "utf8").split("\f");
			} catch {
				continue;
			}
			const nameBoost = terms.filter((t) => f.path.toLowerCase().includes(t)).length * 2;
			pages.forEach((pageText, pi) => {
				for (let off = 0; off < pageText.length; off += CHUNK) {
					const chunk = pageText.slice(Math.max(0, off - 150), off + CHUNK);
					const lower = chunk.toLowerCase();
					let score = 0;
					let matched = 0;
					for (const t of terms) {
						const n = countOccurrences(lower, t);
						if (n) matched++;
						score += Math.min(n, 5);
					}
					if (!matched) continue;
					score = score * (matched / terms.length) ** 2 + nameBoost;
					if (matched === terms.length && lower.includes(terms.join(" "))) score += 5;
					hits.push({
						path: f.path,
						page: pages.length > 1 ? pi + 1 : undefined,
						score,
						snippet: chunk.replace(/\s+/g, " ").trim().slice(0, 500),
					});
				}
			});
		}
		hits.sort((a, b) => b.score - a.score);
		// At most two hits per file so one long PDF doesn't crowd out the rest.
		const perFile = new Map<string, number>();
		const out: SearchHit[] = [];
		for (const h of hits) {
			const n = perFile.get(h.path) ?? 0;
			if (n >= 2) continue;
			perFile.set(h.path, n + 1);
			out.push(h);
			if (out.length >= limit) break;
		}
		return out;
	}
}

const STOP = new Set(["the", "a", "an", "of", "and", "or", "to", "in", "is", "for", "on", "with", "what", "how", "why", "are", "be", "by", "it", "as", "at", "that", "this"]);

function tokenize(q: string): string[] {
	return [...new Set(q.toLowerCase().split(/[^a-z0-9_+#.]+/).filter((t) => t.length > 1 && !STOP.has(t)))];
}

function countOccurrences(hay: string, needle: string): number {
	let n = 0;
	let i = hay.indexOf(needle);
	while (i !== -1) {
		n++;
		i = hay.indexOf(needle, i + needle.length);
	}
	return n;
}

async function extractPages(path: string): Promise<string[]> {
	const ext = extname(path).toLowerCase();
	const opts = { maxBuffer: 200 * 1024 * 1024, timeout: 120_000 };
	if (ext === ".pdf") {
		const { stdout } = await run("pdftotext", ["-layout", "-enc", "UTF-8", path, "-"], opts);
		const pages = stdout.split("\f");
		if (pages.length > 1 && !pages[pages.length - 1].trim()) pages.pop();
		return pages;
	}
	if (DOC_EXT.has(ext)) {
		const { stdout } = await run("textutil", ["-convert", "txt", "-stdout", path], opts);
		return [stdout];
	}
	if (ext === ".pptx") {
		// One "page" per slide, in slide order, text pulled from the slide XML.
		const { stdout: list } = await run("unzip", ["-Z1", path], opts);
		const slides = list
			.split("\n")
			.filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
			.sort((a, b) => Number(a.match(/\d+/)![0]) - Number(b.match(/\d+/)![0]));
		const pages: string[] = [];
		for (const s of slides) {
			const { stdout: xml } = await run("unzip", ["-p", path, s], opts);
			pages.push(xmlText(xml));
		}
		return pages.length ? pages : [""];
	}
	if (ext === ".ipynb") {
		const nb = JSON.parse(readFileSync(path, "utf8"));
		return [(nb.cells ?? []).map((c: any) => [].concat(c.source ?? []).join("")).join("\n\n")];
	}
	const text = readFileSync(path, "utf8");
	return [ext === ".html" || ext === ".htm" ? xmlText(text) : text];
}

function xmlText(xml: string): string {
	return xml
		.replace(/<\/a:p>|<br\s*\/?>|<\/p>/g, "\n")
		.replace(/<[^>]+>/g, " ")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&apos;|&#39;/g, "'")
		.replace(/[ \t]+/g, " ")
		.replace(/\n\s+/g, "\n")
		.trim();
}

export function displayPath(path: string, folders: string[]): string {
	const root = folders.find((f) => path.startsWith(f));
	return root ? join(basename(root), relative(root, path)) : path;
}

export function folderExists(p: string): boolean {
	try {
		return existsSync(p) && statSync(p).isDirectory();
	} catch {
		return false;
	}
}

// Files that look like assessments the teacher gives (quizzes, exams, homework,
// problem sets, practice/review sheets), matched on the file path.
export const ASSESSMENT_PATH = /(quiz|exam|test|midterm|final|hw\d|homework|assignment|problem[ _-]?set|pset|practice|review|worksheet|lab\d|lab[ _-]|checkpoint)/i;
// Answer keys / solutions: useful to see the teacher's expected rigor.
export const ANSWER_KEY_PATH = /(answer|solution|key|sol\b)/i;
