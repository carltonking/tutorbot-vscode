import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { existsSync, type FSWatcher, mkdirSync, readFileSync, statSync, watch, writeFileSync } from "node:fs";
import { basename, extname, isAbsolute, join } from "node:path";
import { getBridge } from "../lib/bridge.ts";
import { coerceJsonArgs } from "../lib/coerce.ts";
import { type Language, normalizeOutput, runCode, type RunResult } from "../lib/run-code.ts";
import { slug, TutorStore } from "../lib/tutor-store.ts";

// ────────────────────────────────────────────────────────────────────────────
// exercises — "write a program" practice for coding subjects.
//
// TutorBot writes a problem, starter code, test cases and a hidden reference
// solution. The reference must pass every test before the exercise is handed
// out (same ground-truth idea as quiz verify). The starter file opens in VS
// Code; tests re-run on every save and on every pause in typing, and compile
// errors show as squiggles. /submit sends the code + results to TutorBot for a
// review; /hint asks for the next smallest nudge.
// ────────────────────────────────────────────────────────────────────────────

interface TestCase {
	name: string;
	stdin?: string;
	expectedOutput: string;
	hidden?: boolean;
}

interface Exercise {
	id: string;
	subject: string;
	concepts: string[];
	title: string;
	language: Language;
	prompt: string;
	tests: TestCase[];
	referenceSolution: string;
	file: string;
	createdAt: string;
	hintsGiven: number;
	status: "active" | "completed" | "closed";
}

interface TestResult {
	name: string;
	pass: boolean;
	detail?: string;
}

interface Diagnostic {
	line: number;
	message: string;
	severity: "error" | "warning";
}

interface CheckStatus {
	running: boolean;
	passed: number;
	total: number;
	results: TestResult[];
	compileError?: string;
	diagnostics: Diagnostic[];
	checkedAt: string;
}

const FILE_NAME: Record<Language, string> = { java: "Main.java", python: "main.py", javascript: "main.js" };
const LANGUAGE_OF_EXT: Record<string, Language> = { ".java": "java", ".py": "python", ".js": "javascript", ".mjs": "javascript", ".cjs": "javascript" };

// A learner's own file to turn into an exercise: it must exist and be a
// program in the exercise's language. Returns an error message, or undefined.
function checkExistingFile(file: string, language: Language): string | undefined {
	if (!isAbsolute(file)) return `existingFile must be an absolute path (got "${file}").`;
	if (!existsSync(file) || !statSync(file).isFile()) return `existingFile ${file} doesn't exist.`;
	const lang = LANGUAGE_OF_EXT[extname(file).toLowerCase()];
	if (!lang) return `existingFile ${basename(file)} isn't a Java, Python or JavaScript file.`;
	if (lang !== language) return `existingFile ${basename(file)} is ${lang}, but language is ${language}.`;
	return undefined;
}
const COMMENT: Record<Language, [string, string, string]> = {
	java: ["/*", " * ", " */"],
	javascript: ["/*", " * ", " */"],
	python: ['"""', "", '"""'],
};

