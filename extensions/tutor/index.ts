import { type ExtensionAPI, SessionManager } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { getBridge } from "../lib/bridge.ts";
import { registerCustomProvider } from "../lib/custom-provider.ts";
import { coerceJsonArgs, coerceList } from "../lib/coerce.ts";
import * as Constructs from "../lib/constructs.ts";
import { type CodeLanguage, type Construct, fencedCode, subjectLanguage, topicFor, untaughtConstructs } from "../lib/constructs.ts";
import {
	askedForTopic,
	BLOCKED_BUILTINS,
	Bounces,
	directSignals,
	distressKind,
	GRADED_WORK,
	hasCorrectCheck,
	hintsWithSolutionLines,
	lastUserText,
	leaksSolution,
	lessonEvidence,
	lessonGaps,
	lessonSinceLastMark,
	looksLikeKnowledgeCheck,
	MASTERY_STREAK,
	MIN_WORKED_EXAMPLES,
	MOVE_ON_REQUEST,
	noteAddressed,
	openExercise,
	probesOn,
	probesSinceUser,
	PROBE_PURPOSES,
	quizKeyLeak,
	skippedSinceUser,
	textOf,
	unmasteredPrevious,
} from "../lib/gates.ts";
import { ANSWER_KEY_PATH, ASSESSMENT_PATH, displayPath, folderExists, ResourceIndex } from "../lib/resources.ts";
import { displayedFields, endsOnLeadIn, findPlainMath, looksLikeTextProblem, looksLikeTextQuiz, repairInputMath } from "../lib/plain-math.ts";
import { SubjectRegistry } from "../lib/subjects.ts";
import { type Approach, APPROACHES, type LessonRating, type QuizOutcome, type QuizPurpose, type QuizRecord, slug, TutorStore } from "../lib/tutor-store.ts";

// Session names TutorBot sets itself; the conversation list shows the first
// message for these instead.
const AUTO_NAME = / · TutorBot$/;

// ────────────────────────────────────────────────────────────────────────────
// tutor — turns the teaching setup into a persistent, any-subject tutor.
//
//   • Progress: every quiz answer is recorded per concept with a spaced-review
//     schedule; Tutor/Progress.md is a live dashboard in Obsidian.
//   • Teach-first gate: a check/review quiz on a concept that was never taught
//     (mark_taught) is blocked before the learner ever sees it.
//   • Notes get answered: a new quiz is blocked until the agent has replied to
//     the note the learner left on the previous one.
//   • Class resources: configured folders are indexed and searchable, so lessons
//     follow the class's own notation, examples and order.
//   • Learner profile: Tutor/Learner Profile.md is injected every turn and the
//     agent adds evidence-backed observations about what works for this learner.
// ────────────────────────────────────────────────────────────────────────────

const QUIZ_TOOLS = new Set(["quiz", "quiz_typed"]);
const PROFILE_SECTIONS = ["Stated preferences", "What works", "What doesn't work", "Pace & format", "Observations log"] as const;
const MAX_PROFILE_CHARS = 5000;
const SUBJECT_ENTRY = "tutor-subject";
// Tools whose text the learner sees typeset (KaTeX) in the VS Code panel.
const MATH_TOOLS = new Set(["quiz", "quiz_typed", "explain_back"]);
// Bounce a call for plain-text math at most this many times in a row, so a
// model that can't comply still gets its question through.
const MAX_MATH_BOUNCES = 2;
const MAX_REPEAT_BOUNCES = 2;
const GATED_TOOLS = new Set(["quiz", "quiz_typed", "assign_exercise"]);
const SUBJECT_TOOLS = new Set(["quiz", "quiz_typed", "assign_exercise", "mark_taught", "explain_back", "set_assessment", "save_course_style", "course_style_sources", "teacher_examples", "course_map_sources", "save_course_map", "tag_concepts"]);
// Files that describe the course structure (for the topic map).
const SYLLABUS_PATH = /(syllabus|schedule|calendar|outline|course[ _-]?(info|overview|plan)|topics|pacing|scope|map|unit[ _-]?plan)/i;
const RATING_LABEL: Record<LessonRating, string> = { clicked: "Clicked", fuzzy: "Still fuzzy", "too-fast": "Too fast", "too-slow": "Too slow" };

const NUDGE_LABEL = "com.tutorbot.nudge";
const nudgePlistPath = () => join(homedir(), "Library", "LaunchAgents", `${NUDGE_LABEL}.plist`);
const NUDGE_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "nudge.mjs");

// Folder picker: the VS Code panel shows VS Code's own dialog.
async function pickFolder(prompt: string, signal?: AbortSignal): Promise<string | undefined> {
	const r = await getBridge().ask("pickFolder", { title: prompt }, signal);
	return r && typeof r.path === "string" && r.path ? r.path : undefined;
}

