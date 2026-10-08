// ────────────────────────────────────────────────────────────────────────────
// plain-math — find math written as plain text ("e^tan(x) * sec^2(x)") instead
// of LaTeX. The VS Code panel typesets $...$ with KaTeX, so math outside
// delimiters shows up raw. Used to bounce quiz calls back to the model.
//
// Code is never flagged: fenced blocks, `inline code`, URLs and lines that read
// as code (statements ending in ; { }, Java/Python keywords) are skipped, and so
// is anything already inside $...$, $$...$$, \(...\) or \[...\]. Arrows (→) and
// prose like "the integral of" are fine as text.
// ────────────────────────────────────────────────────────────────────────────

const STRIP = /```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`|\$\$[\s\S]+?\$\$|\$[^$\n]+?\$|\\\[[\s\S]+?\\\]|\\\([\s\S]+?\\\)/g;
// Not math: URLs, big-O ("O(n^2)"), key combos ("Ctrl^C").
const NOT_MATH = /\b(?:https?:\/\/|www\.)\S+|\bO\([^()\n]*\)|\b(?:Ctrl|Cmd|Alt|Shift)\s*[\^+-]\s*\w+/gi;
// A line of unfenced code: a statement ending in ; { or }, or starting with a code keyword.
const CODE_LINE =
	/^[ \t]*(?:(?:public|private|protected|static|final|int|long|double|float|char|boolean|String|void|var|let|const|def|return|import|class|for|while|if|else|elif|try|catch|System\.out|print(?:ln|f)?)\b.*|.*[;{}][ \t]*)$/gm;

const FN = "sin|cos|tan|sec|csc|cot|arcsin|arccos|arctan|sinh|cosh|tanh|ln|log|exp|sqrt";
// Applied without brackets ("sin x", "ln x", "sin 2x"); "log" and "exp" are also English words.
const FN_SPACE = "sin|cos|tan|sec|csc|cot|arcsin|arccos|arctan|sinh|cosh|tanh|ln|sqrt";
// LaTeX written outside $…$ shows up as raw backslashes.
const TEX = "frac|dfrac|sqrt|int|iint|sum|prod|lim|infty|sin|cos|tan|sec|csc|cot|ln|log|cdot|times|leq?|geq?|neq|pi|theta|alpha|beta|partial|nabla|to|cdots|ldots|left|right";

