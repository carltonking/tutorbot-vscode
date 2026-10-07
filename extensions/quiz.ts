import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { getBridge } from "./lib/bridge.ts";
import { coerceJsonArgs } from "./lib/coerce.ts";
import { type MathSpec, mathEquivalent } from "./lib/math-equiv.ts";
import { describeFailure, labelDescribesFailure, type Language, normalizeOutput, runCode } from "./lib/run-code.ts";

// ────────────────────────────────────────────────────────────────────────────
// quiz — graded questions with a known right answer.
//
//   quiz          pick one (or several) choices; graded against correctAnswer
//   quiz_typed    type the answer; graded against acceptedAnswers / real output
//   explain_back  the learner explains a result before seeing the tutor's
//
// The VS Code panel shows each one as a card. Every multiple-choice card also
// offers "I don't know" (an honest gap, never graded as a wrong guess) and an
// optional note. Before a question is shown, its key is checked against the
// explanation and, when given, against really running the code.
// ────────────────────────────────────────────────────────────────────────────

interface QuizOption {
	label: string;
	value: string;
	description?: string;
}

// One picked choice; `index` is the 1-based number on the card.
interface OptionAnswer {
	label: string;
	value: string;
	index: number;
}

// What the learner sent back from a quiz card.
interface QuizResponse {
	dontKnow: boolean;
	note?: string;
	answers: OptionAnswer[];
	confidence?: 1 | 2 | 3; // guess · fairly sure · certain
	hintsUsed?: number;
	selfExplanation?: string; // explain-it-back, asked after a miss or a guess
	wantsDirect?: boolean; // learner asked to just be shown
}

interface ChoiceExtras {
	hints?: string[];
	checkpoint?: boolean;
}

const CONFIDENCE_LABELS = ["", "Guess", "Fairly sure", "Certain"];

// Explain-it-back (self-explanation) is asked BEFORE the tutor's explanation is
// revealed: after a miss, or after a correct answer the learner rated a guess.
function needsExplainBack(dontKnow: boolean, correct: boolean, confidence?: number): boolean {
	return !dontKnow && (!correct || confidence === 1);
}

type QuizMode = "single-select" | "multi-select";

const OptionSchema = Type.Object({
	label: Type.String({ description: "Text of the choice. Math in LaTeX ($...$), e.g. $3e^{3x}$." }),
	value: Type.Optional(Type.String({ description: "Short id for this choice, used in correctAnswer. Defaults to the label." })),
	description: Type.Optional(Type.String({ description: "A short line shown under the choice." })),
	misconception: Type.Optional(
		Type.String({
			description:
				"Distractors only, never shown to the user: the specific misconception that would lead someone to pick this option (e.g. 'thinks integer division rounds'). Recorded to the learner's progress when they pick it.",
		}),
	),
});

// Shared by quiz and quiz_typed: what the question is about, for progress
// tracking and the teach-first gate (enforced by the tutor extension).
const SubjectParam = Type.String({
	description: 'The subject/course this belongs to, stable across sessions (e.g. "Java", "Calc II", "Organic Chemistry").',
});
const ConceptsParam = Type.Array(Type.String(), {
	minItems: 1,
	description:
		"The concept(s) this question tests, using the SAME names you passed to mark_taught (the tutor lists them). For check/review questions every concept must already be taught.",
});
const PurposeParam = Type.Optional(
	Type.Union([Type.Literal("diagnostic"), Type.Literal("discovery"), Type.Literal("check"), Type.Literal("review"), Type.Literal("checkpoint")], {
		description:
			"'diagnostic' = probing what they already know BEFORE teaching (allowed on untaught concepts; a miss isn't penalised). 'discovery' = a Socratic step where they try to work out the concept you're about to establish (allowed before mark_taught; only logged). 'check' (default) = confirming a node you just taught. 'review' = spaced review of something taught earlier. 'checkpoint' = a NO-HELP question (hints are disabled; it counts most toward mastery) — use inside /checkpoint runs.",
	}),
);
const HintsParam = Type.Optional(
	Type.Array(Type.String(), {
		maxItems: 3,
		description:
			"Graduated hint ladder (1-3), revealed one at a time only if the learner asks: 1) a guiding question or what to notice, 2) the concept/technique to use, 3) the first concrete step. Never the answer itself. Answers that needed hints count as assisted (no schedule promotion). Ignored for purpose 'checkpoint'.",
	}),
);
const VerifyParam = Type.Optional(
	Type.Object(
		{
			language: Type.Union([Type.Literal("java"), Type.Literal("python"), Type.Literal("javascript")]),
			code: Type.String({
				description:
					"Runnable code. mode 'output': the exact program from the question (Java may be bare statements or methods; it is wrapped in a class automatically). mode 'assert': a check program that exits non-zero / raises if your key is wrong (e.g. sympy: `assert sp.simplify(sp.diff(f,x) - key) == 0`).",
			}),
			mode: Type.Optional(
				Type.Union([Type.Literal("output"), Type.Literal("assert")], {
					description: "'output' (default): stdout must equal the correct option's label. 'assert': the program must exit 0.",
				}),
			),
			stdin: Type.Optional(Type.String({ description: "Input fed to the program (for Scanner/input() questions)." })),
		},
		{
			description:
				"Ground-truth check, run BEFORE the question is shown; a mismatch blocks the question and tells you the real result. REQUIRED for any 'what does this code print/return' question; strongly recommended for any computable answer (arithmetic, derivatives, integrals, limits — use python + sympy in assert mode).",
		},
	),
);

