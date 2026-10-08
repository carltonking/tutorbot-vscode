import { spawn, spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { cpus, homedir, tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join } from "node:path";

// ────────────────────────────────────────────────────────────────────────────
// run-code — executes a short snippet so quiz answers can be checked against
// ground truth instead of the model's own (sometimes wrong) mental trace, and
// runs exercise programs against their tests.
//
// Snippets are written to a fresh temp dir and run with a hard timeout. Java
// snippets may be a bare statement list, a set of methods including main, or a
// full class; they are wrapped as needed and run with the single-file source
// launcher (`java Main.java`). Exercise programs are compiled once (javac) and
// then run per test, so compile time never eats into a test's time budget.
//
// The code is untrusted (learner code, and model-written code): it runs with a
// minimal environment (no API keys), in its own process group (so everything
// it spawns dies with it) and, on macOS, under sandbox-exec: no network, no
// writes outside its temp dir, no reads of the user's home except toolchains.
// ────────────────────────────────────────────────────────────────────────────

export const SUPPORTED_LANGUAGES = ["java", "python", "javascript"] as const;
export type Language = (typeof SUPPORTED_LANGUAGES)[number];

export interface RunResult {
	ok: boolean; // exited 0 and did not time out
	stdout: string;
	stderr: string;
	exitCode: number | null;
	timedOut: boolean;
	compileError: boolean;
	missing?: string; // the interpreter/compiler isn't installed (e.g. "java")
	aborted?: boolean; // cancelled by the caller (superseded check)
}

export interface RunOptions {
	signal?: AbortSignal;
	timeoutMs?: number;
}

export const TIMEOUT_MS = 8_000;
const COMPILE_TIMEOUT_MS = 30_000;
const MAX_OUTPUT = 20_000;
// Every run takes a slot: a typing storm can't pile up a dozen JVMs.
const MAX_CONCURRENT = Math.max(2, Math.min(4, Math.floor((cpus().length || 2) / 2)));
// Lean JVM startup; and the learner's output is UTF-8 whatever the locale.
const JVM_FLAGS = ["-XX:+UseSerialGC", "-XX:-UsePerfData", "-Dstdout.encoding=UTF-8", "-Dstderr.encoding=UTF-8"];

// ── concurrency ─────────────────────────────────────────────────────────────
let active = 0;
const waiting: Array<() => void> = [];

async function slot(signal?: AbortSignal): Promise<(() => void) | undefined> {
	if (active >= MAX_CONCURRENT) {
		const got = await new Promise<boolean>((resolve) => {
			const go = () => {
				signal?.removeEventListener("abort", cancel);
				resolve(true);
			};
			const cancel = () => {
				const i = waiting.indexOf(go);
				if (i >= 0) waiting.splice(i, 1);
				resolve(false);
			};
			waiting.push(go);
			signal?.addEventListener("abort", cancel, { once: true });
		});
		if (!got) return undefined;
	} else active++;
	let released = false;
	return () => {
		if (released) return;
		released = true;
		// Hand the slot straight to the next waiter (the count stays the same).
		const next = waiting.shift();
		if (next) next();
		else active--;
	};
}

// ── source preparation ──────────────────────────────────────────────────────

// `package x.y;` would make the launcher/javac look for a folder tree. Blank it
// on the same line so compile-error line numbers stay right.
function stripPackage(code: string): string {
	return code.replace(/^(\s*)package\s+[\w.]+\s*;/m, "$1/* package removed */");
}

// Comments and string literals blanked out, so "public class Greeter" in a
// header comment or a println isn't mistaken for the program's class.
function codeOnly(code: string): string {
	return code.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])'/g, (m) => m.replace(/[^\n]/g, " "));
}

