import { createEmptyCard, fsrs, Rating, type Card } from "ts-fsrs";

// ────────────────────────────────────────────────────────────────────────────
// fsrs — memory strength per concept, using FSRS (the scheduler behind Anki),
// via the ts-fsrs library. FSRS models each concept's own forgetting curve from
// the learner's answers: `stability` is how many days until recall drops to
// 90%; retrievability is today's chance of recall.
//
// Day-based scheduling only (no minute-level "learning steps"): TutorBot's
// teach loop already re-checks a concept right after teaching it.
// ────────────────────────────────────────────────────────────────────────────

export const FSRS_VERSION = 1;
const scheduler = fsrs({ request_retention: 0.9, enable_short_term: false, maximum_interval: 365 });

export interface MemoryState {
	due: string;
	stability: number;
	difficulty: number;
	elapsed_days: number;
	scheduled_days: number;
	learning_steps: number;
	reps: number;
	lapses: number;
	state: number;
	last_review?: string;
}

export interface GradedAnswer {
	purpose: string;
	outcome: string;
	confidence?: number;
	hintsUsed?: number;
	attempts?: number; // typed answers: right on a retry after a miss
	kind?: string;
}

// How an answer maps to an FSRS rating. Undefined = not a memory event.
//   miss / "I don't know"            → Again
//   correct with hints, on a retry,
//   or a guess                       → Hard
//   checkpoint, certain              → Easy
//   any other correct answer         → Good
export function ratingFor(a: GradedAnswer): Rating | undefined {
	if (a.kind === "explain" || a.purpose === "discovery" || a.outcome === "disputed") return undefined;
	if (a.purpose === "diagnostic") return a.outcome === "correct" && a.confidence !== 1 ? Rating.Good : undefined;
	if (a.outcome !== "correct") return Rating.Again;
	if ((a.hintsUsed ?? 0) > 0 || (a.attempts ?? 1) > 1 || a.confidence === 1) return Rating.Hard;
	if (a.purpose === "checkpoint" && a.confidence === 3) return Rating.Easy;
	return Rating.Good;
}

function toCard(m: MemoryState | undefined, when: Date): Card {
	if (!m) return createEmptyCard(when);
	return { ...m, due: new Date(m.due), last_review: m.last_review ? new Date(m.last_review) : undefined } as Card;
}

function fromCard(c: Card): MemoryState {
	return {
		due: c.due.toISOString(),
		stability: c.stability,
		difficulty: c.difficulty,
		elapsed_days: c.elapsed_days,
		scheduled_days: c.scheduled_days,
		learning_steps: c.learning_steps,
		reps: c.reps,
		lapses: c.lapses,
		state: c.state,
		last_review: c.last_review ? c.last_review.toISOString() : undefined,
	};
}

export function reviewMemory(m: MemoryState | undefined, rating: Rating, when: Date, now = new Date()): MemoryState {
	// A timestamp from the future (a bad clock, a hand-edited log) is read as
	// now: kept as-is it would freeze every later review at that date.
	if (!(when.getTime() <= now.getTime())) when = now;
	const card = toCard(m, when);
	if (card.last_review && !(card.last_review.getTime() <= now.getTime())) card.last_review = now;
	// Reviews can't go back in time (replaying an old log out of order).
	const at = card.last_review && when < card.last_review ? card.last_review : when;
	return fromCard(scheduler.next(card, at, rating as any).card);
}

// Today's chance of recall (0..1), or undefined when never reviewed.
export function retrievability(m: MemoryState | undefined, now = new Date()): number | undefined {
	if (!m || !m.reps) return undefined;
	return scheduler.get_retrievability(toCard(m, now), now, false) as number;
}