function parseDiagnostics(language: Language, r: RunResult): Diagnostic[] {
	const out: Diagnostic[] = [];
	const err = r.stderr;
	if (language === "java") {
		for (const m of err.matchAll(/^\S+\.java:(\d+): error: (.*)$/gm)) out.push({ line: Number(m[1]), message: m[2], severity: "error" });
		if (!out.length) {
			const ex = err.match(/Exception in thread "main" ([^\n]+)/);
			const at = err.match(/at \S+\(\S+\.java:(\d+)\)/);
			if (ex && at) out.push({ line: Number(at[1]), message: ex[1], severity: "warning" });
		}
	} else if (language === "python") {
		const lines = [...err.matchAll(/File "[^"]*main\.py", line (\d+)/g)];
		const last = err.trim().split("\n").pop() ?? "";
		if (lines.length) out.push({ line: Number(lines[lines.length - 1][1]), message: last, severity: /SyntaxError|IndentationError/.test(last) ? "error" : "warning" });
	} else {
		const at = err.match(/main\.(?:m?js):(\d+)/);
		const msg = err.split("\n").find((l) => /Error/.test(l)) ?? "";
		if (at) out.push({ line: Number(at[1]), message: msg.trim(), severity: "warning" });
	}
	return out;
}

function firstLines(text: string, n = 6): string {
	const lines = text.trimEnd().split("\n");
	return lines.length > n ? `${lines.slice(0, n).join("\n")}\n…` : lines.join("\n");
}

async function runTests(language: Language, code: string, tests: TestCase[]): Promise<Omit<CheckStatus, "running" | "checkedAt">> {
	const runs = await Promise.all(tests.map((t) => runCode(language, code, t.stdin)));
	const compileFailed = runs.find((r) => r.compileError || (language === "python" && /SyntaxError|IndentationError/.test(r.stderr)));
	if (compileFailed) {
		return {
			passed: 0,
			total: tests.length,
			results: tests.map((t) => ({ name: t.name, pass: false, detail: "doesn't compile yet" })),
			compileError: firstLines(compileFailed.stderr.replace(/\n?error: compilation failed\s*$/, ""), 12),
			diagnostics: parseDiagnostics(language, compileFailed),
		};
	}
	const results: TestResult[] = [];
	const diagnostics: Diagnostic[] = [];
	tests.forEach((t, i) => {
		const r = runs[i];
		let pass = false;
		let detail: string | undefined;
		if (r.timedOut) detail = "timed out — infinite loop, or waiting for input that never comes?";
		else if (!r.ok) {
			detail = `crashed: ${firstLines(r.stderr, 3)}`;
			diagnostics.push(...parseDiagnostics(language, r));
		} else {
			pass = normalizeOutput(r.stdout) === normalizeOutput(t.expectedOutput);
			if (!pass) {
				detail = t.hidden
					? "hidden test — your output differs from what's expected"
					: `${t.stdin ? `input: ${JSON.stringify(t.stdin.trim())} · ` : ""}expected: ${JSON.stringify(t.expectedOutput.trim())} · got: ${JSON.stringify(r.stdout.trim().slice(0, 300))}`;
			}
		}
		results.push({ name: t.hidden ? `${t.name} (hidden)` : t.name, pass, detail });
	});
	const seen = new Set<string>();
	return {
		passed: results.filter((r) => r.pass).length,
		total: tests.length,
		results,
		diagnostics: diagnostics.filter((d) => !seen.has(`${d.line}:${d.message}`) && seen.add(`${d.line}:${d.message}`)),
	};
}

export default function exercises(pi: ExtensionAPI) {
	const bridge = getBridge();
	let ctxRef: any;
	let store: TutorStore | undefined;
	let current: Exercise | undefined;
	let status: CheckStatus | undefined;
	let watcher: FSWatcher | undefined;
	let debounce: NodeJS.Timeout | undefined;
	let checkVersion = 0;
	// While an exercise card is waiting in the panel: request a check / hint from
	// outside the card (editor Submit button, /submit, /hint).
	let liveCard: { check: () => void; hint: () => boolean } | undefined;

	const dataDir = () => join(ctxRef.cwd, "Tutor", ".data", "exercises");
	const exercisePath = (id: string) => join(dataDir(), `${id}.json`);
	const activePath = () => join(dataDir(), "active.json");

	function save(ex: Exercise) {
		mkdirSync(dataDir(), { recursive: true });
		writeFileSync(exercisePath(ex.id), JSON.stringify(ex, null, 2));
	}

	function setActive(ex: Exercise | undefined) {
		current = ex;
		status = undefined;
		mkdirSync(dataDir(), { recursive: true });
		writeFileSync(activePath(), JSON.stringify({ id: ex?.id ?? null }));
		watcher?.close();
		watcher = undefined;
		if (ex && existsSync(ex.file)) {
			try {
				watcher = watch(ex.file, () => scheduleCheck());
			} catch {
				// watching is best-effort; VS Code buffer updates and /submit still work
			}
		}
		publish();
	}

	function publish() {
		const ex = current;
		bridge.setState(
			"exercise",
			ex
				? {
						id: ex.id,
						title: ex.title,
						subject: ex.subject,
						language: ex.language,
						prompt: ex.prompt,
						file: ex.file,
						fileName: basename(ex.file),
						done: ex.status === "completed",
						status,
					}
				: null,
		);
		const score = status ? (status.running ? "running tests…" : status.compileError ? "doesn't compile yet" : `${status.passed}/${status.total} tests passing`) : "not run yet";
		try {
			// ctxRef can be stale after a session switch (pi throws on use) — the
			// new session's instance publishes its own widget, so just skip.
			const ui = ctxRef?.ui;
			if (!ui?.setWidget) return;
			if (!ex || ex.status === "closed") ui.setWidget("tutorbot-exercise", undefined);
			else ui.setWidget("tutorbot-exercise", [`✎ Exercise: ${ex.title} — ${score}  ·  ${basename(ex.file)}  ·  /submit when done · /hint if stuck`]);
		} catch {
			// stale ctx
		}
	}

	async function check(code: string): Promise<CheckStatus | undefined> {
		const ex = current;
		if (!ex) return undefined;
		const version = ++checkVersion;
		status = { ...(status ?? { passed: 0, total: ex.tests.length, results: [], diagnostics: [] }), running: true, checkedAt: new Date().toISOString() };
		publish();
		const r = await runTests(ex.language, code, ex.tests);
		if (version !== checkVersion || current?.id !== ex.id) return undefined; // superseded by newer code
		status = { ...r, running: false, checkedAt: new Date().toISOString() };
		publish();
		bridge.emit("diagnostics", { file: ex.file, diagnostics: status.diagnostics });
		return status;
	}

	function scheduleCheck() {
		clearTimeout(debounce);
		debounce = setTimeout(() => {
			if (current && existsSync(current.file)) check(readFileSync(current.file, "utf8"));
		}, 400);
	}

	function openInEditor(file: string) {
		if (!bridge.hasPanel()) return "not opened: the TutorBot panel isn't connected";
		bridge.emit("open", { file });
		return "opened in VS Code";
	}

	function codeBlock(ex: Exercise, code: string) {
		return `\`\`\`${ex.language}\n${code.trimEnd()}\n\`\`\``;
	}

	function resultsText(s: CheckStatus) {
		if (s.compileError) return `Doesn't compile:\n${s.compileError}`;
		return `${s.passed}/${s.total} tests pass.\n${s.results.map((r) => `- ${r.pass ? "✓" : "✗"} ${r.name}${r.detail ? ` — ${r.detail}` : ""}`).join("\n")}`;
	}

	async function submit(): Promise<string> {
		if (liveCard) {
			liveCard.check();
			return "Checking your code…";
		}
		const ex = current;
		if (!ex) return "No active exercise.";
		const code = readFileSync(ex.file, "utf8");
		// Run directly (not via check): a save-triggered check racing this one must
		// not supersede the graded run. Bumping the version discards their results.
		clearTimeout(debounce);
		const version = ++checkVersion;
		const s: CheckStatus = { ...(await runTests(ex.language, code, ex.tests)), running: false, checkedAt: new Date().toISOString() };
		if (version === checkVersion) {
			status = s;
			publish();
		}
		const allPass = !s.compileError && s.passed === s.total;
		store ??= new TutorStore(ctxRef.cwd);
		store.recordQuiz({
			ts: new Date().toISOString(),
			subject: ex.subject,
			concepts: ex.concepts,
			question: `Exercise: ${ex.title}`,
			purpose: "check",
			kind: "exercise",
			outcome: allPass ? "correct" : "incorrect",
			answer: `${s.passed}/${s.total} tests`,
			expected: `${s.total}/${s.total} tests`,
		});
		if (allPass) {
			ex.status = "completed";
			save(ex);
			publish();
		}
		pi.sendUserMessage(
			`I'm submitting my solution to the exercise "${ex.title}" (${basename(ex.file)}):\n\n${codeBlock(ex, code)}\n\nTest results: ${resultsText(s)}\n\n` +
				(allPass
					? "Review it like a good mentor: confirm what I did well, then point out anything worth improving (clarity, naming, edge cases, a more idiomatic approach) — and ask me a question that checks I understand WHY it works. Don't rewrite my whole program."
					: "Help me get there without giving me the solution: point me at the first thing to look at, ideally with a question, and explain any error message in plain words."),
			{ deliverAs: "followUp" },
		);
		return allPass ? "Submitted — all tests pass." : "Submitted for help.";
	}

	function hint(question?: string): string {
		if (liveCard?.hint()) return "Showing the next hint on the exercise card.";
		const ex = current;
		if (!ex) return "No active exercise.";
		const code = existsSync(ex.file) ? readFileSync(ex.file, "utf8") : "";
		ex.hintsGiven++;
		save(ex);
		pi.sendUserMessage(
			`I'm stuck on the exercise "${ex.title}". This is hint request #${ex.hintsGiven}.${question ? ` My question: ${question}` : ""}\n\nMy current code:\n${codeBlock(ex, code)}\n\n` +
				(status ? `Current test results: ${resultsText(status)}\n\n` : "") +
				"Give me only the next smallest hint (escalate gently with each request: a guiding question first, then the concept to use, then a pseudocode step). Never write the solution for me.",
			{ deliverAs: "followUp" },
		);
		return "Asked TutorBot for a hint.";
	}

	// ── session wiring ───────────────────────────────────────────────────────
	pi.on("session_start", async (_event, ctx) => {
		ctxRef = ctx;
		store = new TutorStore(ctx.cwd);
		try {
			const { id } = JSON.parse(readFileSync(activePath(), "utf8"));
			const ex: Exercise | undefined = id ? JSON.parse(readFileSync(exercisePath(id), "utf8")) : undefined;
			setActive(ex && ex.status !== "closed" ? ex : undefined);
			if (current && existsSync(current.file)) check(readFileSync(current.file, "utf8"));
		} catch {
			setActive(undefined);
		}
		// Latest extension instance owns the API (pi re-creates instances on session switch).
		bridge.onApi("buffer", async (body) => {
			if (!current || body?.file !== current.file || typeof body.content !== "string") return { ok: false };
			const s = await check(body.content);
			return { ok: true, status: s };
		});
		bridge.onApi("submit", async () => ({ message: await submit() }));
		bridge.onApi("hint", async (body) => ({ message: hint(body?.question) }));
		bridge.onApi("ask", async (body) => {
			const where = body?.file ? ` (from ${basename(body.file)}${body.startLine ? `, lines ${body.startLine}–${body.endLine}` : ""})` : "";
			const lang = body?.language ?? "";
			pi.sendUserMessage(`${body?.question || "Can you explain this code?"}${where}\n\n\`\`\`${lang}\n${String(body?.code ?? "").trimEnd()}\n\`\`\``, { deliverAs: "followUp" });
			return { ok: true };
		});
		bridge.onApi("exercise", async () => ({ exercise: current ? { id: current.id, file: current.file, title: current.title } : null, status }));
	});

	pi.on("session_shutdown", async () => {
		checkVersion++; // drop results of checks still running in this (old) instance
		watcher?.close();
		watcher = undefined;
		clearTimeout(debounce);
	});

	// ── the exercise card (panel) ────────────────────────────────────────────
	// Same rhythm as a quiz: the card waits for the learner, Check grades the
	// code by running the tests, and the verdict + explanation show in place.
	async function runCard(ex: Exercise, toolCallId: string, hints: string[], explanation: string, signal?: AbortSignal) {
		let attempts = 0;
		let hintsUsed = 0;
		let last: CheckStatus | undefined;
		let outcome: "correct" | "gaveup" | "help" | "skipped" = "skipped";
		const visible = (s: CheckStatus) => ({ passed: s.passed, total: s.total, compileError: s.compileError, results: s.results });
		try {
			while (true) {
				// External Check / Hint (editor button, /submit, /hint) re-issue the card.
				const ac = new AbortController();
				const onAbort = () => ac.abort();
				signal?.addEventListener("abort", onAbort, { once: true });
				let external: "check" | "hint" | undefined;
				liveCard = {
					check: () => ((external = "check"), ac.abort()),
					hint: () => (hintsUsed < hints.length ? ((external = "hint"), ac.abort(), true) : false),
				};
				const r = await bridge.ask(
					"code",
					{ toolCallId, title: ex.title, prompt: ex.prompt, language: ex.language, file: ex.file, fileName: basename(ex.file), hints, hintsShown: hintsUsed, attempts, last: last && visible(last) },
					ac.signal,
				);
				signal?.removeEventListener("abort", onAbort);
				if (signal?.aborted) break;
				if (r) hintsUsed = Math.max(hintsUsed, Math.min(hints.length, Number(r.hintsUsed) || 0));
				const action = external ?? r?.action;
				if (external === "hint") {
					hintsUsed = Math.min(hints.length, hintsUsed + 1);
					continue;
				}
				if (!action || action === "skip") break;
				if (action === "giveUp") {
					outcome = "gaveup";
					break;
				}
				if (action === "help") {
					outcome = "help";
					break;
				}
				if (action === "check") {
					attempts++;
					clearTimeout(debounce);
					const version = ++checkVersion;
					const code = existsSync(ex.file) ? readFileSync(ex.file, "utf8") : "";
					const s: CheckStatus = { ...(await runTests(ex.language, code, ex.tests)), running: false, checkedAt: new Date().toISOString() };
					if (version === checkVersion) {
						status = s;
						publish();
						bridge.emit("diagnostics", { file: ex.file, diagnostics: s.diagnostics });
					}
					last = s;
					if (!s.compileError && s.passed === s.total) {
						outcome = "correct";
						break;
					}
				}
			}
		} finally {
			liveCard = undefined;
		}

		const code = existsSync(ex.file) ? readFileSync(ex.file, "utf8") : "";
		const lastText = last ? resultsText(last) : "Not checked yet.";
		if (outcome === "skipped") {
			return { content: [{ type: "text" as const, text: `The learner skipped the exercise "${ex.title}" (it stays open in ${basename(ex.file)}).` }], details: { status: "cancelled", kind: "code", question: ex.title } };
		}
		if (outcome === "help") {
			return {
				content: [
					{
						type: "text" as const,
						text:
							`The learner asked for help on "${ex.title}" (${attempts} check${attempts === 1 ? "" : "s"}, ${hintsUsed} hint${hintsUsed === 1 ? "" : "s"} so far). Their code:

${codeBlock(ex, code)}

Latest results: ${lastText}

` +
							"Help them get there without giving the solution: point at the first thing to look at, ideally with a question, and explain any error message in plain words. The exercise stays open; they can press Check on the editor's Submit button or type /submit when ready.",
					},
				],
				details: { status: "help", kind: "code", title: ex.title, attempts, hintsUsed, last: last && visible(last) },
			};
		}
		const correct = outcome === "correct";
		store ??= new TutorStore(ctxRef.cwd);
		try {
			store.recordQuiz({
				ts: new Date().toISOString(),
				subject: ex.subject,
				concepts: ex.concepts,
				question: `Exercise: ${ex.title}`,
				purpose: "check",
				kind: "exercise",
				outcome: correct ? "correct" : "dontknow",
				answer: last ? `${last.passed}/${last.total} tests after ${attempts} check${attempts === 1 ? "" : "s"}` : "no attempt",
				expected: `${ex.tests.length}/${ex.tests.length} tests`,
				hintsUsed,
			});
		} catch {
			// progress is best-effort; the result still reaches the model
		}
		ex.status = correct ? "completed" : "closed";
		save(ex);
		publish();
		const details = {
			status: "answered",
			kind: "code",
			title: ex.title,
			correct,
			gaveUp: !correct,
			attempts,
			hintsUsed,
			total: ex.tests.length,
			last: last && visible(last),
			explanation,
			solution: correct ? undefined : ex.referenceSolution,
			language: ex.language,
		};
		const text = correct
			? `The learner solved "${ex.title}": all ${ex.tests.length} tests pass (${attempts} check${attempts === 1 ? "" : "s"}, ${hintsUsed} hint${hintsUsed === 1 ? "" : "s"}). Their code:

${codeBlock(ex, code)}

` +
				"Review it like a good mentor, briefly: one thing they did well, one improvement worth making (clarity, naming, edge cases, a more idiomatic approach), and one question that checks they understand WHY it works. Don't rewrite their program."
			: `The learner gave up on "${ex.title}" after ${attempts} check${attempts === 1 ? "" : "s"}; the reference solution and explanation are now shown to them. Their last code:

${codeBlock(ex, code)}

Latest results: ${lastText}

` +
				"Walk them through the gap between their code and the solution, one idea at a time, then offer a similar, smaller exercise so they can try the idea again.";
		return { content: [{ type: "text" as const, text }], details };
	}

	// ── tools ────────────────────────────────────────────────────────────────
	pi.registerTool({
		name: "assign_exercise",
		label: "assign_exercise",
		description:
			"Give the learner a 'write a program' exercise. Creates the starter file, opens it in their editor, and auto-runs your test cases as they type/save. Your referenceSolution is run against the tests first — if it fails any, nothing is assigned and you get the real output to fix your tests. Only for concepts already taught.",
		promptSnippet: "Assign a coding exercise the learner solves in their editor, with auto-checked tests.",
		promptGuidelines: [
			"assign_exercise: use it after a programming concept has been taught and quiz-checked, so the learner applies it by writing real code. Keep exercises small (one new idea at a time, 5–25 lines) and build up.",
			"assign_exercise: the prompt must state exactly what to read (input) and print (output) with one worked example. Provide 3–6 tests covering normal cases and an edge case; mark 1–2 as hidden so they can't hard-code answers.",
			"assign_exercise: in the TutorBot panel the exercise is an interactive card: the tool waits while the learner writes code and presses Check, and returns when they pass every test, give up (the reference solution is shown), ask for help, or skip — with their code and test results. Don't write anything while it waits, and never paste a solution.",
			"assign_exercise: when the learner asks you to check a program they wrote themselves, pass its absolute path as `existingFile` (and no starterCode). Their file becomes the exercise: it is never changed, and it gets tests that re-run as they type. First make sure you know what the program should do — from its comments, or ask with ask_user_question — then write the prompt, tests and referenceSolution for that goal. Tests feed stdin and compare stdout, so they suit programs that read input and print output; if theirs doesn't print anything yet, say what to add rather than testing it.",
			"assign_exercise: pass a 1-3 step `hints` ladder (guiding question → technique → first concrete step, never code that solves it) and an `explanation` of the approach, shown after they solve it or give up.",
		],
		prepareArguments: (args: any) => coerceJsonArgs(args, ["concepts", "tests", "hints"]),
		parameters: Type.Object({
			subject: Type.String({ description: 'Subject, e.g. "Java".' }),
			concepts: Type.Array(Type.String(), { minItems: 1, description: "Concept names (as given to mark_taught) this exercise practices." }),
			title: Type.String({ description: "Short title, e.g. 'Sum of digits'." }),
			language: Type.Union([Type.Literal("java"), Type.Literal("python"), Type.Literal("javascript")]),
			prompt: Type.String({ description: "The problem statement in markdown (input format, output format, one worked example). LaTeX allowed." }),
			starterCode: Type.Optional(
				Type.String({
					description: "Starter file content (required unless existingFile is given). Java: must contain `public class Main` with main(); leave TODO comments where they write code. Don't include the solution.",
				}),
			),
			existingFile: Type.Optional(
				Type.String({
					description: "Absolute path of a program the learner wrote themselves, to turn into this exercise instead of creating a starter file. The file is never modified.",
				}),
			),
			tests: Type.Array(
				Type.Object({
					name: Type.String({ description: "What the test checks, e.g. 'three-digit number'." }),
					stdin: Type.Optional(Type.String({ description: "Input fed to the program (newline-separated)." })),
					expectedOutput: Type.String({ description: "Exact expected stdout (whitespace-insensitive comparison)." }),
					hidden: Type.Optional(Type.Boolean({ description: "Hide the expected output from the learner." })),
				}),
				{ minItems: 1 },
			),
			referenceSolution: Type.String({ description: "A complete correct solution. Must pass every test. Shown to the learner only if they give up." }),
			hints: Type.Optional(
				Type.Array(Type.String(), {
					maxItems: 3,
					description: "Graduated hint ladder (1-3), revealed one at a time on the card: 1) a guiding question, 2) the technique/concept to use, 3) the first concrete step. Never solution code.",
				}),
			),
			explanation: Type.Optional(
				Type.String({ description: "How to solve it (the approach and why it works), revealed after the learner passes all tests or gives up. Markdown; math in LaTeX." }),
			),
		}),
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			ctxRef = ctx;
			const language = params.language as Language;
			const refuse = (text: string) => ({ content: [{ type: "text" as const, text: `Exercise NOT assigned: ${text}` }], details: { assigned: false } });
			const existing = params.existingFile?.trim();
			if (existing) {
				const problem = checkExistingFile(existing, language);
				if (problem) return refuse(problem);
			} else if (!params.starterCode?.trim()) return refuse("starterCode is required (or existingFile, to use a program the learner already wrote).");
			onUpdate?.({ content: [{ type: "text", text: "Checking the reference solution against the tests…" }] });
			const ref = await runTests(language, params.referenceSolution, params.tests);
			if (ref.compileError || ref.passed !== ref.total) {
				return {
					content: [
						{
							type: "text",
							text: `Exercise NOT assigned: your reference solution fails your own tests, so the tests (or the solution) are wrong.\n${
								ref.compileError ? `Compile error:\n${ref.compileError}` : ref.results.filter((r) => !r.pass).map((r) => `- ${r.name}: ${r.detail}`).join("\n")
							}\nFix it and call assign_exercise again.`,
						},
					],
					details: { assigned: false },
				};
			}
			let file: string;
			if (existing) {
				// The learner's own program is the exercise; it's only ever read.
				file = existing;
			} else {
				const subjectDir = params.subject.replace(/[/\\:]/g, "-").trim();
				const base = join(ctx.cwd, "Exercises", subjectDir);
				mkdirSync(base, { recursive: true });
				let n = 1;
				let dir: string;
				do {
					dir = join(base, `${String(n).padStart(2, "0")}-${slug(params.title).slice(0, 40)}`);
					n++;
				} while (existsSync(dir));
				mkdirSync(dir, { recursive: true });
				file = join(dir, FILE_NAME[language]);
				const [open, mid, close] = COMMENT[language];
				const header = [open, `${mid}TutorBot exercise: ${params.title}`, `${mid}`, ...params.prompt.split("\n").map((l) => `${mid}${l}`.trimEnd()), close, ""].join("\n");
				writeFileSync(file, `${header}\n${params.starterCode!.trimEnd()}\n`);
				writeFileSync(join(dir, "README.md"), `# ${params.title}\n\n${params.prompt}\n`);
			}

			const ex: Exercise = {
				id: `${Date.now().toString(36)}-${slug(params.title).slice(0, 30)}`,
				subject: params.subject,
				concepts: params.concepts,
				title: params.title,
				language,
				prompt: params.prompt,
				tests: params.tests,
				referenceSolution: params.referenceSolution,
				file,
				createdAt: new Date().toISOString(),
				hintsGiven: 0,
				status: "active",
			};
			save(ex);
			setActive(ex);
			const how = openInEditor(file);
			check(readFileSync(file, "utf8"));
			if (bridge.hasPanel()) return runCard(ex, toolCallId, params.hints ?? [], params.explanation ?? "", signal);
			return {
				content: [
					{
						type: "text",
						text: `Exercise "${ex.title}" assigned (${how}): ${file}\nReference solution passes all ${ex.tests.length} tests. Tests now auto-run as the learner edits. Tell them briefly what to do, then wait — they'll /submit or ask for a hint.`,
					},
				],
				details: { assigned: true, file },
			};
		},
		renderCall(args, theme) {
			// Never render the reference solution or tests.
			return new Text(theme.fg("toolTitle", theme.bold("assign_exercise ")) + theme.fg("muted", String(args.title ?? "")), 0, 0);
		},
	});

	pi.registerTool({
		name: "check_exercise",
		label: "check_exercise",
		description: "Read the learner's current code for the active exercise and run the tests on it. Use when they ask about their code or you want to see their progress.",
		parameters: Type.Object({}),
		async execute(_id, _params, _signal, _onUpdate, ctx) {
			ctxRef = ctx;
			if (!current) return { content: [{ type: "text", text: "No active exercise." }], details: {} };
			const code = existsSync(current.file) ? readFileSync(current.file, "utf8") : "";
			const s = await check(code);
			return {
				content: [{ type: "text", text: `Exercise "${current.title}" — ${current.file}\n\n${codeBlock(current, code)}\n\n${s ? resultsText(s) : ""}\nHints given so far: ${current.hintsGiven}` }],
				details: {},
			};
		},
	});

	// ── commands ─────────────────────────────────────────────────────────────
	pi.registerCommand("submit", {
		description: "Submit your exercise solution for review",
		handler: async (_args, ctx) => {
			ctxRef = ctx;
			ctx.ui.notify(await submit(), "info");
		},
	});

	pi.registerCommand("hint", {
		description: "Ask for the next hint on the current exercise (optionally add a question)",
		handler: async (args, ctx) => {
			ctxRef = ctx;
			ctx.ui.notify(hint(args?.trim() || undefined), "info");
		},
	});

	pi.registerCommand("exercise", {
		description: "Current exercise: open | close | status",
		handler: async (args, ctx) => {
			ctxRef = ctx;
			const verb = (args ?? "").trim() || "open";
			if (!current) {
				ctx.ui.notify("No active exercise. Ask TutorBot for one (e.g. \"give me a coding exercise on loops\").", "info");
				return;
			}
			if (verb === "close") {
				current.status = "closed";
				save(current);
				setActive(undefined);
				ctx.ui.notify("Exercise closed.", "info");
				return;
			}
			if (verb === "status") {
				ctx.ui.notify(status ? resultsText(status) : "Not checked yet.", "info");
				return;
			}
			ctx.ui.notify(`${openInEditor(current.file)}: ${current.file}`, "info");
		},
	});
}