function prepareJava(code: string): { file: string; source: string; mainClass: string } {
	code = stripPackage(code);
	const bare = codeOnly(code);
	const named = bare.match(/\bpublic\s+(?:(?:final|abstract|sealed|strictfp)\s+)*(?:class|record|enum|interface)\s+(\w+)/);
	if (named) return { file: `${named[1]}.java`, source: code, mainClass: named[1] };
	// The launcher runs the first top-level class; with javac it's named explicitly.
	const first = bare.match(/\bclass\s+(\w+)/);
	if (first) return { file: "Main.java", source: code, mainClass: first[1] };

	// Hoist imports out of the snippet before wrapping it in a class.
	const imports: string[] = [];
	const body = code
		.split("\n")
		.filter((line) => {
			if (/^\s*import\s+[\w.*]+\s*;\s*$/.test(line)) {
				imports.push(line.trim());
				return false;
			}
			return true;
		})
		.join("\n");
	const header = ["import java.util.*;", ...imports].join("\n");
	const wrapped = /static\s+void\s+main\s*\(/.test(body)
		? `public class Main {\n${body}\n}`
		: `public class Main {\npublic static void main(String[] args) throws Exception {\n${body}\n}\n}`;
	return { file: "Main.java", source: `${header}\n${wrapped}\n`, mainClass: "Main" };
}

// CommonJS unless the code is an ES module (top-level import/export/await):
// `require` then works as learners expect from Node tutorials.
export function jsFileName(code: string): string {
	const esm = /^\s*(?:import\s*[\w{*"'$]|export\s)/m.test(code) || /^(?:(?:const|let|var)\s+[\w${}\s,[\]]+=\s*)?await\s/m.test(code);
	return esm ? "main.mjs" : "main.cjs";
}

// ── environment & sandbox ───────────────────────────────────────────────────

// Allowlist, not a denylist: learner and model-written code must never see API
// keys, brokerage keys, SSH agent sockets or TutorBot's own variables.
// ELECTRON_RUN_AS_NODE stays: JavaScript runs on the same Node.js as TutorBot
// (VS Code's own when bundled). HOME/TMPDIR point into the run's temp dir.
const ENV_KEEP = /^(PATH|LANG|LC_\w+|JAVA_HOME|ELECTRON_RUN_AS_NODE|PYENV_ROOT|PYENV_VERSION|ASDF_DIR|ASDF_DATA_DIR|SDKMAN_DIR|VOLTA_HOME|NVM_DIR|CONDA_PREFIX|VIRTUAL_ENV|SYSTEMROOT|SystemRoot|COMSPEC|PATHEXT|WINDIR)$/;

export function codeEnv(dir: string): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const [k, v] of Object.entries(process.env)) if (ENV_KEEP.test(k) && v !== undefined) env[k] = v;
	const home = homedir();
	// Version-manager shims find their install via $HOME; keep them pointed at the real one.
	if (!env.PYENV_ROOT && existsSync(join(home, ".pyenv"))) env.PYENV_ROOT = join(home, ".pyenv");
	if (!env.ASDF_DATA_DIR && existsSync(join(home, ".asdf"))) env.ASDF_DATA_DIR = join(home, ".asdf");
	env.HOME = dir;
	env.TMPDIR = dir;
	env.PYTHONIOENCODING = "utf-8";
	env.PYTHONDONTWRITEBYTECODE = "1";
	return env;
}

function real(p: string): string {
	try {
		return realpathSync(p);
	} catch {
		return p;
	}
}

const resolved = new Map<string, string | undefined>();
// The executable's full path, or undefined if it isn't on PATH.
function which(cmd: string): string | undefined {
	if (isAbsolute(cmd)) return existsSync(cmd) ? cmd : undefined;
	const key = `${process.env.PATH}\0${cmd}`;
	if (resolved.has(key)) return resolved.get(key);
	let found: string | undefined;
	const exts = process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];
	for (const d of (process.env.PATH ?? "").split(delimiter)) {
		if (!d) continue;
		for (const e of exts) {
			const p = join(d, cmd + e);
			try {
				accessSync(p, constants.X_OK);
				found = p;
				break;
			} catch {
				// keep looking
			}
		}
		if (found) break;
	}
	resolved.set(key, found);
	return found;
}

const sbString = (p: string) => `"${p.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

// Folders under the home dir that interpreters legitimately read: version
// managers, per-user JDKs and Python packages, and wherever PATH's tools live.
function homeToolchainDirs(home: string, exe: string | undefined): string[] {
	const dirs = [".local/share/fnm", ".local/state/fnm_multishells", ".fnm", ".nvm", ".volta", ".pyenv", ".asdf", ".sdkman", ".jdks", ".conda", "miniconda3", "anaconda3", "miniforge3", ".rye", ".local/bin", ".local/lib", ".local/pipx", "Library/Java", "Library/Python", "Library/pnpm"].map((d) => join(home, d));
	const add = (p: string) => {
		const r = real(p);
		if (r.startsWith(`${home}/`)) dirs.push(r, dirname(r));
	};
	for (const d of (process.env.PATH ?? "").split(delimiter)) if (d.startsWith(`${home}/`)) add(d);
	if (exe) add(dirname(real(exe)));
	add(dirname(real(process.execPath)));
	if (process.env.JAVA_HOME) add(process.env.JAVA_HOME);
	if (process.env.VIRTUAL_ENV) add(process.env.VIRTUAL_ENV);
	// Never the home folder itself (a tool installed straight into ~/bin).
	return [...new Set(dirs)].filter((d) => d !== home);
}

// macOS Seatbelt profile. The last matching rule wins.
export function sandboxProfile(dir: string, exe?: string): string {
	const home = real(homedir());
	const runDir = real(dir);
	const toolchains = homeToolchainDirs(home, exe)
		.map((d) => `(subpath ${sbString(d)})`)
		.join(" ");
	const secrets = [".ssh", ".pi", ".config", ".aws", ".gnupg", ".netrc", ".docker", ".kube", "Library/Keychains", "Library/Mobile Documents", "Library/Application Support", "Library/Cookies"];
	return [
		"(version 1)",
		"(allow default)",
		// No network at all (also blocks unix sockets such as SSH_AUTH_SOCK).
		"(deny network*)",
		// No launching browsers/apps (`open URL` would sidestep the network ban),
		// no keychain, no Apple Events.
		'(deny mach-lookup (global-name "com.apple.coreservices.launchservicesd") (global-name "com.apple.SecurityServer") (global-name "com.apple.securityd"))',
		"(deny appleevent-send)",
		'(deny process-exec (literal "/usr/bin/open") (literal "/usr/bin/osascript"))',
		// Writes only inside the run's temp dir (and /dev: null, tty, fds).
		"(deny file-write*)",
		`(allow file-write* (subpath ${sbString(runDir)}) (subpath "/dev"))`,
		// Nothing under the home folder (keys, notes, the learner's vault), except toolchains.
		`(deny file-read* (subpath ${sbString(home)}))`,
		`(allow file-read-metadata (subpath ${sbString(home)}))`,
		toolchains ? `(allow file-read* ${toolchains})` : "",
		`(allow file-read* (subpath ${sbString(runDir)}))`,
		// Credentials stay unreadable even if a toolchain path covers them.
		`(deny file-read* ${secrets.map((d) => `(subpath ${sbString(join(home, d))})`).join(" ")})`,
	]
		.filter(Boolean)
		.join("\n");
}

const SANDBOX_EXEC = "/usr/bin/sandbox-exec";
let sandboxUsable: boolean | undefined;
function canSandbox(): boolean {
	if (process.platform !== "darwin") return false;
	// Probe once: sandbox-exec can be missing, or refuse to nest inside another sandbox.
	sandboxUsable ??= existsSync(SANDBOX_EXEC) && spawnSync(SANDBOX_EXEC, ["-p", "(version 1)(allow default)", "/usr/bin/true"], { timeout: 5000 }).status === 0;
	return sandboxUsable;
}

// Resource limits that don't hurt the JVM: file size (≈50MB) and CPU seconds.
// (No process-count limit: RLIMIT_NPROC is per user, not per run, on macOS.)
const ULIMIT = 'ulimit -f 100000 2>/dev/null; ulimit -t 60 2>/dev/null; exec "$@"';

// ── running ─────────────────────────────────────────────────────────────────

function emptyResult(extra: Partial<RunResult>): RunResult {
	return { ok: false, stdout: "", stderr: "", exitCode: null, timedOut: false, compileError: false, ...extra };
}

function missingResult(cmd: string): RunResult {
	const name = cmd === process.execPath ? "node" : cmd;
	return emptyResult({ missing: name, stderr: `${name} isn't installed or isn't on PATH` });
}

function killGroup(pid: number | undefined) {
	if (!pid) return;
	try {
		if (process.platform === "win32") process.kill(pid, "SIGKILL");
		else process.kill(-pid, "SIGKILL");
	} catch {
		// already gone
	}
}

async function run(cmd: string, args: string[], cwd: string, stdin: string | undefined, opts: RunOptions = {}): Promise<RunResult> {
	const exe = cmd === process.execPath ? cmd : which(cmd);
	if (!exe) return missingResult(cmd);
	if (opts.signal?.aborted) return emptyResult({ aborted: true });
	const release = await slot(opts.signal);
	if (!release) return emptyResult({ aborted: true });
	try {
		return await runNow(exe, cmd, args, cwd, stdin, opts);
	} finally {
		release();
	}
}

function runNow(exe: string, cmd: string, args: string[], cwd: string, stdin: string | undefined, opts: RunOptions): Promise<RunResult> {
	const posix = process.platform !== "win32";
	const sandboxed = canSandbox();
	let file = exe;
	let argv = args;
	if (posix) {
		argv = ["-c", ULIMIT, "sh", exe, ...args];
		file = "/bin/sh";
		if (sandboxed) {
			argv = ["-p", sandboxProfile(cwd, exe), file, ...argv];
			file = SANDBOX_EXEC;
		}
	}
	return new Promise((resolve) => {
		// detached: its own process group, so the whole tree can be killed at once.
		const child = spawn(file, argv, { cwd, env: codeEnv(cwd), stdio: ["pipe", "pipe", "pipe"], detached: posix });
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		let aborted = false;
		let done = false;
		const finish = (r: RunResult) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			opts.signal?.removeEventListener("abort", onAbort);
			killGroup(child.pid); // leftover grandchildren (a forgotten subprocess) die too
			resolve(r);
		};
		const timer = setTimeout(() => {
			timedOut = true;
			killGroup(child.pid);
		}, opts.timeoutMs ?? TIMEOUT_MS);
		const onAbort = () => {
			aborted = true;
			killGroup(child.pid);
		};
		opts.signal?.addEventListener("abort", onAbort, { once: true });
		child.stdout.on("data", (d) => {
			if (stdout.length < MAX_OUTPUT) stdout += d.toString();
		});
		child.stderr.on("data", (d) => {
			if (stderr.length < MAX_OUTPUT) stderr += d.toString();
		});
		child.stdin.on("error", () => {}); // the program exited without reading its input
		child.on("error", (e: NodeJS.ErrnoException) => {
			if (e.code === "ENOENT") return finish(missingResult(cmd));
			finish(emptyResult({ stderr: `${stderr}${e.message}`, timedOut, aborted }));
		});
		const settle = (exitCode: number | null) => {
			if (done) return;
			// macOS's /usr/bin/java stub exists even when no JDK is installed.
			if (exitCode !== 0 && !stdout && /Unable to locate a Java Runtime|No Java runtime present/.test(stderr)) return finish(missingResult(cmd === "javac" ? "java" : cmd));
			const compileError = /^javac?$/.test(cmd) && /error: compilation failed|\.java:\d+: error:/.test(stderr);
			finish({ ok: exitCode === 0 && !timedOut && !aborted, stdout, stderr, exitCode, timedOut, compileError, aborted: aborted || undefined });
		};
		// Settle on exit (not close): a grandchild holding the pipes open must not
		// stall the result. A short grace lets the last output arrive first.
		child.on("exit", (exitCode) => {
			const grace = setTimeout(() => settle(exitCode), 150);
			child.on("close", () => {
				clearTimeout(grace);
				settle(exitCode);
			});
		});
		child.stdin.end(stdin ?? "");
	});
}

function tempDir(): string {
	return mkdtempSync(join(tmpdir(), "quiz-verify-"));
}

export async function runCode(language: Language, code: string, stdin?: string, opts: RunOptions = {}): Promise<RunResult> {
	const dir = tempDir();
	try {
		if (language === "java") {
			const { file, source } = prepareJava(code);
			writeFileSync(join(dir, file), source);
			return await run("java", [...JVM_FLAGS, file], dir, stdin, opts);
		}
		if (language === "python") {
			writeFileSync(join(dir, "main.py"), code);
			return await run("python3", ["main.py"], dir, stdin, opts);
		}
		const file = jsFileName(code);
		writeFileSync(join(dir, file), code);
		return await run(process.execPath, [file], dir, stdin, opts);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

// ── exercise programs: compile once, run per test ───────────────────────────

export interface Program {
	// Set when the program can't run at all: compile/syntax error, missing tool, aborted.
	failure?: RunResult;
	run(stdin: string | undefined, signal?: AbortSignal): Promise<RunResult>;
	dispose(): void;
}

// Python syntax check that never runs the code: a SyntaxError raised at run
// time (eval, a bad import) is then a crash in one test, not "doesn't compile".
const PY_SYNTAX_CHECK = "src = open('main.py', encoding='utf-8').read()\ncompile(src, 'main.py', 'exec')\n";

export async function prepareProgram(language: Language, code: string, signal?: AbortSignal): Promise<Program> {
	const dir = tempDir();
	const dispose = () => rmSync(dir, { recursive: true, force: true });
	const failed = (failure: RunResult): Program => ({ failure, run: async () => failure, dispose });
	try {
		if (language === "java") {
			const { file, source, mainClass } = prepareJava(code);
			writeFileSync(join(dir, file), source);
			const c = await run("javac", ["-J-XX:+UseSerialGC", "-J-XX:-UsePerfData", "-encoding", "UTF-8", "-d", ".", file], dir, undefined, { signal, timeoutMs: COMPILE_TIMEOUT_MS });
			if (c.missing) return failed({ ...c, missing: "java", stderr: "java (a JDK, which includes javac) isn't installed or isn't on PATH" });
			if (!c.ok) return failed({ ...c, compileError: !c.aborted && !c.timedOut });
			return { run: (stdin, s) => run("java", [...JVM_FLAGS, "-cp", ".", mainClass], dir, stdin, { signal: s }), dispose };
		}
		if (language === "python") {
			writeFileSync(join(dir, "main.py"), code);
			writeFileSync(join(dir, "syntax_check.py"), PY_SYNTAX_CHECK);
			const c = await run("python3", ["syntax_check.py"], dir, undefined, { signal });
			if (c.missing) return failed(c);
			if (c.aborted || c.timedOut) return failed(c);
			if (!c.ok) {
				// Show the traceback without the checker's own frames.
				const stderr = c.stderr.replace(/^Traceback[\s\S]*?(?=^ {2}File "main\.py")/m, "");
				return failed({ ...c, stderr, compileError: true });
			}
			return { run: (stdin, s) => run("python3", ["main.py"], dir, stdin, { signal: s }), dispose };
		}
		const file = jsFileName(code);
		writeFileSync(join(dir, file), code);
		return { run: (stdin, s) => run(process.execPath, [file], dir, stdin, { signal: s }), dispose };
	} catch (e) {
		dispose();
		throw e;
	}
}

// ── output comparison ───────────────────────────────────────────────────────

// Whitespace-insensitive comparison form for program output vs. an answer:
// newlines and runs of spaces collapse, surrounding quotes/backticks drop, and
// a trailing parenthetical gloss ("A B (on separate lines)") is ignored.
// For quiz answers only — exercise tests use sameProgramOutput.
export function normalizeOutput(text: string): string {
	return text
		.replace(/\s*\((?:on |each |printed |separate|one per)[^)]*\)\s*$/i, "")
		.replace(/\s+/g, " ")
		.trim()
		.replace(/^["'`]+|["'`]+$/g, "")
		.trim();
}

