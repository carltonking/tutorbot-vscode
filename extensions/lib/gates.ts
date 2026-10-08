import { conceptKey, type ProgressData, type QuizRecord, sameConcept, slug, unaidedCorrect } from "./tutor-store.ts";

// ────────────────────────────────────────────────────────────────────────────
// gates — the pure checks behind TutorBot's teaching rules (tutor/index.ts
// wires them to pi's events). The tutor model is weak, so every rule that
// matters is enforced here, in code, rather than only asked for in the prompt.
// ────────────────────────────────────────────────────────────────────────────

export const QUIZ_TOOLS = new Set(["quiz", "quiz_typed"]);
export const PROBE_PURPOSES = new Set(["diagnostic", "discovery"]);
export const GRADED_PURPOSES = ["check", "review", "checkpoint"];

// pi's own coding tools. TutorBot never runs commands or touches files itself
// (the learner's files are theirs; exercises go through assign_exercise).
export const BLOCKED_BUILTINS = new Set(["bash", "read", "edit", "write", "grep", "find", "ls"]);

export function textOf(message: any): string {
	const c = message?.content;
	if (typeof c === "string") return c;
	if (!Array.isArray(c)) return "";
	return c
		.filter((b: any) => b?.type === "text")
		.map((b: any) => b.text)
		.join("\n");
}

export function lastUserText(branch: any[]): string {
	for (let i = branch.length - 1; i >= 0; i--) if (branch[i]?.message?.role === "user") return textOf(branch[i].message);
	return "";
}

// ── The learner's own words ─────────────────────────────────────────────────
// Apostrophes can be curly (’) when typed on a Mac.
export const FRUSTRATION =
	/\b(just (tell|give|show) me|(?:tell|give) me the answer(?! (?:format|style|layout))|what['’]?s the answer(?! (?:format|style|layout))|show me the (answer|solution)|i (don['’]?t|do not) (get|understand)|i['’]?m (so |really |completely |totally )?(lost|confused|stuck)|i am (so |really |completely |totally )?(lost|confused|stuck)|(this|that|it) (is|makes) no sense|(this|that|it) (does ?n['’]?t|does not) make (any )?sense|confus\w*|frustrat\w*|ugh+|wtf|pmo|stop asking|i give up)\b/i;
