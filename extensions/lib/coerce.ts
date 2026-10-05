// Some models send structured tool arguments as JSON *strings*
// ("options": "[{\"label\": …}]") instead of real arrays/objects. pi's schema
// validation then rejects the call, and the model retries until it drops the
// structure (misconception tags, LaTeX…) to get through. This repairs such
// arguments before validation (pi's `prepareArguments` hook).
//
// LaTeX makes it worse: "$u = \cos x$" inside a JSON string is an invalid
// escape (\c), and "\frac" / "\theta" are *valid* escapes (\f, \t) that would
// silently become control characters. So: try strict JSON; then only fix
// invalid escapes; if that leaves control characters, treat every lone
// backslash as a literal one.
const CONTROL = /[\b\f\t\r\v]/;

function hasControl(v: unknown): boolean {
	if (typeof v === "string") return CONTROL.test(v);
	if (Array.isArray(v)) return v.some(hasControl);
	if (v && typeof v === "object") return Object.values(v).some(hasControl);
	return false;
}

function tryParse(t: string): { ok: boolean; value?: unknown } {
	try {
		return { ok: true, value: JSON.parse(t) };
	} catch {
		return { ok: false };
	}
}

export function parseLooseJson(text: string): unknown | undefined {
	const t = text.trim();
	if (!(t.startsWith("[") && t.endsWith("]")) && !(t.startsWith("{") && t.endsWith("}"))) return undefined;
	const strict = tryParse(t);
	if (strict.ok && !hasControl(strict.value)) return strict.value;
	const invalidOnly = tryParse(t.replace(/\\(?!["\\/bfnrtu])/g, "\\\\"));
	if (invalidOnly.ok && !hasControl(invalidOnly.value)) return invalidOnly.value;
	// Every lone backslash literal (keeps already-doubled ones and \" quotes).
	const literal = tryParse(t.replace(/\\\\|\\"|\\/g, (m) => (m === "\\" ? "\\\\" : m)));
	if (literal.ok) return literal.value;
	return strict.ok ? strict.value : invalidOnly.ok ? invalidOnly.value : undefined;
}

export function coerceJsonArgs(args: unknown, keys: string[]): any {
	if (!args || typeof args !== "object") return args;
	const out: Record<string, unknown> = { ...(args as Record<string, unknown>) };
	for (const k of keys) {
		const v = out[k];
		if (typeof v !== "string") continue;
		const parsed = parseLooseJson(v);
		if (parsed !== undefined) out[k] = parsed;
	}
	return out;
}
