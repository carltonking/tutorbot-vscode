import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

// ────────────────────────────────────────────────────────────────────────────
// custom-provider — a FreeLLMAPI (or other OpenAI-compatible) server the
// learner connected in VS Code (TutorBot: Connect API Key). The panel passes
// its address and model ids in TUTORBOT_FREELLMAPI and the key in
// TUTORBOT_FREELLMAPI_KEY; nothing is written to the learner's pi config.
// ────────────────────────────────────────────────────────────────────────────

export const CUSTOM_PROVIDER = "freellmapi";

export function registerCustomProvider(pi: ExtensionAPI): void {
	const raw = process.env.TUTORBOT_FREELLMAPI;
	if (!raw) return;
	let config: { baseUrl?: string; models?: string[] };
	try {
		config = JSON.parse(raw);
	} catch {
		return;
	}
	const baseUrl = String(config.baseUrl ?? "").replace(/\/+$/, "");
	const ids = (config.models ?? []).filter((m) => typeof m === "string" && m.trim());
	if (!baseUrl || !ids.length) return;
	pi.registerProvider(CUSTOM_PROVIDER, {
		name: "FreeLLMAPI",
		baseUrl,
		apiKey: "$TUTORBOT_FREELLMAPI_KEY",
		api: "openai-completions",
		models: ids.map((id) => ({
			id,
			name: id,
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 16384,
			// Many OpenAI-compatible routers reject these OpenAI-only fields.
			compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
		})),
	});
}
