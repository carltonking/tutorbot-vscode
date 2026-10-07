import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Rating } from "ts-fsrs";
import { FSRS_VERSION, type MemoryState, ratingFor, retrievability, reviewMemory } from "./fsrs.ts";

// ────────────────────────────────────────────────────────────────────────────
// tutor-store — the learner's durable state, kept inside the vault so it is
// readable in Obsidian:
//
//   Tutor/Progress.md               generated dashboard (rewritten; don't edit)
//   Tutor/Learner Profile.md        how this learner learns (agent + learner edit)
//   Tutor/Courses/<Subject>.md      course style profile built from class files
//   Tutor/Weekly/<date>.md          weekly summaries
//   Tutor/.data/progress.json       concepts, schedule, answer log, signals
//   Tutor/.data/config.json         global class-resource folders
//
// Scheduling (Leitner boxes, per concept):
//   • An unassisted, non-guessed correct answer promotes one box.
//   • A correct answer that needed hints, or that the learner rated a guess,
//     does NOT promote: it is logged as assisted (the "crutch" pattern —
//     practice success that doesn't transfer).
//   • A miss / "I don't know" drops to box 0 (due now). A confident miss is
//     also flagged so review targets it first.
//   • "Mastered" requires a high box AND a passed no-help checkpoint.
// ────────────────────────────────────────────────────────────────────────────

export type ConceptStatus = "taught" | "known" | "learning" | "mastered";
export type QuizPurpose = "diagnostic" | "discovery" | "check" | "review" | "checkpoint";
export type QuizOutcome = "correct" | "incorrect" | "dontknow" | "disputed";
export type Confidence = 1 | 2 | 3; // guess · fairly sure · certain
export const APPROACHES = ["socratic", "worked-example", "direct", "analogy", "visual", "code-first", "practice-first"] as const;
export type Approach = (typeof APPROACHES)[number];
export type LessonRating = "clicked" | "fuzzy" | "too-fast" | "too-slow";

export interface Concept {
	id: string;
	subject: string;
	name: string;
	summary?: string;
	status: ConceptStatus;
	taughtAt?: string;
	box: number;
	due?: string;
	attempts: number;
	correct: number;
	lastSeen?: string;
	approach?: Approach; // how it was taught
	family?: string; // group of easily-confused concepts (for interleaving)
	verified?: boolean; // passed a no-help checkpoint
	assisted?: number; // correct answers that needed hints / were guesses
	confidentMisses?: number;
	fsrs?: MemoryState; // FSRS memory model (drives `due`)
	topic?: string; // course-map topic id (auto-tagged when taught)
}

// Course topic map for a subject: Tutor/Courses/<Subject> - Topics.json
export interface CourseTopic {
	id: string;
	title: string;
	unit?: string;
	order?: number;
	weight?: number;
}
export interface TopicMap {
	topics: CourseTopic[];
	source?: string;
	updatedAt?: string;
}
// Dashboard-owned confirmations: Tutor/.data/topic-links.json
export type TopicLinks = Record<string, { topic: string; confirmed?: boolean }>;
export type ProofLevel = "not-tested" | "not-yet" | "with-help" | "on-your-own" | "proven";
export const PROOF_LABEL: Record<ProofLevel, string> = {
	"not-tested": "Not tested",
	"not-yet": "Not yet correct",
	"with-help": "With help",
	"on-your-own": "On your own",
	proven: "Checkpoint-proven",
};
const MASTERED_STABILITY_DAYS = 21;

export interface QuizRecord {
	ts: string;
	subject: string;
	concepts: string[];
	question: string;
	purpose: QuizPurpose;
	kind: "choice" | "typed" | "exercise" | "explain";
	outcome: QuizOutcome;
	answer?: string;
	expected?: string;
	misconception?: string;
	note?: string;
	confidence?: Confidence;
	hintsUsed?: number;
	attempts?: number; // typed answers: tries before it was right (or the answer was shown)
	selfExplanation?: string; // explain-it-back text
	explainQuality?: "good" | "partial" | "missing";
	approach?: Approach; // approach the concept was taught with
}

export interface LessonFeedback {
	ts: string;
	subject: string;
	concepts: string[];
	approach?: Approach;
	rating: LessonRating;
}

export interface Signal {
	ts: string;
	subject?: string;
	kind: "frustration" | "asked-for-answer" | "stuck" | "escape-hatch";
	detail?: string;
}

// Whole local calendar days from today to a YYYY-MM-DD date (not UTC: at 9pm
// in New York, UTC is already tomorrow).
export function daysUntil(date: string, now = new Date()): number {
	const [y, m, d] = date.split("-").map(Number);
	const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
	return Math.round((new Date(y, (m || 1) - 1, d || 1).getTime() - today.getTime()) / 86_400_000);
}

export interface Assessment {
	id: string;
	subject: string;
	name: string;
	date: string; // YYYY-MM-DD
	kind?: string; // exam, quiz, homework, project…
	topics?: string;
	done?: boolean;
	result?: string;
}

export interface ProgressData {
	version: 1;
	concepts: Record<string, Concept>;
	quizLog: QuizRecord[];
	lessonFeedback?: LessonFeedback[];
	signals?: Signal[];
	assessments?: Assessment[];
	meta?: { lastWeekly?: string; fsrsVersion?: number };
}

export interface TutorConfig {
	resourceFolders: string[];
	nudges?: { enabled: boolean; time: string };
}

// Days until the next review for each Leitner box.
const BOX_INTERVAL_DAYS = [0, 1, 3, 7, 16, 35];
const MASTERED_BOX = 4;
const MAX_LOG = 3000;
const MAX_SIDE_LOG = 1000;
const GRADED: QuizPurpose[] = ["check", "review", "checkpoint"];

