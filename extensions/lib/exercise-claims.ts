import { markdownFences } from "./constructs.ts";

// A reply that tells the learner an exercise file is open/ready, or that
// writes the exercise out as chat text. Only assign_exercise creates the file,
// and some models skip it (after a refused call, or trusting their own earlier
// claim): the learner then hunts for a file that doesn't exist. The exercises
// extension checks such replies against reality.

// Plain text: no markdown emphasis/backticks, straight apostrophes.
const plain = (s: string) => s.replace(/[’‘]/g, "'").replace(/[*_`]+/g, "");

const FILE = String.raw`[\w-]+\.(?:java|py|js)\b`;
// Things that are unmistakably the exercise.
const SUBJECT = String.raw`(?:(?:your|the|this) )?(?:[\w ]{0,40} )?(?:exercise|starter code|starter file|(?:coding|exercise|practice|code|your) file|${FILE})`;
const STATE = String.raw`(?:'s|'re| is| are)(?: now| already| all)? (?:open(?:ed)?|ready|loaded|waiting|set up)\b`;
const WHERE = String.raw`\b(?:in|on) (?:the |your )?(?:editor|left|right|vs ?code|workspace|sidebar|explorer|tab|exercises? folder)\b|\bfor you\b`;
const CLAIMS = [
	// "I've (just) opened / created … CountLetterA.java / the exercise / in your editor"
	new RegExp(String.raw`\bi(?:'ve| have)? (?:just |now |already )?(?:opened|created|set up|loaded|put|placed|made|generated)\b.*?(?:\b(?:file|exercise|editor|starter|workspace|vs ?code)\b|${FILE})`, "i"),
	// "Your exercise is ready", "CountLetterA.java is now open", "Your coding file is ready"
	new RegExp(`${SUBJECT}${STATE}`, "i"),
	// "The file's open on the left" — "the file" alone may be file I/O teaching, so it needs a place.
	new RegExp(String.raw`\b(?:the|a) (?:new )?file${STATE}.*?(?:${WHERE})`, "i"),
	// "… is (now) open in the editor / VS Code"
	/\b(?:is|are|'s) (?:now |already )?open(?:ed)? in (?:the |your )?(?:editor|vs ?code)\b/i,
	/\balready (?:open|loaded) (?:for you|in (?:the |your )?editor)\b/i,
	/\bstarter code (?:is )?(?:already |now )?(?:loaded|in (?:the |your )?editor)\b/i,
];
// Negated, conditional or future sentences aren't claims: "No file is open yet",
// "When the exercise file is ready, I'll…", "Once you've opened the file…".
const HEDGED = /\b(?:not|no|never|none|yet|when|whenever|once|if|unless|until|after|before|will|won't|would|going to|soon|about to)\b|n't\b|'ll\b/i;

export function claimsExerciseFile(text: string): boolean {
	const prose = markdownFences(plain(text)).rest;
	const clauses = prose.split(/(?<=[.!?])\s+|\n+|\s[—–-]\s|;\s*/);
	// Hedges count up to the end of the claim: "I've opened X.java, and if you get stuck…" is still a claim.
	return clauses.some(
		(c) =>
			!/\?\s*$/.test(c) &&
			CLAIMS.some((re) => {
				const m = re.exec(c);
				return m !== null && !HEDGED.test(c.slice(0, m.index + m[0].length));
			}),
	);
}

// A placeholder for the learner's code inside a block.
const PLACEHOLDER = /(?:\/\/|#|\/\*)\s*(?:todo\b|\.\.\.|your code|write your code|fill (?:this )?in)|\byour code (?:goes )?here\b|^\s*(?:pass|\.\.\.)\s*$/im;
// A program skeleton: class with main / a function definition.
const SKELETON = /\bclass\s+\w+[\s\S]*\bstatic\s+void\s+main\s*\(|^\s*def\s+\w+\s*\(|\bfunction\s+\w+\s*\(/m;
// Words that hand the learner a task.
const TASK = /\b(?:your task|exercise|try (?:this|it)|try:|complete (?:this|the)|fill in|implement|write (?:the|a|your) (?:program|code)|starter code)\b/i;
const PASTE_INTO = /\b(?:copy[- ]?(?:and[- ])?paste|paste)\b[^.\n]*\binto\b[^.\n]*\b[\w-]+\.(?:java|py|js)\b/i;

// Only comments / placeholders / blank lines: a block that is all blank to fill.
const onlyPlaceholders = (code: string) => code.split("\n").every((l) => !l.trim() || /^\s*(?:\/\/|#|\/\*|\*)/.test(l) || /^\s*(?:pass|\.\.\.)\s*$/.test(l));

// An exercise typed into chat: a program skeleton with a placeholder to fill
// in, or code the learner is told to paste into a file. Code under review
// ("Test case 2 failed…", "In your starter code, line 5…") is neither.
export function looksLikeTextExercise(text: string): boolean {
	const { blocks, rest } = markdownFences(text);
	if (!blocks.length) return false;
	if (PASTE_INTO.test(plain(rest))) return true;
	return blocks.some((b) => PLACEHOLDER.test(b.code) && (SKELETON.test(b.code) || onlyPlaceholders(b.code) || TASK.test(plain(rest))));
}

export function fakeExercise(text: string): boolean {
	return claimsExerciseFile(text) || looksLikeTextExercise(text);
}