// Asking to be handed the answer (vs. saying they're confused or frustrated).
const SHOW_ME = /\b(just (tell|give|show) me|(?:tell|give) me the answer(?! (?:format|style|layout))|what['’]?s the answer(?! (?:format|style|layout))|show me the (answer|solution)|stop asking|i give up)\b/i;
// Their own graded coursework: never solved for them, whatever they ask.
export const GRADED_WORK = /\b(home ?work|hw ?\d*|worksheet|assignment|problem set|pset|graded|take[- ]home|lab ?\d+|(number|question|problem|exercise) \d+|#\d+)\b/i;

export type Distress = "show" | "confused";
// "show": they asked to be shown. "confused": confusion or frustration, which
// gets a parallel worked example, never their own problem solved.
export function distressKind(text: string): Distress | undefined {
	if (!text || text.trimStart().startsWith("/") || !FRUSTRATION.test(text)) return undefined;
	return SHOW_ME.test(text) && !GRADED_WORK.test(text) ? "show" : "confused";
}

// An explicit request to move on from an unmastered concept: anchored at the
// start of the message, or unmistakable phrasing. "ok I get it" or "can we go
// on to the example?" are not requests to skip.
export const MOVE_ON_REQUEST = new RegExp(
	[
		String.raw`^\s*(?:(?:ok(?:ay)?|alright|cool|great|thanks|got it|sure|yes|yeah)[,.!\s]+)*(?:(?:can|could) we |let['’]?s |please |i (?:want|would like) to |i['’]?d like to )?(?:just )?(?:move on|skip(?: (?:this|it|ahead|that))?|next (?:topic|concept|lesson|one)|go (?:on )?to the next (?:topic|concept|lesson))\b`,
		String.raw`\b(?:let['’]?s|can we|could we|i want to|i['’]?d like to|i would like to) (?:just )?(?:move on|skip (?:this|that|it|ahead)|go (?:on )?to the next (?:topic|concept|lesson))\b`,
		String.raw`\bnext (?:topic|concept|lesson),? please\b`,
		String.raw`\bskip (?:this|that) (?:topic|concept|lesson|one)\b`,
		String.raw`^\s*(?:(?:ok(?:ay)?|got it|cool)[,.!\s]+)?next[.!]*\s*$`,
	].join("|"),
	"i",
);

// ── ask_user_question vs. a graded question ─────────────────────────────────
const MATHY = /[$∫∑√]|\\(int|frac|lim|sum|sqrt)|d\/dx|\blim\b|=\s*\?|\d\s*[-+*/%^×÷]\s*\d|\b[a-z]\s*\^\s*\d|\b(derivative|integral|antiderivative|limit|square root|factorial|value) of\b/i;
const CODEY = /`[^`]+`|\bwhat (does|will|would)\b.*\b(print|return|output|evaluate|display)/i;
const ANSWER_ASK =
	/^(what is|what's|what are|evaluate|compute|calculate|find|solve|simplify|differentiate|integrate|derive|define|true or false|how many (times|iterations)|what does .* (print|return|output|evaluate)|which (of these|one|option) (is|are|will|would))/;

// Does an ask_user_question prompt actually have a right answer? Those must go
// through quiz/quiz_typed. Questions about the learner themself are left alone,
// but "What do you think 2+2 is?" is still a question with a right answer.
export function looksLikeKnowledgeCheck(question: string, details?: string): boolean {
	const q = question.trim().toLowerCase();
	const mathy = MATHY.test(`${question} ${details ?? ""}`) || CODEY.test(question);
	if (/\b(prefer|want|would like|should we|shall we|goal|comfortable|feel)\b/.test(q) && !/\b(what is|what's)\b|=\s*\?/.test(q)) return false;
	if (/\b(you|your|you'?d|you'?re|ready)\b/.test(q) && !mathy) return false;
	return mathy || ANSWER_ASK.test(q);
}

// ── Lessons: what the chat shows since the last mark_taught ─────────────────
// Example headings: "Example 1:", "**Worked Example 1**", "## Example 2",
// "Worked problem 1", "Ex. 1". A number or a colon is required, so "Example
// usage below" or "For example, …" don't count.
const EXAMPLE_LABEL = /^[ \t]*(?:#{1,6}[ \t]*)?(?:\*\*|__|\*)?[ \t]*(?:worked[ \t]+(?:example|problem)|example|ex\.)(?:[ \t]*#?\d+\b|[ \t]+(?:one|two|three)\b|[ \t]*:)/im;
const EXAMPLE_HEAD = new RegExp(`${EXAMPLE_LABEL.source}[^\\n]*`, "gim");
const OTHER_HEADING = /^[ \t]*#{1,6}[ \t]+\S/m;
const DELIMITER_LINE = /^\s*(\$\$|\\\[|\\\]|```\w*)\s*$/;
export const MIN_EXAMPLE_CHARS = 120;
export const MIN_EXAMPLE_STEPS = 2;

// Lines of working: code inside a fence, or a line with math, an equation or an arrow.
export function workingSteps(section: string): number {
	let steps = 0;
	let fenced = false;
	for (const line of section.split("\n")) {
		if (/^\s*```/.test(line)) {
			fenced = !fenced;
			continue;
		}
		if (!line.trim() || DELIMITER_LINE.test(line)) continue;
		if (fenced || /\$[^$]+\$|\$\$|\\\(|\\\[|=|→|⇒|->|`[^`]+`/.test(line)) steps++;
	}
	return steps;
}

// The body of each labelled example: up to the next example or other heading.
export function exampleSections(text: string): string[] {
	const heads = [...text.matchAll(EXAMPLE_HEAD)];
	return heads.map((h, i) => {
		const start = (h.index ?? 0) + h[0].length;
		const firstLine = h[0].replace(EXAMPLE_LABEL, "").replace(/^[\s*_:.)\-—–]+/, "");
		const end = i + 1 < heads.length ? (heads[i + 1].index ?? text.length) : text.length;
		let body = text.slice(start, end);
		const other = body.slice(1).search(OTHER_HEADING);
		if (other >= 0) body = body.slice(0, other + 1);
		// Working written on the heading line itself ("Example 1: $x^2$ → …") counts.
		return `${firstLine}\n${body}`;
	});
}

const substantive = (section: string) => section.replace(/\s+/g, " ").trim().length >= MIN_EXAMPLE_CHARS && workingSteps(section) >= MIN_EXAMPLE_STEPS;

// Display math / code blocks that hold real working (≥2 content lines).
export function substantiveBlocks(text: string): number {
	return (text.match(/\$\$[\s\S]+?\$\$|\\\[[\s\S]+?\\\]|```[\s\S]+?```/g) ?? []).filter((b) => {
		const body = b.replace(/^(\$\$|\\\[|```\w*)|(\$\$|\\\]|```)$/g, "");
		return body.split("\n").filter((l) => l.trim()).length >= 2 && body.replace(/\s+/g, "").length >= 20;
	}).length;
}

// Words of a concept name worth looking for in its lesson.
const NAME_STOP = new Set(["and", "the", "for", "with", "using", "basic", "intro", "how", "what", "into", "from", "your", "its", "use"]);
export function conceptWords(name: string): string[] {
	return conceptKey(name)
		.split("-")
		.filter((w) => w.length >= 3 && !NAME_STOP.has(w));
}
export function mentionsConcept(text: string, name: string): boolean {
	const t = text.toLowerCase();
	const words = conceptWords(name);
	if (!words.length) return true;
	return words.some((w) => t.includes(w.slice(0, Math.max(3, Math.min(5, w.length)))));
}

export interface LessonEvidence {
	chars: number;
	labelled: number; // example headings found
	examples: number; // labelled examples with real working
	blocks: number; // substantive display-math / code blocks
	unmentioned: string[]; // concepts the lesson text never names
}

export function lessonEvidence(text: string, concepts: string[] = []): LessonEvidence {
	const sections = exampleSections(text);
	return {
		chars: text.trim().length,
		labelled: sections.length,
		examples: sections.filter(substantive).length,
		blocks: substantiveBlocks(text),
		unmentioned: concepts.filter((c) => !mentionsConcept(text, c)),
	};
}

export const MIN_TEACH_CHARS = 500;
export const MIN_WORKED_EXAMPLES = 2;

// What is still missing before mark_taught may record these concepts.
export function lessonGaps(ev: LessonEvidence, min = MIN_WORKED_EXAMPLES): string[] {
	const missing: string[] = [];
	if (ev.chars < MIN_TEACH_CHARS) missing.push("an explanation of the idea (what it is, why it works, when to use it)");
	// Labelled, substantial examples; or (unlabelled) twice as many multi-line worked blocks.
	if (ev.examples < min && ev.blocks < 2 * min)
		missing.push(
			`${min} fully worked examples, each headed "**Example 1:**", "**Example 2:**" and worked step by step: at least ${MIN_EXAMPLE_STEPS} lines of working each (math or code), about ${MIN_EXAMPLE_CHARS}+ characters each (found ${ev.examples} complete of ${ev.labelled} labelled)`,
		);
	if (ev.unmentioned.length) missing.push(`a lesson that actually names what it teaches (never mentioned: ${ev.unmentioned.join(", ")})`);
	return missing;
}

// One answered quiz card in the session, with its call's arguments.
export interface AnsweredCard {
	index: number;
	tool: string;
	purpose: string;
	concepts: string[];
	correct: boolean;
}

export function answeredQuizzes(branch: any[], from = 0): AnsweredCard[] {
	const calls = new Map<string, any>();
	const out: AnsweredCard[] = [];
	for (let i = 0; i < branch.length; i++) {
		const m = branch[i]?.message;
		if (m?.role === "assistant") {
			for (const b of m.content ?? []) if (b?.type === "toolCall" && QUIZ_TOOLS.has(b.name)) calls.set(b.id, b.arguments ?? {});
		} else if (i >= from && m?.role === "toolResult" && QUIZ_TOOLS.has(m.toolName) && m.details?.status === "answered") {
			const a = calls.get(m.toolCallId) ?? {};
			out.push({
				index: i,
				tool: m.toolName,
				purpose: String(a.purpose ?? "check"),
				concepts: Array.isArray(a.concepts) ? a.concepts.map(String) : [],
				correct: Boolean(m.details.correct),
			});
		}
	}
	return out;
}

// A mark_taught that recorded at least one fresh concept. A no-op mark_taught
// (only names that already existed) doesn't open a new lesson window.
function isFreshMark(m: any): boolean {
	if (m?.role !== "toolResult" || m.toolName !== "mark_taught" || m.isError) return false;
	const fresh = m.details?.fresh;
	return !Array.isArray(fresh) || fresh.length > 0;
}

export interface Lesson {
	start: number; // branch index the lesson window starts at
	text: string;
	probes: number;
	checks: number;
	marked: boolean;
	taught: string[]; // concepts recorded by the mark_taught that opened the window
}

// Everything since the last mark_taught that recorded a fresh concept.
export function lessonSinceLastMark(branch: any[]): Lesson {
	let start = 0;
	let taught: string[] = [];
	for (let i = branch.length - 1; i >= 0; i--) {
		const m = branch[i]?.message;
		if (isFreshMark(m)) {
			start = i + 1;
			taught = Array.isArray(m.details?.concepts) ? m.details.concepts.map(String) : [];
			break;
		}
	}
	let text = "";
	for (const e of branch.slice(start)) if (e?.message?.role === "assistant") text += `\n\n${textOf(e.message)}`;
	const cards = answeredQuizzes(branch, start);
	const probes = cards.filter((c) => PROBE_PURPOSES.has(c.purpose)).length;
	return { start, text, probes, checks: cards.length - probes, marked: start > 0, taught };
}

// Probe questions answered in this session on one concept, and since the last learner message.
export function probesOn(branch: any[], concept: string): number {
	return answeredQuizzes(branch).filter((c) => PROBE_PURPOSES.has(c.purpose) && c.concepts.some((x) => sameConcept(x, concept))).length;
}
export function probesSinceUser(branch: any[]): number {
	let from = 0;
	for (let i = branch.length - 1; i >= 0; i--)
		if (branch[i]?.message?.role === "user") {
			from = i;
			break;
		}
	return answeredQuizzes(branch, from).filter((c) => PROBE_PURPOSES.has(c.purpose)).length;
}

// ── Mastery before moving on ────────────────────────────────────────────────
export const MASTERY_STREAK = 2;
export const MAX_CHECKS_BEFORE_RELEASE = 8; // after this many, stop blocking (re-teaching is the model's call)

// The concept taught most recently in this subject, if the learner hasn't yet
// shown they can do it unaided. Across sittings: yesterday's unfinished
// concept still gates today. Nothing is excluded (re-listing the previous
// concept next to a new one doesn't get around it).
export function unmasteredPrevious(data: ProgressData, subject: string): { name: string; streak: number; checks: number } | undefined {
	const subj = slug(subject);
	const prev = Object.values(data.concepts ?? {})
		.filter((c) => slug(c.subject) === subj && c.taughtAt)
		.sort((a, b) => Date.parse(b.taughtAt!) - Date.parse(a.taughtAt!))[0];
	if (!prev) return undefined;
	const recs = (data.quizLog ?? []).filter(
		(r) => slug(r.subject) === subj && GRADED_PURPOSES.includes(r.purpose) && Date.parse(r.ts) >= Date.parse(prev.taughtAt!) && r.concepts.some((c) => sameConcept(c, prev.name)),
	);
	let streak = 0;
	for (let i = recs.length - 1; i >= 0 && unaidedCorrect(recs[i]); i--) streak++;
	if (streak >= MASTERY_STREAK || recs.length >= MAX_CHECKS_BEFORE_RELEASE) return undefined;
	return { name: prev.name, streak, checks: recs.length };
}

// At least one correct graded answer on the concept (or it was proven known).
export function hasCorrectCheck(data: ProgressData, subject: string, concept: string): boolean {
	const subj = slug(subject);
	const c = Object.values(data.concepts).find((x) => slug(x.subject) === subj && sameConcept(x.name, concept));
	if (c && (c.status === "known" || c.verified)) return true;
	return data.quizLog.some((r) => slug(r.subject) === subj && GRADED_PURPOSES.includes(r.purpose) && r.outcome === "correct" && r.concepts.some((x) => sameConcept(x, concept)));
}

// ── Course order ────────────────────────────────────────────────────────────
// Did the learner ask for this topic (by id or its title's words), or to skip ahead?
export function askedForTopic(userText: string, topic: { id: string; title: string }): boolean {
	const t = userText.toLowerCase();
	if (!t.trim()) return false;
	if (t.includes(topic.id.toLowerCase()) || slug(userText).includes(topic.id)) return true;
	if (/\b(skip ahead|jump (ahead|to)|go ahead to|already know (this|these|it)|i know (this|these) already)\b/.test(t)) return true;
	const words = (topic.title.toLowerCase().match(/[a-z][a-z0-9+#]{3,}/g) ?? []).filter((w) => !NAME_STOP.has(w));
	return words.some((w) => t.includes(w.replace(/s$/, "")));
}

// ── Escape hatch ────────────────────────────────────────────────────────────
// "Asked to be shown" signals in this subject, from the last `minutes`, and
// only those after the learner's last correct graded answer (it ends the hatch).
export function directSignals(data: ProgressData, subject: string | undefined, minutes = 20, now = Date.now()) {
	const cutoff = now - minutes * 60_000;
	const inSubj = (s?: string) => (subject ? Boolean(s) && slug(s!) === slug(subject) : !s);
	const lastCorrect = Math.max(0, ...data.quizLog.filter((r) => inSubj(r.subject) && GRADED_PURPOSES.includes(r.purpose) && r.outcome === "correct").map((r) => Date.parse(r.ts)));
	return (data.signals ?? []).filter((s) => s.kind === "asked-for-answer" && inSubj(s.subject) && Date.parse(s.ts) > Math.max(cutoff, lastCorrect));
}

// ── Solutions to graded work ────────────────────────────────────────────────
// Lines that say nothing about the solution: braces, imports, the class and
// main headers, comments, and reading input.
const TRIVIAL_LINE = /^(?:[{}()[\];,]*|import\b.*|package\b.*|(?:public\s+)?class\s+\w+\s*\{?|(?:public\s+)?static\s+void\s+main\s*\(.*\)\s*\{?|if __name__ == .*|def main\(\):|main\(\)|(?:\/\/|#|\*|\/\*).*|"""|'''|\w+\.close\(\);?)$/;
const INPUT_LINE = /new Scanner|\.next\w*\(|\binput\(|readline|prompt\(/i;
const normLine = (l: string) => l.replace(/\/\/.*$/, "").replace(/\s+/g, "");

export function solutionLines(code: string): { all: string[]; core: string[] } {
	const all = [...new Set(code.split("\n").map((l) => l.trim()).filter((l) => l && !TRIVIAL_LINE.test(l)).map(normLine).filter((l) => l.length >= 4))];
	const core = all.filter((l) => !INPUT_LINE.test(l));
	return { all, core: core.length ? core : all };
}

// Share of the solution's meaningful lines that appear in `text`.
export function solutionOverlap(solution: string, text: string): { ratio: number; matched: number; total: number } {
	const { core } = solutionLines(solution);
	if (core.length < 2) return { ratio: 0, matched: 0, total: core.length };
	const have = new Set(text.split("\n").map((l) => normLine(l.trim().replace(/^[>*-]\s+/, ""))));
	const matched = core.filter((l) => have.has(l)).length;
	return { ratio: matched / core.length, matched, total: core.length };
}

export const LEAK_RATIO = 0.6;
export function leaksSolution(solution: string | undefined, text: string): boolean {
	if (!solution?.trim() || !text.trim()) return false;
	const o = solutionOverlap(solution, text);
	return o.ratio >= LEAK_RATIO && o.matched >= 2;
}

// A hint that contains a whole line of the reference solution (≥6 chars).
export function hintsWithSolutionLines(hints: unknown, solution: string | undefined): string[] {
	if (!Array.isArray(hints) || !solution) return [];
	const lines = solutionLines(solution).all.filter((l) => l.length >= 6);
	const out: string[] = [];
	for (const h of hints) {
		const flat = String(h ?? "").replace(/\s+/g, "");
		for (const l of lines) if (flat.includes(l)) out.push(l);
	}
	return [...new Set(out)];
}

// The quiz's key, if it is already shown before the learner answers: in the
// hints or details (and, for typed questions, the question itself). Code the
// learner is meant to trace is skipped in question/details (`println("hi")`
// legitimately contains "hi").
const normAnswer = (s: string) =>
	s
		.toLowerCase()
		.replace(/\\[,;:! ]|\$|\\left|\\right/g, "")
		.replace(/[\s{}]/g, "")
		.replace(/[.;]+$/, "");
const stripCode = (s: string) => s.replace(/```[\s\S]*?```/g, " ").replace(/`[^`\n]*`/g, " ");
const TRIVIAL_ANSWERS = new Set(["true", "false", "yes", "no", "none", "both", "neither", "alloftheabove", "noneoftheabove"]);
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function quizKeyLeak(tool: string, input: any): string | undefined {
	let keys: string[] = [];
	if (tool === "quiz_typed") keys = (Array.isArray(input?.acceptedAnswers) ? input.acceptedAnswers : []).map(String);
	else if (tool === "quiz") {
		const want = (Array.isArray(input?.correctAnswer) ? input.correctAnswer : [input?.correctAnswer]).filter(Boolean).map((x: any) => String(x).trim());
		for (const o of Array.isArray(input?.options) ? input.options : []) {
			const label = String(o?.label ?? o ?? "").trim();
			const value = String(o?.value ?? label).trim();
			if (want.includes(value) || want.includes(label)) keys.push(label);
		}
	}
	keys = keys.filter((k) => k.trim() && !TRIVIAL_ANSWERS.has(normAnswer(k)));
	if (!keys.length) return undefined;
	const hints = (Array.isArray(input?.hints) ? input.hints : []).map((h: any) => String(h ?? ""));
	const fields: { name: string; text: string; cueEq: boolean }[] = [
		...hints.map((h: string, i: number) => ({ name: `hint ${i + 1}`, text: h, cueEq: true })),
		{ name: "details", text: stripCode(String(input?.details ?? "")), cueEq: false },
		...(tool === "quiz_typed" ? [{ name: "question", text: stripCode(String(input?.question ?? "")), cueEq: false }] : []),
	];
	for (const k of keys) {
		const nk = normAnswer(k);
		for (const f of fields) {
			if (!f.text.trim()) continue;
			if (nk.length >= 3) {
				if (normAnswer(f.text).includes(nk)) return `${f.name} contains the answer "${k}"`;
				continue;
			}
			// A short answer ("5", "x") only counts when it's presented as an answer or format.
			const cue = new RegExp(`(?:e\\.g\\.|for example|example|format|such as|answer(?: is)?|like${f.cueEq ? "|=" : ""})\\s*:?\\s*["'\`$]*${escapeRe(k.trim())}(?![\\w.])`, "i");
			if (cue.test(f.text)) return `${f.name} gives away the answer "${k}"`;
		}
	}
	return undefined;
}

// ── Notes the learner left on an answer ─────────────────────────────────────
const NOTE_STOP = new Set(["this", "that", "what", "why", "how", "does", "the", "and", "but", "with", "have", "just", "about", "into", "they", "them", "there", "here", "when", "then", "than", "your", "you", "are", "was", "were", "it's", "its", "can", "not", "don't", "for"]);
const noteWords = (s: string) => [...new Set((s.toLowerCase().match(/[a-z0-9_+\-*/%<>=!&|]{3,}/g) ?? []).filter((w) => !NOTE_STOP.has(w)))];

// Did the reply answer the note? It refers to it ("your note", "you asked"),
// shares a content word with it, or, for a note with almost no content words
// ("??", "huh"), is at least a full sentence.
export function noteAddressed(note: string, reply: string): boolean {
	const r = reply.toLowerCase();
	if (/\b(your note|you (asked|wrote|said|mentioned|noted)|good question|great question|to answer your)\b/.test(r)) return true;
	const words = noteWords(note);
	if (words.length < 2) return /[a-z].{20,}[.!?]/i.test(reply);
	return words.some((w) => r.includes(w.replace(/s$/, "")));
}

// ── After the learner skips a card ──────────────────────────────────────────
const CARD_RESULTS = new Set(["quiz", "quiz_typed", "assign_exercise"]);
// The last card result since the learner's last message was a skip.
export function skippedSinceUser(branch: any[]): string | undefined {
	for (let i = branch.length - 1; i >= 0; i--) {
		const m = branch[i]?.message;
		if (!m) continue;
		if (m.role === "user") return undefined;
		if (m.role === "toolResult" && CARD_RESULTS.has(m.toolName) && !m.isError) {
			return m.details?.status === "cancelled" ? m.toolName : undefined;
		}
	}
	return undefined;
}

// ── The open exercise ───────────────────────────────────────────────────────
export interface OpenExercise {
	title?: string;
	referenceSolution?: string;
	language?: string;
	status?: string;
}

// The exercise the learner is working on: the exercises extension publishes it
// (globalThis.__tutorExercise); otherwise the last assign_exercise in this
// session that hasn't been solved or given up.
export function openExercise(branch: any[], published: OpenExercise | undefined = (globalThis as any).__tutorExercise): OpenExercise | undefined {
	if (published && typeof published === "object") {
		const st = String(published.status ?? "active");
		if (st !== "active") return undefined;
		const title = published.title;
		const gaveUp = branch.some((e) => e?.message?.role === "toolResult" && e.message.toolName === "assign_exercise" && e.message.details?.status === "answered" && (!title || e.message.details?.title === title));
		return gaveUp ? undefined : published;
	}
	for (let i = branch.length - 1; i >= 0; i--) {
		const m = branch[i]?.message;
		if (m?.role !== "assistant") continue;
		const call = (m.content ?? []).find((b: any) => b?.type === "toolCall" && b.name === "assign_exercise" && b.arguments?.referenceSolution);
		if (!call) continue;
		const res = branch.slice(i + 1).find((e) => e?.message?.role === "toolResult" && e.message.toolCallId === call.id)?.message;
		if (res && (res.isError || res.details?.status === "answered")) return undefined;
		return { title: call.arguments.title, referenceSolution: call.arguments.referenceSolution, language: call.arguments.language, status: "active" };
	}
	return undefined;
}

// ── Bounce budgets ──────────────────────────────────────────────────────────
// Bounce a call at most `max` times per (kind, question), so a model that
// can't comply still gets through, without one stubborn question switching the
// rule off for the rest of the session. Reset on every learner message.
export class Bounces {
	private n = new Map<string, number>();
	take(kind: string, key: string, max: number): boolean {
		const k = `${kind}\u0000${key}`;
		const used = this.n.get(k) ?? 0;
		if (used >= max) return false;
		this.n.set(k, used + 1);
		return true;
	}
	reset(): void {
		this.n.clear();
	}
}

export type { QuizRecord };