const QuizParams = Type.Object({
	question: Type.String({ description: "One graded question. Write math in LaTeX ($...$ inline, $$...$$ display)." }),
	subject: SubjectParam,
	concepts: ConceptsParam,
	purpose: PurposeParam,
	hints: HintsParam,
	details: Type.Optional(Type.String({ description: "Context shown under the question (e.g. the code to read)." })),
	options: Type.Array(OptionSchema, {
		minItems: 2,
		description: "At least two real choices. Give each a distinct `value`; correctAnswer names the right one(s) by value.",
	}),
	multiSelect: Type.Optional(Type.Boolean({ description: "true when several choices are right and the learner must pick exactly that set." })),
	// explanation is deliberately listed BEFORE correctAnswer: models emit tool
	// arguments in schema order, so this makes them work the problem out first
	// and then pick the key from that worked solution, instead of committing to a
	// (possibly wrong) key and rationalising it afterwards.
	explanation: Type.String({
		description:
			"REQUIRED. Write this FIRST, before correctAnswer: work the problem out step by step (trace the code, do the arithmetic) and end with a final line like `Answer: <exact option label>`. Revealed AFTER the user answers, whether they got it right or wrong.",
	}),
	correctAnswer: Type.Union([Type.String(), Type.Array(Type.String())], {
		description: 'The `value` of the right choice, as your explanation concluded (its label also works). For multiSelect, an array of values. Never a position number.',
	}),
	shuffle: Type.Optional(
		Type.Boolean({
			description: "Default true: choices are shown in random order. Use false only when order carries meaning (a numeric sequence, or \"none of these\" that must stay last).",
		}),
	),
	verify: VerifyParam,
});

const QuizTypedParams = Type.Object({
	question: Type.String({ description: "The question. The learner types the answer (multi-line allowed). Write all math in LaTeX ($...$ inline, $$...$$ display)." }),
	subject: SubjectParam,
	concepts: ConceptsParam,
	purpose: PurposeParam,
	hints: HintsParam,
	details: Type.Optional(Type.String({ description: "Optional extra context shown under the question (e.g. the code to trace)." })),
	explanation: Type.String({
		description: "REQUIRED. Write this FIRST: work the answer out step by step. Revealed after the learner answers.",
	}),
	acceptedAnswers: Type.Optional(
		Type.Array(Type.String(), {
			description:
				"Every acceptable answer form (compared ignoring case and whitespace, e.g. ['2x cos(x^2)', '2xcos(x^2)', 'cos(x^2)*2x']). Optional when verify (mode 'output') is given: then the program's real output is the answer.",
		}),
	),
	caseSensitive: Type.Optional(Type.Boolean({ description: "Default false. Set true when case matters (e.g. exact program output with capitals)." })),
	math: Type.Optional(
		Type.Object(
			{
				variable: Type.Optional(Type.String({ description: "The variable, default x." })),
				upToConstant: Type.Optional(Type.Boolean({ description: "true for antiderivatives: any answer differing by a constant (+C) counts." })),
			},
			{
				description:
					"Grade a math answer by meaning, not spelling: the learner's expression is compared with acceptedAnswers[0] by sympy, so any equivalent form counts ('3x/8 + sin(2x)/4' = '\\frac{3}{8}x + \\frac{1}{4}\\sin(2x)'). Use for every expression answer (integrals, derivatives, simplifications, identities).",
			},
		),
	),
	verify: VerifyParam,
});

// Wrong typed answers on practice questions: try again before the answer shows.
const TYPED_ATTEMPTS = 3;

// Trim choices, default each value to its label, drop empty ones. Two choices
// with the same value can't be graded apart, so that's an error.
function cleanOptions(raw: Array<{ label: string; value?: string; description?: string }> | undefined): QuizOption[] {
	const out: QuizOption[] = [];
	const values = new Set<string>();
	for (const o of raw ?? []) {
		const label = String(o?.label ?? "").trim();
		if (!label) continue;
		const value = o.value?.trim() || label;
		if (values.has(value)) throw new Error(`has two choices with the value "${value}"`);
		values.add(value);
		out.push({ label, value, description: o.description?.trim() || undefined });
	}
	return out;
}

// Random display order. Grading uses values, so positions are only resolved
// after shuffling and always match what the learner sees.
function shuffleOptions(options: QuizOption[]): QuizOption[] {
	const out = options.slice();
	for (let i = out.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1));
		const t = out[i];
		out[i] = out[j];
		out[j] = t;
	}
	return out;
}

// correctAnswer as a list of strings. Models sometimes send a multi-select key
// as a JSON string ('["a","b"]') or a bare number.
function keyList(raw: string | string[]): string[] {
	if (Array.isArray(raw)) return raw.map(String);
	const s = String(raw).trim();
	if (/^\[.*\]$/s.test(s)) {
		try {
			const parsed = JSON.parse(s);
			if (Array.isArray(parsed)) return parsed.map(String);
		} catch {
			// a literal value that happens to look like a list
		}
	}
	return [String(raw)];
}

// Turn correctAnswer into 1-based positions in display order. A value is
// matched exactly first, then loosely (case/spacing) against values and
// labels, since models often send the label. Anything else is an error, so a
// typo can't silently grade the wrong choice.
function resolveCorrect(raw: string | string[] | undefined, options: QuizOption[]): { indices: number[]; error?: string } {
	const keys = raw === undefined ? [] : keyList(raw);
	if (!keys.length) return { indices: [], error: "needs correctAnswer" };
	const found = new Set<number>();
	for (const k of keys) {
		const want = String(k).trim();
		let i = options.findIndex((o) => o.value === want);
		if (i < 0) i = options.findIndex((o) => normalizeForMatch(o.value) === normalizeForMatch(want) || normalizeForMatch(o.label) === normalizeForMatch(want));
		if (i < 0) return { indices: [], error: `correctAnswer "${want}" isn't one of the choices (${options.map((o) => `"${o.value}"`).join(", ")})` };
		found.add(i + 1);
	}
	return { indices: [...found].sort((a, b) => a - b) };
}

