// ────────────────────────────────────────────────────────────────────────────
// plain-math — find math written as plain text ("e^tan(x) * sec^2(x)") instead
// of LaTeX. The VS Code panel typesets $...$ with KaTeX, so math outside
// delimiters shows up raw. Used to bounce quiz calls back to the model.
//
// Code is never flagged: fenced blocks and `inline code` are skipped, and so is
// anything already inside $...$, $$...$$, \(...\) or \[...\].
// ────────────────────────────────────────────────────────────────────────────

const STRIP = /```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`|\$\$[\s\S]+?\$\$|\$[^$\n]+?\$|\\\[[\s\S]+?\\\]|\\\([\s\S]+?\\\)/g;

const FN = "sin|cos|tan|sec|csc|cot|arcsin|arccos|arctan|sinh|cosh|tanh|ln|log|exp|sqrt";

const PATTERNS: RegExp[] = [
	// exponents: e^x, x^2, sec^2(x), (x+1)^3, e^(2x)
	/(?:[A-Za-z0-9)\]]|\b(?:FN))\^\s*[-({A-Za-z0-9]/,
	// function calls / applications: tan(x), sqrt(2), ln x, sin 2x (not math.sqrt(...) code)
	/(?<![.\w])(?:FN)\s*\(|(?<![.\w])(?:FN)\s+[a-z0-9]\b/,
	// derivative / integral / limit notation
	/\bd\/d[a-z]\b|\bd[a-z]\/d[a-z]\b|\blim\s*(?:\(|[a-z]\s*->)|\bintegral of\b/i,
	// Unicode math symbols that belong in LaTeX
	/[∫∑∏√∞≤≥≠≈±·×÷→⇒∂∇πθ²³]/,
	// products / fractions of symbols: x*y, 2*x, 1/x, a/b (letters or digits on both sides, no spaces)
	/(?<![\w/])[A-Za-z0-9)]\s?\*\s?[A-Za-z0-9(]|(?<![\w/:.])\d+\/[a-z](?![\w/])|(?<![\w/:.])[a-z]\/\d+(?![\w/.])/,
].map((r) => new RegExp(r.source.replaceAll("FN", FN), r.flags));

/** Snippets of plain-text math in `text` (empty when it is all LaTeX / prose / code). */
export function findPlainMath(text: string | undefined): string[] {
	if (!text) return [];
	const prose = text.replace(STRIP, " ");
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
// form feed + "rac", so KaTeX shows "e^{ an x}". Inside math spans those
// control characters are never intended — turn them back into commands. Code
// (fenced or inline) is matched first and left untouched.
const MATH_SPAN = /(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`)|\$\$[\s\S]+?\$\$|\$[^$]+?\$|\\\[[\s\S]+?\\\]|\\\([\s\S]+?\\\)/g;
const CONTROL: Record<string, string> = { "\t": "\\t", "\f": "\\f", "\b": "\\b", "\v": "\\v", "\r": "\\r" };
// A newline is only a damaged command when what follows is one (\neq, \nabla, \not, \nu, \ni, \neg).
const DAMAGED_NEWLINE = /\n(?=(?:eq|abla|ot|u|i|eg|eqslant|leq|geq|mid|parallel|subseteq)(?![A-Za-z]))/g;

const OVER_ESCAPED = /\\\\(?=[A-Za-z]{2,})/g;

export function repairMathEscapes(text: string): string {
	if (!/[\t\f\b\v\r\n]|\\\\[A-Za-z]/.test(text) || !/[$\\]/.test(text)) return text;
	return text.replace(MATH_SPAN, (span, code) =>
		code
			? span
			: span
					.replace(/[\t\f\b\v\r]/g, (c) => CONTROL[c])
					.replace(DAMAGED_NEWLINE, "\\n")
					// Over-escaped: "\\tan" reaches KaTeX as a line break + "tan".
					.replace(OVER_ESCAPED, "\\"),
	);
}

// Repair every displayed/graded string of a quiz-like call in place. `verify`
// (runnable code) is left alone; arrays sent as JSON strings are re-encoded.
export function repairInputMath(input: any): void {
	const walk = (v: any): any => {
		if (typeof v === "string") return repairMathEscapes(v);
		if (Array.isArray(v)) return v.map(walk);
		if (v && typeof v === "object") {
			for (const k of Object.keys(v)) if (k !== "verify") v[k] = walk(v[k]);
		}
		return v;
	};
	for (const k of Object.keys(input ?? {})) {
		if (k === "verify") continue;
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