const PATTERNS: RegExp[] = [
	// exponents: e^x, x^2, sec^2(x), (x+1)^3, e^(2x) — not a^b / Ctrl^C (XOR, keys)
	/(?:\b(?:FN)|[A-Za-z0-9)\]])\^\s*[-({0-9]|(?<![A-Za-z])e\^\s*[A-Za-z]|\)\^\s*[A-Za-z]/,
	// function calls / applications: tan(x), sqrt(2), ln x, sin 2x (not math.sqrt(...) code, not "cos 2 points")
	/(?<![.\w])(?:FN)\s*\(|(?<![.\w])(?:FN_SPACE)\s+\d*[a-z](?![A-Za-z])/,
	// derivative / limit notation
	/\bd\/d[a-z]\b|\bd[a-z]\/d[a-z]\b|\blim\s*(?:\(|[a-z]\s*->)/i,
	// Unicode math symbols that belong in LaTeX
	/[∫∑∏√∞≤≥≠≈±÷∂∇πθ²³]/,
	// fractions of symbols: 1/x, x/2 (not "5/s" rates, dates, and/or)
	/(?<![\w/:.])\d+\/(?![smhg]\b)[a-z](?![\w/])|(?<![\w/:.])[a-z]\/\d+(?![\w/.])/,
	// LaTeX outside $…$: \frac{1}{2}, \int_0^1
	/\\(?:TEX)(?![A-Za-z])/,
	// subscripts and equations: x_1 + x_2, 3x + 2 = 5
	/(?<![\w])[A-Za-z]_(?:\d|\{)|(?<![\w.])\d+[a-z](?![\w])\s*[-+=]\s*\d|[-+=]\s*\d+[a-z](?![\w])/,
].map((r) => new RegExp(r.source.replaceAll("FN_SPACE", FN_SPACE).replaceAll("FN", FN).replaceAll("TEX", TEX), r.flags));

/** Snippets of plain-text math in `text` (empty when it is all LaTeX / prose / code). */
export function findPlainMath(text: string | undefined): string[] {
	if (!text) return [];
	const prose = text.replace(STRIP, " ").replace(NOT_MATH, " ").replace(CODE_LINE, " ");
	const hits: string[] = [];
	for (const re of PATTERNS) {
		const g = new RegExp(re.source, `${re.flags.replace("g", "")}g`);
		for (const m of prose.matchAll(g)) {
			const at = m.index ?? 0;
			// Show the surrounding "word" so the model sees exactly what to fix.
			const start = prose.lastIndexOf(" ", at) + 1;
			const endSpace = prose.indexOf(" ", at + m[0].length);
			const snippet = prose.slice(start, endSpace < 0 ? undefined : endSpace).trim();
			if (snippet && !hits.includes(snippet)) hits.push(snippet);
			if (hits.length >= 4) return hits;
		}
	}
	return hits;
}

// Subjects whose quiz text is math (plain-text math there is worth bouncing);
// programming subjects are mostly code and their ^ * / are operators.
export function isMathSubject(subject: string | undefined): boolean {
	if (!subject) return false;
	if (/\b(java|python|javascript|programming|coding|cs\s*\d|computer|software|algorithms?|data structures)\b/i.test(subject)) return false;
	return /calc|math|algebra|geometry|trig|statistic|probability|differential|precalc|physics|discrete|analysis|equations/i.test(subject);
}

/** All displayed text fields of a quiz / quiz_typed / explain_back call. */
export function displayedFields(input: any): string[] {
	// Some models send arrays as JSON strings (the tools coerce them later).
	const list = (v: any): any[] => {
		if (typeof v === "string") {
			try {
				v = JSON.parse(v);
			} catch {
				return [];
			}
		}
		return Array.isArray(v) ? v : [];
	};
	const out: string[] = [input?.question, input?.details, input?.explanation, input?.prompt];
	for (const o of list(input?.options)) out.push(typeof o === "string" ? o : o?.label, o?.description);
	for (const h of list(input?.hints)) out.push(h);
	return out.filter((x): x is string => typeof x === "string" && x.length > 0);
}

// ── JSON-escape damage ───────────────────────────────────────────────────────
// Tool arguments are JSON, where \t \f \b \r \n are escapes. A model writing
// "\tan" or "\frac" without doubling the backslash delivers a TAB + "an" or a
// form feed + "rac", so KaTeX shows "e^{ an x}". Inside math spans a control
// character is turned back into a command ONLY when the result is a real LaTeX
// command (TAB + "heta" → \theta; a real TAB before "System.out" or "$6" stays).
// Code (fenced or inline) is matched first and left untouched.
const MATH_SPAN = /(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`)|\$\$[\s\S]+?\$\$|\$[^$]+?\$|\\\[[\s\S]+?\\\]|\\\([\s\S]+?\\\)/g;
// What follows each control character when it was a LaTeX command.
const DAMAGED: Record<string, { cmd: string; rest: string }> = {
	"\t": { cmd: "\\t", rest: "an|anh|heta|imes|ext|extbf|extit|frac|o|au|op|riangle|ilde|extrm|extstyle" },
	"\f": { cmd: "\\f", rest: "rac|orall|lat" },
	"\b": { cmd: "\\b", rest: "eta|inom|ar|f|ig|igg|Big|mod|oldsymbol|ot|ullet|egin|ecause|oxed|m" },
	"\v": { cmd: "\\v", rest: "ec|arepsilon|arphi|artheta|ee|ert|dots|arrho" },
	"\r": { cmd: "\\r", rest: "ho|ight|ightarrow|angle|m|ceil|floor|Rightarrow" },
};
const DAMAGED_CONTROL = new RegExp(
	Object.entries(DAMAGED)
		.map(([c, d]) => `${c === "\t" ? "\\t" : c === "\f" ? "\\f" : c === "\b" ? "[\\b]" : c === "\v" ? "\\v" : "\\r"}(?=(?:${d.rest})(?![A-Za-z]))`)
		.join("|"),
	"g",
);
// A newline is only a damaged command when what follows is one (\neq, \nabla, \not, \nu, \ni, \neg).
const DAMAGED_NEWLINE = /\n(?=(?:eq|abla|ot|u|i|eg|eqslant|leq|geq|mid|parallel|subseteq|ewline|ewcommand)(?![A-Za-z]))/g;

const OVER_ESCAPED = /\\\\(?=[A-Za-z]{2,})/g;

export function repairMathEscapes(text: string): string {
	if (!/[\t\f\b\v\r\n]|\\\\[A-Za-z]/.test(text) || !/[$\\]/.test(text)) return text;
	return text.replace(MATH_SPAN, (span, code) =>
		code
			? span
			: span
					.replace(DAMAGED_CONTROL, (c) => DAMAGED[c].cmd)
					.replace(DAMAGED_NEWLINE, "\\n")
					// Over-escaped: "\\tan" reaches KaTeX as a line break + "tan".
					.replace(OVER_ESCAPED, "\\"),
	);
}

// A question about code: its answers and details are program text, never LaTeX.
function isCodeQuestion(input: any): boolean {
	const v = input?.verify;
	if (v && (typeof v === "object" || (typeof v === "string" && v.trim()))) return true;
	return [input?.question, input?.details].some((t) => typeof t === "string" && /```|~~~/.test(t));
}

// Repair every displayed/graded string of a quiz-like call in place. `verify`
// (runnable code) is left alone, and so are a code question's acceptedAnswers
// and details; arrays sent as JSON strings are re-encoded.
export function repairInputMath(input: any): void {
	const skip = new Set(["verify", ...(isCodeQuestion(input) ? ["acceptedAnswers", "details"] : [])]);
	const walk = (v: any): any => {
		if (typeof v === "string") return repairMathEscapes(v);
		if (Array.isArray(v)) return v.map(walk);
		if (v && typeof v === "object") {
			for (const k of Object.keys(v)) if (k !== "verify") v[k] = walk(v[k]);
		}
		return v;
	};
	for (const k of Object.keys(input ?? {})) {
		if (skip.has(k)) continue;
		const v = input[k];
		if (typeof v === "string" && /^\s*\[/.test(v)) {
			try {
				input[k] = JSON.stringify(walk(JSON.parse(v)));
				continue;
			} catch {
				// not JSON after all
			}
		}
		input[k] = walk(v);
	}
}

// ── multiple-choice questions typed into chat ───────────────────────────────
// "A) sin(x)  B) −sin(x)  C) …" (or a. / (a) style) with a question: at least
// three consecutive lettered option lines, ignoring code blocks. Numbered lists
// are left alone — those are usually worked steps, not answer choices.
const OPTION_LINE = /^\s*(?:[-*]\s*)?(?:\*\*)?\(?([A-Fa-f])(?:\)|\.|:)(?:\*\*)?\s+\S/;

export function looksLikeTextQuiz(text: string): boolean {
	const lines = text.replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g, "").split("\n");
	const order = "abcdef";
	let run = 0;
	let prev = -1;
	// The question may come before the options or after them ("Which do you choose?").
	const questionSeen = lines.some((l) => /\?\s*(?:\*\*)?\s*$/.test(l) || /\b(?:question|which|pick|choose|select)\b/i.test(l));
	if (!questionSeen) return false;
	for (const line of lines) {
		const m = line.match(OPTION_LINE);
		if (!m) {
			if (line.trim()) run = 0, prev = -1;
			continue;
		}
		const k = m[1].toLowerCase();
		const idx = order.indexOf(k);
		run = idx === prev + 1 ? run + 1 : idx === 0 ? 1 : 0;
		prev = idx;
		if (run >= 3) return true;
	}
	return false;
}

// A problem for the learner to solve, posed as plain chat text ("Evaluate
// ∫cos⁴x dx … What do you get for the final answer?"). It should be a
// quiz_typed card: graded, with its hints hidden until asked for.
const ASKS_FOR_ANSWER =
	/\b(what do you get|what('s| is) your (final )?answer|final answer|give it a (try|shot)|try (it|this one)( yourself)?|your turn|(can you|now) (evaluate|compute|solve|find|simplify|differentiate|integrate))\b/i;
export function looksLikeTextProblem(text: string): boolean {
	const t = text.replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g, "").trim();
	const paras = t.split(/\n\s*\n/).filter((p) => p.trim());
	const ending = paras.slice(-2).join("\n");
	if (!/\?\s*(\*\*|_)*\s*$/.test(ending) || !ASKS_FOR_ANSWER.test(ending)) return false;
	// Something to work out: math in the message (a stated problem, not a chat question).
	return /\$\$|\\\[|\$[^$\n]*(\\int|\\frac|\\lim|\\sum|\^|=)[^$\n]*\$|∫/.test(t);
}

// A reply that announces what comes next and then stops ("Now let's test it:",
// "Here's a practice problem."). Some models end the turn right there instead of
// making the quiz call or writing the problem, leaving the learner waiting.
const ANNOUNCES_NEXT =
	/^(?:(?:ok(?:ay)?|alright|great|good|now|so|next|then)[,!.]?\s+)*(?:let'?s|let us|let me|i'?ll|i will|i'?m going to|here(?:'s| is| are| comes)|time for|on to|moving on to|next(?: up)?[,:]?)\b.{0,80}\b(?:test|try|check|practice|quiz|question|problem|exercise|example|another|one more|next one|variant|apply|see if|see how|work through)\b/i;
export function endsOnLeadIn(text: string): boolean {
	const t = text
		.replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g, "")
		.replace(/(?:\s|-{3,}|\*{3,}|_{3,})+$/, "")
		.trim();
	if (!t) return false;
	const last = (t.split(/\n\s*\n/).pop() ?? "").trim();
	// Strip markdown emphasis/heading marks so "**Now let's test it:**" still counts.
	const line = (last.split("\n").pop() ?? "").replace(/^[#>\s]+|[*_]+/g, "").trim();
	if (!line || line.endsWith("?")) return false;
	// "Your answer:" hands the turn to the learner; that reply is finished.
	if (/^(?:your\s+)?(?:answer|turn|response|guess|prediction|output|solution|attempt)s?\s*:$/i.test(line)) return false;
	if (/:$/.test(line)) return true;
	// "Let me know if…" and "…next time" close the reply rather than announce more.
	if (/\blet me know\b|\b(?:next time|later|tomorrow|next session|whenever you)\b/i.test(line)) return false;
	return line.length <= 120 && ANNOUNCES_NEXT.test(line);
}
