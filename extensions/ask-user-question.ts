import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { getBridge } from "./lib/bridge.ts";
import { coerceJsonArgs, coerceList } from "./lib/coerce.ts";

// ────────────────────────────────────────────────────────────────────────────
// ask_user_question — the tutor asks the learner something that has no right
// answer (a preference, a goal, a choice of what to do next). The VS Code
// panel shows it as a card: pick from choices, write your own, or type freely.
// Questions with a right answer belong to quiz / quiz_typed instead.
// ────────────────────────────────────────────────────────────────────────────

type Kind = "text" | "single-select" | "multi-select";

// What the learner gave back. `index` is the 1-based number shown on the card.
type Reply =
	| { type: "option"; index: number; label: string; value: string }
	| { type: "other"; label: string; value: string }
	| { type: "text"; label: string; value: string };

interface Choice {
	label: string;
	value: string;
	description?: string;
}

const Params = Type.Object({
	question: Type.String({ description: "One question for the learner." }),
	details: Type.Optional(Type.String({ description: "Optional context shown under the question." })),
	options: Type.Optional(
		Type.Array(
			Type.Object({
				label: Type.String({ description: "Text of the choice. Put a suggested choice first and mark it \"(Recommended)\"." }),
				value: Type.Optional(Type.String({ description: "Value reported back for this choice; defaults to the label." })),
				description: Type.Optional(Type.String({ description: "A short line under the choice." })),
			}),
			{ description: "Choices to pick from. Leave out for a typed answer. The learner can always write their own answer instead." },
		),
	),
	multiSelect: Type.Optional(Type.Boolean({ description: "Let the learner pick more than one choice." })),
});

function cleanChoices(raw: Array<{ label: string; value?: string; description?: string }> | undefined): Choice[] {
	const out: Choice[] = [];
	for (const c of raw ?? []) {
		const label = String(c?.label ?? "").trim();
		if (!label) continue;
		out.push({ label, value: c.value?.trim() || label, description: c.description?.trim() || undefined });
	}
	return out;
}

function describe(r: Reply): string {
	if (r.type === "option") return `${r.index}. ${r.label}`;
	if (r.type === "other") return `(own answer) ${r.label}`;
	return r.label;
}

function result(status: "answered" | "cancelled" | "unavailable", text: string, base: { question: string; context?: string; mode: Kind }, answers: Reply[] = []) {
	return {
		content: [{ type: "text" as const, text }],
		details: { status, ...base, answers, message: status === "answered" ? undefined : text },
	};
}

export default function askUserQuestion(pi: ExtensionAPI) {
	pi.registerTool({
		name: "ask_user_question",
		label: "ask_user_question",
		description:
			"Ask the learner one question that has no right answer — a preference, a goal, or a choice about what to do next — and wait for the reply. Offer choices when there are natural ones; otherwise they type an answer.",
		promptSnippet: "Ask the learner one preference or decision question and wait for the answer.",
		promptGuidelines: [
			"ask_user_question: one question per call; call again for a second question.",
			"ask_user_question: never for questions with a right answer — those go through quiz or quiz_typed.",
			"ask_user_question: when you have a suggestion, list it first and add \"(Recommended)\" to its label.",
		],
		parameters: Params,
		// Options sent as plain strings (["Yes", "No"]) become { label }.
		prepareArguments: (args: any) => coerceList(coerceJsonArgs(args, ["options"]), "options", "label"),

		async execute(toolCallId, params, signal) {
			const choices = cleanChoices(params.options);
			const mode: Kind = !choices.length ? "text" : params.multiSelect ? "multi-select" : "single-select";
			const base = { question: params.question, context: params.details?.trim() || undefined, mode };
			const skipped = () => result("cancelled", "The learner skipped the question.", base);

			if (signal?.aborted) return skipped();
			const bridge = getBridge();
			if (!bridge.hasPanel()) return result("unavailable", "ask_user_question needs the TutorBot panel in VS Code.", base);

			const reply = await bridge.ask(
				"question",
				{
					toolCallId,
					question: base.question,
					context: base.context,
					mode,
					options: choices.map((c, i) => ({ index: i + 1, label: c.label, description: c.description })),
				},
				signal,
			);
			if (!reply) return skipped();

			const answers: Reply[] = [];
			if (mode === "text") {
				const typed = String(reply.text ?? "").trim();
				answers.push({ type: "text", label: typed, value: typed });
			} else {
				for (const n of Array.isArray(reply.indices) ? reply.indices : []) {
					const c = choices[n - 1];
					if (c) answers.push({ type: "option", index: n, label: c.label, value: c.value });
				}
				const own = String(reply.other ?? "").trim();
				if (own) answers.push({ type: "other", label: own, value: own });
			}
			if (!answers.length) return skipped();

			const text =
				mode === "text"
					? answers[0].label
						? `The learner answered: ${answers[0].label}`
						: "The learner sent an empty answer."
					: `The learner chose:\n${answers.map((a) => `- ${describe(a)}`).join("\n")}`;
			return result("answered", text, base, answers);
		},
	});
}