export function slug(text: string): string {
	return text
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

export function conceptId(subject: string, name: string): string {
	return `${slug(subject)}/${slug(name)}`;
}

const pct = (a: number, b: number) => (b ? Math.round((100 * a) / b) : 0);

export class TutorStore {
	readonly root: string;
	readonly dataDir: string;
	readonly progressPath: string;
	readonly configPath: string;
	readonly dashboardPath: string;
	readonly profilePath: string;
	readonly coursesDir: string;
	readonly weeklyDir: string;

	constructor(vaultRoot: string) {
		this.root = join(vaultRoot, "Tutor");
		this.dataDir = join(this.root, ".data");
		this.progressPath = join(this.dataDir, "progress.json");
		this.configPath = join(this.dataDir, "config.json");
		this.dashboardPath = join(this.root, "Progress.md");
		this.profilePath = join(this.root, "Learner Profile.md");
		this.coursesDir = join(this.root, "Courses");
		this.weeklyDir = join(this.root, "Weekly");
		mkdirSync(this.dataDir, { recursive: true });
		if (!existsSync(this.profilePath)) writeFileSync(this.profilePath, DEFAULT_PROFILE);
	}

	// ── persistence ──────────────────────────────────────────────────────────

	private readJson<T>(path: string, fallback: T): T {
		try {
			return JSON.parse(readFileSync(path, "utf8")) as T;
		} catch {
			return fallback;
		}
	}

	private writeAtomic(path: string, text: string): void {
		const tmp = `${path}.tmp`;
		writeFileSync(tmp, text);
		renameSync(tmp, path);
	}

	loadProgress(): ProgressData {
		const data = this.readJson<ProgressData>(this.progressPath, { version: 1, concepts: {}, quizLog: [] });
		if (data.meta?.fsrsVersion !== FSRS_VERSION) this.migrateToFsrs(data);
		return data;
	}

	// Rebuild every concept's FSRS memory state by replaying the answer log in
	// time order. Idempotent; runs once (meta.fsrsVersion), persisted on the next save.
	private migrateToFsrs(data: ProgressData): void {
		for (const c of Object.values(data.concepts)) delete c.fsrs;
		const log = [...data.quizLog].sort((a, b) => a.ts.localeCompare(b.ts));
		const lastMiss = new Map<string, string | undefined>();
		for (const r of log) {
			const rating = ratingFor(r);
			if (rating === undefined) continue;
			for (const name of r.concepts) {
				const c = this.findConcept(data, r.subject, name);
				if (!c) continue;
				c.fsrs = reviewMemory(c.fsrs, rating, new Date(r.ts));
				lastMiss.set(c.id, rating === Rating.Again ? r.ts : undefined);
			}
		}
		for (const c of Object.values(data.concepts)) {
			if (!c.fsrs) continue;
			c.due = lastMiss.get(c.id) ?? c.fsrs.due;
			c.status = c.verified && c.fsrs.stability >= MASTERED_STABILITY_DAYS ? "mastered" : c.status === "known" ? "known" : c.attempts > 0 ? "learning" : c.status;
		}
		data.meta = { ...(data.meta ?? {}), fsrsVersion: FSRS_VERSION };
	}

	// ── course topic maps & dashboard confirmations ──────────────────────────

	topicMapPath(subject: string): string {
		return join(this.coursesDir, `${subject.replace(/[/\\:]/g, "-").trim()} - Topics.json`);
	}

	readTopicMap(subject: string): TopicMap | undefined {
		return this.readJson<TopicMap | undefined>(this.topicMapPath(subject), undefined);
	}

	writeTopicMap(subject: string, map: TopicMap): string {
		mkdirSync(this.coursesDir, { recursive: true });
		const path = this.topicMapPath(subject);
		this.writeAtomic(path, JSON.stringify({ ...map, updatedAt: new Date().toISOString() }, null, 2));
		return path;
	}

	loadLinks(): TopicLinks {
		return this.readJson<TopicLinks>(join(this.dataDir, "topic-links.json"), {});
	}

	// The learner's confirmation (dashboard) wins over TutorBot's auto tag.
	// The learner's confirmation (dashboard) wins over TutorBot's auto tag. With
	// `onMap`, tags pointing at topics no longer on the course map don't count
	// (same rule as the dashboard).
	effectiveTopic(c: Concept, links: TopicLinks = this.loadLinks(), onMap?: Set<string>): { topic?: string; confirmed: boolean } {
		const ok = (t?: string) => Boolean(t) && (!onMap || onMap.has(t!));
		const l = links[c.id];
		if (l && ok(l.topic)) return { topic: l.topic, confirmed: Boolean(l.confirmed) };
		return { topic: ok(c.topic) ? c.topic : undefined, confirmed: false };
	}

	tagConcept(data: ProgressData, subject: string, name: string, topic: string): Concept | undefined {
		const c = this.findConcept(data, subject, name);
		if (c) c.topic = topic;
		return c;
	}

	memoryStrength(c: Concept, now = new Date()): number | undefined {
		return retrievability(c.fsrs, now);
	}

	// How strong the evidence is that they really know it.
	proofLevel(data: ProgressData, c: Concept): ProofLevel {
		if (c.verified) return "proven";
		const graded = this.answersFor(data, c).filter((r) => GRADED.includes(r.purpose) && r.outcome !== "disputed");
		if (!graded.length) return c.status === "known" ? "on-your-own" : "not-tested";
		const correct = graded.filter((r) => r.outcome === "correct");
		if (correct.some((r) => !(r.hintsUsed ?? 0) && r.confidence !== 1)) return "on-your-own";
		if (correct.length) return "with-help";
		return "not-yet";
	}

	saveProgress(data: ProgressData): void {
		if (data.quizLog.length > MAX_LOG) data.quizLog = data.quizLog.slice(-MAX_LOG);
		if (data.lessonFeedback && data.lessonFeedback.length > MAX_SIDE_LOG) data.lessonFeedback = data.lessonFeedback.slice(-MAX_SIDE_LOG);
		if (data.signals && data.signals.length > MAX_SIDE_LOG) data.signals = data.signals.slice(-MAX_SIDE_LOG);
		this.writeAtomic(this.progressPath, JSON.stringify(data, null, 1));
		this.writeAtomic(this.dashboardPath, this.renderDashboard(data));
	}

	loadConfig(): TutorConfig {
		return this.readJson<TutorConfig>(this.configPath, { resourceFolders: [] });
	}

	saveConfig(config: TutorConfig): void {
		this.writeAtomic(this.configPath, JSON.stringify(config, null, 2));
	}

	readProfile(): string {
		try {
			return readFileSync(this.profilePath, "utf8");
		} catch {
			return DEFAULT_PROFILE;
		}
	}

	writeProfile(text: string): void {
		this.writeAtomic(this.profilePath, text);
	}

	// ── course style profiles (built from the class folder) ─────────────────

	courseStylePath(subject: string): string {
		return join(this.coursesDir, `${subject.replace(/[/\\:]/g, "-").trim()} - Course Style.md`);
	}

	readCourseStyle(subject: string): string | undefined {
		try {
			return readFileSync(this.courseStylePath(subject), "utf8");
		} catch {
			return undefined;
		}
	}

	writeCourseStyle(subject: string, markdown: string): string {
		mkdirSync(this.coursesDir, { recursive: true });
		const path = this.courseStylePath(subject);
		this.writeAtomic(path, markdown);
		return path;
	}

	// ── concepts ─────────────────────────────────────────────────────────────

	// Exact id match first, then a lenient containment match within the same
	// subject ("integer division" ↔ "integer-division-in-java"), so small naming
	// drift between mark_taught and quiz doesn't block a legitimate question.
	// One answer belongs to exactly one concept: the exact name, else the
	// closest loose match ("limits" never borrows "limits at infinity"'s answers
	// when "limits" exists). The dashboard uses the same rule.
	findConcept(data: ProgressData, subject: string, name: string): Concept | undefined {
		const id = conceptId(subject, name);
		if (data.concepts[id]) return data.concepts[id];
		const s = slug(name);
		if (s.length < 4) return undefined;
		const subj = slug(subject);
		let best: Concept | undefined;
		let bestGap = Infinity;
		for (const c of Object.values(data.concepts)) {
			if (slug(c.subject) !== subj) continue;
			const cs = slug(c.name);
			if (cs === s) return c;
			if (cs.length < 4 || !(cs.includes(s) || s.includes(cs))) continue;
			const gap = Math.abs(cs.length - s.length);
			if (gap < bestGap) [best, bestGap] = [c, gap];
		}
		return best;
	}

	// Every logged answer resolved to its concept(s) once, then cached until the
	// log or the concept list changes (resolving per concept × record was
	// quadratic and froze saves on long logs).
	private attribution = new WeakMap<ProgressData, { key: string; byConcept: Map<string, QuizRecord[]> }>();

	answersFor(data: ProgressData, c: Concept): QuizRecord[] {
		const key = `${data.quizLog.length}:${Object.keys(data.concepts).length}:${data.quizLog[data.quizLog.length - 1]?.ts ?? ""}`;
		let hit = this.attribution.get(data);
		if (!hit || hit.key !== key) {
			const byConcept = new Map<string, QuizRecord[]>();
			const resolved = new Map<string, string | undefined>();
			for (const r of data.quizLog) {
				const ids = new Set<string>();
				for (const n of r.concepts) {
					const k = `${slug(r.subject)}/${slug(n)}`;
					if (!resolved.has(k)) resolved.set(k, this.findConcept(data, r.subject, n)?.id);
					const id = resolved.get(k);
					if (id) ids.add(id);
				}
				for (const id of ids) {
					if (!byConcept.has(id)) byConcept.set(id, []);
					byConcept.get(id)!.push(r);
				}
			}
			hit = { key, byConcept };
			this.attribution.set(data, hit);
		}
		return hit.byConcept.get(c.id) ?? [];
	}

	conceptsForSubject(data: ProgressData, subject: string): Concept[] {
		const subj = slug(subject);
		return Object.values(data.concepts).filter((c) => slug(c.subject) === subj);
	}

	// Move a subject's concepts and history to a new name (ids include the
	// subject, so concepts are re-keyed). Returns how many concepts moved.
	renameSubject(from: string, to: string): number {
		const data = this.loadProgress();
		const f = slug(from);
		let moved = 0;
		const concepts: Record<string, Concept> = {};
		const newIds: Record<string, string> = {};
		for (const [id, c] of Object.entries(data.concepts)) {
			if (slug(c.subject) !== f) {
				concepts[id] = c;
				continue;
			}
			c.subject = to;
			c.id = conceptId(to, c.name);
			newIds[id] = c.id;
			concepts[c.id] = c;
			moved++;
		}
		data.concepts = concepts;
		for (const q of data.quizLog) if (slug(q.subject) === f) q.subject = to;
		for (const x of data.lessonFeedback ?? []) if (slug(x.subject) === f) x.subject = to;
		for (const x of data.signals ?? []) if (x.subject && slug(x.subject) === f) x.subject = to;
		for (const x of data.assessments ?? []) if (slug(x.subject) === f) x.subject = to;
		this.saveProgress(data);
		// Confirmed topic links are keyed by concept id: re-key them.
		const links = this.loadLinks();
		let relinked = false;
		for (const [oldId, newId] of Object.entries(newIds)) {
			if (oldId === newId || !links[oldId]) continue;
			links[newId] = links[oldId];
			delete links[oldId];
			relinked = true;
		}
		if (relinked) this.writeAtomic(join(this.dataDir, "topic-links.json"), JSON.stringify(links, null, 2));
		// The course map and style profile are named after the subject.
		for (const path of [(s: string) => this.topicMapPath(s), (s: string) => this.courseStylePath(s)]) {
			const a = path(from);
			const b = path(to);
			if (a !== b && existsSync(a) && !existsSync(b)) renameSync(a, b);
		}
		return moved;
	}

	// Forget a subject's progress: its concepts, quiz history, feedback, signals
	// and exams. Returns how many concepts were removed.
	deleteSubject(subject: string): number {
		const data = this.loadProgress();
		const f = slug(subject);
		const removed: string[] = [];
		for (const [id, c] of Object.entries(data.concepts)) {
			if (slug(c.subject) !== f) continue;
			delete data.concepts[id];
			removed.push(id);
		}
		data.quizLog = data.quizLog.filter((q) => slug(q.subject) !== f);
		if (data.lessonFeedback) data.lessonFeedback = data.lessonFeedback.filter((x) => slug(x.subject) !== f);
		if (data.signals) data.signals = data.signals.filter((x) => !x.subject || slug(x.subject) !== f);
		if (data.assessments) data.assessments = data.assessments.filter((x) => slug(x.subject) !== f);
		this.saveProgress(data);
		const links = this.loadLinks();
		if (removed.some((id) => links[id])) {
			for (const id of removed) delete links[id];
			this.writeAtomic(join(this.dataDir, "topic-links.json"), JSON.stringify(links, null, 2));
		}
		return removed.length;
	}

	markTaught(subject: string, items: { name: string; summary?: string; family?: string; topic?: string }[], approach?: Approach): Concept[] {
		const data = this.loadProgress();
		const now = new Date().toISOString();
		const out: Concept[] = [];
		for (const item of items) {
			const existing = this.findConcept(data, subject, item.name);
			const c: Concept = existing ?? {
				id: conceptId(subject, item.name),
				subject,
				name: item.name,
				status: "taught",
				box: 0,
				attempts: 0,
				correct: 0,
			};
			if (item.summary) c.summary = item.summary;
			if (item.family) c.family = item.family.trim();
			if (item.topic) c.topic = item.topic.trim();
			if (approach) c.approach = approach;
			c.taughtAt ??= now;
			c.due ??= now; // freshly taught → a quiz-check is due right away
			data.concepts[c.id] = c;
			out.push(c);
		}
		this.saveProgress(data);
		return out;
	}

	recordQuiz(record: QuizRecord): void {
		const data = this.loadProgress();
		if (!record.approach) {
			for (const n of record.concepts) {
				const a = this.findConcept(data, record.subject, n)?.approach;
				if (a) {
					record.approach = a;
					break;
				}
			}
		}
		data.quizLog.push(record);
		this.applySchedule(data, record);
		this.saveProgress(data);
	}

	// Grade the learner's most recent explain-it-back (judged by the tutor).
	rateLatestExplanation(subject: string | undefined, quality: NonNullable<QuizRecord["explainQuality"]>): QuizRecord | undefined {
		const data = this.loadProgress();
		const rec = [...data.quizLog].reverse().find((r) => r.selfExplanation && (!subject || slug(r.subject) === slug(subject)));
		if (!rec) return undefined;
		rec.explainQuality = quality;
		this.saveProgress(data);
		return rec;
	}

	// Settle the most recent disputed typed answer (the learner pressed "d").
	resolveDispute(verdict: "correct" | "incorrect"): QuizRecord | undefined {
		const data = this.loadProgress();
		const rec = [...data.quizLog].reverse().find((r) => r.outcome === "disputed");
		if (!rec) return undefined;
		rec.outcome = verdict;
		this.applySchedule(data, rec);
		this.saveProgress(data);
		return rec;
	}

	private applySchedule(data: ProgressData, record: QuizRecord): void {
		const now = new Date();
		for (const name of record.concepts) {
			let c = this.findConcept(data, record.subject, name);
			if (record.purpose === "discovery") continue; // mid-discovery attempt: logged only
			if (record.purpose === "diagnostic") {
				// Pre-teaching probe: a correct, confident answer means they already
				// hold it. A miss is just a mapped gap.
				if (record.outcome === "correct" && !c && record.confidence !== 1) {
					c = {
						id: conceptId(record.subject, name),
						subject: record.subject,
						name,
						status: "known",
						box: 1,
						attempts: 0,
						correct: 0,
						due: addDays(now, BOX_INTERVAL_DAYS[1]),
					};
					data.concepts[c.id] = c;
				}
				if (c) {
					c.attempts++;
					if (record.outcome === "correct") c.correct++;
					c.lastSeen = record.ts;
					const r = ratingFor(record);
					if (r !== undefined) {
						c.fsrs = reviewMemory(c.fsrs, r, new Date(record.ts));
						c.due = c.fsrs.due;
					}
				}
				continue;
			}
			if (!c) continue;
			if (record.outcome === "disputed") continue; // adjudicated later
			c.attempts++;
			c.lastSeen = record.ts;
			const checkpoint = record.purpose === "checkpoint";
			if (record.outcome === "correct") {
				c.correct++;
				const assisted = !checkpoint && ((record.hintsUsed ?? 0) > 0 || record.confidence === 1);
				if (assisted) {
					// Practice success that needed help doesn't move the schedule on.
					c.assisted = (c.assisted ?? 0) + 1;
					c.due = addDays(now, Math.max(1, BOX_INTERVAL_DAYS[c.box]));
				} else {
					c.box = Math.min(BOX_INTERVAL_DAYS.length - 1, c.box + 1);
					c.due = addDays(now, BOX_INTERVAL_DAYS[c.box]);
				}
				if (checkpoint) c.verified = true;
			} else {
				c.box = 0;
				c.due = now.toISOString();
				if (record.confidence === 3) c.confidentMisses = (c.confidentMisses ?? 0) + 1;
				if (checkpoint) c.verified = false;
			}
			// FSRS owns the review schedule (the Leitner box above is kept for
			// stuck detection and practice-set ordering).
			const rating = ratingFor(record);
			if (rating !== undefined) {
				c.fsrs = reviewMemory(c.fsrs, rating, new Date(record.ts));
				// A miss is re-checked now (front of review); FSRS still learns from it.
				c.due = rating === Rating.Again ? record.ts : c.fsrs.due;
			}
			c.status = c.verified && (c.fsrs?.stability ?? 0) >= MASTERED_STABILITY_DAYS ? "mastered" : "learning";
		}
	}

	addLessonFeedback(fb: Omit<LessonFeedback, "ts" | "approach"> & { approach?: Approach }): LessonFeedback {
		const data = this.loadProgress();
		const entry: LessonFeedback = { ts: new Date().toISOString(), ...fb };
		if (!entry.approach) {
			for (const n of fb.concepts) {
				const a = this.findConcept(data, fb.subject, n)?.approach;
				if (a) {
					entry.approach = a;
					break;
				}
			}
		}
		(data.lessonFeedback ??= []).push(entry);
		this.saveProgress(data);
		return entry;
	}

	addSignal(sig: Omit<Signal, "ts">): void {
		const data = this.loadProgress();
		(data.signals ??= []).push({ ts: new Date().toISOString(), ...sig });
		this.saveProgress(data);
	}

	// ── assessments ──────────────────────────────────────────────────────────

	addAssessment(a: Omit<Assessment, "id">): Assessment {
		const data = this.loadProgress();
		const entry: Assessment = { id: `${slug(a.subject)}-${slug(a.name)}-${a.date}`, ...a };
		data.assessments = (data.assessments ?? []).filter((x) => x.id !== entry.id);
		data.assessments.push(entry);
		data.assessments.sort((x, y) => x.date.localeCompare(y.date));
		this.saveProgress(data);
		return entry;
	}

	updateAssessment(id: string, patch: Partial<Assessment>): Assessment | undefined {
		const data = this.loadProgress();
		const a = (data.assessments ?? []).find((x) => x.id === id || slug(x.name) === slug(id));
		if (!a) return undefined;
		Object.assign(a, patch);
		this.saveProgress(data);
		return a;
	}

	upcomingAssessments(data: ProgressData, withinDays = 30, subject?: string): (Assessment & { daysLeft: number })[] {
		return (data.assessments ?? [])
			.filter((a) => !a.done && (!subject || slug(a.subject) === slug(subject)))
			.map((a) => ({ ...a, daysLeft: daysUntil(a.date) }))
			.filter((a) => a.daysLeft >= 0 && a.daysLeft <= withinDays);
	}

	// Past assessments the learner hasn't reported on yet.
	pastUnreported(data: ProgressData): Assessment[] {
		return (data.assessments ?? []).filter((a) => !a.done && daysUntil(a.date) < 0);
	}

	// ── practice-set builders ────────────────────────────────────────────────

	// Interleaved practice: mix easily-confused concepts (same family) so the
	// learner must first identify which technique applies. Never the same
	// concept twice in a row; most fragile first.
	interleavedSet(data: ProgressData, subject: string, n = 6, family?: string): Concept[] {
		let pool = this.conceptsForSubject(data, subject).filter((c) => c.status !== "known" || c.attempts > 0);
		if (family) pool = pool.filter((c) => c.family && slug(c.family) === slug(family));
		if (!pool.length) return [];
		const now = Date.now();
		const score = (c: Concept) => (c.due && Date.parse(c.due) <= now ? 0 : 10) + c.box * 2 + (c.verified ? 3 : 0) - (c.confidentMisses ?? 0) * 2;
		// Prefer families with ≥2 members (that's where discrimination is learned).
		const byFamily = new Map<string, Concept[]>();
		for (const c of pool) {
			const k = c.family ? slug(c.family) : `solo:${c.id}`;
			byFamily.set(k, [...(byFamily.get(k) ?? []), c]);
		}
		const groups = [...byFamily.values()].sort((a, b) => b.length - a.length || Math.min(...a.map(score)) - Math.min(...b.map(score)));
		const chosen: Concept[] = [];
		for (const g of groups) {
			for (const c of [...g].sort((a, b) => score(a) - score(b))) {
				if (chosen.length >= n) break;
				chosen.push(c);
			}
			if (chosen.length >= n) break;
		}
		// Round-robin order across concepts: A B C A B …, never the same twice in a row.
		const out: Concept[] = [];
		const queue = [...chosen];
		while (out.length < n && queue.length) {
			const next = queue.find((c) => c.id !== out[out.length - 1]?.id) ?? queue[0];
			out.push(next);
			queue.splice(queue.indexOf(next), 1);
			if (chosen.length > 1 && queue.length === 0 && out.length < n) queue.push(...chosen.filter((c) => c.id !== out[out.length - 1].id));
		}
		return out;
	}

	// No-help checkpoint: practised concepts not yet verified (or due), cumulative.
	checkpointSet(data: ProgressData, subject: string, n = 6): Concept[] {
		const pool = this.conceptsForSubject(data, subject).filter((c) => c.attempts > 0 || c.status === "taught");
		const now = Date.now();
		const rank = (c: Concept) => (c.verified ? 20 : 0) + (c.due && Date.parse(c.due) <= now ? 0 : 5) + c.box - (c.assisted ?? 0);
		const picked = [...pool].sort((a, b) => rank(a) - rank(b)).slice(0, n);
		// Interleave by family so similar concepts don't sit together.
		const fam = (c: Concept) => c.family ?? c.id;
		const out: Concept[] = [];
		const rest = [...picked];
		while (rest.length) {
			const i = rest.findIndex((c) => !out.length || fam(c) !== fam(out[out.length - 1]));
			out.push(...rest.splice(i < 0 ? 0 : i, 1));
		}
		return out;
	}

	// ── stuck detection (for the Socratic escape hatch) ─────────────────────

	stuckState(data: ProgressData, subject?: string): { concept: string; misses: number; hintsUsed: number } | undefined {
		const cutoff = Date.now() - 3 * 3600_000;
		const recent = data.quizLog.filter((r) => Date.parse(r.ts) > cutoff && (!subject || slug(r.subject) === slug(subject)) && r.purpose !== "diagnostic" && r.kind !== "explain");
		if (recent.length < 2) return undefined;
		const last = recent[recent.length - 1];
		if (last.outcome === "correct") return undefined;
		for (const concept of last.concepts) {
			let misses = 0;
			let hints = 0;
			for (let i = recent.length - 1; i >= 0; i--) {
				const r = recent[i];
				if (!r.concepts.some((c) => slug(c) === slug(concept))) continue;
				if (r.outcome === "correct") break;
				misses++;
				hints += r.hintsUsed ?? 0;
			}
			if (misses >= 2) return { concept, misses, hintsUsed: hints };
		}
		return undefined;
	}

	recentSignals(data: ProgressData, withinMinutes = 30): Signal[] {
		const cutoff = Date.now() - withinMinutes * 60_000;
		return (data.signals ?? []).filter((s) => Date.parse(s.ts) > cutoff);
	}

	// ── the measured learner model ───────────────────────────────────────────

	learnerModel(data: ProgressData, subject?: string): LearnerModel {
		const inSubj = (s: string) => !subject || slug(s) === slug(subject);
		const graded = data.quizLog.filter((r) => inSubj(r.subject) && GRADED.includes(r.purpose) && r.outcome !== "disputed");
		const ok = (r: QuizRecord) => r.outcome === "correct";

		// Teaching approach effectiveness: first check after teaching, later
		// retention (review/checkpoint), and the learner's own lesson ratings.
		const approaches: ApproachStat[] = [];
		const concepts = Object.values(data.concepts).filter((c) => inSubj(c.subject));
		for (const a of APPROACHES) {
			const taught = concepts.filter((c) => c.approach === a);
			const firstChecks: boolean[] = [];
			for (const c of taught) {
				const first = this.answersFor(data, c).find((r) => r.purpose === "check");
				if (first && first.outcome !== "disputed") firstChecks.push(ok(first) && !(first.hintsUsed ?? 0));
			}
			const later = graded.filter((r) => r.approach === a && r.purpose !== "check");
			const fb = (data.lessonFeedback ?? []).filter((f) => f.approach === a && inSubj(f.subject));
			if (!taught.length && !fb.length) continue;
			approaches.push({
				approach: a,
				concepts: taught.length,
				firstCheckN: firstChecks.length,
				firstCheckPct: pct(firstChecks.filter(Boolean).length, firstChecks.length),
				retentionN: later.length,
				retentionPct: pct(later.filter(ok).length, later.length),
				clicked: fb.filter((f) => f.rating === "clicked").length,
				fuzzy: fb.filter((f) => f.rating === "fuzzy").length,
				tooFast: fb.filter((f) => f.rating === "too-fast").length,
				tooSlow: fb.filter((f) => f.rating === "too-slow").length,
			});
		}
		approaches.sort((x, y) => scoreApproach(y) - scoreApproach(x));

		// Confidence calibration.
		const calibration = ([1, 2, 3] as Confidence[]).map((lvl) => {
			const rs = graded.filter((r) => r.confidence === lvl);
			return { level: lvl, n: rs.length, pct: pct(rs.filter(ok).length, rs.length) };
		});

		// Help reliance: assisted vs unassisted, practice vs checkpoint.
		const practice = graded.filter((r) => r.purpose !== "checkpoint");
		const withHints = practice.filter((r) => (r.hintsUsed ?? 0) > 0);
		const checkpoints = graded.filter((r) => r.purpose === "checkpoint");

		// Explain-it-back quality.
		const explained = data.quizLog.filter((r) => inSubj(r.subject) && r.selfExplanation);

		// Time of day.
		const buckets: Record<string, QuizRecord[]> = { morning: [], afternoon: [], evening: [], night: [] };
		for (const r of graded) {
			const h = new Date(r.ts).getHours();
			buckets[h >= 5 && h < 12 ? "morning" : h < 17 && h >= 12 ? "afternoon" : h >= 17 && h < 22 ? "evening" : "night"].push(r);
		}
		const timeOfDay = Object.entries(buckets)
			.filter(([, rs]) => rs.length >= 5)
			.map(([k, rs]) => ({ when: k, n: rs.length, pct: pct(rs.filter(ok).length, rs.length) }));

		const fb = (data.lessonFeedback ?? []).filter((f) => inSubj(f.subject));
		const recent = graded.slice(-30);
		return {
			answers: graded.length,
			approaches,
			calibration,
			practiceN: practice.length,
			practicePct: pct(practice.filter(ok).length, practice.length),
			hintedN: withHints.length,
			hintedPct: pct(withHints.filter(ok).length, withHints.length),
			unhintedPct: pct(practice.filter((r) => !(r.hintsUsed ?? 0) && ok(r)).length, practice.filter((r) => !(r.hintsUsed ?? 0)).length),
			checkpointN: checkpoints.length,
			checkpointPct: pct(checkpoints.filter(ok).length, checkpoints.length),
			explainedN: explained.length,
			explainGood: explained.filter((r) => r.explainQuality === "good").length,
			explainPartial: explained.filter((r) => r.explainQuality === "partial").length,
			dontKnowPct: pct(recent.filter((r) => r.outcome === "dontknow").length, recent.length),
			tooFast: fb.filter((f) => f.rating === "too-fast").length,
			tooSlow: fb.filter((f) => f.rating === "too-slow").length,
			timeOfDay,
		};
	}

	// Compact, actionable version for the system prompt.
	learnerModelText(data: ProgressData, subject?: string): string {
		const m = this.learnerModel(data, subject);
		const lines: string[] = [];
		const evidenced = m.approaches.filter((a) => a.firstCheckN + a.retentionN + a.clicked + a.fuzzy >= 3);
		if (evidenced.length) {
			lines.push("Teaching approaches, best first (first-check accuracy without hints; later retention; learner ratings):");
			for (const a of evidenced.slice(0, 5)) {
				lines.push(`  - ${a.approach}: first check ${a.firstCheckPct}% (n=${a.firstCheckN}), retention ${a.retentionPct}% (n=${a.retentionN}), rated clicked ${a.clicked} / fuzzy ${a.fuzzy}${a.tooFast ? ` / too fast ${a.tooFast}` : ""}${a.tooSlow ? ` / too slow ${a.tooSlow}` : ""}`);
			}
			lines.push("  → Prefer the top approach for new concepts, but still try another approach about one time in four so the comparison stays honest.");
		} else {
			lines.push("Teaching approaches: not enough data yet. Vary deliberately (worked-example, socratic, direct, analogy, visual, code-first) and pass `approach` to mark_taught so the tutor can learn what works for this learner.");
		}
		const cal = m.calibration.filter((c) => c.n >= 4);
		if (cal.length) {
			lines.push(`Confidence calibration: ${cal.map((c) => `${["", "guess", "fairly sure", "certain"][c.level]} ${c.pct}% right (n=${c.n})`).join(", ")}.`);
			const certain = m.calibration[2];
			const guess = m.calibration[0];
			if (certain.n >= 4 && certain.pct < 75) lines.push("  → Overconfident: 'certain' answers are often wrong. Probe those concepts deeper and ask them to explain why before moving on.");
			if (guess.n >= 4 && guess.pct > 70) lines.push("  → Underconfident: 'guesses' are usually right. Point this out; build confidence.");
		}
		if (m.hintedN >= 4) lines.push(`Hints: used on ${pct(m.hintedN, m.practiceN)}% of practice answers.`);
		if (m.checkpointN >= 3 && m.practiceN >= 5 && m.practicePct - m.checkpointPct >= 20)
			lines.push(`  → Crutch warning: practice ${m.practicePct}% vs no-help checkpoints ${m.checkpointPct}%. Fade hints faster and run more checkpoints.`);
		if (m.dontKnowPct >= 30) lines.push(`"I don't know" on ${m.dontKnowPct}% of recent answers — slow down, re-teach foundations.`);
		if (m.tooFast > m.tooSlow + 1) lines.push(`Pace: rated "too fast" ${m.tooFast}× — slow down, smaller steps.`);
		if (m.tooSlow > m.tooFast + 1) lines.push(`Pace: rated "too slow" ${m.tooSlow}× — move faster, skip what they've shown they know.`);
		const tod = m.timeOfDay.sort((a, b) => b.pct - a.pct);
		if (tod.length >= 2 && tod[0].pct - tod[tod.length - 1].pct >= 15) lines.push(`Best time of day: ${tod[0].when} (${tod[0].pct}%) vs ${tod[tod.length - 1].when} (${tod[tod.length - 1].pct}%).`);
		return lines.join("\n");
	}

	// ── summaries for the system prompt ──────────────────────────────────────

	dueConcepts(data: ProgressData, subject?: string): Concept[] {
		const now = Date.now();
		return Object.values(data.concepts)
			.filter((c) => (!subject || slug(c.subject) === slug(subject)) && c.attempts > 0 && c.due && Date.parse(c.due) <= now)
			.sort((a, b) => (b.confidentMisses ?? 0) - (a.confidentMisses ?? 0) || a.box - b.box || Date.parse(a.due!) - Date.parse(b.due!));
	}

	untestedConcepts(data: ProgressData): Concept[] {
		return Object.values(data.concepts).filter((c) => c.status === "taught" && c.attempts === 0);
	}

	summary(data: ProgressData): string {
		const concepts = Object.values(data.concepts);
		if (!concepts.length && !data.quizLog.length) return "No progress recorded yet.";
		const lines: string[] = [];
		const subjects = [...new Set(concepts.map((c) => c.subject))];
		for (const s of subjects) {
			const cs = concepts.filter((c) => c.subject === s);
			const count = (st: ConceptStatus) => cs.filter((c) => c.status === st).length;
			const recent = data.quizLog.filter((r) => r.subject === s && GRADED.includes(r.purpose)).slice(-20);
			const acc = recent.length ? pct(recent.filter((r) => r.outcome === "correct").length, recent.length) : undefined;
			const unverified = cs.filter((c) => c.box >= MASTERED_BOX && !c.verified).length;
			lines.push(
				`- ${s}: ${cs.length} concepts (${count("mastered")} mastered, ${count("learning")} learning, ${count("taught")} taught-untested, ${count("known")} known${unverified ? `, ${unverified} awaiting a no-help checkpoint` : ""})` +
					(acc !== undefined ? `; last ${recent.length} answers ${acc}% correct` : ""),
			);
		}
		const due = this.dueConcepts(data);
		if (due.length) {
			lines.push(`Due for review now (${due.length}): ${due.slice(0, 12).map((c) => `${c.subject} › ${c.name}${c.confidentMisses ? " [confidently missed]" : ""}`).join("; ")}`);
		}
		const untested = this.untestedConcepts(data);
		if (untested.length) {
			lines.push(`Taught but never quiz-checked: ${untested.slice(0, 12).map((c) => `${c.subject} › ${c.name}`).join("; ")}`);
		}
		const misses = data.quizLog.filter((r) => r.outcome === "incorrect" && r.misconception).slice(-6);
		if (misses.length) {
			lines.push("Recent misconceptions revealed by wrong picks (target these with a contrasting example or an interleaved item):");
			for (const r of misses) lines.push(`  - [${r.subject} › ${r.concepts.join(", ")}] ${r.misconception}`);
		}
		return lines.join("\n");
	}

	// Compact list of concept names for one subject, so the model reuses exact names.
	conceptIndex(data: ProgressData, subject: string): string {
		const cs = this.conceptsForSubject(data, subject);
		return cs.length ? cs.map((c) => `${c.name} [${c.status}${c.family ? `; ${c.family}` : ""}]`).join("; ") : "(none yet)";
	}

	// ── weekly summary ───────────────────────────────────────────────────────

	weeklySummary(data: ProgressData, days = 7): string {
		const since = Date.now() - days * 86_400_000;
		const log = data.quizLog.filter((r) => Date.parse(r.ts) >= since);
		const graded = log.filter((r) => GRADED.includes(r.purpose));
		const subjects = [...new Set(log.map((r) => r.subject))];
		const taught = Object.values(data.concepts).filter((c) => c.taughtAt && Date.parse(c.taughtAt) >= since);
		const activeDays = new Set(log.map((r) => r.ts.slice(0, 10))).size;
		const out = [`# Week ending ${new Date().toISOString().slice(0, 10)}`, ""];
		out.push(`- Study days: **${activeDays}** of ${days}`);
		out.push(`- Answers: **${graded.length}**, ${pct(graded.filter((r) => r.outcome === "correct").length, graded.length)}% correct`);
		out.push(`- New concepts taught: **${taught.length}**${taught.length ? ` (${taught.slice(0, 8).map((c) => c.name).join(", ")})` : ""}`);
		const cps = graded.filter((r) => r.purpose === "checkpoint");
		if (cps.length) out.push(`- No-help checkpoints: ${cps.length} questions, ${pct(cps.filter((r) => r.outcome === "correct").length, cps.length)}% correct`);
		for (const s of subjects) {
			const g = graded.filter((r) => r.subject === s);
			out.push(`  - ${s}: ${g.length} answers, ${pct(g.filter((r) => r.outcome === "correct").length, g.length)}% correct`);
		}
		const due = this.dueConcepts(data);
		out.push(`- Due for review now: **${due.length}**`);
		const up = this.upcomingAssessments(data, 21);
		if (up.length) {
			out.push("", "## Coming up");
			for (const a of up) out.push(`- ${a.subject}: ${a.name} on ${a.date} (${a.daysLeft} day${a.daysLeft === 1 ? "" : "s"})`);
		}
		const weak = Object.values(data.concepts)
			.filter((c) => c.confidentMisses || (c.attempts >= 2 && c.correct / c.attempts < 0.6))
			.slice(0, 8);
		if (weak.length) {
			out.push("", "## Needs work");
			for (const c of weak) out.push(`- ${c.subject} › ${c.name} (${c.correct}/${c.attempts}${c.confidentMisses ? `, ${c.confidentMisses} confident miss${c.confidentMisses > 1 ? "es" : ""}` : ""})`);
		}
		out.push("", "Remember: TutorBot practice is not the real course. Do the assigned homework and past exams too.", "");
		return out.join("\n");
	}

	writeWeekly(markdown: string): string {
		mkdirSync(this.weeklyDir, { recursive: true });
		const path = join(this.weeklyDir, `${new Date().toISOString().slice(0, 10)}.md`);
		this.writeAtomic(path, markdown);
		return path;
	}

	// ── dashboard ────────────────────────────────────────────────────────────

	renderDashboard(data: ProgressData): string {
		const out: string[] = [
			"# Learning Progress",
			"",
			`_Generated by TutorBot on ${new Date().toISOString().slice(0, 16).replace("T", " ")}. Don't edit; it is rewritten after every answer._`,
			"",
		];
		const concepts = Object.values(data.concepts);
		const due = this.dueConcepts(data);
		out.push(`**Due for review:** ${due.length ? due.map((c) => `${c.subject} › ${c.name}`).join(", ") : "nothing, you're caught up"}`, "");
		const up = this.upcomingAssessments(data, 30);
		if (up.length) out.push(`**Coming up:** ${up.map((a) => `${a.subject} ${a.name} (${a.date}, ${a.daysLeft}d)`).join(" · ")}`, "");

		const subjects = [...new Set(concepts.map((c) => c.subject))].sort();
		const links = this.loadLinks();
		const now = new Date();
		const cell = (t: string) => t.replace(/\|/g, "\\|");
		for (const s of subjects) {
			out.push(`## ${s}`, "");
			const cs = concepts.filter((c) => c.subject === s).sort((a, b) => (a.taughtAt ?? "").localeCompare(b.taughtAt ?? ""));
			const map = this.readTopicMap(s);
			if (map?.topics.length) {
				// Studied = something in the topic has been taught (same rule as the dashboard).
				const onMap = new Set(map.topics.map((t) => t.id));
				const touched = new Set(cs.map((c) => this.effectiveTopic(c, links, onMap).topic).filter(Boolean));
				const proven = map.topics.filter((t) => {
					const tc = cs.filter((c) => this.effectiveTopic(c, links, onMap).topic === t.id);
					return tc.length > 0 && tc.every((c) => c.verified);
				}).length;
				out.push(`Course topics studied: **${touched.size} of ${map.topics.length}** · checkpoint-proven: **${proven}**`, "");
			}
			out.push("| Concept | Memory today | Proof | Next review |", "|---|---|---|---|");
			for (const c of cs) {
				const mine = this.answersFor(data, c);
				const graded = mine.filter((r) => GRADED.includes(r.purpose) && r.outcome !== "disputed").length;
				// Right after a miss FSRS says ~100% ("just reviewed"); say what happened instead.
				const lastRated = [...mine].reverse().find((r) => ratingFor(r) !== undefined);
				const r = this.memoryStrength(c, now);
				const mem =
					lastRated && lastRated.outcome !== "correct" ? "missed last time" : graded < 2 && !c.verified ? "not enough evidence" : r === undefined ? "—" : `${Math.round(r * 100)}%`;
				out.push(`| ${cell(c.name)}${c.family ? ` _(${cell(c.family)})_` : ""} | ${mem} | ${PROOF_LABEL[this.proofLevel(data, c)]} | ${fmtDate(c.due)} |`);
			}
			out.push("");
		}

		const m = this.learnerModel(data);
		if (m.answers) {
			out.push("## How you learn (measured)", "");
			if (m.approaches.length) {
				out.push("| Teaching approach | Concepts | First check (no hints) | Later retention | Your ratings |", "|---|---|---|---|---|");
				for (const a of m.approaches)
					out.push(`| ${a.approach} | ${a.concepts} | ${a.firstCheckN ? `${a.firstCheckPct}% of ${a.firstCheckN}` : "—"} | ${a.retentionN ? `${a.retentionPct}% of ${a.retentionN}` : "—"} | ${[a.clicked && `clicked ${a.clicked}`, a.fuzzy && `fuzzy ${a.fuzzy}`, a.tooFast && `too fast ${a.tooFast}`, a.tooSlow && `too slow ${a.tooSlow}`].filter(Boolean).join(", ") || "—"} |`);
				out.push("");
			}
			const cal = m.calibration.filter((c) => c.n);
			if (cal.length) {
				out.push("**Confidence vs. accuracy**", "", "| You said | Answers | Actually right |", "|---|---|---|");
				for (const c of cal) out.push(`| ${["", "Guess", "Fairly sure", "Certain"][c.level]} | ${c.n} | ${c.pct}% |`);
				out.push("");
			}
			out.push(`- Practice accuracy ${m.practicePct}% · with hints ${m.hintedN ? `${m.hintedPct}%` : "—"} · no-help checkpoints ${m.checkpointN ? `${m.checkpointPct}% of ${m.checkpointN}` : "none yet"}`);
			if (m.explainedN) out.push(`- Explained in your own words: ${m.explainedN} times (${m.explainGood} solid, ${m.explainPartial} partial)`);
			if (m.timeOfDay.length) out.push(`- By time of day: ${m.timeOfDay.map((t) => `${t.when} ${t.pct}% (${t.n})`).join(", ")}`);
			out.push("");
		}

		const misses = data.quizLog.filter((r) => r.outcome === "incorrect").slice(-15).reverse();
		if (misses.length) {
			out.push("## Recent misses", "");
			for (const r of misses) {
				const q = r.question.split("\n")[0].slice(0, 120);
				out.push(`- **${r.subject}** (${fmtDate(r.ts)}): ${q}`);
				out.push(`  - You answered: ${r.answer ?? "—"} · Correct: ${r.expected ?? "—"}${r.confidence === 3 ? " · you were certain" : ""}`);
				if (r.misconception) out.push(`  - Misconception: ${r.misconception}`);
				if (r.selfExplanation) out.push(`  - Your explanation: ${r.selfExplanation.slice(0, 200)}`);
			}
			out.push("");
		}
		out.push("Memory today = estimated chance you'd recall it now (FSRS). Proof: Not tested → Not yet correct → With help → On your own → Checkpoint-proven. The full interactive view is TutorBot: Open Progress in VS Code.", "");
		return out.join("\n");
	}
}

export interface ApproachStat {
	approach: Approach;
	concepts: number;
	firstCheckN: number;
	firstCheckPct: number;
	retentionN: number;
	retentionPct: number;
	clicked: number;
	fuzzy: number;
	tooFast: number;
	tooSlow: number;
}

export interface LearnerModel {
	answers: number;
	approaches: ApproachStat[];
	calibration: { level: Confidence; n: number; pct: number }[];
	practiceN: number;
	practicePct: number;
	hintedN: number;
	hintedPct: number;
	unhintedPct: number;
	checkpointN: number;
	checkpointPct: number;
	explainedN: number;
	explainGood: number;
	explainPartial: number;
	dontKnowPct: number;
	tooFast: number;
	tooSlow: number;
	timeOfDay: { when: string; n: number; pct: number }[];
}

// Evidence-weighted score for ranking approaches (shrinks toward 50% when n is small).
function scoreApproach(a: ApproachStat): number {
	const prior = 3;
	const fc = (a.firstCheckPct * a.firstCheckN + 50 * prior) / (a.firstCheckN + prior);
	const rt = (a.retentionPct * a.retentionN + 50 * prior) / (a.retentionN + prior);
	const ratings = (a.clicked - a.fuzzy) * 4;
	return fc * 0.5 + rt * 0.5 + ratings;
}

function addDays(d: Date, days: number): string {
	return new Date(d.getTime() + days * 86_400_000).toISOString();
}

function fmtDate(iso?: string): string {
	return iso ? iso.slice(0, 10) : "—";
}

const DEFAULT_PROFILE = `# Learner Profile

How I learn best. The tutor reads this at the start of every turn and adds to it
as it learns what works for me. I can edit it too; my edits always win.

## Stated preferences
- Teach every concept before quizzing me on it. Never quiz on a method, keyword, or idea that hasn't been explained in the session. _(stated 2026-10-03)_
- Start from scratch so I don't miss anything; don't assume background I haven't shown. _(stated 2026-10-02)_
- When I leave a note on a quiz answer, answer it directly before moving on. _(2026-10-02)_

## What works

## What doesn't work
- Problems that combine several new ideas at once before each one has been taught and checked on its own. _(2026-10-03)_

## Pace & format

## Observations log
`;