// Exercise test form: exact text, line by line. Only line endings, trailing
// spaces on a line and trailing blank lines are forgiven — leading spaces
// (star patterns), line breaks (print vs println), quotes and case all count.
export function strictOutput(text: string): string {
	const lines = text
		.replace(/\r\n?/g, "\n")
		.split("\n")
		.map((l) => l.trimEnd());
	while (lines.length && lines[lines.length - 1] === "") lines.pop();
	return lines.join("\n");
}

export function sameProgramOutput(actual: string, expected: string): boolean {
	return strictOutput(actual) === strictOutput(expected);
}

export function describeFailure(r: RunResult): string {
	if (r.missing) return `${r.missing} isn't installed or isn't on PATH`;
	if (r.timedOut) return `timed out after ${TIMEOUT_MS / 1000}s (likely an infinite loop)`;
	const kind = r.compileError ? "compile error" : `exit code ${r.exitCode}`;
	return `${kind}:\n${r.stderr.trim().slice(0, 1500)}`;
}

// Does an option label describe a failed run (compile error / exception / hang)?
export function labelDescribesFailure(label: string, r: RunResult): boolean {
	if (r.timedOut) return /infinite|never (ends|stops|terminates)|forever|runs forever/i.test(label);
	return /error|exception|won'?t compile|does not compile|doesn'?t compile|crash/i.test(label);
}
