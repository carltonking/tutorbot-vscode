// Assembles runtime/: everything the extension needs to run TutorBot with no
// separate installs.
//
//   runtime/pi/      pi (the agent engine) + only its runtime dependencies
//   runtime/tutor/   TutorBot's pi extensions and the teach skill
//
// pi comes from the pinned devDependency; the tutor files come from the repo
// (../extensions, ../skills). Run by `vsce package` via vscode:prepublish.
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const EXT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = resolve(EXT, "..");
const OUT = join(EXT, "runtime");
const PI_NAME = "@earendil-works/pi-coding-agent";

// TutorBot's core pi extensions and skills. The visual/subagent tools need
// tmux and are not part of the VS Code build.
const TUTOR_EXTENSIONS = ["ask-user-question.ts", "quiz.ts", "exercises", "tutor", "lib"];
const TUTOR_SKILLS = ["teach"];
const TUTOR_DEPS = ["ts-fsrs"];

// Declared by a pi dependency but never loaded by pi itself: esbuild is only
// used by @earendil-works/chord's bundler entry, and ships a native binary
// that would make the extension platform-specific.
const EXCLUDE = new Set(["esbuild"]);

const SKIP = /(\.map|\.d\.[cm]?ts|\.md|\.markdown)$|[\\/](test|tests|__tests__|docs|examples)$/;
const copy = (from, to, filter = (s) => !SKIP.test(s)) => cpSync(from, to, { recursive: true, dereference: true, filter });

const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));

// Node's lookup: <dir>/node_modules/<name>, then each parent, up to EXT.
function findPackage(name, fromDir) {
	for (let dir = fromDir; ; dir = dirname(dir)) {
		const candidate = join(dir, "node_modules", name);
		if (existsSync(join(candidate, "package.json"))) return candidate;
		if (dir === EXT || dirname(dir) === dir) return undefined;
	}
}

// Where a resolved package lands under runtime/pi/node_modules, keeping npm's
// nesting so each package still resolves the same versions it did here.
function destFor(pkgDir, piDir) {
	const rootModules = join(EXT, "node_modules") + sep;
	const piModules = join(piDir, "node_modules") + sep;
	const rel = pkgDir.startsWith(piModules) ? pkgDir.slice(piModules.length) : relative(rootModules, pkgDir);
	return join(OUT, "pi", "node_modules", rel);
}

function dependencyClosure(rootDir) {
	const found = new Set();
	const missing = [];
	const stack = [rootDir];
	const visited = new Set();
	while (stack.length) {
		const dir = stack.pop();
		if (visited.has(dir)) continue;
		visited.add(dir);
		const pkg = readJson(join(dir, "package.json"));
		for (const name of Object.keys(pkg.dependencies ?? {})) {
			if (EXCLUDE.has(name)) continue;
			const dep = findPackage(name, dir);
			if (!dep) {
				missing.push(`${name} (needed by ${pkg.name})`);
				continue;
			}
			found.add(dep);
			stack.push(dep);
		}
	}
	return { found: [...found], missing };
}

rmSync(OUT, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
mkdirSync(OUT, { recursive: true });

// ── pi ──────────────────────────────────────────────────────────────────────
const piDir = findPackage(PI_NAME, EXT);
if (!piDir) throw new Error(`${PI_NAME} isn't installed. Run npm install in vscode-extension/.`);
const piVersion = readJson(join(piDir, "package.json")).version;
// Package root files + dist (the bundle and the assets it reads, e.g. themes).
// The unbundled dist/*.js modules are only for the SDK, so they're skipped.
copy(join(piDir, "package.json"), join(OUT, "pi", "package.json"));
copy(join(piDir, "dist"), join(OUT, "pi", "dist"), (src) => {
	if (SKIP.test(src)) return false;
	const rel = relative(join(piDir, "dist"), src);
	if (!rel || statSync(src).isDirectory()) return true;
	return rel.startsWith(`bundle${sep}`) || !/\.[cm]?js$/.test(rel);
});
const { found, missing } = dependencyClosure(piDir);
const optional = new Set(Object.keys(readJson(join(piDir, "package.json")).optionalDependencies ?? {}));
const hardMissing = missing.filter((m) => !optional.has(m.split(" ")[0]) && !m.startsWith("@types/"));
if (hardMissing.length) throw new Error(`pi dependencies not installed:\n  ${hardMissing.join("\n  ")}`);
const dests = new Map();
for (const dir of found) {
	const dest = destFor(dir, piDir);
	if (dests.has(dest) && dests.get(dest) !== dir) throw new Error(`two versions of one package map to ${dest}`);
	dests.set(dest, dir);
	copy(dir, dest);
}

// ── tutor ───────────────────────────────────────────────────────────────────
// Skills are Markdown, so the tutor copy keeps .md files.
const tutorFilter = (src) => !/[\\/]node_modules$/.test(src) && !/\.map$/.test(src);
for (const f of TUTOR_EXTENSIONS) copy(join(REPO, "extensions", f), join(OUT, "tutor", "extensions", f), tutorFilter);
for (const s of TUTOR_SKILLS) copy(join(REPO, "skills", s), join(OUT, "tutor", "skills", s), tutorFilter);
for (const d of TUTOR_DEPS) {
	const dir = findPackage(d, EXT);
	if (!dir) throw new Error(`${d} isn't installed. Run npm install in vscode-extension/.`);
	copy(dir, join(OUT, "tutor", "extensions", "node_modules", d));
}

console.log(`runtime/: pi ${piVersion} + ${found.length} packages, tutor (${TUTOR_EXTENSIONS.length} extension entries, skills: ${TUTOR_SKILLS.join(", ")})`);
