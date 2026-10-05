import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ────────────────────────────────────────────────────────────────────────────
// run-code — executes a short snippet so quiz answers can be checked against
// ground truth instead of the model's own (sometimes wrong) mental trace.
//
// Snippets are written to a fresh temp dir and run with a hard timeout. Java
// snippets may be a bare statement list, a set of methods including main, or a
// full class; they are wrapped as needed and run with the single-file source
// launcher (`java Main.java`).
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
}

const TIMEOUT_MS = 8_000;
const MAX_OUTPUT = 20_000;

function prepareJava(code: string): { file: string; source: string } {
	const named = code.match(/public\s+(?:final\s+|abstract\s+)?class\s+(\w+)/);
	if (named) return { file: `${named[1]}.java`, source: code };
	if (/\bclass\s+\w+/.test(code)) return { file: "Main.java", source: code };

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
	return { file: "Main.java", source: `${header}\n${wrapped}\n` };
}

// Learner and model-written code never sees API keys or TutorBot's own
// variables. ELECTRON_RUN_AS_NODE stays: JavaScript runs on the same Node.js
// as TutorBot (VS Code's own when bundled).
function codeEnv(): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const [k, v] of Object.entries(process.env)) {
		if (/(_API_KEY|_TOKEN|_SECRET)$/i.test(k) || k.startsWith("TUTORBOT")) continue;
		env[k] = v;
	}
	return env;
}

function run(cmd: string, args: string[], cwd: string, stdin: string | undefined): Promise<RunResult> {
	return new Promise((resolve) => {
		const child = spawn(cmd, args, { cwd, env: codeEnv(), stdio: ["pipe", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGKILL");
		}, TIMEOUT_MS);
		child.stdout.on("data", (d) => {
			if (stdout.length < MAX_OUTPUT) stdout += d.toString();
		});
		child.stderr.on("data", (d) => {
			if (stderr.length < MAX_OUTPUT) stderr += d.toString();
		});
		child.on("error", (e) => {
			clearTimeout(timer);
			resolve({ ok: false, stdout, stderr: `${stderr}${e.message}`, exitCode: null, timedOut, compileError: false });
		});
		child.on("close", (exitCode) => {
			clearTimeout(timer);
			const compileError = cmd === "java" && /error: compilation failed|\.java:\d+: error:/.test(stderr);
			resolve({ ok: exitCode === 0 && !timedOut, stdout, stderr, exitCode, timedOut, compileError });
		});
		child.stdin.end(stdin ?? "");
	});
}

export async function runCode(language: Language, code: string, stdin?: string): Promise<RunResult> {
	const dir = mkdtempSync(join(tmpdir(), "quiz-verify-"));
	try {
		if (language === "java") {
			const { file, source } = prepareJava(code);
			writeFileSync(join(dir, file), source);
			return await run("java", [file], dir, stdin);
		}
		if (language === "python") {
			writeFileSync(join(dir, "main.py"), code);
			return await run("python3", ["main.py"], dir, stdin);
		}
		writeFileSync(join(dir, "main.mjs"), code);
		return await run(process.execPath, ["main.mjs"], dir, stdin);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

// Whitespace-insensitive comparison form for program output vs. an answer:
// newlines and runs of spaces collapse, surrounding quotes/backticks drop, and
// a trailing parenthetical gloss ("A B (on separate lines)") is ignored.
export function normalizeOutput(text: string): string {
	return text
		.replace(/\s*\((?:on |each |printed |separate|one per)[^)]*\)\s*$/i, "")
		.replace(/\s+/g, " ")
		.trim()
		.replace(/^["'`]+|["'`]+$/g, "")
		.trim();
}

export function describeFailure(r: RunResult): string {
	if (r.timedOut) return `timed out after ${TIMEOUT_MS / 1000}s (likely an infinite loop)`;
	const kind = r.compileError ? "compile error" : `exit code ${r.exitCode}`;
	return `${kind}:\n${r.stderr.trim().slice(0, 1500)}`;
}

// Does an option label describe a failed run (compile error / exception / hang)?
export function labelDescribesFailure(label: string, r: RunResult): boolean {
	if (r.timedOut) return /infinite|never (ends|stops|terminates)|forever|runs forever/i.test(label);
	return /error|exception|won'?t compile|does not compile|doesn'?t compile|crash/i.test(label);
}
