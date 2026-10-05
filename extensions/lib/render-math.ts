/**
 * render-math — Unicode math for custom popups.
 *
 * pi's transcript renderer turns LaTeX in markdown into terminal-friendly
 * Unicode (pi >= 0.84), but popups like quiz / ask_user_question are custom
 * components that bypass that pipeline. This helper wraps pi-tui's renderLatex
 * so those popups show the same readable math.
 *
 * DISPLAY ONLY: never feed these strings back into graded values, tool result
 * details, or anything sent to the model — keep the model's original source.
 */
import { renderLatex } from "@earendil-works/pi-tui";

/** Inline `$...$`, `\(...\)`; display `$$...$$`, `\[...\]`. */
const MATH_SEGMENT = /\$\$([\s\S]+?)\$\$|\$([^$\n]+?)\$|\\\[([\s\S]+?)\\\]|\\\(([\s\S]+?)\\\)/g;

/**
 * `$...$` is ambiguous — plain prose like "$5 and $10" must not turn into
 * math. Render it only when the content looks like real math: a LaTeX
 * command, a math symbol, or an unspaced short form such as `2x`. The
 * explicit delimiters `$$`, `\[`, `\(` skip this check — writing them is
 * the intent.
 */
function looksLikeMath(source: string): boolean {
	if (/\\[A-Za-z]+/.test(source)) return true;
	if (/[_^=+*/<>()\[\]{}|±≤≥≠≈∈→⇒∞∫∑√]/.test(source)) return true;
	return !/\s/.test(source);
}

export function renderMathInText(text: string): string {
	if (!text || (!text.includes("$") && !text.includes("\\"))) return text;
	return text.replace(
		MATH_SEGMENT,
		(match, displayDollar, inlineDollar, displayBracket, inlineParen) => {
			const source: string | undefined = displayDollar ?? inlineDollar ?? displayBracket ?? inlineParen;
			if (source === undefined) return match;
			const explicit = inlineDollar === undefined; // $$, \[, \( are unambiguous
			if (!explicit && !looksLikeMath(source)) return match;
			// Display math ($$…$$, \[…\]) gets its own lines with stacked fractions.
			const display = displayDollar !== undefined || displayBracket !== undefined;
			const rendered = renderLatex(source.trim(), { display });
			if (rendered === undefined) return match;
			return display && rendered.includes("\n") ? `\n${rendered}\n` : rendered;
		},
	);
}