function expandPath(p: string): string {
	const t = p.trim().replace(/^["']|["']$/g, "");
	return resolve(t.startsWith("~") ? join(homedir(), t.slice(1)) : t);
}

// ── Re-asking after a miss ──────────────────────────────────────────────────
// Re-asking a just-missed question only tests memory of the answer shown
// seconds ago. After a miss the tutor asks a variant, and the original comes
// back after at least RETEST_GAP other questions (a delayed, effortful retest).
const RETEST_GAP = 2;

// A question's identity, ignoring LaTeX delimiters, spacing, case and punctuation.
function questionKey(q: string): string {
	return q
		.toLowerCase()
		.replace(/\\[,;:! ]|\$/g, "")
		.replace(/[\s?.!:,;'"`]/g, "");
}

// Exact match only: a real variant can differ from the original by a single
// character (a 3 in place of a 1), so no fuzzy matching.
const sameQuestion = (a: string, b: string): boolean => a === b;

interface AskedQuestion {
	question: string;
	key: string;
	correct: boolean;
}

// Graded questions the learner answered in this session, oldest first.
function sessionQuestions(branch: any[]): AskedQuestion[] {
	const out: AskedQuestion[] = [];
	for (const e of branch) {
		const m = e?.message;
		if (m?.role !== "toolResult" || !QUIZ_TOOLS.has(m.toolName) || m.details?.status !== "answered") continue;
		if (typeof m.details.question !== "string") continue;
		out.push({ question: m.details.question, key: questionKey(m.details.question), correct: Boolean(m.details.correct) });
	}
	return out;
}

// Misses not asked again yet: `ready` once RETEST_GAP other questions came after.
function pendingRetests(asked: AskedQuestion[]): { miss: AskedQuestion; since: number }[] {
	const out: { miss: AskedQuestion; since: number }[] = [];
	asked.forEach((q, i) => {
		if (q.correct) return;
		const later = asked.slice(i + 1);
		if (later.some((x) => sameQuestion(x.key, q.key))) return;
		if (out.some((x) => sameQuestion(x.miss.key, q.key))) return;
		out.push({ miss: q, since: later.length });
	});
	return out;
}

// A reply that stops inside a math expression: an unclosed $$…, or a last line
// whose final $ opens LaTeX that never closes. (Some routers cut a reply short
// and still report a normal stop.)
function endsMidMath(text: string): boolean {
	const t = text.replace(/```[\s\S]*?(```|$)/g, "").replace(/`[^`\n]*`/g, "").replace(/\\\$/g, "");
	if ((t.match(/\$\$/g) ?? []).length % 2) return true;
	const last = t.replace(/\$\$[\s\S]*?\$\$/g, "").trimEnd().split("\n").pop() ?? "";
	const dollars = (last.match(/\$/g) ?? []).length;
	if (dollars % 2 === 0) return false;
	const tail = last.slice(last.lastIndexOf("$") + 1);
	return /\\[A-Za-z]|[_^=+\-*/(){}]/.test(tail);
}

// ── Teach-first evidence ────────────────────────────────────────────────────
// "Taught" must mean the learner actually saw a lesson: an explanation and
// worked examples in the chat since the last mark_taught (lib/gates.ts).
// Without this a model marks a whole course as taught in one call and goes
// straight to quizzing.
const MAX_NEW_CONCEPTS_PER_LESSON = 2;
const MAX_PROBES = 3; // diagnostic/discovery questions before the tutor has to teach (per lesson, per concept, per learner message)
const MAX_GUIDED_BOUNCES = 3; // per lesson: then the model's question goes through

// Mastery gating (a criterion before the next unit) helps most for weaker
// learners (Kulik et al. 1990, ES ≈ 0.52): MASTERY_STREAK unaided correct
// checks in a row (right, not a guess, no hints, first try) before the next
// concept. Unaided, because help during practice inflates scores without
// learning (Bastani et al. 2025).

// The session branch, or nothing from a ctx whose session was replaced.
function safeBranch(ctx: any): any[] {
	try {
		return (ctx.sessionManager.getBranch() as any[]) ?? [];
	} catch {
		return [];
	}
}

// The course's topic order for a subject (its topic map), what the learner's
// concepts already cover, and the first topic nothing covers yet.
function courseOrder(store: TutorStore, data: ReturnType<TutorStore["loadProgress"]>, subject: string) {
	const map = store.readTopicMap(subject);
	if (!map?.topics.length) return undefined;
	const topics = map.topics.slice().sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
	const links = store.loadLinks();
	const onMap = new Set(topics.map((t) => t.id));
	const covered = new Set(store.conceptsForSubject(data, subject).flatMap((c) => [store.effectiveTopic(c, links, onMap).topic, slug(c.name)]).filter(Boolean) as string[]);
	const next = topics.find((t) => !covered.has(t.id));
	const index = (id?: string) => (id ? topics.findIndex((t) => t.id === id) : -1);
	return { topics, covered, next, index };
}

// Feedback that explains *why* beats right/wrong feedback (high-information
// feedback d ≈ 0.99 vs corrective d ≈ 0.46; Wisniewski et al. 2020). The
// explanation shown after an answer must carry reasoning, not just the key.
function explanationReasoning(explanation: string): number {
	return explanation
		.replace(/^\s*(?:\*\*)?(?:final\s+)?answer(?:\*\*)?\s*:.*$/gim, "")
		.replace(/\s+/g, " ")
		.trim().length;
}
const MIN_EXPLANATION_REASONING = 80;

// A question card the model was writing when the session ended: the last
// message is an assistant reply whose card tool call never got a result.
// Only recent ones (an old unfinished session isn't resumed out of the blue).
const CARD_CALLS = new Set(["quiz", "quiz_typed", "ask_user_question", "explain_back", "assign_exercise"]);
function interruptedCardCall(branch: any[]): string | undefined {
	const msgs = branch.filter((e) => e?.type === "message" && e.message);
	const last = msgs[msgs.length - 1]?.message;
	if (last?.role !== "assistant" || Date.now() - Number(last.timestamp ?? 0) > 2 * 3_600_000) return undefined;
	const call = (last.content ?? []).find((b: any) => b?.type === "toolCall" && CARD_CALLS.has(b.name));
	return call?.name;
}

// The subject a session file was tagged with (its last tutor-subject entry).
function subjectTagOf(file: string | undefined): string | undefined {
	if (!file) return undefined;
	let subject: string | undefined;
	try {
		for (const line of readFileSync(file, "utf8").split("\n")) {
			if (!line.includes(SUBJECT_ENTRY)) continue;
			try {
				const e = JSON.parse(line);
				if (e?.type === "custom" && e.customType === SUBJECT_ENTRY && e.data?.subject) subject = e.data.subject;
			} catch {
				// partial line
			}
		}
	} catch {
		// not written yet / unreadable
	}
	return subject;
}

// Run a UI call if this ctx is still live; after a session switch it throws.
function safeUi(ctx: any, fn: (ui: any) => void): void {
	try {
		fn(ctx.ui);
	} catch {
		// stale ctx from a replaced session — nothing to show
	}
}

function today(): string {
	return new Date().toISOString().slice(0, 10);
}

function reviewPrompt(store: TutorStore, data: ReturnType<TutorStore["loadProgress"]>, subject?: string): string | undefined {
	const due = store.dueConcepts(data, subject).slice(0, 10);
	if (!due.length) return undefined;
	// Interleave: never two items from the same family back to back.
	const ordered: typeof due = [];
	const rest = [...due];
	while (rest.length) {
		const prev = ordered[ordered.length - 1];
		const i = rest.findIndex((c) => !prev || (c.family ?? c.id) !== (prev.family ?? prev.id));
		ordered.push(...rest.splice(i < 0 ? 0 : i, 1));
	}
	const list = ordered
		.map((c) => `- ${c.subject} › ${c.name}${c.family ? ` [${c.family}]` : ""}${c.summary ? ` (${c.summary})` : ""} — ${c.correct}/${c.attempts} so far${c.confidentMisses ? ", confidently missed before" : ""}`)
		.join("\n");
	return (
		`Run a short spaced-review session on these due concepts, in this mixed order:\n${list}\n\n` +
		`For each: one review question with purpose "review" (quiz_typed when the answer is short or is code output, quiz otherwise; verify anything computable; include a hints ladder). ` +
		`For concepts in a family, present the problem without naming the technique, so I have to recognise which one applies. ` +
		`If I miss one, re-teach just that idea briefly from its foundation, then re-check. Don't introduce new material. End with a one-line summary of what's solid and what still needs work.`
	);
}

function practicePrompt(store: TutorStore, data: ReturnType<TutorStore["loadProgress"]>, subject: string, family?: string, n = 6): string | undefined {
	const set = store.interleavedSet(data, subject, n, family);
	if (set.length < 2) return undefined;
	const families = [...new Set(set.map((c) => c.family).filter(Boolean))];
	return (
		`Run an INTERLEAVED practice set for ${subject} (${set.length} problems, in exactly this order):\n` +
		set.map((c, i) => `${i + 1}. ${c.name}${c.family ? ` [${c.family}]` : ""}`).join("\n") +
		`\n\nFor each problem: write a fresh problem that needs that concept${families.length ? " (in the course's style; call teacher_examples first if a class folder exists)" : ""}, but do NOT say which technique it is. ` +
		`First ask me which technique/approach applies (quiz, purpose "review", options = the techniques from the same family, concepts = [that concept]); then have me solve it (quiz_typed or quiz with purpose "review", a hints ladder, and a verify check when computable). ` +
		`Keep the order mixed even if I get one wrong (re-teach briefly, then continue). At the end: which techniques I confuse with each other, in one or two lines.`
	);
}

function checkpointPrompt(store: TutorStore, data: ReturnType<TutorStore["loadProgress"]>, subject: string, n = 6): string | undefined {
	const set = store.checkpointSet(data, subject, n);
	if (!set.length) return undefined;
	return (
		`Run a NO-HELP CHECKPOINT for ${subject}: ${set.length} questions, one per concept, in this order:\n` +
		set.map((c, i) => `${i + 1}. ${c.name}`).join("\n") +
		`\n\nRules: purpose "checkpoint" on every question, NO hints, no teaching or feedback between questions beyond the automatic result, mixed formats (quiz and quiz_typed), verify anything computable, and write the questions in the course's style (teacher_examples if a class folder exists). ` +
		`After the last one, give me a short scorecard: which concepts I truly own now, which need work, and what we'll do about them.`
	);
}

export default function tutor(pi: ExtensionAPI) {
	registerCustomProvider(pi);
	let store: TutorStore | undefined;
	let index: ResourceIndex | undefined;
	let registry: SubjectRegistry | undefined;
	let activeSubject: string | undefined;
	let weeklyPending: string | undefined; // weekly summary to recap on the next turn

	function get(ctx: { cwd: string }) {
		if (!store || store.root !== join(ctx.cwd, "Tutor")) {
			store = new TutorStore(ctx.cwd);
			index = new ResourceIndex(store.dataDir);
			registry = new SubjectRegistry(store.dataDir);
		}
		return { store, index: index!, registry: registry! };
	}

	function searchFolders(ctx: { cwd: string }, all = false): string[] {
		const { store, registry } = get(ctx);
		const global = store.loadConfig().resourceFolders;
		return all ? registry.allFolders(global) : registry.foldersFor(activeSubject, global);
	}

	// Indexing outlives session switches, so it is one process-wide job, and its
	// UI updates go through safeUi (a ctx from a replaced session throws on use).
	function startIndexing(ctx: any, notifyWhenDone: boolean) {
		const g = globalThis as any;
		if (g.__tutorIndexing) return g.__tutorIndexing as Promise<unknown>;
		const { index } = get(ctx);
		const folders = searchFolders(ctx, true);
		if (!folders.length) return undefined;
		g.__tutorIndexing = index
			.build(folders, (done, total, file) => {
				safeUi(ctx, (ui) => ui.setStatus("tutor", `Indexing class resources ${done}/${total}: ${file.split("/").pop()}`));
			})
			.then((r) => {
				safeUi(ctx, (ui) => {
					ui.setStatus("tutor", undefined);
					if (notifyWhenDone) ui.notify(`Indexed ${r.total} resource files (${r.extracted} new/changed${r.failed ? `, ${r.failed} unreadable` : ""}).`, "info");
				});
				return r;
			})
			.catch((e) => {
				safeUi(ctx, (ui) => {
					ui.setStatus("tutor", undefined);
					ui.notify(`Resource indexing failed: ${(e as Error).message}`, "error");
				});
			})
			.finally(() => {
				g.__tutorIndexing = undefined;
			});
		return g.__tutorIndexing as Promise<unknown>;
	}

	const isIndexing = () => Boolean((globalThis as any).__tutorIndexing);

	// Refresh the index quietly in the background when a session starts, so
	// files added to class folders since last time become searchable.
	pi.on("session_start", async (event, ctx) => {
		const g = globalThis as any;
		// TutorBot only runs inside the VS Code panel; quizzes, questions and
		// exercises have no terminal UI.
		if (ctx.mode === "tui" && !g.__tutorbotTuiWarned) {
			g.__tutorbotTuiWarned = true;
			ctx.ui.notify("TutorBot runs in VS Code: open the TutorBot panel (⌘Esc). Quizzes and exercises don't work in the terminal.", "warning");
		}
		const { registry } = get(ctx);
		// A subject chosen in /subject before a session switch is handed to the
		// new extension instance through this global (old instances are torn down).
		const pending: string | undefined = g.__tutorPendingSubject;
		g.__tutorPendingSubject = undefined;
		activeSubject = undefined;
		for (const e of ctx.sessionManager.getBranch() as any[]) {
			if (e?.type === "custom" && e.customType === SUBJECT_ENTRY) activeSubject = e.data?.subject;
		}
		// A subject renamed since this session was tagged resolves to its new name;
		// one removed from the subject list (VS Code directory) is dropped.
		if (activeSubject) activeSubject = registry.has(activeSubject) ? registry.resolve(activeSubject) : undefined;
		// New Chat keeps the subject you were studying (unless you chose "Just chat").
		const freeChat = Boolean(g.__tutorFreeChat);
		g.__tutorFreeChat = false;
		const carried = event.reason === "new" && !pending && !activeSubject && !freeChat ? (subjectTagOf(event.previousSessionFile) ?? g.__tutorLastSubject) : undefined;
		const tag = pending ?? (carried && registry.has(carried) ? registry.resolve(carried) : undefined);
		if (tag) {
			activeSubject = tag;
			pi.appendEntry(SUBJECT_ENTRY, { subject: tag });
			pi.setSessionName(`${tag} · TutorBot`);
		}
		if (activeSubject) {
			registry.update(activeSubject, { lastUsed: new Date().toISOString(), lastSession: ctx.sessionManager.getSessionFile() });
		}
		g.__tutorLastSubject = activeSubject; // for New Chat when the old session was never written
		getBridge().setState("subject", activeSubject ?? null);
		getBridge().reset(); // the panel reloads the transcript
		showSubjectStatus(ctx);
		startIndexing(ctx, false);
		registerSessionApi(ctx);
		registerLearningApi(ctx);
		maybeWriteWeekly(ctx);

		// Started by the VS Code panel: open the subject picker first — unless it
		// was started from the subject directory, which picks the subject itself.
		if (event.reason === "startup" && process.env.TUTORBOT === "1" && process.env.TUTORBOT_NO_PICKER !== "1" && !g.__tutorbotPickerShown) {
			g.__tutorbotPickerShown = true;
			setTimeout(() => pi.sendUserMessage("/subject", { expandPromptTemplates: true }), 300);
		}

		// Reopened mid-question: TutorBot restarted (or the panel reloaded) while a
		// quiz was still being written, so the reply ends on its lead-in ("Here is a
		// variant:") and the card never arrived. Ask it again.
		const orphan = interruptedCardCall(ctx.sessionManager.getBranch() as any[]);
		const resumeSid = ctx.sessionManager.getSessionId();
		if ((event.reason === "resume" || event.reason === "reload") && orphan && g.__tutorResumedFor !== resumeSid) {
			g.__tutorResumedFor = resumeSid;
			setTimeout(
				() =>
					pi.sendMessage(
						{
							customType: "tutor-nudge",
							content: `TutorBot restarted while your ${orphan} call was in progress, so the learner never saw that question and your last reply ends on its lead-in. Ask it again now by calling ${orphan} with the same question. Don't repeat the text you already wrote and don't mention the restart unless asked.`,
							display: false,
						},
						{ deliverAs: "followUp", triggerTurn: true },
					),
				600,
			);
		}

		// A new, empty session asks where to start — unless it starts itself
		// (a /home kickoff message) or the learner explicitly chose free chat.
		const kickoff = Boolean(g.__tutorKickoff);
		g.__tutorKickoff = false;
		const empty = !(ctx.sessionManager.getBranch() as any[]).some((e) => e?.type === "message");
		// session_start can fire more than once for one new session: ask only once.
		const sid = ctx.sessionManager.getSessionId();
		if (event.reason === "new" && empty && !kickoff && !freeChat && g.__tutorOpenerFor !== sid) {
			g.__tutorOpenerFor = sid;
			setTimeout(() => openingMenu(ctx), 400);
		}
	});

	// "Where do you want to start?" — choices built from the learner's progress.
	async function openingMenu(ctx: any) {
		try {
			if (!activeSubject) {
				pi.sendUserMessage("/home", { expandPromptTemplates: true });
				return;
			}
			const subject = activeSubject;
			const { store } = get(ctx);
			const data = store.loadProgress();
			const concepts = store.conceptsForSubject(data, subject);
			const due = store.dueConcepts(data, subject);
			const when = (c: any) => c.lastSeen ?? c.taughtAt ?? "";
			const last = concepts.filter(when).sort((a, b) => when(b).localeCompare(when(a)))[0];
			const links = store.loadLinks();
			const covered = new Set(concepts.map((c) => store.effectiveTopic(c, links).topic).filter(Boolean));
			const next = store
				.readTopicMap(subject)
				?.topics.slice()
				.sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
				.find((t) => !covered.has(t.id));
			const exam = store.upcomingAssessments(data, 14, subject)[0];

			const choices: [string, string | undefined][] = [];
			if (last) choices.push([`Continue with ${last.name}`, `Let's continue with ${last.name} in ${subject}. Briefly recap where we left off, then pick up from there.`]);
			if (due.length) choices.push([`Review what's due (${due.length})`, reviewPrompt(store, data, subject)]);
			if (next) choices.push([`Start the next topic: ${next.title}`, `Teach me the next topic in ${subject}: ${next.title}. Check the prerequisites I need first.`]);
			if (exam) {
				const days = exam.daysLeft === 0 ? "today" : `in ${exam.daysLeft} day${exam.daysLeft === 1 ? "" : "s"}`;
				choices.push([`Prepare for ${exam.name} (${days})`, `Help me prepare for ${exam.name} in ${subject} on ${exam.date}${exam.topics ? ` (covers: ${exam.topics})` : ""}. Start with a short checkpoint on what it covers, then focus on my weak spots.`]);
			}
			if (!concepts.length) {
				choices.push([`Start ${subject} from the beginning`, `I want to learn ${subject} from the beginning. Propose a plan, then start with the first topic.`]);
				choices.push(["Find out what I already know", `Find out what I already know about ${subject} with a few short diagnostic questions, then suggest where I should start.`]);
			}
			choices.push(["Something else (I'll type it)", undefined]);

			const pick = await ctx.ui.select(`Where do you want to start? · ${subject}`, choices.map(([label]) => label));
			const prompt = choices.find(([label]) => label === pick)?.[1];
			if (prompt) pi.sendUserMessage(prompt);
			else if (pick) ctx.ui.notify("Type what you'd like to work on below.", "info");
		} catch {
			// session replaced before the menu could show
		}
	}

	// Some models (notably reasoning models) end a turn with only hidden
	// reasoning and no visible text — the learner sees nothing useful. Nudge
	// the model once per learner message to actually write its reply.
	let nudgedSinceUser = false;
	let cutNudgedSinceUser = false; // "you were cut off mid-formula" sent since the learner's last message
	let leadInNudgedSinceUser = false; // "you announced a question and stopped" sent since the learner's last message
	let textQuizNudges = 0; // "re-ask that as a quiz" nudges since the learner's last message (also reset by a real quiz call)
	let textProblemNudges = 0; // "pose that problem as a quiz_typed card" nudges (same resets)
	const bounces = new Bounces(); // per-question bounce budgets for the gates below (reset per learner message)
	let leakNudgedSinceUser = false; // "you just pasted the exercise's solution"
	let lessonCodeNudgedSinceUser = false; // "your example uses untaught constructs"
	pi.on("message_end", async (event, ctx) => {
		const m: any = event.message;
		if (m?.role === "user") {
			nudgedSinceUser = false;
			cutNudgedSinceUser = false;
			leadInNudgedSinceUser = false;
			leakNudgedSinceUser = false;
			lessonCodeNudgedSinceUser = false;
			textQuizNudges = textProblemNudges = 0;
			bounces.reset();
			return;
		}
		if (m?.role !== "assistant") return;
		const hasToolCall = (m.content ?? []).some((b: any) => b?.type === "toolCall");
		const said = textOf(m);
		// The solution to the open exercise, pasted into chat: it can't be
		// unsent, but the model must stop and switch to a parallel example.
		if (!leakNudgedSinceUser && said.trim()) {
			const branch = safeBranch(ctx);
			const ex = openExercise(branch);
			if (ex && leaksSolution(ex.referenceSolution, said)) {
				leakNudgedSinceUser = true;
				try {
					get(ctx).store.addSignal({ subject: activeSubject, kind: "solution-leak", detail: String(ex.title ?? "").slice(0, 120) });
				} catch {
					// logging is best-effort
				}
				pi.sendMessage(
					{
						customType: "tutor-nudge",
						content:
							`STOP: your last message contains the solution (or nearly all of it) to the learner's open, graded exercise "${ex.title ?? ""}". Handing over the solution to graded work is never allowed, even when they ask. ` +
							"Don't repeat or explain that code further. In your next message, tell the learner briefly to try it themselves first, then help with a hint or a worked PARALLEL example (a different problem using the same idea). " +
							"If they really want the reference solution, the exercise card's Give up button shows it.",
						display: false,
					},
					{ deliverAs: "followUp", triggerTurn: true },
				);
				return;
			}
		}
		// Lesson examples may only use what's been taught (plus the construct the
		// lesson is about): the code gate only sees tool arguments.
		if (!lessonCodeNudgedSinceUser && activeSubject && said.includes("```")) {
			const untaught = untaughtInLesson(ctx, said);
			if (untaught.length) {
				lessonCodeNudgedSinceUser = true;
				pi.sendMessage(
					{
						customType: "tutor-nudge",
						content:
							`The code in your last message uses things the learner hasn't been taught yet: ${untaught.map((c) => c.label).join("; ")}. ` +
							"Redo that example (say briefly that you're simplifying it) using only what they've been taught plus the one construct this lesson is about. If you were quoting the learner's own code, ignore this.",
						display: false,
					},
					{ deliverAs: "followUp", triggerTurn: true },
				);
				return;
			}
		}
		// A multiple-choice question typed into chat ("A) … B) … C) …") can't be
		// clicked or graded: have the model ask it again through the quiz tool.
		if (hasToolCall && (m.content ?? []).some((b: any) => b?.type === "toolCall" && QUIZ_TOOLS.has(b.name))) textQuizNudges = textProblemNudges = 0;
		// A practice problem typed into chat: the learner answers in the chat box,
		// nothing is graded, and the hints sit in plain sight. Re-pose it as a card.
		if (m.stopReason === "stop" && !hasToolCall && !looksLikeTextQuiz(textOf(m)) && looksLikeTextProblem(textOf(m)) && textProblemNudges < 2) {
			textProblemNudges++;
			pi.sendMessage(
				{
					customType: "tutor-nudge",
					content:
						"You just posed a problem for the learner to solve as plain chat text, so their answer won't be graded and your hint gives the method away. " +
						"Pose that same problem again right now with quiz_typed: `question` = only the problem statement (no method, identity or steps); the method, identities and first step go in the `hints` ladder, which stays hidden until they ask; " +
						"the full worked solution goes in `explanation` (shown only after they get it or ask for the answer); for an expression answer pass `math` (upToConstant: true for an integral) and the answer in acceptedAnswers[0]. " +
						"Don't write any text before the call and don't repeat the problem in chat — the card shows it.",
					display: false,
				},
				{ deliverAs: "followUp", triggerTurn: true },
			);
			return;
		}
		if (m.stopReason === "stop" && !hasToolCall && looksLikeTextQuiz(textOf(m)) && textQuizNudges < 2) {
			textQuizNudges++;
			pi.sendMessage(
				{
					customType: "tutor-nudge",
					content:
						"You just wrote a multiple-choice question as plain chat text, so the learner can't click an answer and it won't be graded or recorded. " +
						"Ask that same question again right now by calling the quiz tool (options as an array, explanation, correctAnswer, subject, concepts; all math in LaTeX $...$). " +
						"Don't write any text before the tool call and don't repeat the question in chat — the quiz card shows it. From now on every question with a right answer goes through quiz or quiz_typed.",
					display: false,
				},
				{ deliverAs: "followUp", triggerTurn: true },
			);
			return;
		}
		if (!hasToolCall && !cutNudgedSinceUser && (m.stopReason === "stop" || m.stopReason === "length") && endsMidMath(textOf(m))) {
			cutNudgedSinceUser = true;
			const tail = textOf(m).trimEnd().slice(-80);
			pi.sendMessage(
				{
					customType: "tutor-nudge",
					content: `Your last reply was cut off in the middle of a math expression; it ends with: «${tail}». Continue exactly where it stopped: start with the rest of that expression (closing its $), then finish the reply. Don't repeat anything you already wrote.`,
					display: false,
				},
				{ deliverAs: "followUp", triggerTurn: true },
			);
			return;
		}
		// "Now let's test it:" and then the turn ends: the model announced a
		// question or next step but stopped before making the call.
		if (!hasToolCall && !leadInNudgedSinceUser && m.stopReason === "stop" && endsOnLeadIn(textOf(m))) {
			leadInNudgedSinceUser = true;
			const tail = textOf(m).trimEnd().slice(-80);
			pi.sendMessage(
				{
					customType: "tutor-nudge",
					content: `Your last reply ended with «${tail}» and then stopped, so the learner is still waiting for what you announced. Do it now: if it's a question or problem with a right answer, call quiz or quiz_typed right away; otherwise write the rest of the reply. Don't repeat or re-introduce anything you already wrote.`,
					display: false,
				},
				{ deliverAs: "followUp", triggerTurn: true },
			);
			return;
		}
		if (m.stopReason !== "stop" || nudgedSinceUser || hasToolCall || textOf(m).trim().length > 0) return;
		nudgedSinceUser = true;
		pi.sendMessage(
			{
				customType: "tutor-nudge",
				content:
					"Your last reply had no visible text — the learner only saw your hidden reasoning and got no answer. Write your reply to the learner now as normal visible text: give the result (correct answer + a short explanation if they just answered something), then the next step.",
				display: false,
			},
			{ deliverAs: "followUp", triggerTurn: true },
		);
	});

	function showSubjectStatus(ctx: any) {
		safeUi(ctx, (ui) => ui.setStatus("tutorbot-home", activeSubject ? `${activeSubject} · /home to switch` : "/home to pick a subject"));
		const folders = activeSubject ? (get(ctx).registry.find(activeSubject)?.folders ?? []) : [];
		getBridge().setState("folders", folders.map((f) => ({ path: f, name: basename(f) })));
	}

	// Add a class folder to a subject (or the active one), index it, and let
	// the model know a course style profile can now be built from it.
	function addSubjectFolder(ctx: any, subject: string | undefined, path: string): string {
		const { store, registry } = get(ctx);
		const p = expandPath(path);
		if (!folderExists(p)) throw new Error(`Not a folder: ${p}`);
		if (subject) registry.addFolder(subject, p);
		else {
			const config = store.loadConfig();
			if (!config.resourceFolders.includes(p)) config.resourceFolders.push(p);
			store.saveConfig(config);
		}
		startIndexing(ctx, true);
		showSubjectStatus(ctx);
		return p;
	}

	async function chooseFolderFor(ctx: any, subject: string | undefined, signal?: AbortSignal): Promise<string | undefined> {
		const picked = await pickFolder(subject ? `Choose the folder with your ${subject} class materials` : "Choose a folder with class materials", signal);
		if (!picked) return undefined;
		return addSubjectFolder(ctx, subject, picked);
	}

	function recordLessonFeedback(ctx: any, concepts: string[], rating: LessonRating) {
		const { store } = get(ctx);
		const subject = activeSubject ?? "General";
		store.addLessonFeedback({ subject, concepts, rating });
		const label = RATING_LABEL[rating];
		const what = concepts.length ? concepts.join(", ") : "the last explanation";
		const adapt =
			rating === "fuzzy"
				? "Re-teach it now using a DIFFERENT approach than before (if you used socratic, try a worked example or a direct explanation; if direct, try an analogy or visual), then a quick check."
				: rating === "too-fast"
					? "Slow down from here: smaller steps, one idea per message, check understanding more often."
					: rating === "too-slow"
						? "Speed up: skip what they've shown they know, bigger steps, fewer confirmations."
						: "That approach worked for them; lean on it for similar concepts.";
		// "Still fuzzy" deserves an immediate response; the rest steer the next turn.
		pi.sendMessage(
			{ customType: "tutor-lesson-feedback", content: `Learner feedback on ${what}: "${label}". ${adapt}`, display: false },
			rating === "fuzzy" ? { deliverAs: "followUp", triggerTurn: true } : { deliverAs: "nextTurn" },
		);
	}

	// ── Conversations & subjects for the VS Code panel (bridge API) ──────────
	// Latest extension instance owns the API (pi re-creates instances on session switch).
	function registerSessionApi(ctx: any) {
		const bridge = getBridge();
		const { store, registry } = get(ctx);

		// The subject a session file is tagged with (its last tutor-subject entry).
		const subjectOf = (file: string): string | undefined => {
			let subject: string | undefined;
			try {
				for (const line of readFileSync(file, "utf8").split("\n")) {
					if (!line.includes(SUBJECT_ENTRY)) continue;
					try {
						const e = JSON.parse(line);
						if (e?.type === "custom" && e.customType === SUBJECT_ENTRY && e.data?.subject) subject = e.data.subject;
					} catch {
						// partial line
					}
				}
			} catch {
				// unreadable file
			}
			return subject ? registry.resolve(subject) : undefined;
		};
		const titleOf = (name: string | undefined, firstMessage: string) => {
			if (name && !AUTO_NAME.test(name)) return name;
			// A skill invocation expands to <skill …>…</skill> + the learner's text.
			const skill = firstMessage.match(/<skill name="([^"]+)"/)?.[1];
			const text = firstMessage.replace(/<skill[\s\S]*?<\/skill>/g, "").replace(/<[^>]+>/g, "").trim();
			const line = text.split("\n")[0] || (skill ? `/${skill}` : "");
			return line ? (line.length > 80 ? `${line.slice(0, 79)}…` : line) : "Untitled conversation";
		};

		bridge.onApi("sessions", async () => {
			const sm = ctx.sessionManager;
			const current = sm.getSessionFile();
			const infos = await SessionManager.list(ctx.cwd, sm.getSessionDir());
			const sessions = infos.map((i) => ({
				path: i.path,
				title: titleOf(i.name, i.firstMessage),
				named: Boolean(i.name && !AUTO_NAME.test(i.name)),
				subject: i.path === current ? activeSubject : subjectOf(i.path),
				modified: new Date(i.modified).toISOString(),
				messages: i.messageCount,
				current: i.path === current,
			}));
			// A brand-new session isn't written to disk until the first reply.
			if (current && !sessions.some((x) => x.current)) {
				const name = sm.getSessionName();
				sessions.unshift({ path: current, title: titleOf(name, ""), named: Boolean(name && !AUTO_NAME.test(name)), subject: activeSubject, modified: new Date().toISOString(), messages: 0, current: true });
			}
			sessions.sort((a, b) => b.modified.localeCompare(a.modified));
			return { sessions, subjects: registry.list().map((s) => ({ name: s.name, lastUsed: s.lastUsed ?? s.createdAt, group: s.group ?? null })), groups: registry.groups(), activeSubject: activeSubject ?? null };
		});

		bridge.onApi("renameSession", async (body) => {
			const name = String(body?.name ?? "").trim();
			const file = String(body?.path ?? "");
			if (!name) return { ok: false, error: "The name can't be empty." };
			if (file === ctx.sessionManager.getSessionFile()) pi.setSessionName(name);
			else {
				if (!existsSync(file)) return { ok: false, error: "That conversation no longer exists." };
				SessionManager.open(file, ctx.sessionManager.getSessionDir()).appendSessionInfo(name);
			}
			return { ok: true };
		});

		bridge.onApi("renameSubject", async (body) => renameSubjectEverywhere(ctx, String(body?.from ?? ""), String(body?.to ?? "")));

		// Remove a subject from the list (VS Code directory). Its conversations
		// stay; its progress is deleted only when asked.
		bridge.onApi("removeSubject", async (body) => {
			const name = String(body?.name ?? "").trim();
			const removed = name ? registry.remove(name) : undefined;
			if (!removed) return { ok: false, error: `No subject named "${name}".` };
			const concepts = body?.deleteProgress ? store.deleteSubject(removed.name) : 0;
			const g = globalThis as any;
			if (g.__tutorLastSubject && slug(g.__tutorLastSubject) === slug(removed.name)) g.__tutorLastSubject = undefined;
			if (activeSubject && slug(activeSubject) === slug(removed.name)) {
				activeSubject = undefined;
				getBridge().setState("subject", null);
				showSubjectStatus(ctx);
			}
			return { ok: true, name: removed.name, concepts };
		});
	}

	// Rename a subject: registry (old name kept as an alias), progress, topic
	// links, course map/style files, and the current session's subject.
	function renameSubjectEverywhere(ctx: any, fromRaw: string, toRaw: string): { ok: boolean; name?: string; error?: string } {
		const from = fromRaw.trim();
		const to = toRaw.replace(/\s+/g, " ").trim();
		if (!from || !to) return { ok: false, error: "The name can't be empty." };
		const { store, registry } = get(ctx);
		let renamed;
		try {
			renamed = registry.rename(from, to);
		} catch (e) {
			return { ok: false, error: (e as Error).message };
		}
		store.renameSubject(from, renamed.name);
		if (activeSubject && slug(activeSubject) === slug(from)) {
			activeSubject = renamed.name;
			pi.appendEntry(SUBJECT_ENTRY, { subject: renamed.name });
			getBridge().setState("subject", renamed.name);
			showSubjectStatus(ctx);
		}
		return { ok: true, name: renamed.name };
	}

	// A weekly summary, once a week, when there was study activity that week.
	function maybeWriteWeekly(ctx: any) {
		try {
			const { store } = get(ctx);
			const data = store.loadProgress();
			const last = data.meta?.lastWeekly ? Date.parse(data.meta.lastWeekly) : 0;
			const weekAgo = Date.now() - 7 * 86_400_000;
			if (last > weekAgo) return;
			const active = data.quizLog.some((r) => Date.parse(r.ts) >= weekAgo);
			if (!active) return;
			const path = store.writeWeekly(store.weeklySummary(data));
			data.meta = { ...(data.meta ?? {}), lastWeekly: new Date().toISOString() };
			store.saveProgress(data);
			weeklyPending = path;
		} catch {
			// never block a session on the summary
		}
	}

	function registerLearningApi(ctx: any) {
		const bridge = getBridge();
		bridge.onApi("setFolder", async (body) => {
			const subject = (typeof body?.subject === "string" && body.subject) || activeSubject;
			try {
				if (body?.action === "remove" && body?.path) {
					get(ctx).registry.removeFolder(String(body.path));
					showSubjectStatus(ctx);
					return { ok: true };
				}
				const path = body?.path ? addSubjectFolder(ctx, subject, String(body.path)) : await chooseFolderFor(ctx, subject);
				return path ? { ok: true, path, subject: subject ?? null } : { ok: false, cancelled: true };
			} catch (e) {
				return { ok: false, error: (e as Error).message };
			}
		});
		bridge.onApi("lessonFeedback", async (body) => {
			const rating = String(body?.rating ?? "") as LessonRating;
			if (!RATING_LABEL[rating]) return { ok: false, error: "unknown rating" };
			const concepts = Array.isArray(body?.concepts) ? body.concepts.map(String).slice(0, 10) : [];
			recordLessonFeedback(ctx, concepts, rating);
			return { ok: true };
		});
	}

	pi.on("agent_end", async (_event, ctx) => {
		if (activeSubject) get(ctx).registry.update(activeSubject, { lastUsed: new Date().toISOString(), lastSession: ctx.sessionManager.getSessionFile() });
	});

	// ── System prompt: profile + progress + resources + rules ────────────────
	pi.on("before_agent_start", async (event, ctx) => {
		const { store, index, registry } = get(ctx);
		const data = store.loadProgress();
		let profile = store.readProfile().trim();
		if (profile.length > MAX_PROFILE_CHARS) profile = `${profile.slice(0, MAX_PROFILE_CHARS)}\n…(truncated — consolidate the profile with update_learner_profile action "replace")`;
		const folders = searchFolders(ctx);
		const st = index.stats();
		const subjFolders = activeSubject ? (registry.find(activeSubject)?.folders ?? []) : [];

		// Class materials + the course's question style.
		let resources: string;
		if (folders.length) {
			resources = `Folders: ${folders.join(" · ")}\nIndexed files: ${st.files}${isIndexing() ? " (indexing in progress)" : ""}.\nBefore teaching a topic, call search_resources and follow how the class presents it (its notation, terminology, examples, order). Cite the source briefly ("Lecture 4 slides, p. 12"). If the class materials and your own knowledge disagree, point it out instead of silently picking one.`;
			const style = activeSubject ? store.readCourseStyle(activeSubject) : undefined;
			if (style) {
				resources += `\n\n### How this course asks questions (course style profile — write practice, review and checkpoint questions to match it)\n${style.length > 3500 ? `${style.slice(0, 3500)}\n…` : style}\nBefore writing a practice or checkpoint question on a topic, call teacher_examples for that topic and model yours on the teacher's real questions (same format, notation, phrasing and difficulty).`;
			} else if (activeSubject && subjFolders.length && st.files > 0) {
				resources += `\n\nNo course style profile for ${activeSubject} yet. Build one soon (call course_style_sources, then save_course_style) so practice questions mimic how this teacher writes quizzes and exams.`;
			}
		} else {
			resources = activeSubject
				? `None for ${activeSubject}. Tell the learner once that they can pick their class folder (the folder button in the panel, or /folder) so practice questions match their teacher's style.`
				: "None configured.";
		}

		let topicBlock = "";
		let nextTopic = "";
		if (activeSubject) {
			const map = store.readTopicMap(activeSubject);
			if (map?.topics.length) {
				const links = store.loadLinks();
				const onMap = new Set(map.topics.map((t) => t.id));
				const subjConcepts = store.conceptsForSubject(data, activeSubject);
				const untagged = subjConcepts.filter((c) => !store.effectiveTopic(c, links, onMap).topic);
				// The course's order is the teaching order: the first topic nothing covers yet.
				const covered = new Set(subjConcepts.flatMap((c) => [store.effectiveTopic(c, links, onMap).topic, slug(c.name)]));
				const next = map.topics.find((t) => !covered.has(t.id));
				if (next) nextTopic = `${next.id}: ${next.title}${next.unit ? ` (${next.unit})` : ""}`;
				topicBlock =
					`\n\n### Course topic map, in the order the course teaches it (pass the id as \`topic\` for each concept in mark_taught)\n` +
					map.topics
						.slice(0, 80)
						.map((t) => `- ${t.id}: ${t.title}${t.unit ? ` (${t.unit})` : ""}${covered.has(t.id) ? " ✓ taught" : ""}`)
						.join("\n") +
					(nextTopic ? `\nNext topic in course order: ${nextTopic}. Teach topics in this order unless the learner asks for something else.` : "") +
					(untagged.length ? `\nConcepts not linked to a topic yet (link them with tag_concepts when convenient): ${untagged.slice(0, 15).map((c) => c.name).join(", ")}` : "");
			} else if (subjFolders.length) {
				topicBlock = `\n\nNo course topic map for ${activeSubject} yet. Build one soon (course_map_sources, then save_course_map) so the progress dashboard can show which parts of the course are covered.`;
			}
		}
		// Missed questions whose delayed re-test is due (see RETEST_GAP).
		const due = pendingRetests(sessionQuestions(ctx.sessionManager.getBranch() as any[])).filter((p) => p.since >= RETEST_GAP);
		const retest = due.length
			? `\n\n## Re-test due (missed earlier this session)\nThese were missed and enough other questions have come since. Ask one again now as your next graded question, the original question as it was asked (not a variant), unless the learner is mid-way through something else. Tell them it's the question they missed earlier.\n${due
					.slice(0, 3)
					.map((p) => `- ${p.miss.question}`)
					.join("\n")}`
			: "";
		const subjectBlock = activeSubject
			? `## Current subject: ${activeSubject}
This session is for ${activeSubject}. Pass subject "${activeSubject}" to quiz, quiz_typed, mark_taught and assign_exercise. Concepts recorded so far: ${store.conceptIndex(data, activeSubject)}.

### The learner's toolbox — the ONLY things they know in ${activeSubject}
Assume the learner knows nothing about ${activeSubject} beyond the concepts recorded above. Not "the basics", not what most students would know by now: only what's recorded. Every worked example, quiz, practice problem and exercise must be solvable with those alone. Don't use any keyword, operator, method or idea outside the toolbox (in code: no loops, if, &&/||, ++, helper methods, arrays, String methods etc. until each one is taught). If a problem would need something new, pick a different problem, or teach the new thing first (introduce → explain → two worked examples → mark_taught). The tutor scans exercise and quiz code and refuses anything that uses untaught constructs. A concept leaves "unknown" only with evidence: you taught it, or the learner proved it (two confident, unaided, correct diagnostic answers on that one concept, at least one typed). A lesson's examples may use the construct the lesson is about, nothing else new.${topicBlock}`
			: "## Current subject: none\nNo subject selected (the learner can pick one with /home). Ask which subject they're studying before any lesson, quiz or exercise; the first quiz, mark_taught or exercise files everything under the subject you pass.";

		// Escape hatch: repeated misses on one concept, or frustration in the
		// learner's own words → stop withholding and teach directly. Scoped to
		// this subject, and over once they get a check right.
		const prompt = String(event.prompt ?? "");
		const stuck = store.stuckState(data, activeSubject);
		const distress = distressKind(prompt);
		if (distress) store.addSignal({ subject: activeSubject, kind: "frustration", detail: prompt.slice(0, 200) });
		const recentDirect = directSignals(data, activeSubject).length > 0;
		// An open exercise is graded work: its solution is only ever shown by the card's Give up button.
		const exercise = openExercise(ctx.sessionManager.getBranch() as any[]);
		const homework = Boolean(distress) && GRADED_WORK.test(prompt);
		let escape = "";
		if (stuck || distress || recentDirect) {
			const why = distress
				? distress === "show"
					? "the learner asks to just be shown"
					: "the learner's message shows confusion or frustration"
				: stuck
					? `${stuck.misses} misses in a row on "${stuck.concept}"${stuck.hintsUsed ? ` even with ${stuck.hintsUsed} hint(s)` : ""}`
					: "the learner asked to be shown";
			if (stuck && !distress) store.addSignal({ subject: activeSubject, kind: "escape-hatch", detail: why });
			const show = !exercise && !homework && (distress === "show" || (!distress && recentDirect && !stuck));
			const parallel =
				"Stop testing this idea and teach it directly, but don't solve their problem for them: walk through one fully worked example of a PARALLEL problem (same method, different numbers, function or program), then hand their own problem back for another try.";
			escape = `\n\n## ESCAPE HATCH ACTIVE — ${why}
${
	show
		? "They asked to be shown, so show them: explain the idea plainly and walk through the solution of the practice question they're on (no more Socratic questions on this point), then give ONE easier check."
		: exercise
			? `${parallel} They have an open exercise ("${exercise.title ?? "the current exercise"}"): never write its solution or code that solves it, even if they ask. If they want to see the reference solution, the exercise card's Give up button shows it.`
			: homework
				? `${parallel} This is their own graded coursework: never solve it or give its answer; teach the method on a different problem.`
				: `${parallel} Offer to show their problem's full solution if they want it; show it only if they say yes.`
} Acknowledge the difficulty briefly and warmly; don't lecture about effort. Return to the normal flow once they get a check right. (Strict withholding after genuine effort lowers learning; doing the work for them does too.)`;
		}
		// The exercises extension marks submits made under the escape hatch as assisted.
		const g = globalThis as any;
		g.__tutorEscape = escape ? { subject: activeSubject, since: g.__tutorEscape?.since ?? new Date().toISOString() } : undefined;

		// Exams and due dates the learner has told us about.
		const upcoming = store.upcomingAssessments(data, 21, activeSubject);
		const past = store.pastUnreported(data);
		let assessments = "";
		if (upcoming.length || past.length) {
			const lines = upcoming.map((a) => {
				const mode = a.daysLeft <= 3 ? "EXAM MODE: prioritise a no-help /checkpoint and a timed practice set in the course's style on its topics; no new material unless asked." : a.daysLeft <= 10 ? "Suggest a checkpoint and interleaved review of its topics this week." : "";
				return `- ${a.subject}: ${a.name}${a.kind ? ` (${a.kind})` : ""} on ${a.date} — ${a.daysLeft} day${a.daysLeft === 1 ? "" : "s"} away${a.topics ? `; topics: ${a.topics}` : ""}. ${mode}`;
			});
			for (const a of past) lines.push(`- ${a.subject}: ${a.name} was on ${a.date} — ask how it went, then call assessment_result and note anything useful in the learner profile.`);
			assessments = `\n\n## Assessments\n${lines.join("\n")}`;
		}

		const weekly = weeklyPending
			? `\n\n## Weekly summary\nA weekly summary was just written to ${weeklyPending}. Open your first reply with a 2–3 line recap (study days, accuracy, what needs work, what's coming up) and one sentence reminding them to also do the real course work (assigned homework, past exams).`
			: "";
		weeklyPending = undefined;

		const block = `

# Tutor system (persistent across sessions)

${subjectBlock}${retest}${escape}

## Learner profile — follow it; it overrides general teaching defaults
${profile}

## How this learner learns (measured from their answers and lesson ratings)
${store.learnerModelText(data, activeSubject)}

## Progress so far
${store.summary(data)}${assessments}${weekly}

## Class resources
${resources}

## Tutor rules
- Teach first, then quiz. Every new concept goes: introduce it → explain it in short chunks → two fully worked examples (headed **Example 1:** / **Example 2:**) → mark_taught → guided practice (quiz_typed with hints) → unaided check questions. Never quiz a learner on something they haven't been taught in this way; mark_taught is refused until the chat shows the explanation and the worked examples. After you teach a concept, call mark_taught with the subject, the concept name(s), the \`approach\` you used (socratic, worked-example, direct, analogy, visual, code-first, practice-first) and a \`family\` for concepts that are easily confused with each other (e.g. "integration techniques", "convergence tests", "loop patterns"). quiz/quiz_typed with purpose "check", "review" or "checkpoint" are BLOCKED for concepts that weren't marked taught. Use purpose "diagnostic" to probe prior knowledge before teaching, and "discovery" for Socratic questions where they work out the concept you are about to establish.
- Personalise from evidence: follow the measured approach ranking above, but try a different approach about one time in four so the comparison stays honest. After explaining a concept, the learner can rate it (Clicked / Still fuzzy / Too fast / Too slow); adapt immediately to those ratings.
- Explain-it-back: ask before you explain. Before explaining a result, a code output, a mistake or a step they just saw, have them explain it first (explain_back; quiz and quiz_typed do this automatically after a miss or a guess). Evaluate their explanation, fix the exact gap, call rate_explanation. Don't add explain-back to worked examples you are demonstrating.
- Hint ladder, not answers: during practice give hints in steps (pass \`hints\` to quiz/quiz_typed: guiding question → technique → first step). Don't hand over a full solution while they are still attempting. After two genuine failed attempts or an exhausted ladder, teach with a worked PARALLEL example and hand their problem back (the escape hatch); for a practice question, show its solution only when they ask.
- The learner does the work. Never solve the learner's problem for them unless they ask about a practice question ("Show answer", "Just show me", or in words). Exercises (assign_exercise) and their own coursework are graded work: never write their solution or code that solves them, even if asked, even after "just show me" — give a worked PARALLEL example (a different problem, same idea) instead. The exercise card's Give up button is how they see the reference solution. Pose practice problems with quiz_typed (question = only the problem; method and identities in the hidden hints). When they answer partly right in chat, say exactly which part is right and ask for the next step; give at most one hint, not the rest of the solution. Don't put the method in the problem statement.
- No-help checkpoints: every few lessons, and before any exam, run a checkpoint (/checkpoint, or quiz with purpose "checkpoint": no hints, no teaching between questions; explain afterwards). Only checkpoints prove mastery.
- Interleave practice: when reviewing or practising concepts from the same family, mix them so the learner must first identify WHICH technique applies, then solve (/practice builds such sets). Never interleave definitions or reading — only problem types.
- Confidence: confident misses are misconceptions — confront them with a contrasting example; feedback fixes them best, but they return within days without practice, so re-test them later in the session and at the next review. Correct guesses are not yet learned.
- After a miss: (1) brief elaborated feedback — the specific misconception, why the right method works, one contrasting case; (2) one specific "why" prompt so they state the difference; (3) a VARIANT question with the same deep structure and a new surface (different constants, form or direction), never the identical question — the learner would only recall the answer you just showed; (4) re-test the original after at least two other questions ("Re-test due" below lists them). Two misses in a row on one idea: stop testing, work a PARALLEL example (not their problem), then let them retry theirs.
- Successive relearning: a concept is solid after about three correct, spaced recalls across sessions, not one success today. Fade worked examples into problems as the learner succeeds.
- Keep concept names stable and reuse them exactly (tutor_progress lists them). One concept = one idea the learner can be quizzed on.
- Every question with a right answer goes through quiz or quiz_typed — never ask_user_question and never as plain chat text — so the learner is graded and sees the correct answer and explanation. Never reveal the answer in the question's details.
- Every computable question (code output, arithmetic, calculus) gets a verify block so the key is checked by actually running it. When the learner questions a graded result, don't just agree: the quiz result shows the verified answer (what the program really prints); re-derive from it step by step, say plainly which of your statements was wrong if one was, and never invent a justification (e.g. calling 151 / 5 integer division when the result is 30.2).
- Always end your turn with a visible message to the learner. Your reasoning is not shown as an answer; say the result, the correct answer, and the explanation in plain text.
- Coding subjects: once a programming concept is taught and quiz-checked, have them write real code with assign_exercise (small, one new idea at a time). Assign an exercise only after the concept has at least one correct check (guided practice, then a check). Then let them work; mentor through /submit and /hint, never hand over the solution. Only assign_exercise creates and opens the learner's file: never write an exercise or a code skeleton for it as chat text (the learner writes the whole program from scratch, imports, class and main included), and never say a file is created or open unless assign_exercise just succeeded. If it was refused, fix the problem and call it again.
- Math: write ALL math in LaTeX ($...$ inline, $$...$$ display) — in chat and in every quiz field (question, options, hints, explanation). Never plain text like e^tan(x) * sec^2(x); write $e^{\\tan x}\\sec^2 x$. Plain-text math in a quiz is rejected.
- If the learner left a note on a quiz answer, answer it directly (refer to what they wrote) before the next question (the next quiz is blocked until you do).
- When the learner skips a quiz or exercise card, don't assign another exercise or start another quiz on your own: ask what they'd like to do (ask_user_question) or reply in text. The next card is blocked until they ask for one.
- Never tell the learner they've "mastered" something. Mastery comes from no-help checkpoints and spaced reviews, shown on the progress dashboard; after a correct answer say what they got right and what comes next.
- Diagnostics: tag each diagnostic question with exactly ONE concept, the one it tests. A single right answer proves nothing; "known" takes two confident, unaided, correct diagnostics on that concept (at least one quiz_typed). At most ${MAX_PROBES} probes per concept per session, then teach.
- Course order: when a course topic map exists, pass \`topic\` (a map id) for every concept in mark_taught, and teach the next topic in course order; mark_taught for a later topic is refused unless the learner asked for it.
- TutorBot can't run shell commands or read, write or edit files. To look at a learner's program, use assign_exercise with existingFile.
- When items are due for review, offer a short review (/review) at the start of a session, before new material.
- When the learner mentions an upcoming exam, quiz, or deadline, record it with set_assessment.
- TutorBot supplements the course; it doesn't replace it. Every few sessions, remind them to do the real coursework too (assigned homework, past exams, office hours). Never do their current graded homework for them; use past and practice material as style models.
- Learn how they learn: when the learner shows frustration, confusion, a request about HOW you teach, or something clearly lands or fails, call update_learner_profile with one concrete, evidence-backed observation. Don't record trivia or duplicate what is already there.`;
		return { systemPrompt: event.systemPrompt + block };
	});

	// ── Gates ────────────────────────────────────────────────────────────────
	let guided = { start: -1, n: 0 }; // guided-practice bounces in the current lesson window
	pi.on("tool_call", async (event, ctx) => {
		const input = event.input as any;
		const tool = event.toolName;

		// TutorBot never runs commands or touches files, whatever tools the
		// launcher left enabled. The learner's files are theirs.
		if (BLOCKED_BUILTINS.has(tool)) {
			return {
				block: true,
				reason:
					"TutorBot can't run commands or touch files; that isn't part of tutoring here. Teach in chat, check computable answers with a quiz `verify` block, and give coding practice with assign_exercise " +
					"(pass existingFile to turn a program the learner wrote into an exercise). Don't tell the learner you ran or opened anything.",
			};
		}

		// Math must be LaTeX so it renders typeset, not as "e^tan(x) * sec^2(x)".
		// Not for programming subjects: there `i <= 4` is code, and bouncing it
		// made the model rewrite Java into `i \le 4`.
		if (MATH_TOOLS.has(tool) && !subjectLanguage(String(activeSubject ?? input.subject ?? ""))) {
			repairInputMath(input);
			const plain = [...new Set(displayedFields(input).flatMap(findPlainMath))].slice(0, 6);
			if (plain.length && bounces.take("math", questionKey(String(input.question ?? input.prompt ?? "")), MAX_MATH_BOUNCES)) {
				return {
					block: true,
					reason:
						`Math must be written in LaTeX so it renders typeset. Found plain-text math: ${plain.map((p) => `"${p}"`).join(", ")}. ` +
						"Call again with every math expression in the question, details, option labels/descriptions, hints and explanation wrapped in $...$ " +
						"(e.g. $e^{\\tan x}\\sec^2 x$, $\\frac{d}{dx}$, $\\int_0^1 x\\,dx$, $\\lim_{x\\to 0}$, $\\sqrt{2}$). Use LaTeX commands (\\tan, \\sec, \\ln), braces for multi-character exponents, and no * for multiplication. " +
						"Keep the explanation's `Answer:` line identical to the option label. Code stays in backticks.",
				};
			}
		}

		// Progress is always filed under a subject: the selected one (models drift:
		// "Calculis II" vs "Calc II" would split the record), else the one passed
		// or last studied. Without one the toolbox in the prompt is empty.
		if (SUBJECT_TOOLS.has(tool)) {
			if (!activeSubject && !adoptSubject(ctx, String(input.subject ?? ""))) {
				return { block: true, reason: "No subject is selected. Ask the learner which subject they're studying (or to pick one with /home), then pass it as `subject`." };
			}
			input.subject = activeSubject;
		}

		if (tool === "ask_user_question" && looksLikeKnowledgeCheck(String(input.question ?? ""), input.details)) {
			return {
				block: true,
				reason:
					"This question has a right answer, so it must be graded: ask it with quiz_typed (free response — best for 'what is ∫…', definitions, short computations, code output) or quiz (multiple choice), " +
					"with a worked explanation and a verify check where it's computable. The learner then sees ✓/✗, the correct answer and the explanation immediately. " +
					"Do not put the answer or a hint that gives it away in `details`. ask_user_question is only for preferences and decisions.",
			};
		}

		// The answer key must not be on the card before they answer.
		if (QUIZ_TOOLS.has(tool)) {
			const leak = quizKeyLeak(tool, input);
			if (leak && bounces.take("key", questionKey(String(input.question ?? "")), 2)) {
				return {
					block: true,
					reason:
						`The learner would see the answer before answering: ${leak}. Hints guide toward the method (what to notice, which rule, the first step), never the answer; details and the question give context, never the key or an "example answer" that is the answer. ` +
						"Rewrite those fields and call again; the full answer belongs only in `explanation`.",
				};
			}
		}
		if (tool === "assign_exercise") {
			const lines = hintsWithSolutionLines(input.hints, input.referenceSolution);
			if (lines.length) {
				return {
					block: true,
					reason:
						`The hints contain line(s) of the reference solution (${lines.slice(0, 3).map((l) => `\`${l}\``).join(", ")}), which hands over the graded answer. ` +
						"Rewrite the hints as a ladder that guides without code that solves it: a guiding question → the technique → a first concrete step in words. Nothing was assigned; call assign_exercise again.",
				};
			}
		}

		// A just-missed question can't be re-asked right away: ask a variant.
		if (QUIZ_TOOLS.has(tool) && typeof input.question === "string") {
			const key = questionKey(input.question);
			const early = pendingRetests(sessionQuestions(ctx.sessionManager.getBranch() as any[])).find((p) => p.since < RETEST_GAP && sameQuestion(p.miss.key, key));
			if (early && bounces.take("repeat", key, MAX_REPEAT_BOUNCES)) {
				return {
					block: true,
					reason:
						"The learner just missed this exact question. Re-asking it now only tests whether they remember the answer you just showed, which isn't learning. " +
						"Ask a VARIANT instead: the same idea with a new surface (different constants, a different form, or the reverse direction; e.g. after missing $\\int \\frac{1}{\\sqrt{1-x^2}}\\,dx$, ask $\\int \\frac{3}{\\sqrt{1-x^2}}\\,dx$ or $\\frac{d}{dx}\\arcsin(2x)$). " +
						`The original question comes back as a delayed re-test after ${RETEST_GAP} other questions.`,
				};
			}
		}

		// Teach-first, part 1: "taught" has to mean the learner saw a lesson, in course order.
		if (tool === "mark_taught") {
			const { store } = get(ctx);
			const data = store.loadProgress();
			const subject = String(input.subject ?? "").trim();
			const items: any[] = Array.isArray(input.concepts) ? input.concepts : [];
			const nameOf = (c: any) => String(c?.name ?? c ?? "").trim();
			const names: string[] = items.map(nameOf).filter(Boolean);
			// Exact names (or plural/"-basics" variants) only: "nested loops" is not "loops".
			const fresh = names.filter((n) => !store.findConceptStrict(data, subject, n));
			if (fresh.length > MAX_NEW_CONCEPTS_PER_LESSON) {
				return {
					block: true,
					reason:
						`mark_taught records what the learner was just taught, not a syllabus. ${fresh.length} new concepts at once (${fresh.join(", ")}) can't all have been taught. ` +
						`Teach ONE concept now (introduce → explain → ${MIN_WORKED_EXAMPLES} worked examples), then mark just that one. (Concepts the learner proved with diagnostics are already recorded and don't count.)`,
				};
			}
			const branchNow = ctx.sessionManager.getBranch() as any[];
			const userText = lastUserText(branchNow);
			const order = courseOrder(store, data, subject);
			if (order && fresh.length) {
				const topicOf = (t: unknown) => (t ? order.topics.find((x) => x.id === slug(String(t)) || slug(x.title) === slug(String(t))) : undefined);
				const lacking: string[] = [];
				for (const it of items) {
					if (!fresh.includes(nameOf(it)) || typeof it !== "object") continue;
					const t = topicOf(it.topic);
					if (t) it.topic = t.id;
					else lacking.push(nameOf(it));
				}
				if (lacking.length) {
					return {
						block: true,
						reason:
							`This course has a topic map, so every new concept needs \`topic\`: the id of the course topic it belongs to. Missing or not on the map for: ${lacking.join(", ")}. ` +
							`Topic ids in course order: ${order.topics.slice(0, 60).map((t) => `${t.id} (${t.title})${order.covered.has(t.id) ? " ✓" : ""}`).join("; ")}.`,
					};
				}
				if (order.next) {
					const nextIdx = order.index(order.next.id);
					const ahead = items.filter((it) => fresh.includes(nameOf(it)) && order.index(it.topic) > nextIdx).map((it) => ({ name: nameOf(it), topic: topicOf(it.topic)! }));
					const unasked = ahead.filter((a) => !askedForTopic(userText, a.topic));
					if (unasked.length) {
						return {
							block: true,
							reason:
								`Course order: the next topic in this course is "${order.next.id}: ${order.next.title}", but ${unasked.map((a) => `"${a.name}" is in the later topic "${a.topic.id}: ${a.topic.title}"`).join("; ")}. ` +
								"The learner follows the professor's order, so teach the next topic first (or record this concept under the topic it really belongs to). Jump ahead only when the learner asks for that topic.",
						};
					}
				}
			}
			if (fresh.length) {
				const gap = unmasteredPrevious(data, subject);
				if (gap && !MOVE_ON_REQUEST.test(userText)) {
					return {
						block: true,
						reason:
							`Not yet: the learner hasn't mastered "${gap.name}" (${gap.streak} of ${MASTERY_STREAK} unaided correct checks in a row; ${gap.checks} check${gap.checks === 1 ? "" : "s"} so far). ` +
							`Before starting a new concept, keep practising "${gap.name}" with NEW problems (purpose "check", tagged "${gap.name}"; unaided means no hints, not a guess, right first try). ` +
							"If they keep missing, re-teach it a different way with another worked example instead of moving on. Only move on early if the learner asks to (e.g. \"let's move on\").",
					};
				}
				const lesson = lessonSinceLastMark(branchNow);
				const missing = lessonGaps(lessonEvidence(lesson.text, fresh));
				if (missing.length) {
					return {
						block: true,
						reason:
							`Not recorded: the learner hasn't been taught ${fresh.join(", ")} yet in this conversation. Before mark_taught, the chat since the last mark_taught must contain ${missing.join(" and ")}. ` +
							"Teach it now in a normal message: (1) introduce it and connect it to what they know, (2) explain it in short chunks, (3) work the examples step by step, the second one different from the first. Then call mark_taught and check with a NEW problem. " +
							"If the learner says they already know it, prove it: two diagnostic questions on just this concept (one quiz_typed), answered confidently and correctly without hints, record it as known.",
					};
				}
			}
		}

		// Probe questions: one concept each, and a few at most, then teach.
		if (QUIZ_TOOLS.has(tool) && PROBE_PURPOSES.has(input.purpose)) {
			const concepts: string[] = Array.isArray(input.concepts) ? input.concepts.map(String) : [];
			if (input.purpose === "diagnostic" && concepts.length > 1) {
				return {
					block: true,
					reason: `A diagnostic question tests ONE concept, so tag it with exactly one (the one a right answer would show they know), not ${concepts.length}. Call again with concepts: ["<that concept>"].`,
				};
			}
			const branch = ctx.sessionManager.getBranch() as any[];
			const lesson = lessonSinceLastMark(branch);
			const sinceUser = probesSinceUser(branch);
			const overdone = concepts.find((c) => probesOn(branch, c) >= MAX_PROBES);
			if (lesson.probes >= MAX_PROBES || sinceUser >= MAX_PROBES || overdone) {
				return {
					block: true,
					reason:
						`${overdone ? `"${overdone}" has already been probed ${MAX_PROBES} times this session` : `The learner has answered ${Math.max(lesson.probes, sinceUser)} diagnostic/discovery questions without a lesson since`}. That's enough probing: you know where they stand. ` +
						"Teach now — introduce the next concept, explain it, work 2 labelled examples — then mark_taught and check. Don't quiz on material they haven't been taught.",
				};
			}
		}

		// Elaborated feedback: the explanation shown after an answer must say why.
		if (
			QUIZ_TOOLS.has(tool) &&
			input.purpose !== "diagnostic" &&
			typeof input.explanation === "string" &&
			explanationReasoning(input.explanation) < MIN_EXPLANATION_REASONING &&
			bounces.take("feedback", questionKey(String(input.question ?? "")), 2)
		) {
			return {
				block: true,
				reason:
					"The explanation is what the learner reads after answering, and feedback that explains WHY works about twice as well as just giving the answer. " +
					"Rewrite `explanation` as a short worked solution: the key idea, the steps (in LaTeX), and why the most tempting wrong option is wrong. End with the `Answer:` line. Then call again.",
			};
		}

		// Guided practice first: the first graded question after a lesson (any
		// purpose: check, review or checkpoint) is a "check" with a hint ladder,
		// so the learner can succeed with support before being tested unaided.
		if (QUIZ_TOOLS.has(tool) && !PROBE_PURPOSES.has(input.purpose)) {
			const lesson = lessonSinceLastMark(ctx.sessionManager.getBranch() as any[]);
			const purpose = input.purpose ?? "check";
			const hinted = Array.isArray(input.hints) && input.hints.some((h: any) => String(h ?? "").trim());
			if (lesson.marked && lesson.checks === 0 && (purpose !== "check" || !hinted)) {
				if (guided.start !== lesson.start) guided = { start: lesson.start, n: 0 };
				if (guided.n < MAX_GUIDED_BOUNCES) {
					guided.n++;
					return {
						block: true,
						reason:
							"This is the learner's first question right after the lesson, so make it guided practice: purpose \"check\" (a review or checkpoint comes later), the same kind of problem as the worked examples (new numbers), " +
							"with a `hints` ladder of 2–3 steps (1: what to notice / which rule, 2: the setup or first step, 3: the next step). Prefer quiz_typed. Then call again.",
					};
				}
			}
		}

		if (!GATED_TOOLS.has(tool)) return;
		const branch = ctx.sessionManager.getBranch() as any[];

		// 1) They just skipped a card: don't push another one at them unasked.
		const skipped = skippedSinceUser(branch);
		if (skipped) {
			return {
				block: true,
				reason:
					`The learner just skipped that ${skipped === "assign_exercise" ? "exercise" : "question"}. Don't hand them another ${tool === "assign_exercise" ? "exercise" : "question"} they didn't ask for. ` +
					"Reply briefly and ask what they'd like to do next (ask_user_question with a few options, e.g. an easier one, more explanation, something else, or a break). Assign or quiz again only when they ask.",
			};
		}

		// 2) Has the agent replied to the note left on the previous quiz?
		let replies = "";
		for (let i = branch.length - 1; i >= 0; i--) {
			const m = branch[i]?.message;
			if (!m) continue;
			if (m.role === "user") break;
			if (m.role === "assistant") replies = `${textOf(m)}\n${replies}`;
			// Skip blocked/unavailable quiz results: only an answered question can carry a note.
			if (m.role === "toolResult" && QUIZ_TOOLS.has(m.toolName) && m.details?.status === "answered") {
				const note = m.details?.note;
				if (note && !noteAddressed(String(note), replies)) {
					return {
						block: true,
						reason: `The learner left a note on the previous question that you haven't answered: "${note}". Reply to it directly in a normal message first (refer to what they wrote: explain, answer their question, or adjust), then continue.`,
					};
				}
				break;
			}
		}

		// 3) Teach-first: every concept in a check/review question (or exercise) must be taught.
		const purpose: QuizPurpose = tool === "assign_exercise" ? "check" : (input.purpose ?? "check");
		if (PROBE_PURPOSES.has(purpose)) return;
		const subject = String(input.subject ?? "").trim();
		const concepts: string[] = Array.isArray(input.concepts) ? input.concepts.map(String) : [];
		if (!subject || !concepts.length) {
			return { block: true, reason: "Pass subject and concepts so the tutor can track progress and check the concepts were taught." };
		}
		const { store } = get(ctx);
		const data = store.loadProgress();
		const missing = concepts.filter((c) => !store.findConceptStrict(data, subject, c));
		if (missing.length) {
			return {
				block: true,
				reason:
					`Not taught yet in "${subject}": ${missing.join(", ")}. The learner asked to be taught before being quizzed. ` +
					`Teach it first (introduce → explain → two worked examples), call mark_taught, then guided practice, then quiz. If you DID teach it under another name, reuse that exact name; a different name ("nested loops" vs "loops") is a different concept that needs its own lesson. ` +
					`Concepts recorded for ${subject}: ${store.conceptIndex(data, subject)}. ` +
					`(To probe prior knowledge before teaching, use purpose "diagnostic" with one concept.)`,
			};
		}

		// 4) An exercise comes after the learner got a check on it right.
		if (tool === "assign_exercise" && !input.existingFile) {
			const unchecked = concepts.filter((c) => !hasCorrectCheck(data, subject, c));
			if (unchecked.length) {
				return {
					block: true,
					reason:
						`Not yet: ${unchecked.join(", ")} has no correct check question yet. Before writing code on their own the learner needs guided practice (quiz_typed with hints) and at least one correct check on it. ` +
						"Nothing was assigned and no file was created; don't tell the learner a file is ready.",
				};
			}
		}

		// 5) Teach-first, in the code: the tags can say "string-basics" while the
		// solution needs a for loop and ||. Check what the code itself relies on.
		const untaught = untaughtInCode(tool, input, subject, store, data);
		if (untaught.length) {
			const map = store.readTopicMap(subject)?.topics ?? [];
			const list = untaught.map((c) => {
				const t = topicFor(c, map);
				return `${c.label}${t ? ` (course topic "${t.id}": ${t.title})` : ""}`;
			});
			const what = tool === "assign_exercise" ? "This exercise's reference solution" : "The code in this question";
			return {
				block: true,
				reason:
					`${what} uses things the learner hasn't been taught yet: ${list.join("; ")}. The learner only knows what's been taught, so they'd be stuck or guessing. ` +
					`Either (a) redesign it so it can be solved with only what they've been taught (${store.conceptIndex(data, subject)}), or (b) if they're ready for the next topic in course order, teach it first: introduce → explain → two worked examples → mark_taught (with its course topic), then guided practice. ` +
					`If the learner says they already know it, prove it with diagnostics first (two on that one concept, one typed). ` +
					(tool === "assign_exercise" ? "Nothing was assigned and no file was created or opened: call assign_exercise again with the redesigned exercise, and never tell the learner a file is ready unless assign_exercise succeeded." : ""),
			};
		}
	});

	// Adopt a subject when none is selected: the one the model passed, else the
	// last one studied. Tags the session so the toolbox shows from now on.
	function adoptSubject(ctx: any, wanted: string): string | undefined {
		const { registry } = get(ctx);
		const g = globalThis as any;
		const w = wanted.trim();
		let name: string | undefined;
		if (w) name = registry.has(w) ? registry.resolve(w) : registry.ensure(w).name;
		else if (g.__tutorLastSubject && registry.has(g.__tutorLastSubject)) name = registry.resolve(g.__tutorLastSubject);
		else name = registry.list()[0]?.name;
		if (!name) return undefined;
		activeSubject = name;
		g.__tutorLastSubject = name;
		pi.appendEntry(SUBJECT_ENTRY, { subject: name });
		getBridge().setState("subject", name);
		showSubjectStatus(ctx);
		return name;
	}

	// Code snippets in markdown worth scanning (constructs.scanText when available).
	function codeSnippets(text: string, fallback: CodeLanguage | undefined): { code: string; language: CodeLanguage }[] {
		const scan = (Constructs as any).scanText;
		if (typeof scan === "function") {
			try {
				return scan(text, fallback) ?? [];
			} catch {
				// fall back to fenced blocks
			}
		}
		return fencedCode(text, fallback);
	}

	// Untaught constructs in a lesson's code. Allowed beyond the toolbox: the
	// concept the current lesson recorded, the next topic in course order, and
	// whatever the lesson names in a heading or in bold (what it's about).
	function untaughtInLesson(ctx: any, text: string): Construct[] {
		if (!activeSubject) return [];
		const snippets = codeSnippets(text, subjectLanguage(activeSubject));
		if (!snippets.length) return [];
		const { store } = get(ctx);
		const data = store.loadProgress();
		const order = courseOrder(store, data, activeSubject);
		const links = store.loadLinks();
		const known: { name: string; topic?: string }[] = store.conceptsForSubject(data, activeSubject).map((c) => ({ name: c.name, topic: store.effectiveTopic(c, links).topic }));
		for (const n of lessonSinceLastMark(safeBranch(ctx)).taught) known.push({ name: n });
		if (order?.next) known.push({ name: order.next.title, topic: order.next.id });
		const named = [...text.matchAll(/^#{1,6}[ \t]+(.+)$|\*\*([^*\n]+)\*\*/gm)].map((m) => m[1] ?? m[2]).join("\n");
		const seen = new Map<string, Construct>();
		for (const s of snippets) for (const c of untaughtConstructs(s.code, s.language, known, order?.topics ?? [])) if (!c.words.test(named)) seen.set(c.id, c);
		return [...seen.values()];
	}

	// Constructs the exercise / quiz code uses that no recorded concept covers.
	function untaughtInCode(tool: string, input: any, subject: string, store: TutorStore, data: any): Construct[] {
		const fallback = subjectLanguage(subject);
		const snippets: { code: string; language: CodeLanguage }[] = [];
		if (tool === "assign_exercise") {
			// The learner's own program shows what they can already use.
			if (input.existingFile) return [];
			const lang = ["java", "python", "javascript"].includes(input.language) ? (input.language as CodeLanguage) : fallback;
			// Separately: joined, the two `public class Main`s would read as "defines classes".
			if (lang) for (const code of [input.referenceSolution]) if (typeof code === "string" && code.trim()) snippets.push({ code, language: lang });
		} else {
			// What the learner sees while answering (the explanation comes after).
			for (const text of displayedFields({ ...input, explanation: undefined })) {
				snippets.push(...fencedCode(text, fallback));
				const inline = [...text.replace(/```[\s\S]*?```/g, "").matchAll(/`([^`\n]+)`/g)].map((m) => m[1]).join("\n");
				if (inline && fallback) snippets.push({ code: inline, language: fallback });
			}
		}
		if (!snippets.length) return [];
		const map = store.readTopicMap(subject)?.topics ?? [];
		const links = store.loadLinks();
		const known = store.conceptsForSubject(data, subject).map((c) => ({ name: c.name, topic: store.effectiveTopic(c, links).topic }));
		const seen = new Map<string, Construct>();
		for (const s of snippets) for (const c of untaughtConstructs(s.code, s.language, known, map)) seen.set(c.id, c);
		return [...seen.values()];
	}

	// ── Recording ────────────────────────────────────────────────────────────
	pi.on("tool_result", async (event, ctx) => {
		const d = event.details as any;
		if (!d || d.status !== "answered") return;
		const input = event.input as any;
		const { store } = get(ctx);
		if (event.toolName === "explain_back") {
			// Explain-it-back on a result/step: logged (not graded) for the learner model.
			if (d.wantsDirect) store.addSignal({ subject: activeSubject, kind: "asked-for-answer", detail: String(input.prompt ?? "").slice(0, 120) });
			if (!d.text) return;
			store.recordQuiz({
				ts: new Date().toISOString(),
				subject: String(input.subject ?? activeSubject ?? "General"),
				concepts: Array.isArray(input.concepts) ? input.concepts : [],
				question: String(input.prompt ?? ""),
				purpose: "discovery",
				kind: "explain",
				outcome: "correct",
				selfExplanation: d.text,
			});
			return;
		}
		if (!QUIZ_TOOLS.has(event.toolName)) return;
		let outcome: QuizOutcome;
		let answer: string | undefined;
		let expected: string | undefined;
		let misconception: string | undefined;
		if (event.toolName === "quiz_typed") {
			outcome = d.dontKnow ? "dontknow" : d.correct ? "correct" : d.disputed ? "disputed" : "incorrect";
			answer = d.answer;
			expected = d.expected;
		} else {
			outcome = d.dontKnow ? "dontknow" : d.correct ? "correct" : "incorrect";
			answer = (d.answers ?? []).map((a: any) => a.label).join(", ") || undefined;
			expected = (d.correctIndices ?? [])
				.map((i: number) => d.options?.find((o: any) => o.index === i)?.label)
				.filter(Boolean)
				.join(", ");
			if (outcome === "incorrect") {
				const picked = new Set((d.answers ?? []).map((a: any) => a.value));
				misconception = (input.options ?? [])
					.filter((o: any) => picked.has((o.value ?? o.label ?? "").trim()) && o.misconception)
					.map((o: any) => o.misconception)
					.join("; ") || undefined;
			}
		}
		const record: QuizRecord = {
			ts: new Date().toISOString(),
			subject: String(input.subject ?? "General"),
			concepts: Array.isArray(input.concepts) ? input.concepts : [],
			question: String(input.question ?? d.question ?? ""),
			purpose: input.purpose ?? "check",
			kind: event.toolName === "quiz_typed" ? "typed" : "choice",
			outcome,
			answer,
			expected,
			misconception,
			note: d.note,
			confidence: [1, 2, 3].includes(d.confidence) ? d.confidence : undefined,
			hintsUsed: Number(d.hintsUsed) || 0,
			attempts: Number(d.attempts) > 1 ? Number(d.attempts) : undefined,
			selfExplanation: d.selfExplanation,
			toolCallId: (event as any).toolCallId,
		};
		if (d.wantsDirect) store.addSignal({ subject: record.subject, kind: "asked-for-answer", detail: record.question.slice(0, 120) });
		try {
			store.recordQuiz(record);
		} catch (e) {
			safeUi(ctx, (ui) => ui.notify(`Tutor: failed to save progress: ${(e as Error).message}`, "error"));
		}
	});

	// ── Tools ────────────────────────────────────────────────────────────────
	pi.registerTool({
		name: "mark_taught",
		label: "mark_taught",
		description:
			"Record that you have just taught one or more concepts (motivated, established and connected them). Required before quizzing on them with purpose check/review. Also creates their spaced-review schedule.",
		promptSnippet: "Record concepts you have just taught (required before quizzing on them).",
		// Models send concepts as plain strings ("loops") or a JSON string of them.
		prepareArguments: (args: any) => coerceList(coerceJsonArgs(args, ["concepts"]), "concepts", "name"),
		parameters: Type.Object({
			subject: Type.String({ description: 'Subject/course, stable across sessions (e.g. "Java", "Calc II").' }),
			concepts: Type.Array(
				Type.Object({
					name: Type.String({ description: "Short, stable concept name, e.g. 'integer division', 'chain rule'." }),
					summary: Type.Optional(Type.String({ description: "One-line statement of the idea as you taught it." })),
					family: Type.Optional(
						Type.String({ description: "Group of easily-confused concepts this belongs to, e.g. 'integration techniques', 'convergence tests', 'loop patterns'. Used to build interleaved practice." }),
					),
					topic: Type.Optional(
						Type.String({ description: "The course-map topic id this concept belongs to (listed in the system prompt under 'Course topic map'). Powers the progress dashboard's course coverage." }),
					),
				}),
				{ minItems: 1 },
			),
			approach: Type.Optional(
				Type.Union(APPROACHES.map((a) => Type.Literal(a)), {
					description: "How you taught it: socratic, worked-example, direct, analogy, visual, code-first, practice-first. Lets TutorBot measure which approaches work best for this learner.",
				}),
			),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const { store } = get(ctx);
			// Fresh = newly recorded. Only a mark_taught with fresh concepts starts
			// a new lesson window (probe count, guided practice).
			const before = store.loadProgress();
			const fresh = params.concepts.filter((c) => !store.findConceptStrict(before, params.subject, c.name)).map((c) => c.name);
			const saved = store.markTaught(params.subject, params.concepts, params.approach as Approach | undefined);
			return {
				content: [{ type: "text", text: `Recorded as taught in ${params.subject}${params.approach ? ` (${params.approach})` : ""}: ${saved.map((c) => c.name).join(", ")}. Now guided practice (quiz_typed with hints), then unaided checks.` }],
				details: { subject: params.subject, concepts: saved.map((c) => c.name), fresh, approach: params.approach },
			};
		},
	});

	pi.registerTool({
		name: "tutor_progress",
		label: "tutor_progress",
		description:
			"Look up the learner's recorded progress: concepts per subject with status, accuracy and next review date, what is due, and recent misses with the misconception behind them.",
		promptSnippet: "Look up the learner's progress, due reviews, and recorded concept names.",
		parameters: Type.Object({
			subject: Type.Optional(Type.String({ description: "Limit to one subject." })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const { store } = get(ctx);
			const data = store.loadProgress();
			const lines: string[] = [store.summary(data), "", "## How this learner learns (measured)", store.learnerModelText(data, params.subject), ""];
			const subjects = params.subject ? [params.subject] : [...new Set(Object.values(data.concepts).map((c) => c.subject))];
			for (const s of subjects) {
				lines.push(`## ${s}`);
				for (const c of store.conceptsForSubject(data, s)) {
					lines.push(`- ${c.name} [${c.status}] ${c.correct}/${c.attempts} correct, next review ${c.due?.slice(0, 10) ?? "—"}${c.summary ? ` — ${c.summary}` : ""}`);
				}
				const misses = data.quizLog.filter((r) => r.subject === s && r.outcome === "incorrect").slice(-8);
				if (misses.length) {
					lines.push("Recent misses:");
					for (const r of misses) lines.push(`  - ${r.question.split("\n")[0].slice(0, 100)} → answered ${r.answer}, correct ${r.expected}${r.misconception ? ` (${r.misconception})` : ""}`);
				}
			}
			return { content: [{ type: "text", text: lines.join("\n") }], details: {} };
		},
	});

	pi.registerTool({
		name: "update_learner_profile",
		label: "update_learner_profile",
		description:
			"Update Tutor/Learner Profile.md — the record of how this learner learns best, injected into every future session. 'add' appends one dated bullet to a section; 'replace' rewrites a whole section (use to consolidate duplicates). Only record concrete observations backed by evidence from the session.",
		promptSnippet: "Record an evidence-backed observation about how the learner learns best.",
		parameters: Type.Object({
			section: Type.Union(PROFILE_SECTIONS.map((s) => Type.Literal(s))),
			action: Type.Union([Type.Literal("add"), Type.Literal("replace")]),
			text: Type.String({
				description: "add: one observation (e.g. 'Concrete code traces land better than abstract rules for Java control flow'). replace: the full new section body as markdown bullets.",
			}),
			evidence: Type.Optional(Type.String({ description: "add only: what you saw that supports it (short)." })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const { store } = get(ctx);
			const lines = store.readProfile().split("\n");
			const heading = `## ${params.section}`;
			let start = lines.findIndex((l) => l.trim() === heading);
			if (start === -1) {
				lines.push("", heading);
				start = lines.length - 1;
			}
			let end = lines.findIndex((l, i) => i > start && l.startsWith("## "));
			if (end === -1) end = lines.length;
			if (params.action === "add") {
				const bullet = `- ${params.text.trim()} _(${today()}${params.evidence ? ` · ${params.evidence.trim()}` : ""})_`;
				let insertAt = end;
				while (insertAt > start + 1 && lines[insertAt - 1].trim() === "") insertAt--;
				lines.splice(insertAt, 0, bullet);
			} else {
				lines.splice(start + 1, end - start - 1, params.text.trim(), "");
			}
			store.writeProfile(lines.join("\n").replace(/\n{3,}/g, "\n\n"));
			return { content: [{ type: "text", text: `Learner profile updated (${params.section}, ${params.action}).` }], details: {} };
		},
	});

	pi.registerTool({
		name: "resolve_dispute",
		label: "resolve_dispute",
		description: "Settle the learner's most recent disputed quiz_typed answer (this session, this subject) after judging it on substance. Updates their progress accordingly; a settled dispute never counts as checkpoint proof.",
		parameters: Type.Object({
			verdict: Type.Union([Type.Literal("correct"), Type.Literal("incorrect")]),
			reason: Type.String({ description: "One sentence: why." }),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			// The dispute from this session's latest disputed card, in this subject only.
			const branch = safeBranch(ctx);
			const disputed = [...branch].reverse().find((e) => e?.message?.role === "toolResult" && e.message.toolName === "quiz_typed" && e.message.details?.disputed)?.message;
			const rec = get(ctx).store.resolveDispute(params.verdict, { subject: activeSubject, toolCallId: disputed?.toolCallId });
			const text = rec ? `Recorded the disputed answer as ${params.verdict}.` : "No disputed answer was pending.";
			return { content: [{ type: "text", text }], details: { verdict: params.verdict, reason: params.reason } };
		},
	});

	pi.registerTool({
		name: "search_resources",
		label: "search_resources",
		description:
			"Search the learner's class resource folders (lecture slides, notes, handouts, PDFs, Word docs, code) for a topic. Returns the best-matching passages with file and page, so you can teach the way the class does and cite it. Follow up with read_resource for full pages.",
		promptSnippet: "Search the learner's class materials (slides, notes, PDFs) for a topic.",
		parameters: Type.Object({
			query: Type.String({ description: "Key terms, e.g. 'integer division modulus' or 'chain rule composite'." }),
			pathContains: Type.Optional(Type.String({ description: "Only files whose path contains this (e.g. a course folder name or 'Lecture 5')." })),
			limit: Type.Optional(Type.Number({ description: "Max results (default 8)." })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const { index } = get(ctx);
			const folders = searchFolders(ctx, Boolean(params.pathContains));
			if (!folders.length) {
				return { content: [{ type: "text", text: "No class resource folders configured. The learner can add one with /tutor-resources add <folder>." }], details: {} };
			}
			if (index.stats().files === 0) await startIndexing(ctx, false);
			const hits = index.search(params.query, folders, Math.min(20, params.limit ?? 8), params.pathContains);
			if (!hits.length) {
				return { content: [{ type: "text", text: `No matches for "${params.query}" in the class resources${isIndexing() ? " (indexing still in progress — try again shortly)" : ""}.` }], details: {} };
			}
			const text = hits
				.map((h, i) => `${i + 1}. ${displayPath(h.path, folders)}${h.page ? `, p. ${h.page}` : ""}\n   path: ${h.path}\n   …${h.snippet}…`)
				.join("\n\n");
			return { content: [{ type: "text", text }], details: { hits: hits.length } };
		},
	});

	pi.registerTool({
		name: "read_resource",
		label: "read_resource",
		description: "Read the extracted text of a class resource file (any indexed type, including PDF/PPTX/DOCX), optionally a page range. Use the path returned by search_resources.",
		parameters: Type.Object({
			path: Type.String(),
			fromPage: Type.Optional(Type.Number()),
			toPage: Type.Optional(Type.Number({ description: "Inclusive. Default: fromPage + 4." })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const r = get(ctx).index.readPages(params.path, params.fromPage, params.toPage);
			if (!r) return { content: [{ type: "text", text: `Not in the resource index: ${params.path}` }], details: {} };
			const text = r.text.length > 40_000 ? `${r.text.slice(0, 40_000)}\n…(truncated; request fewer pages)` : r.text;
			return { content: [{ type: "text", text: `(${r.pages} page(s) total)\n${text}` }], details: { pages: r.pages } };
		},
	});

	pi.registerTool({
		name: "rate_explanation",
		label: "rate_explanation",
		description: "Record how good the learner's own explanation (explain-it-back) was, after you've compared it with the correct reasoning. Feeds the learner model.",
		parameters: Type.Object({
			quality: Type.Union([Type.Literal("good"), Type.Literal("partial"), Type.Literal("missing")], {
				description: "good = correct and complete reasoning; partial = a real attempt with the right idea, cue or slip identified but a gap, error or no full reasoning; missing = no real attempt (blank, 'I don't know', or unrelated).",
			}),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const rec = get(ctx).store.rateLatestExplanation(activeSubject, params.quality);
			return { content: [{ type: "text", text: rec ? `Recorded: explanation was ${params.quality}.` : "No recent explanation to rate." }], details: {} };
		},
	});

	pi.registerTool({
		name: "course_style_sources",
		label: "course_style_sources",
		description:
			"Collect samples of how the learner's teacher writes assessments (quizzes, exams, homework, practice sheets) from the subject's class folder, so you can write a course style profile with save_course_style.",
		promptSnippet: "Gather the teacher's quizzes/exams from the class folder to learn the course's question style.",
		parameters: Type.Object({
			subject: Type.String(),
			maxFiles: Type.Optional(Type.Number({ description: "How many assessment files to sample (default 8)." })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const { index, registry, store } = get(ctx);
			const folders = registry.find(params.subject)?.folders ?? [];
			if (!folders.length) return { content: [{ type: "text", text: `No class folder for ${params.subject}. Ask the learner to choose one (/folder, or the folder button in the panel).` }], details: {} };
			if (index.stats().files === 0 || isIndexing()) await startIndexing(ctx, false);
			const files = index.indexedFiles(folders);
			const assess = files.filter((f) => ASSESSMENT_PATH.test(f.path));
			// Prefer question papers over answer keys, and a spread of kinds.
			const papers = assess.filter((f) => !ANSWER_KEY_PATH.test(basename(f.path)));
			const keys = assess.filter((f) => ANSWER_KEY_PATH.test(basename(f.path)));
			const n = Math.max(2, Math.min(12, params.maxFiles ?? 8));
			const pick = [...papers.slice(0, n - Math.min(2, keys.length)), ...keys.slice(0, 2)];
			let budget = 30_000;
			const parts: string[] = [];
			for (const f of pick) {
				const r = index.readPages(f.path, 1, 3);
				if (!r) continue;
				const chunk = r.text.slice(0, Math.min(4000, budget));
				budget -= chunk.length;
				parts.push(`### ${displayPath(f.path, folders)}${ANSWER_KEY_PATH.test(basename(f.path)) ? " (answer key)" : ""}\n${chunk}`);
				if (budget <= 0) break;
			}
			const listing = files.slice(0, 80).map((f) => `- ${displayPath(f.path, folders)}`).join("\n");
			const existing = store.readCourseStyle(params.subject);
			const text =
				(parts.length
					? `Assessment samples (${pick.length} of ${assess.length} assessment-like files):\n\n${parts.join("\n\n")}`
					: `No files that look like quizzes/exams/homework were found (by file name). Infer the style from lecture materials instead.`) +
				`\n\nAll indexed files (first 80):\n${listing}\n\n` +
				`Now write the course style profile and save it with save_course_style. Cover: question formats and their mix (multiple choice / free response / show-work / proofs / code), typical number of questions and points, notation and naming conventions, phrasing patterns (the verbs and setups the teacher uses), difficulty level and multi-part structure, what a full-credit answer looks like (exact form, units, work shown), the distractor style for multiple choice, topics emphasised, and 3–5 question TEMPLATES in the teacher's voice (with placeholders, not copied verbatim).` +
				(existing ? `\n\nAn existing profile will be replaced:\n${existing.slice(0, 1500)}` : "");
			return { content: [{ type: "text", text }], details: { files: pick.map((f) => f.path) } };
		},
	});

	pi.registerTool({
		name: "save_course_style",
		label: "save_course_style",
		description: "Save the course style profile (markdown) for a subject. It is shown to you in every session of that subject so practice questions match the teacher's style.",
		parameters: Type.Object({
			subject: Type.String(),
			markdown: Type.String({ description: "The profile, starting with a '# <Subject> — course style' heading." }),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const path = get(ctx).store.writeCourseStyle(params.subject, params.markdown.trim() + "\n");
			return { content: [{ type: "text", text: `Saved the course style profile: ${path}. Tell the learner in one line what you learned about how their teacher asks questions.` }], details: { path } };
		},
	});

	pi.registerTool({
		name: "teacher_examples",
		label: "teacher_examples",
		description:
			"Find how the learner's teacher actually asks about a topic: searches only quizzes, exams, homework and practice files in the subject's class folder. Use before writing practice or checkpoint questions so yours match the teacher's format, notation and difficulty.",
		promptSnippet: "Find the teacher's real questions on a topic (from quizzes/exams in the class folder).",
		parameters: Type.Object({
			subject: Type.String(),
			topic: Type.String({ description: "Key terms, e.g. 'integration by parts' or 'while loop trace'." }),
			limit: Type.Optional(Type.Number({ description: "Max passages (default 5)." })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const { index, registry } = get(ctx);
			const folders = registry.find(params.subject)?.folders ?? [];
			if (!folders.length) return { content: [{ type: "text", text: `No class folder for ${params.subject}.` }], details: {} };
			const hits = index.search(params.topic, folders, Math.min(10, params.limit ?? 5), ASSESSMENT_PATH);
			if (!hits.length) return { content: [{ type: "text", text: `No quiz/exam/homework passages about "${params.topic}". Use the course style profile and lecture materials instead.` }], details: {} };
			const text = hits.map((h, i) => `${i + 1}. ${displayPath(h.path, folders)}${h.page ? `, p. ${h.page}` : ""}\n   …${h.snippet}…`).join("\n\n");
			return {
				content: [{ type: "text", text: `${text}\n\nModel your question on these (format, notation, wording, difficulty) without copying one verbatim, and never solve their CURRENT graded homework for them.` }],
				details: { hits: hits.length },
			};
		},
	});

	pi.registerTool({
		name: "course_map_sources",
		label: "course_map_sources",
		description:
			"Collect what describes the course's structure (syllabus, schedule, outline, and the ordered list of lecture/notes files) from the subject's class folder, so you can build the course topic map with save_course_map.",
		promptSnippet: "Gather the syllabus and lecture order from the class folder to build the course topic map.",
		parameters: Type.Object({ subject: Type.String() }),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const { index, registry, store } = get(ctx);
			const folders = registry.find(params.subject)?.folders ?? [];
			if (!folders.length) return { content: [{ type: "text", text: `No class folder for ${params.subject}. Ask the learner to choose one (/folder, or the folder chip in the panel). Without one, build the map from the standard curriculum and say so.` }], details: {} };
			if (index.stats().files === 0 || isIndexing()) await startIndexing(ctx, false);
			const files = index.indexedFiles(folders);
			const syllabi = files.filter((f) => SYLLABUS_PATH.test(basename(f.path))).slice(0, 3);
			let budget = 24_000;
			const parts: string[] = [];
			for (const f of syllabi) {
				const r = index.readPages(f.path, 1, 6);
				if (!r) continue;
				const chunk = r.text.slice(0, Math.min(8000, budget));
				budget -= chunk.length;
				parts.push(`### ${displayPath(f.path, folders)}\n${chunk}`);
			}
			// Natural sort so "Lecture 2" comes before "Lecture 10".
			const ordered = files
				.map((f) => displayPath(f.path, folders))
				.sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }))
				.slice(0, 150);
			const existing = store.readTopicMap(params.subject);
			const text =
				(parts.length ? `Course structure documents:\n\n${parts.join("\n\n")}` : "No syllabus/schedule file found by name; infer the structure from the file list (lectures, chapters, units, quizzes).") +
				`\n\nAll class files in order:\n${ordered.map((x) => `- ${x}`).join("\n")}\n\n` +
				`Now build the course topic map and save it with save_course_map: 10–40 topics, each one quiz-able idea or skill (e.g. "Integration by parts", "Ratio test", "For loops"), in teaching order, grouped into units (chapters/weeks/units as the course names them). Ids: short kebab-case, stable. Then link any already-taught concepts with tag_concepts.` +
				(existing ? `\n\nAn existing map (${existing.topics.length} topics) will be replaced; keep its ids where the topic is the same so links survive.` : "");
			return { content: [{ type: "text", text }], details: { syllabi: syllabi.map((f) => f.path) } };
		},
	});

	pi.registerTool({
		name: "save_course_map",
		label: "save_course_map",
		description: "Save the course topic map for a subject (ordered topics grouped into units). The progress dashboard shows coverage of these topics; untouched ones appear as gaps.",
		prepareArguments: (args: any) => coerceJsonArgs(args, ["topics"]),
		parameters: Type.Object({
			subject: Type.String(),
			topics: Type.Array(
				Type.Object({
					id: Type.String({ description: "Short stable kebab-case id, e.g. 'integration-by-parts'." }),
					title: Type.String(),
					unit: Type.Optional(Type.String({ description: "Unit / chapter / week it belongs to." })),
				}),
				{ minItems: 1 },
			),
			source: Type.Optional(Type.String({ description: "What it was built from (e.g. 'syllabus.pdf + lecture list')." })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const seen = new Set<string>();
			const topics = params.topics
				.map((t, i) => ({ id: slug(t.id || t.title) || `topic-${i + 1}`, title: t.title.trim(), unit: t.unit?.trim() || undefined, order: i + 1 }))
				.filter((t) => (seen.has(t.id) ? false : (seen.add(t.id), true)));
			const path = get(ctx).store.writeTopicMap(params.subject, { topics, source: params.source });
			return { content: [{ type: "text", text: `Saved ${topics.length} topics for ${params.subject} (${path}). Link already-taught concepts with tag_concepts, and pass topic ids to mark_taught from now on.` }], details: { topics: topics.length } };
		},
	});

	pi.registerTool({
		name: "tag_concepts",
		label: "tag_concepts",
		description: "Link already-recorded concepts to course-map topics (by topic id). The learner can confirm or change these links in the progress dashboard.",
		prepareArguments: (args: any) => coerceJsonArgs(args, ["tags"]),
		parameters: Type.Object({
			subject: Type.String(),
			tags: Type.Array(Type.Object({ concept: Type.String(), topic: Type.String() }), { minItems: 1 }),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const { store } = get(ctx);
			const map = store.readTopicMap(params.subject);
			const ids = new Set((map?.topics ?? []).map((t) => t.id));
			const data = store.loadProgress();
			const done: string[] = [];
			const bad: string[] = [];
			for (const t of params.tags) {
				if (ids.size && !ids.has(t.topic)) {
					bad.push(`${t.concept} → ${t.topic} (unknown topic id)`);
					continue;
				}
				const c = store.tagConcept(data, params.subject, t.concept, t.topic);
				(c ? done : bad).push(c ? `${c.name} → ${t.topic}` : `${t.concept} (no such concept)`);
			}
			store.saveProgress(data);
			return { content: [{ type: "text", text: `Linked: ${done.join("; ") || "none"}${bad.length ? `\nSkipped: ${bad.join("; ")}` : ""}` }], details: { linked: done.length } };
		},
	});

	pi.registerTool({
		name: "set_assessment",
		label: "set_assessment",
		description: "Record an upcoming exam, quiz, homework deadline or project the learner mentioned, so TutorBot counts down to it, plans review and switches to exam prep near the date.",
		parameters: Type.Object({
			subject: Type.String(),
			name: Type.String({ description: "e.g. 'Midterm 1', 'Quiz 4', 'HW 6'." }),
			date: Type.String({ description: "YYYY-MM-DD." }),
			kind: Type.Optional(Type.String({ description: "exam, quiz, homework, project…" })),
			topics: Type.Optional(Type.String({ description: "Topics it covers, if known." })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			if (!/^\d{4}-\d{2}-\d{2}$/.test(params.date)) return { content: [{ type: "text", text: "date must be YYYY-MM-DD" }], details: {} };
			const a = get(ctx).store.addAssessment(params);
			return { content: [{ type: "text", text: `Recorded ${a.subject}: ${a.name} on ${a.date}.` }], details: { assessment: a } };
		},
	});

	pi.registerTool({
		name: "assessment_result",
		label: "assessment_result",
		description: "Record how a past exam/quiz went (the learner's report or score), and mark it done.",
		parameters: Type.Object({
			name: Type.String({ description: "The assessment's name (as recorded)." }),
			result: Type.String({ description: "Score or the learner's own summary." }),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const a = get(ctx).store.updateAssessment(params.name, { done: true, result: params.result });
			return { content: [{ type: "text", text: a ? `Recorded result for ${a.name}.` : `No assessment named "${params.name}".` }], details: {} };
		},
	});

	// ── Commands ─────────────────────────────────────────────────────────────
	pi.registerCommand("tutor", {
		description: "Show learning progress (full dashboard: Tutor/Progress.md)",
		handler: async (_args, ctx) => {
			const { store } = get(ctx);
			const data = store.loadProgress();
			store.saveProgress(data); // regenerates the dashboard
			ctx.ui.notify(`${store.summary(data)}\n\nDashboard: Tutor/Progress.md · Profile: Tutor/Learner Profile.md`, "info");
		},
	});

	pi.registerCommand("tutor-resources", {
		description: "Class material folders for the current subject: add <folder> | remove <folder> | list",
		getArgumentCompletions: (prefix: string) => {
			const items = ["add ", "remove ", "list"].map((v) => ({ value: v, label: v.trim() }));
			const f = items.filter((i) => i.value.startsWith(prefix));
			return f.length ? f : null;
		},
		handler: async (args, ctx) => {
			const { store, index, registry } = get(ctx);
			const config = store.loadConfig();
			const [verb, ...rest] = (args ?? "").trim().split(/\s+/);
			const target = rest.join(" ");
			if (verb === "add" && target) {
				const p = expandPath(target);
				if (!folderExists(p)) {
					ctx.ui.notify(`Not a folder: ${p}`, "error");
					return;
				}
				// Folders belong to the current subject, so searches stay on-topic.
				if (activeSubject) registry.addFolder(activeSubject, p);
				else if (!config.resourceFolders.includes(p)) {
					config.resourceFolders.push(p);
					store.saveConfig(config);
				}
				ctx.ui.notify(`Added ${p}${activeSubject ? ` to ${activeSubject}` : " (all subjects)"}. Indexing ${index.listFiles([p]).length} files in the background…`, "info");
				startIndexing(ctx, true);
				return;
			}
			if (verb === "remove" && target) {
				const p = expandPath(target);
				config.resourceFolders = config.resourceFolders.filter((f) => f !== p && !f.endsWith(target));
				store.saveConfig(config);
				registry.removeFolder(p);
				ctx.ui.notify("Removed.", "info");
				return;
			}
			const st = index.stats();
			const lines: string[] = [];
			if (config.resourceFolders.length) lines.push("All subjects:", ...config.resourceFolders.map((f) => `  • ${f}`));
			for (const sub of registry.list()) if (sub.folders.length) lines.push(`${sub.name}:`, ...sub.folders.map((f) => `  • ${f}`));
			ctx.ui.notify(
				lines.length
					? `${lines.join("\n")}\n${st.files} files indexed${st.errors ? `, ${st.errors} unreadable` : ""}${st.builtAt ? ` (updated ${st.builtAt.slice(0, 16).replace("T", " ")})` : ""}.`
					: "No class folders yet. Pick a subject (/subject), then: /tutor-resources add ~/path/to/class/folder",
				"info",
			);
		},
	});

	pi.registerCommand("tutor-index", {
		description: "Re-scan class resource folders for new or changed files",
		handler: async (_args, ctx) => {
			if (!searchFolders(ctx, true).length) {
				ctx.ui.notify("No resource folders yet. Use /tutor-resources add <folder>.", "warning");
				return;
			}
			ctx.ui.notify("Indexing class resources in the background…", "info");
			startIndexing(ctx, true);
		},
	});

	pi.registerCommand("review", {
		description: "Spaced review of concepts that are due (optionally: /review <subject>)",
		handler: async (args, ctx) => {
			const { store } = get(ctx);
			const subject = (args ?? "").trim() || activeSubject;
			const prompt = reviewPrompt(store, store.loadProgress(), subject);
			if (!prompt) {
				ctx.ui.notify(`Nothing due for review${subject ? ` in ${subject}` : ""}.`, "info");
				return;
			}
			pi.sendUserMessage(prompt);
		},
	});

	pi.registerCommand("folder", {
		description: "Choose the class-materials folder for the current subject (opens a folder picker). /folder <path> | /folder remove <path> | /folder list",
		handler: async (args, ctx) => {
			const a = (args ?? "").trim();
			const { registry } = get(ctx);
			if (a === "list") {
				const lines = registry.list().filter((x) => x.folders.length).map((x) => `${x.name}: ${x.folders.join(", ")}`);
				ctx.ui.notify(lines.length ? lines.join("\n") : "No class folders yet. Use /folder to choose one.", "info");
				return;
			}
			if (a.startsWith("remove ")) {
				registry.removeFolder(expandPath(a.slice(7)));
				showSubjectStatus(ctx);
				ctx.ui.notify("Removed.", "info");
				return;
			}
			if (!activeSubject) {
				ctx.ui.notify("Pick a subject first (/home), then choose its folder.", "warning");
				return;
			}
			try {
				const p = a ? addSubjectFolder(ctx, activeSubject, a) : await chooseFolderFor(ctx, activeSubject);
				if (!p) return;
				ctx.ui.notify(`${activeSubject} now uses ${p}. Indexing in the background; TutorBot will learn the course's question style from it.`, "info");
			} catch (e) {
				ctx.ui.notify((e as Error).message, "error");
			}
		},
	});

	pi.registerCommand("course-style", {
		description: "Build (or rebuild) the course style profile from the class folder, so practice questions match how the teacher asks",
		handler: async (_args, ctx) => {
			if (!activeSubject) return ctx.ui.notify("Pick a subject first (/home).", "warning");
			if (!(get(ctx).registry.find(activeSubject)?.folders.length)) return ctx.ui.notify("Choose a class folder first (/folder).", "warning");
			pi.sendUserMessage(
				`Build the course style profile for ${activeSubject}: call course_style_sources, study how my teacher writes quizzes and exams, then save it with save_course_style. Afterwards tell me in 3–4 lines what you learned about the course's question style.`,
			);
		},
	});

	pi.registerCommand("course-map", {
		description: "Build (or rebuild) the course topic map from the class folder, for the progress dashboard",
		handler: async (_args, ctx) => {
			if (!activeSubject) return ctx.ui.notify("Pick a subject first (/home).", "warning");
			pi.sendUserMessage(
				`Build the course topic map for ${activeSubject}: call course_map_sources, then save_course_map with the topics in teaching order grouped into units, then link the concepts I've already learned with tag_concepts. Finish with one line: how many topics and units, and how many of my concepts you linked.`,
			);
		},
	});

	pi.registerCommand("practice", {
		description: "Interleaved practice: mixed problems from easily-confused concepts (identify the technique, then solve). /practice [family]",
		handler: async (args, ctx) => {
			if (!activeSubject) return ctx.ui.notify("Pick a subject first (/home).", "warning");
			const { store } = get(ctx);
			const p = practicePrompt(store, store.loadProgress(), activeSubject, (args ?? "").trim() || undefined);
			if (!p) return ctx.ui.notify("Not enough practised concepts for an interleaved set yet; learn at least two related concepts first.", "info");
			pi.sendUserMessage(p);
		},
	});

	pi.registerCommand("checkpoint", {
		description: "No-help checkpoint: a cumulative quiz with no hints; the only thing that counts as mastery",
		handler: async (args, ctx) => {
			if (!activeSubject) return ctx.ui.notify("Pick a subject first (/home).", "warning");
			const { store } = get(ctx);
			const n = Math.min(12, Math.max(3, Number((args ?? "").trim()) || 6));
			const p = checkpointPrompt(store, store.loadProgress(), activeSubject, n);
			if (!p) return ctx.ui.notify("Nothing to checkpoint yet; learn a concept first.", "info");
			pi.sendUserMessage(p);
		},
	});

	pi.registerCommand("exams", {
		description: "Upcoming exams/quizzes/deadlines and countdowns (tell TutorBot dates in chat to add them)",
		handler: async (_args, ctx) => {
			const { store } = get(ctx);
			const data = store.loadProgress();
			const up = store.upcomingAssessments(data, 120);
			ctx.ui.notify(
				up.length
					? up.map((a) => `${a.subject}: ${a.name} — ${a.date} (${a.daysLeft} day${a.daysLeft === 1 ? "" : "s"})`).join("\n")
					: "No upcoming assessments recorded. Tell TutorBot about one, e.g. \"My Calc II midterm is on Oct 20\".",
				"info",
			);
		},
	});

	pi.registerCommand("week", {
		description: "Write and show this week's study summary",
		handler: async (_args, ctx) => {
			const { store } = get(ctx);
			const data = store.loadProgress();
			const md = store.weeklySummary(data);
			const path = store.writeWeekly(md);
			ctx.ui.notify(`${md.split("\n").slice(2, 8).join("\n")}\n\nSaved: ${path}`, "info");
		},
	});

	pi.registerCommand("rate", {
		description: "Rate the last explanation: clicked | fuzzy | fast | slow (TutorBot adapts and learns your preferences)",
		getArgumentCompletions: (prefix: string) => {
			const f = ["clicked", "fuzzy", "fast", "slow"].filter((x) => x.startsWith(prefix)).map((x) => ({ value: x, label: x }));
			return f.length ? f : null;
		},
		handler: async (args, ctx) => {
			const a = (args ?? "").trim().toLowerCase();
			const rating: LessonRating | undefined = a.startsWith("click") ? "clicked" : a.startsWith("fuzz") ? "fuzzy" : a.includes("fast") ? "too-fast" : a.includes("slow") ? "too-slow" : undefined;
			if (!rating) return ctx.ui.notify("Use /rate clicked, /rate fuzzy, /rate fast or /rate slow.", "warning");
			// Rate the most recently taught concepts.
			const { store } = get(ctx);
			const data = store.loadProgress();
			const recent = Object.values(data.concepts)
				.filter((c) => c.taughtAt && (!activeSubject || slug(c.subject) === slug(activeSubject)))
				.sort((x, y) => (y.taughtAt ?? "").localeCompare(x.taughtAt ?? ""))
				.slice(0, 1)
				.map((c) => c.name);
			recordLessonFeedback(ctx, recent, rating);
			ctx.ui.notify(`Noted: ${RATING_LABEL[rating]}.`, "info");
		},
	});

	pi.registerCommand("stuck", {
		description: "Tell TutorBot you're stuck: it switches from questions to a direct, worked explanation",
		handler: async (_args, ctx) => {
			get(ctx).store.addSignal({ subject: activeSubject, kind: "asked-for-answer", detail: "/stuck" });
			pi.sendUserMessage("I'm stuck on this. Please just show me: explain it directly with a worked example, then give me one easier question to check.");
		},
	});

	pi.registerCommand("nudges", {
		description: "Daily study reminders as Mac notifications: /nudges on [HH:MM] | off | now | status",
		handler: async (args, ctx) => {
			const { store } = get(ctx);
			const [verb, time] = (args ?? "status").trim().split(/\s+/);
			const config = store.loadConfig();
			if (process.platform !== "darwin") return ctx.ui.notify("Nudges use macOS notifications; not available on this system.", "warning");
			const launchctl = (cmd: string[]) => new Promise<void>((done) => execFile("launchctl", cmd, () => done()));
			const uid = process.getuid?.() ?? 501;
			if (verb === "on") {
				const t = /^\d{1,2}:\d{2}$/.test(time ?? "") ? time : "18:00";
				const [h, m] = t.split(":").map(Number);
				// launchd runs a copy in the data folder: the extension's own folder
				// changes with every update.
				const script = join(store.dataDir, "nudge.mjs");
				writeFileSync(script, readFileSync(NUDGE_SCRIPT, "utf8"));
				const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${NUDGE_LABEL}</string>
<key>ProgramArguments</key><array><string>${process.execPath}</string><string>${script}</string><string>${ctx.cwd}</string></array>
<key>EnvironmentVariables</key><dict><key>ELECTRON_RUN_AS_NODE</key><string>1</string></dict>
<key>StartCalendarInterval</key><dict><key>Hour</key><integer>${h}</integer><key>Minute</key><integer>${m}</integer></dict>
<key>StandardErrorPath</key><string>${join(store.dataDir, "nudge.log")}</string>
</dict></plist>
`;
				mkdirSync(dirname(nudgePlistPath()), { recursive: true });
				writeFileSync(nudgePlistPath(), plist);
				await launchctl(["bootout", `gui/${uid}/${NUDGE_LABEL}`]);
				await launchctl(["bootstrap", `gui/${uid}`, nudgePlistPath()]);
				store.saveConfig({ ...config, nudges: { enabled: true, time: t } });
				return ctx.ui.notify(`Daily reminder on at ${t}. It only appears when reviews are due, an exam is close, or you haven't studied in a while. /nudges off to stop.`, "info");
			}
			if (verb === "off") {
				await launchctl(["bootout", `gui/${uid}/${NUDGE_LABEL}`]);
				try {
					unlinkSync(nudgePlistPath());
				} catch {
					// already gone
				}
				store.saveConfig({ ...config, nudges: { enabled: false, time: config.nudges?.time ?? "18:00" } });
				return ctx.ui.notify("Daily reminders off.", "info");
			}
			if (verb === "now") {
				execFile(process.execPath, [NUDGE_SCRIPT, ctx.cwd, "--force"], () => {});
				return ctx.ui.notify("Sent a test reminder.", "info");
			}
			ctx.ui.notify(config.nudges?.enabled ? `Daily reminders are on at ${config.nudges.time}.` : "Daily reminders are off. /nudges on [HH:MM] to turn them on.", "info");
		},
	});

	pi.registerCommand("tutor-reflect", {
		description: "Have the tutor reflect on this session and update your learner profile",
		handler: async () => {
			pi.sendUserMessage(
				"Reflect on this session as my tutor. Look at my quiz answers, notes, questions, and anything I said about how you were teaching. " +
					"What explanations landed? What confused me or frustrated me? Was the pace right? " +
					"Then call update_learner_profile for each concrete, evidence-backed lesson (skip anything already in the profile; use action 'replace' to consolidate a section that's getting long). " +
					"Finish with a short list of what you changed.",
			);
		},
	});

	// ── Subjects ─────────────────────────────────────────────────────────────
	const homeCommand = {
		description: "TutorBot home: switch subject, start a new subject, or just chat (/home <name> jumps straight to a subject)",
		getArgumentCompletions: (prefix: string) => {
			const names = registry?.list().map((s) => s.name) ?? [];
			const f = names.filter((n) => n.toLowerCase().startsWith(prefix.toLowerCase())).map((n) => ({ value: n, label: n }));
			return f.length ? f : null;
		},
		handler: async (args, ctx) => {
			const { store, registry } = get(ctx);
			let data = store.loadProgress();
			const g = globalThis as any;
			const currentFile = ctx.sessionManager.getSessionFile();

			const startFresh = async (name: string, kickoff?: string) => {
				g.__tutorPendingSubject = name;
				g.__tutorKickoff = Boolean(kickoff);
				await ctx.newSession({
					withSession: async (c: any) => {
						if (kickoff) await c.sendUserMessage(kickoff);
						else c.ui.notify(`${name} — new session. Your progress carries over.`, "info");
					},
				});
			};

			const openSubject = async (name: string, direct: boolean): Promise<boolean> => {
				const sub = registry.find(name) ?? registry.ensure(name);
				const last = sub.lastSession && existsSync(sub.lastSession) ? sub.lastSession : undefined;
				const due = store.dueConcepts(data, sub.name).length;
				const CONTINUE = "Continue where I left off";
				const FRESH = "Start a fresh session (progress is kept)";
				const REVIEW = `Review what's due (${due})`;
				const FOLDER = sub.folders.length ? `Class folder: ${sub.folders.map((f) => basename(f)).join(", ")} (change)` : "Choose class folder…";
				const BACK = "Back";
				let choice: string | undefined;
				if (direct && last) choice = CONTINUE;
				else {
					while (true) {
						const opts = [...(last ? [CONTINUE] : []), FRESH, ...(due ? [REVIEW] : []), FOLDER, ...(direct ? [] : [BACK])];
						choice = await ctx.ui.select(sub.name, opts);
						if (choice !== FOLDER) break;
						const p = await chooseFolderFor(ctx, sub.name);
						if (p) ctx.ui.notify(`${sub.name} now uses ${p}. Indexing in the background.`, "info");
						return openSubject(name, direct);
					}
				}
				if (!choice || choice === BACK) return false;
				if (choice === CONTINUE && last) {
					if (last === currentFile) {
						activeSubject = sub.name;
						getBridge().setState("subject", sub.name);
						ctx.ui.notify(`Continuing ${sub.name}.`, "info");
						return true;
					}
					await ctx.switchSession(last, { withSession: async (c: any) => c.ui.notify(`Welcome back to ${sub.name}.`, "info") });
					return true;
				}
				if (choice === REVIEW) {
					await startFresh(sub.name, reviewPrompt(store, data, sub.name));
					return true;
				}
				await startFresh(
					sub.name,
					store.conceptsForSubject(data, sub.name).length
						? `I'm back to study ${sub.name}. Briefly: where did we leave off, what's due for review, and what do you suggest next? Then wait for me to choose.`
						: undefined,
				);
				return true;
			};

			const renameFromHome = async (names: string[]) => {
				const from = names.length === 1 ? names[0] : await ctx.ui.select("Rename which subject?", names);
				if (!from) return;
				const to = (await ctx.ui.input(`New name for ${from}`, from))?.trim();
				if (!to || to === from) return;
				const r = renameSubjectEverywhere(ctx, from, to);
				if (r.ok) data = store.loadProgress();
				ctx.ui.notify(r.ok ? `Renamed ${from} to ${r.name}. Its progress, history and class folder moved with it.` : `Couldn't rename: ${r.error}`, r.ok ? "info" : "error");
			};

			const newSubject = async (preset?: string) => {
				const name = (preset ?? (await ctx.ui.input("New subject — what do you want to learn?", "e.g. Java, Calc II, Organic Chemistry")) ?? "").trim();
				if (!name) return false;
				registry.ensure(name);
				let folderNote = "";
				const pick = await ctx.ui.select(`Do you keep your ${name} class materials in a folder? TutorBot can use them to match your teacher's questions.`, ["Choose folder…", "Skip for now"]);
				if (pick === "Choose folder…") {
					try {
						const p = await chooseFolderFor(ctx, name);
						if (p) folderNote = " My class materials for it are indexed; use them, and build the course style profile so practice matches my teacher's questions.";
					} catch (e) {
						ctx.ui.notify((e as Error).message, "error");
					}
				}
				await startFresh(
					name,
					`I want to start learning ${name}.${folderNote} Start by finding out what I already know and what I want to get out of it — then propose a plan.`,
				);
				return true;
			};

			// `/home <name> --continue` (dashboard actions): switch with no dialogs;
			// resume the last session, else a quiet fresh one.
			// `/home <name> --new` (VS Code directory): always a new subject, even
			// when the name is a prefix of an existing one.
			const quiet = /\s--continue\s*$/.test(args ?? "");
			const fresh = /\s--new\s*$/.test(args ?? "");
			const wanted = (args ?? "").replace(/\s--(continue|new)\s*$/, "").trim();
			if (wanted && fresh) {
				await newSubject(wanted);
				return;
			}
			if (wanted && quiet) {
				// Exact name (or a renamed subject's old name) only: find() also matches
				// prefixes ("Java" → "JavaScript").
				const sub = registry.ensure(wanted);
				const last = sub.lastSession && existsSync(sub.lastSession) ? sub.lastSession : undefined;
				if (last === currentFile || (!last && activeSubject === sub.name)) {
					activeSubject = sub.name;
					getBridge().setState("subject", sub.name);
				} else if (last) await ctx.switchSession(last, { withSession: async (c: any) => c.ui.notify(`Switched to ${sub.name}.`, "info") });
				else await startFresh(sub.name);
				return;
			}
			if (wanted) {
				if (registry.find(wanted)) await openSubject(wanted, true);
				else await newSubject(wanted);
				return;
			}

			// Subject folders: create, file subjects into, rename, delete.
			const organize = async () => {
				const NEWF = "New folder…";
				const MOVE = "Move a subject into a folder…";
				const OUT = "Take a subject out of its folder…";
				const RENF = "Rename a folder…";
				const DELF = "Delete a folder (its subjects stay)…";
				const BACK = "Back";
				const groups = registry.groups();
				const filed = registry.list().filter((s) => s.group);
				const pick = await ctx.ui.select("Subject folders — group your subjects (e.g. by semester or school)", [
					NEWF,
					...(registry.list().length ? [MOVE] : []),
					...(filed.length ? [OUT] : []),
					...(groups.length ? [RENF, DELF] : []),
					BACK,
				]);
				try {
					if (pick === NEWF) {
						const n = (await ctx.ui.input("Name of the new folder", "e.g. Fall 2026, NYU, Personal"))?.trim();
						if (n) ctx.ui.notify(`Created folder ${registry.createGroup(n)}.`, "info");
					} else if (pick === MOVE) {
						const subj = await ctx.ui.select("Move which subject?", registry.list().map((s) => s.name));
						if (!subj) return;
						const NEWHERE = "New folder…";
						let to = await ctx.ui.select(`Move ${subj} into which folder?`, [...groups, NEWHERE]);
						if (to === NEWHERE) to = (await ctx.ui.input("Name of the new folder", "e.g. Fall 2026"))?.trim();
						if (to) ctx.ui.notify(`${subj} is now in ${registry.setGroup(subj, to).group}.`, "info");
					} else if (pick === OUT) {
						const subj = await ctx.ui.select("Take which subject out of its folder?", filed.map((s) => `${s.name} (in ${s.group})`));
						const s = filed.find((x) => `${x.name} (in ${x.group})` === subj);
						if (s) ctx.ui.notify(`${registry.setGroup(s.name, undefined).name} is no longer in a folder.`, "info");
					} else if (pick === RENF) {
						const from = await ctx.ui.select("Rename which folder?", groups);
						const to = from && (await ctx.ui.input(`New name for ${from}`, from))?.trim();
						if (from && to && to !== from) ctx.ui.notify(`Renamed folder ${from} to ${registry.renameGroup(from, to)}.`, "info");
					} else if (pick === DELF) {
						const name = await ctx.ui.select("Delete which folder? Its subjects move out of it; nothing else is deleted.", groups);
						if (name) {
							const n = registry.deleteGroup(name);
							ctx.ui.notify(`Deleted folder ${name}${n ? `; its ${n} subject${n === 1 ? "" : "s"} moved to the top level` : ""}.`, "info");
						}
					}
				} catch (e) {
					ctx.ui.notify((e as Error).message, "error");
				}
			};

			let inFolder: string | undefined; // the folder being browsed, if any
			while (true) {
				const NEW = "Start a new subject";
				const CHAT = "Just chat (no subject)";
				const isCurrent = (name: string) => activeSubject !== undefined && slug(name) === slug(activeSubject);
				const RENAME = "Rename a subject…";
				const ORGANIZE = "Organize subject folders…";
				const BACK = "Back";
				const groups = inFolder === undefined ? registry.groups() : [];
				// At the top: folders first, then subjects in no folder. Inside a folder: its subjects.
				const subjects = registry.inGroup(inFolder);
				const folderLabel = (g: string) => {
					const n = registry.inGroup(g).length;
					return `📁 ${g} (${n} subject${n === 1 ? "" : "s"})`;
				};
				const folderLabels = groups.map(folderLabel);
				const labels = subjects.map((s) => `${s.name}${isCurrent(s.name) ? "  (current)" : ""}`);
				const title =
					inFolder !== undefined
						? `📁 ${inFolder}`
						: activeSubject
							? `TutorBot Home — currently studying ${activeSubject}`
							: "TutorBot Home — what are we studying?";
				const options =
					inFolder !== undefined
						? [...labels, BACK]
						: [...folderLabels, ...labels, NEW, ...(registry.list().length ? [RENAME, ORGANIZE] : []), CHAT];
				const choice = await ctx.ui.select(title, options);
				if (!choice) return;
				if (choice === BACK) {
					inFolder = undefined;
					continue;
				}
				const folderIdx = folderLabels.indexOf(choice);
				if (folderIdx >= 0) {
					inFolder = groups[folderIdx];
					continue;
				}
				if (choice === ORGANIZE) {
					await organize();
					continue;
				}
				if (choice === RENAME) {
					await renameFromHome(registry.list().map((s) => s.name));
					continue;
				}
				if (choice === CHAT) {
					// Leave the subject for real: a fresh session with no subject tag.
					if (!activeSubject) return;
					g.__tutorFreeChat = true;
					await ctx.newSession({ withSession: async (c: any) => c.ui.notify("Free chat — no subject. Type /home anytime to pick one.", "info") });
					return;
				}
				if (choice === NEW) {
					if (await newSubject()) return;
					continue;
				}
				const picked = subjects[labels.indexOf(choice)];
				if (picked && (await openSubject(picked.name, false))) return;
			}
		},
	};
	pi.registerCommand("home", homeCommand);
	pi.registerCommand("subject", homeCommand);
}