// ── Self-consistency guard ──────────────────────────────────────────────────
// The extension cannot know the ground truth: it grades strictly against the
// author-supplied `correctAnswer` VALUE, so a key that is wrong but points at a
// real option passes silently. One such failure IS detectable without knowing
// the domain, though: the explanation argues for a different option than the key
// declares (common when options are prefix-related — "1 2" / "1 2 3" /
// "1 2 3 4"). Showing that to the learner makes the ✓, the grade, and the
// explanation contradict each other, so hand it back to the model instead.
//
// Firing wrongly is the costly direction (it interrupts the user and can push
// the model to "fix" a key that was right), so the check is deliberately
// narrow: it fires only when the declared-correct option is NOT mentioned
// anywhere in the explanation while EXACTLY ONE other option is.
function normalizeForMatch(text: string): string {
	return text.toLowerCase().replace(/\s+/g, " ").trim();
}

// Very short values ("3", "42") match almost any prose and would produce false
// positives, so they are never searched for. Substring matching is intentional
// and lenient: it can miss a contradiction, but it cannot invent one.
const MIN_MENTION_LENGTH = 3;
const MAX_MENTION_OPTION_LENGTH = 30;

function mentionsOption(haystack: string, option: QuizOption): boolean {
	return [option.label, option.value].some((text) => {
		const needle = normalizeForMatch(text);
		return needle.length >= MIN_MENTION_LENGTH && haystack.includes(needle);
	});
}

// Read the option the explanation CONCLUDES with. Only the final sentence is
// considered, and only when it is clearly a conclusion ("Answer: …", "Output:
// …", "So … = 4", "Therefore it prints B"), so asides like "if you wanted 2.5,
// write 5.0 / 2" never count. The text after the last marker must start with an
// option's label/value at a word boundary; the longest such option wins, so
// "1 2 (then break exits)" picks "1 2", not "1 2 3".
const CONCLUSION_START = /^(so|therefore|thus|hence|output|answer|final answer|result|prints?|it prints|the answer|the output|the result)\b/;
const CONCLUSION_MARKER = /(?:\banswer\s*(?:is|:)|\boutput\s*(?:is|:)|\bresult\s*(?:is|:)|\bprints?\b\s*:?|\breturns\b\s*:?|=|→|:|\bis\b)/g;

function optionAtStart(claim: string, options: QuizOption[]): number | undefined {
	let best: { idx: number; len: number } | undefined;
	options.forEach((o, i) => {
		for (const text of [o.label, o.value]) {
			const needle = normalizeForMatch(text);
			if (!needle || !claim.startsWith(needle)) continue;
			// The option must be the whole claim: followed only by the end of the
			// sentence, a parenthetical, or "because …". So "2.5" is not "2", and
			// "start, then hello…, then end" is not "Start".
			const rest = claim.slice(needle.length).replace(/^["'”’`]+/, "");
			if (!/^([.!?]?\s*$|\s*[(—–]|\s+-\s|[.!?]?\s+(because|since|as|which)\b)/.test(rest)) continue;
			if (!best || needle.length > best.len) best = { idx: i + 1, len: needle.length };
		}
	});
	return best?.idx;
}

function findConcludedOption(explanation: string, options: QuizOption[]): number | undefined {
	const lines = explanation.split("\n").map((l) => l.trim()).filter(Boolean);
	const lastLine = lines[lines.length - 1];
	if (!lastLine) return undefined;
	const sentences = lastLine.split(/(?<=[.!?])\s+(?=[A-Z*"'`-])/);
	const sentence = normalizeForMatch(
		sentences[sentences.length - 1].replace(/^[-*>#\s]+/, "").replace(/[*_`]/g, ""),
	);
	if (!CONCLUSION_START.test(sentence) && !/\b(answer|output)\s*(is|:)/.test(sentence)) return undefined;
	// Try the text after each marker, last marker first ("= 5 - 1 = 4" → "4").
	const cuts = [...sentence.matchAll(CONCLUSION_MARKER)].map((m) => m.index! + m[0].length).reverse();
	for (const cut of cuts) {
		const claim = sentence.slice(cut).trim().replace(/^["'“‘(]+/, "");
		const idx = claim ? optionAtStart(claim, options) : undefined;
		if (idx !== undefined) return idx;
	}
	return undefined;
}

function findContradictedOption(
	explanation: string,
	options: QuizOption[],
	correctIndices: number[],
): number | undefined {
	// Single-select only: with several correct options the explanation legitimately
	// talks around the set, and "which single value does it claim" stops being a
	// meaningful question — so the guard stays out of multi-select's way.
	if (correctIndices.length !== 1) return undefined;
	const haystack = normalizeForMatch(explanation);
	if (!haystack) return undefined;
	const correctIdx = correctIndices[0];
	// Strongest signal first: the explanation's own concluding line. This also
	// covers short answers ("4", "B") that the mention check below must skip.
	const concluded = findConcludedOption(explanation, options);
	if (concluded !== undefined) return concluded === correctIdx ? undefined : concluded;
	// The mention heuristic only makes sense for short, answer-like options
	// ("1 2 3", "10 20"). With sentence-length options the explanation paraphrases
	// the key instead of quoting it, while naming distractors to rebut them.
	if (options.some((o) => o.label.length > MAX_MENTION_OPTION_LENGTH)) return undefined;
	// A key too short to search for ("5", "B") can never count as "mentioned",
	// so the heuristic would fire on every such question.
	const key = options[correctIdx - 1];
	if (Math.max(key.label.length, key.value.length) < MIN_MENTION_LENGTH) return undefined;
	if (mentionsOption(haystack, options[correctIdx - 1])) return undefined;
	const claimants = options
		.map((_, i) => i + 1)
		.filter((idx) => idx !== correctIdx && mentionsOption(haystack, options[idx - 1]));
	return claimants.length === 1 ? claimants[0] : undefined;
}

// ── Ground-truth verification ───────────────────────────────────────────────
// Runs the author's code before the question is shown. Returns an error message
// (the question is then withheld and the model must fix it) or undefined.
type VerifySpec = { language: Language; code: string; mode?: "output" | "assert"; stdin?: string };

async function verifyChoice(spec: VerifySpec, options: QuizOption[], correctIndices: number[]): Promise<string | undefined> {
	const r = await runCode(spec.language, spec.code, spec.stdin);
	if ((spec.mode ?? "output") === "assert") {
		return r.ok ? undefined : `quiz verify (assert) failed — your key is wrong or the check is broken. Program ${describeFailure(r)}\nRe-derive the answer, fix correctAnswer/explanation (or the check), and call quiz again.`;
	}
	if (correctIndices.length !== 1) return undefined; // output mode compares one answer
	const key = options[correctIndices[0] - 1];
	if (!r.ok) {
		if (labelDescribesFailure(key.label, r)) return undefined;
		const failing = options.findIndex((o) => labelDescribesFailure(o.label, r));
		return (
			`quiz verify failed: the code does not run cleanly — ${describeFailure(r)}\n` +
			(failing >= 0
				? `So the correct option is "${options[failing].label}", not "${key.label}". Fix correctAnswer and the explanation, then call quiz again.`
				: "If that is the intended answer, add an option saying so; otherwise fix the code. Then call quiz again.")
		);
	}
	const actual = normalizeOutput(r.stdout);
	const same = (o: QuizOption) => normalizeOutput(o.label) === actual || normalizeOutput(o.value) === actual;
	if (same(key)) return undefined;
	const match = options.find(same);
	if (match) {
		return `quiz verify failed: the code actually prints "${actual}", which is option "${match.label}" — not your key "${key.label}". Your trace was wrong: rewrite the explanation by re-tracing carefully, set correctAnswer to "${match.value}", and call quiz again.`;
	}
	return (
		`quiz verify failed: the code actually prints:\n${r.stdout.trimEnd() || "(nothing)"}\n` +
		`No option's label equals that output. Make the correct option's label exactly the real output (whitespace/newlines are ignored), fix the explanation, and call quiz again.`
	);
}

function isCorrect(picked: number[], key: number[]): boolean {
	const a = new Set(picked);
	return a.size === key.length && key.every((i) => a.has(i));
}

const optionRef = (options: QuizOption[], index: number) => `${index}. ${options[index - 1]?.label ?? "(missing)"}`;
const formatOptionRef = optionRef;

function quizDetails(status: "answered" | "cancelled" | "unavailable", base: { question: string; context?: string; mode: QuizMode }, correctIndices: number[], extra: Record<string, unknown> = {}) {
	return { status, ...base, answers: [] as OptionAnswer[], correctIndices, ...extra };
}

function cancelledResult(question: string, mode: QuizMode, correctIndices: number[], context?: string) {
	const message = "The learner skipped the question.";
	return { content: [{ type: "text" as const, text: message }], details: quizDetails("cancelled", { question, context, mode }, correctIndices, { message }) };
}

function unavailableResult(question: string, mode: QuizMode, message: string, correctIndices: number[], context?: string) {
	return { content: [{ type: "text" as const, text: message }], details: quizDetails("unavailable", { question, context, mode }, correctIndices, { message }) };
}

// The graded result: a summary for the tutor model, and details the panel and
// the progress tracker read.
function buildResult(
	question: string,
	context: string | undefined,
	mode: QuizMode,
	options: QuizOption[],
	response: QuizResponse,
	correctIndices: number[],
	explanation: string | undefined,
	extras: ChoiceExtras = {},
) {
	const { dontKnow, note, answers } = response;
	const correct = !dontKnow && isCorrect(answers.map((a) => a.index), correctIndices);
	const key = correctIndices.map((i) => optionRef(options, i)).join(", ");
	const lines: string[] = [];
	if (dontKnow) lines.push("The learner chose \"I don't know\": no attempt, so this is a gap to teach, not a wrong guess.", `Right answer: ${key}`);
	else lines.push(`The learner was ${correct ? "right" : "wrong"}.`, `Picked: ${answers.map((a) => `${a.index}. ${a.label}`).join(", ")}`, `Right answer: ${key}`);
	if (note) lines.push(`Their note: ${note}`, "(Answer this note first in your next message.)");
	let text = lines.join("\n") + learnerSignalsText(response, correct, extras);
	if (explanation) text += `\nExplanation: ${explanation}`;
	const details = quizDetails("answered", { question, context, mode }, correctIndices, {
		answers,
		options: options.map((o, i) => ({ index: i + 1, label: o.label })),
		correct,
		dontKnow,
		note,
		explanation,
		confidence: response.confidence,
		hintsUsed: response.hintsUsed ?? 0,
		hintsAvailable: extras.hints?.length ?? 0,
		selfExplanation: response.selfExplanation,
		wantsDirect: response.wantsDirect,
		checkpoint: extras.checkpoint,
	});
	return { content: [{ type: "text" as const, text }], details };
}

// What the tutor model needs to know beyond right/wrong: confidence, help used,
// and the learner's own explanation (to evaluate before teaching).
function learnerSignalsText(r: QuizResponse, correct: boolean, extras: ChoiceExtras): string {
	let t = "";
	if (extras.checkpoint) t += "\n(No-help checkpoint question.)";
	if (r.confidence) {
		t += `\nConfidence: ${CONFIDENCE_LABELS[r.confidence]}.`;
		if (!correct && !r.dontKnow && r.confidence === 3) t += " CONFIDENT MISS — a real misconception is likely: name it and confront it with a contrasting example. Tell them confident mistakes are the ones feedback fixes best, but they come back without practice, so it will be re-tested later.";
		if (correct && r.confidence === 1) t += " Correct but a guess — treat as not yet learned.";
	}
	if (!correct) t += "\nNext (after a miss): brief elaborated feedback on the specific misconception, then a VARIANT question on the same idea with a new surface (different constants, form or direction). Do NOT re-ask this same question now; it gets re-tested later, after at least two other questions.";
	if (r.hintsUsed) t += `\nHints used: ${r.hintsUsed}${extras.hints ? ` of ${extras.hints.length}` : ""} (assisted — doesn't count as mastery).`;
	if (r.wantsDirect) t += "\nThe learner pressed 'Just show me' (they asked to be shown): give a clear worked explanation of this exact problem now, then one easier check. No more Socratic questions on this point.";
	else if (r.selfExplanation) t += `\nLearner's own explanation (explain-it-back, written before seeing yours): «${r.selfExplanation}»\nEvaluate it first: say exactly what they got right, correct the specific gap, then call rate_explanation (good / partial / missing; a real attempt that names the right cue or slip is at least partial).`;
	else if (needsExplainBack(r.dontKnow, correct, r.confidence)) t += "\n(They skipped explaining it back.)";
	return t;
}

// ── quiz_typed: free-response, graded ───────────────────────────────────────

function normalizeTyped(text: string, caseSensitive: boolean): string {
	const t = normalizeOutput(text).replace(/\$/g, "");
	return caseSensitive ? t : t.toLowerCase();
}

export default function quiz(pi: ExtensionAPI) {
	pi.registerTool({
		name: "quiz",
		label: "quiz",
		description:
			"Ask one graded multiple-choice question with a known right answer. The learner picks a choice (or several, with multiSelect), or says \"I don't know\", and can add a note. They then see whether they were right, the right answer, and your explanation. Use it to find out what they already know before teaching, to check a step you just taught, and for spaced review. For questions without a right answer, use ask_user_question.",
		promptSnippet: "Ask a graded multiple-choice question (with a required key and worked explanation).",
		promptGuidelines: [
			"quiz: anything with a right answer goes through quiz or quiz_typed; ask_user_question is only for preferences and decisions.",
			"quiz: write the explanation first — actually work the problem, ending with `Answer: <exact choice label>` — then set correctAnswer to that choice's value. If the explanation and the key disagree, the question is sent back to you; re-derive the answer rather than editing the explanation to fit the key.",
			"quiz: make sure your worked answer is literally one of the choices before calling. Never settle for the closest one.",
			"quiz: give only real choices. \"I don't know\" is added automatically, so never add your own \"not sure\" option.",
			"quiz: make each wrong choice a specific, plausible mistake (a real misconception or a commonly confused idea) so the learner's pick shows what to teach next; give it a hidden `misconception`. Every wrong choice must be clearly wrong, not a defensible reading.",
			"quiz: keep choices alike in length, precision and style so the right one can't be spotted by its shape. Choices are shuffled unless shuffle is false.",
			"quiz: multiSelect is graded as an exact set: every right choice and no wrong ones.",
			"quiz: a dontKnow result is an honest gap, not a wrong guess: teach into it. A note, when present, tells you what they were thinking; respond to it.",
			"quiz: prefer a few short questions that adapt to each answer over one big one.",
			"quiz verify: for ANY question about what code prints/returns, pass verify {language, code} with the exact program — the quiz runs it and blocks the question if your key is wrong. For computable math (derivatives, integrals, limits, arithmetic) pass verify {language: 'python', mode: 'assert', code: <sympy check that asserts your key is right>}.",
			"quiz subject/concepts: always pass the subject and the concept names (exactly as given to mark_taught). Use purpose 'diagnostic' only to probe what they know BEFORE teaching; otherwise the concepts must already be taught.",
			"quiz hints: on practice questions (check/review), pass a short graduated `hints` ladder (guiding question → technique → first step; never the answer). The learner opens them only if needed; hint use is tracked and assisted answers don't count as mastery. Never pass hints with purpose 'checkpoint'.",
			"quiz confidence & explain-it-back: after answering, the learner rates their confidence; after a miss (or a correct guess) they explain the reasoning in their own words BEFORE your explanation is shown. When the result contains their explanation, evaluate it first (what's right, the exact gap), then call rate_explanation. A CONFIDENT MISS means a misconception: confront it directly.",
		],
		parameters: QuizParams,
		prepareArguments: (args: any) => coerceJsonArgs(args, ["options", "concepts", "hints", "correctAnswer", "verify"]),

		async execute(toolCallId, params, signal, onUpdate) {
			const context = params.details?.trim() || undefined;
			const explanation = params.explanation.trim();
			const mode: QuizMode = params.multiSelect ? "multi-select" : "single-select";
			const refuse = (message: string, key: number[] = []) => unavailableResult(params.question, mode, message, key, context);

			let options: QuizOption[];
			try {
				options = cleanOptions(params.options);
			} catch (e) {
				return refuse(`quiz ${(e as Error).message}`);
			}
			if (options.length < 2) return refuse("quiz needs at least two choices");
			if (params.shuffle !== false) options = shuffleOptions(options);
			// The display order, without the key: lets the panel show the card in the
			// order the learner will see it.
			onUpdate?.({ content: [{ type: "text", text: "Waiting for the learner..." }], details: { options: options.map((o, i) => ({ index: i + 1, label: o.label })) } });

			const { indices: correctIndices, error: keyError } = resolveCorrect(params.correctAnswer as string | string[], options);
			if (signal?.aborted) return cancelledResult(params.question, mode, correctIndices, context);
			if (keyError) return refuse(`quiz ${keyError}`, correctIndices);

			// Guard: never display a quiz whose declared key and whose explanation
			// disagree — the ✓ marker, the grade, and the explanation would then
			// contradict each other in front of the learner. The model re-derives the
			// answer and calls quiz again; see findContradictedOption.
			const contradicted = findContradictedOption(explanation, options, correctIndices);
			if (contradicted !== undefined) {
				const declared = options[correctIndices[0] - 1];
				const claimed = options[contradicted - 1];
				return unavailableResult(
					params.question,
					mode,
					`quiz self-contradiction: correctAnswer is "${declared.value}" but the explanation states the answer is "${claimed.value}". ` +
						"The marked answer, the grade, and the explanation must all agree, so nothing was shown. " +
						"Re-derive the answer from the question itself (or re-read the code), then fix whichever of the two is actually wrong — " +
						"do not simply rewrite the explanation to match the key — and call quiz again.",
					correctIndices,
					context,
				);
			}

			if (params.verify) {
				onUpdate?.({ content: [{ type: "text", text: "Verifying answer by running the code..." }] });
				const verifyError = await verifyChoice(params.verify as VerifySpec, options, correctIndices);
				if (verifyError) return unavailableResult(params.question, mode, verifyError, correctIndices, context);
			}

			// Asked through the VS Code panel: it renders the card and sends the
			// answer back over the bridge.
			const extras: ChoiceExtras = {
				checkpoint: params.purpose === "checkpoint",
				hints: params.purpose === "checkpoint" ? [] : (params.hints ?? []).map((h) => h.trim()).filter(Boolean).slice(0, 3),
			};

			{
				const bridge = getBridge();
				if (!bridge.hasPanel()) return unavailableResult(params.question, mode, "quiz needs the TutorBot panel in VS Code", correctIndices, context);
				const r = await bridge.ask(
					"quiz",
					{
						toolCallId,
						question: params.question,
						context,
						multiSelect: mode === "multi-select",
						purpose: params.purpose,
						checkpoint: extras.checkpoint,
						hints: extras.hints,
						options: options.map((o, i) => ({ index: i + 1, label: o.label, description: o.description })),
					},
					signal,
				);
				if (!r) return cancelledResult(params.question, mode, correctIndices, context);
				const picked: number[] = Array.isArray(r.indices) ? r.indices.filter((i: number) => i >= 1 && i <= options.length) : [];
				const response: QuizResponse = {
					dontKnow: Boolean(r.dontKnow),
					note: typeof r.note === "string" && r.note.trim() ? r.note.trim() : undefined,
					answers: r.dontKnow ? [] : picked.map((i) => ({ label: options[i - 1].label, value: options[i - 1].value, index: i })),
					confidence: [1, 2, 3].includes(r.confidence) ? r.confidence : undefined,
					hintsUsed: Math.max(0, Math.min(extras.hints!.length, Number(r.hintsUsed) || 0)),
				};
				// Explain-it-back before the explanation is revealed.
				const correct = !response.dontKnow && isCorrect(picked, correctIndices);
				if (needsExplainBack(response.dontKnow, correct, response.confidence)) {
					const ex = await bridge.ask(
						"explain_back",
						{
							toolCallId,
							correct,
							yourAnswer: response.answers.map((a) => `${a.index}. ${a.label}`).join(", "),
							correctAnswer: correctIndices.map((i) => formatOptionRef(options, i)).join(", "),
						},
						signal,
					);
					if (ex?.wantsDirect) response.wantsDirect = true;
					else if (typeof ex?.text === "string" && ex.text.trim()) response.selfExplanation = ex.text.trim().slice(0, 4000);
				}
				return buildResult(params.question, context, mode, options, response, correctIndices, explanation, extras);
			}
		},

	});

	pi.registerTool({
		name: "quiz_typed",
		label: "quiz_typed",
		description:
			"Ask a GRADED free-response question: the learner types the answer instead of picking an option, so it can't be found by elimination. Best for code tracing ('type exactly what this prints'), short computations, and recall of a definition/term. Graded by exact match (ignoring whitespace, $ signs and, by default, case) against acceptedAnswers, or against the real program output when verify is given. If the learner disputes a miss as equivalent, you decide.",
		promptSnippet: "Use quiz_typed for graded free-response questions (code tracing, short computations) where multiple choice would allow guessing.",
		promptGuidelines: [
			"quiz_typed: prefer it over quiz for 'what does this code print' once the learner has seen the concept once via multiple choice — typing the full output proves they actually traced it. Always pass verify with the program so the expected answer is the real output.",
			"quiz_typed: for a math expression answer, pass `math` (upToConstant: true for antiderivatives) so any equivalent form is accepted; put the answer in acceptedAnswers[0] in plain or LaTeX form.",
			"quiz_typed: use it for every practice problem with a computed answer (worksheet problems, integrals, derivatives). The question states only the problem: never the method, the identity to use or a worked step; those go in the hidden `hints` ladder. A wrong answer lets the learner try again (up to 3 tries) before the answer is shown.",
			"quiz_typed: if the result says the learner DISPUTED the grade, judge their answer honestly on substance. Then call resolve_dispute with your verdict and tell them plainly whether they were right.",
			"quiz_typed: like quiz, pass a graduated `hints` ladder on practice questions (never with purpose 'checkpoint'); confidence and explain-it-back are collected the same way.",
		],
		parameters: QuizTypedParams,
		prepareArguments: (args: any) => coerceJsonArgs(args, ["concepts", "hints", "acceptedAnswers", "verify", "math"]),

		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const explanation = params.explanation.trim();
			const caseSensitive = params.caseSensitive ?? false;
			let accepted = (params.acceptedAnswers ?? []).map((a) => a.trim()).filter(Boolean);
			const fail = (message: string) => ({
				content: [{ type: "text" as const, text: message }],
				details: { status: "unavailable", question: params.question, message },
			});

			if (params.verify) {
				const spec = params.verify as VerifySpec;
				onUpdate?.({ content: [{ type: "text", text: "Verifying answer by running the code..." }] });
				const r = await runCode(spec.language, spec.code, spec.stdin);
				if ((spec.mode ?? "output") === "assert") {
					if (!r.ok) return fail(`quiz_typed verify (assert) failed — your expected answer is wrong or the check is broken. Program ${describeFailure(r)}`);
				} else {
					if (!r.ok) return fail(`quiz_typed verify failed: the code does not run cleanly — ${describeFailure(r)}\nFix the code (or ask about the error with quiz instead).`);
					const actual = r.stdout.trimEnd();
					const wrong = accepted.filter((a) => normalizeTyped(a, caseSensitive) !== normalizeTyped(actual, caseSensitive));
					if (accepted.length && wrong.length === accepted.length) {
						return fail(
							`quiz_typed verify failed: the code actually prints:\n${actual || "(nothing)"}\nbut acceptedAnswers says ${JSON.stringify(accepted)}. Re-trace, fix the explanation, and call again (or omit acceptedAnswers to use the real output).`,
						);
					}
					accepted = [actual, ...accepted.filter((a) => !wrong.includes(a))];
				}
			}
			if (!accepted.length) return fail("quiz_typed needs acceptedAnswers, or verify in 'output' mode.");
			if (signal?.aborted) return fail("User cancelled the quiz");
			const expected = accepted[0];
			const spec = params.math as MathSpec | undefined;
			if (spec && (await mathEquivalent(expected, expected, spec)) === "error")
				return fail(`quiz_typed: math grading couldn't read acceptedAnswers[0] ("${expected}"). Write it as a plain expression (e.g. 3*x/8 + sin(2*x)/4 + C) or simple LaTeX.`);
			const grade = async (answer: string) => {
				const dontKnow = answer.length === 0 || /^(i don'?t know|idk|not sure|\?)$/i.test(answer);
				let correct = !dontKnow && accepted.some((a) => normalizeTyped(a, caseSensitive) === normalizeTyped(answer, caseSensitive));
				if (!correct && !dontKnow && spec) correct = (await mathEquivalent(answer, expected, spec)) === "equal";
				return { dontKnow, correct };
			};
			const hints = params.purpose === "checkpoint" ? [] : (params.hints ?? []).map((h) => h.trim()).filter(Boolean).slice(0, 3);
			const extras: ChoiceExtras = { checkpoint: params.purpose === "checkpoint", hints };
			const typedResult = (answer: string, dontKnow: boolean, correct: boolean, disputed: boolean, sig: Partial<QuizResponse> = {}, rt: { attempts: number; tries: string[]; revealed: boolean } = { attempts: 1, tries: [], revealed: false }) => {
				let text: string;
				if (dontKnow) text = `User said they don't know (no attempt — a genuine gap, not a wrong guess).\nExpected: ${expected}`;
				else if (correct) text = `User answered correctly${rt.attempts > 1 ? ` on try ${rt.attempts} (earlier tries: ${rt.tries.map((t) => `«${t}»`).join(", ")}) — they found it themselves after a miss; assisted, not yet solid` : ""}.\nTyped: ${answer}`;
				else if (disputed)
					text = `User answered "${answer}", which did not literally match "${expected}", and DISPUTED the grade (they believe it's equivalent). Judge it on substance, call resolve_dispute with your verdict, and tell them which it is and why.`;
				else text = `User answered incorrectly${rt.attempts > 1 ? ` after ${rt.attempts} tries (${[...rt.tries, ...(rt.revealed ? [] : [answer])].map((t) => `«${t}»`).join(", ")})` : ""}${rt.revealed ? " and pressed Show answer" : ""}.\nTyped: ${answer}\nExpected: ${expected}`;
				text += learnerSignalsText({ dontKnow, answers: [], ...sig }, correct, extras);
				text += `\nExplanation: ${explanation}`;
				return {
					content: [{ type: "text" as const, text }],
					details: {
						status: "answered",
						kind: "typed",
						question: params.question,
						answer,
						expected,
						correct,
						dontKnow,
						disputed,
						explanation,
						confidence: sig.confidence,
						hintsUsed: sig.hintsUsed ?? 0,
						hintsAvailable: hints.length,
						attempts: rt.attempts,
						earlierTries: rt.tries,
						revealed: rt.revealed,
						selfExplanation: sig.selfExplanation,
						wantsDirect: sig.wantsDirect,
						checkpoint: extras.checkpoint,
					},
				};
			};

			{
				const bridge = getBridge();
				if (!bridge.hasPanel()) return fail("quiz_typed needs the TutorBot panel in VS Code");
				// Practice: a wrong answer re-opens the box ("Not quite — try again")
				// until it's right, the learner asks for the answer, or tries run out.
				// No-help checkpoints get one try.
				const maxTries = extras.checkpoint ? 1 : TYPED_ATTEMPTS;
				const tries: string[] = [];
				let r: any;
				let answer = "";
				let dontKnow = false;
				let correct = false;
				let confidence: 1 | 2 | 3 | undefined;
				let hintsUsed = 0;
				while (true) {
					r = await bridge.ask(
						"typed",
						{
							toolCallId,
							question: params.question,
							context: params.details,
							purpose: params.purpose,
							checkpoint: extras.checkpoint,
							hints,
							retry: tries.length ? { previous: tries[tries.length - 1], attempt: tries.length + 1, of: maxTries, hintsShown: hintsUsed } : undefined,
						},
						signal,
					);
					if (!r) return { content: [{ type: "text" as const, text: "User cancelled the quiz" }], details: { status: "cancelled", question: params.question } };
					hintsUsed = Math.max(hintsUsed, Math.min(hints.length, Number(r.hintsUsed) || 0));
					if (confidence === undefined && [1, 2, 3].includes(r.confidence)) confidence = r.confidence;
					if (r.reveal) {
						// "Show answer" after a wrong try: graded as that wrong try.
						answer = tries[tries.length - 1] ?? "";
						dontKnow = !answer;
						correct = false;
						break;
					}
					answer = String(r.dontKnow ? "" : (r.answer ?? "")).trim();
					({ dontKnow, correct } = await grade(answer));
					if (correct || dontKnow || tries.length + 1 >= maxTries) break;
					tries.push(answer);
				}
				const attempts = tries.length + (r.reveal ? 0 : 1);
				// After "Show answer" the last try is the answer shown on the card.
				const earlier = r.reveal ? tries.slice(0, -1) : tries;
				const sig: Partial<QuizResponse> = { confidence, hintsUsed };
				// Explain-it-back before the explanation is revealed.
				if (needsExplainBack(dontKnow, correct, sig.confidence)) {
					const ex = await bridge.ask("explain_back", { toolCallId, correct, yourAnswer: answer, correctAnswer: expected }, signal);
					if (ex?.wantsDirect) sig.wantsDirect = true;
					else if (typeof ex?.text === "string" && ex.text.trim()) sig.selfExplanation = ex.text.trim().slice(0, 4000);
				}
				// Then show ✓/✗ + explanation; on a miss the learner may dispute.
				const fb = await bridge.ask("typed_feedback", { toolCallId, question: params.question, answer, dontKnow, correct, expected, explanation, selfExplanation: sig.selfExplanation, attempts, earlierTries: earlier }, signal);
				return typedResult(answer, dontKnow, correct, Boolean(fb?.disputed) && !dontKnow && !correct, sig, { attempts, tries: earlier, revealed: Boolean(r.reveal) });
			}
		},

	});

	// ── explain_back: the learner explains, then sees the reference ───────────
	pi.registerTool({
		name: "explain_back",
		label: "explain_back",
		description:
			"Explain-it-back (self-explanation): show the learner something — a code result, a worked step, an error, a surprising outcome — and have them explain WHY in their own words before you explain. Your reference explanation stays hidden until they answer. Use on problems, results and mistakes; NOT on worked examples you just walked through.",
		promptSnippet: "Have the learner explain a result or step in their own words before you explain it.",
		promptGuidelines: [
			"explain_back: use it before explaining any non-trivial result, code output or step the learner just saw — ask first, explain after. Then compare their explanation with yours, praise what's right, fix the exact gap, and call rate_explanation.",
		],
		prepareArguments: (args: any) => coerceJsonArgs(args, ["concepts"]),
		parameters: Type.Object({
			subject: SubjectParam,
			concepts: ConceptsParam,
			prompt: Type.String({ description: "What to explain, e.g. 'Why does this loop print 0 1 2 and not 0 1 2 3?' Markdown + LaTeX; include the code/result if relevant." }),
			details: Type.Optional(Type.String({ description: "Extra context shown with the prompt (e.g. the code and its output)." })),
			referenceExplanation: Type.String({ description: "Your correct explanation. Hidden until the learner has written theirs." }),
		}),
		async execute(toolCallId, params, signal, _onUpdate, ctx) {
			const reference = params.referenceExplanation.trim();
			const bridge = getBridge();
			if (!bridge.hasPanel()) return { content: [{ type: "text" as const, text: "explain_back needs the TutorBot panel in VS Code" }], details: { status: "unavailable" } };
			const r = await bridge.ask("explain", { toolCallId, prompt: params.prompt, context: params.details }, signal);
			if (!r) return { content: [{ type: "text" as const, text: "User skipped explaining." }], details: { status: "cancelled", prompt: params.prompt, reference } };
			const wantsDirect = Boolean(r.wantsDirect);
			const text: string | undefined = typeof r.text === "string" ? r.text.trim().slice(0, 4000) : undefined;
			const body = wantsDirect
				? "The learner pressed 'Just show me': explain it directly now (clear and concrete), then one easier check."
				: text
					? `Learner's explanation: «${text}»\nYour reference: ${reference}\nCompare them: say exactly what they got right, correct the specific gap (or confirm it's complete), then call rate_explanation (good / partial / missing; a real attempt that names the right cue or slip is at least partial).`
					: `The learner skipped explaining. Explain it now, then ask a quick check question.\nYour reference: ${reference}`;
			return {
				content: [{ type: "text" as const, text: body }],
				details: { status: "answered", kind: "explain", prompt: params.prompt, text, reference, wantsDirect },
			};
		},
	});
}
