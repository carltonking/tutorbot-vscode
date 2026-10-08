import { PY_MATH } from "./math-equiv.ts";
import { runCode } from "./run-code.ts";

// ────────────────────────────────────────────────────────────────────────────
// math-key — check a quiz's answer key without trusting the model. When the
// question is a derivative, integral or limit TutorBot can read ("What is
// $\frac{d}{dx}\left[\frac{3x-1}{x+1}\right]$?"), sympy computes the true answer
// and every option is compared with it. A model can mis-derive a key and then
// "explain" the wrong answer; this catches that before the learner sees it.
// ────────────────────────────────────────────────────────────────────────────

export interface KeyCheck {
	// "ok": the question was understood and computed; `matches` lists the
	// candidates (1-based) equal to the true answer, `unparsed` the ones that
	// aren't math sympy could read ("Does not exist", "None of these").
	status: "ok" | "unrecognized" | "error" | "unavailable";
	truth?: string;
	kind?: "derivative" | "integral" | "definite integral" | "limit";
	antiderivativeOf?: boolean; // integrals: truth is the integrand; candidates are differentiated
	matches: number[];
	// Right only where the candidate itself is defined (ln(x) for the
	// antiderivative of 1/x, when ln|x| is the one right everywhere).
	loose: number[];
	unparsed: number[];
}

const SCRIPT = String.raw`
import json, re, sys
try:
    import sympy
    from sympy import integrate, limit, latex, zoo, nan
except ImportError:
    print(json.dumps({"status": "unavailable"})); sys.exit(0)
Q, CANDS = json.loads(sys.stdin.read())
${PY_MATH}
PAIRS = {"[": "]", "(": ")", "{": "}"}
ORDINAL = {"second": 2, "2nd": 2, "third": 3, "3rd": 3, "fourth": 4, "4th": 4}
STOP = r"(?:using|for|where|when|if|at|with|evaluated|and)"
Y_DEF = r"(?:^|\b(?:if|for|where|of|when|given|let)\s+|[,:;(]\s*)y\s*=\s*(.+)"   # "for y = x^3", not "x^2 + y = 1"

def norm(q):
    q = q.replace("$", " ")
    for a in ["\\left", "\\right", "\\displaystyle", "\\limits", "\\Big", "\\big", "\\bigg"]:
        q = q.replace(a, "")
    return q.replace("\\dfrac", "\\frac").replace("\\tfrac", "\\frac")

def group(s, i):
    # s[i] opens a bracket: return (inside, index after the closing bracket).
    o = s[i]; c = PAIRS[o]; depth = 0
    for j in range(i, len(s)):
        if s[j] == o: depth += 1
        elif s[j] == c:
            depth -= 1
            if depth == 0: return s[i + 1:j], j + 1
    raise ValueError("unbalanced")

def operand(s):
    # What an operator applies to: a bracketed group, else the rest of the sentence.
    s = s.lstrip()
    if s and s[0] in PAIRS:
        inner, end = group(s, 0)
        rest = s[end:].lstrip()
        if not rest.strip(" ?.,:;") or rest.startswith(("?", ",", ".", "\\text")) or re.match(STOP + r"\b", rest):
            return inner
    return re.split(r"\?|,\s|\.\s|\.$|\s" + STOP + r"\s", s)[0]

def order(q):
    # How many times to differentiate; None = a higher derivative we can't pin down.
    m = re.search(r"\b(second|2nd|third|3rd|fourth|4th)[\s-]+(?:order\s+)?derivative", q, re.I)
    if m: return ORDINAL[m.group(1).lower()]
    m = re.search(r"\\frac\s*\{\s*d\s*\^\s*\{?\s*(\d+)\s*\}?[^{}]*\}\s*\{\s*d\s*[a-z]\s*\^", q) or re.search(r"\bd\s*\^\s*\{?\s*(\d+)\s*\}?\s*[a-z]?\s*/\s*d\s*[a-z]\s*\^", q)
    if m: return int(m.group(1))
    m = re.search(r"\b[a-zA-Z]\s*\^\s*\{?\s*\((\d+)\)", q)
    if m: return int(m.group(1))
    m = re.search(r"\b[a-zA-Z]('{2,}|\u2033|\u2034)", q)
    if m: return {"\u2033": 2, "\u2034": 3}.get(m.group(1), len(m.group(1)))
    if re.search(r"\b(nth|n-th|higher|\d+(?:th|st))[\s-]+(?:order\s+)?derivative|\\frac\s*\{\s*d\s*\^|\bd\s*\^\s*\{?\s*[a-z]", q, re.I): return None
    return 1

def at_point(q, v, f):
    # "... at x = 2": evaluate there.
    m = re.search(r"\b(?:at|when)\s+" + v + r"\s*=\s*([^?,;]+?)\s*(?:[?,;]|\.(?:\s|$)|$)", q)
    return f.subs(var(v), parse(m.group(1), v)) if m else f

def derivative(q, v, f, n):
    return "derivative", v, at_point(q, v, diff(f, var(v), n)), False

def task(q):
    q = norm(q)
    m = re.search(r"\\lim\s*_\s*\{\s*([a-z])\s*(?:\\to|\\rightarrow|->)\s*([^{}]+?)\s*\}", q)
    if m:
        v, to = m.group(1), m.group(2).strip()
        d = "+-"
        if to.endswith("^+") or to.endswith("^{+}"): d = "+"
        elif to.endswith("^-") or to.endswith("^{-}"): d = "-"
        to = re.sub(r"\^\{?[+-]\}?$", "", to)
        x = var(v); f = parse(operand(q[m.end():]), v)
        if d == "+-":
            l, r = limit(f, x, parse(to, v), "+"), limit(f, x, parse(to, v), "-")
            return "limit", v, (l if l == r else "DNE"), False
        return "limit", v, limit(f, x, parse(to, v), d), False
    m = re.search(r"\\int\s*(?:_\s*(\{[^{}]*\}|\\[A-Za-z]+|\S)\s*\^\s*(\{[^{}]*\}|\\[A-Za-z]+|\S))?(.+?)\\?,?\s*d([a-z])\b", q)
    if m:
        v = m.group(4); x = var(v); f = parse(m.group(3), v)
        if m.group(1):
            a, b = (parse(g.strip("{}"), v) for g in (m.group(1), m.group(2)))
            return "definite integral", v, integrate(f, (x, a, b)), False
        return "integral", v, f, True     # compare by differentiating the candidate
    n = order(q)
    if n is None: return None
    m = re.search(r"\\frac\s*\{\s*d\s*(?:\^\s*\{?\s*\d+\s*\}?)?\s*(y?)\s*\}\s*\{\s*d\s*([a-z])\s*(?:\^\s*\{?\s*\d+\s*\}?)?\s*\}|\bd\s*(?:\^\s*\{?\s*\d+\s*\}?)?\s*(y?)\s*/\s*d\s*([a-z])(?:\s*\^\s*\{?\s*\d+\s*\}?)?(?![a-z])", q)
    if m:
        v = m.group(2) or m.group(4)
        if m.group(1) or m.group(3):
            # dy/dx: of the y defined in the question ("for y = x^3"), if there is one.
            d = re.search(Y_DEF, q, re.I)
            if not d or re.search(r"=", d.group(1)): return None
            return derivative(q, v, parse(operand(d.group(1)), v), n)
        return derivative(q, v, parse(operand(q[m.end():]), v), n)
    m = re.search(r"(?<!anti)(?:derivative of|differentiate)\s+(?:[a-zA-Z]\s*\(\s*([a-z])\s*\)\s*=\s*|y\s*=\s*)?(.+)", q, re.I)
    if m:
        v = m.group(1) or "x"
        return derivative(q, v, parse(operand(m.group(2)), v), n)
    m = re.search(r"\b(?:anti-?derivative|indefinite integral|integral) of\s+(.+)", q, re.I)
    if m:
        return "integral", "x", parse(operand(m.group(1)), "x"), True
    # f''(x) / f'(x) asked about a defined f(x) = ..., or y'' for y = ...
    m = re.search(r"\b([a-zA-Z])\s*('+|\u2032|\u2033|\u2034|\^\s*\{?\s*\(\d+\)\s*\}?)\s*\(\s*([a-z])\s*\)", q)
    if m:
        d = re.search(r"\b" + m.group(1) + r"\s*\(\s*" + m.group(3) + r"\s*\)\s*=\s*(.+)", q)
        if d: return derivative(q, m.group(3), parse(operand(d.group(1)), m.group(3)), n)
    if re.search(r"\by\s*('+|\u2032|\u2033|\u2034)", q):
        d = re.search(Y_DEF, q, re.I)
        if d: return derivative(q, "x", parse(operand(d.group(1)), "x"), n)
    return None

try:
    t = task(Q)
    if t is None:
        print(json.dumps({"status": "unrecognized"})); sys.exit(0)
    kind, v, truth, by_derivative = t
    if truth == "DNE":
        # One-sided limits differ: the key must be a "does not exist" option.
        dne = [i for i, c in enumerate(CANDS, 1) if re.search(r"not exist|\bdne\b", c, re.I)]
        print(json.dumps({"status": "ok", "kind": kind, "truth": "does not exist (the one-sided limits differ)", "matches": dne, "loose": [], "unparsed": [i for i in range(1, len(CANDS) + 1) if i not in dne]})); sys.exit(0)
    if truth is None or truth.has(zoo, nan) or (getattr(truth, "is_number", False) and not (truth.is_finite or truth in (oo, -oo))):
        print(json.dumps({"status": "unrecognized"})); sys.exit(0)
    x = var(v)
    # matches: right everywhere the true answer is real (ln|x| for 1/x);
    # loose: right where the candidate is defined (ln(x) for 1/x).
    matches, loose, unparsed = [], [], []
    for i, c in enumerate(CANDS, 1):
        try:
            e = parse(c, v)
            if by_derivative: e = no_constant(e)
        except Exception:
            unparsed.append(i); continue
        # Words parse as products of symbols ("quotient rule"): not a math answer.
        if e.free_symbols - {x}:
            unparsed.append(i); continue
        if truth in (oo, -oo):
            if e == truth: matches.append(i)
            continue
        got = diff(e, x) if by_derivative else e
        if same(got, truth, v, True, e if by_derivative else None): matches.append(i)
        elif same(got, truth, v): loose.append(i)
    try: nice = simplify(truth)
    except Exception: nice = truth
    print(json.dumps({"status": "ok", "kind": kind, "truth": latex(nice), "antiderivativeOf": by_derivative, "matches": matches, "loose": loose, "unparsed": unparsed}))
except Exception as e:
    print(json.dumps({"status": "error", "error": str(e)[:200]}))
`;

export async function checkMathKey(question: string, candidates: string[]): Promise<KeyCheck> {
	const r = await runCode("python", SCRIPT, JSON.stringify([question, candidates]));
	try {
		const out = JSON.parse(r.stdout.trim().split("\n").pop() || "{}");
		return { matches: [], loose: [], unparsed: [], ...out };
	} catch {
		return { status: "error", matches: [], loose: [], unparsed: [] };
	}
}

// A question that asks for a derivative, integral or limit — something sympy
// can check. If TutorBot can't read it, the model must pass its own verify.
const OPERATOR = /\\frac\s*\{\s*d\s*(\^\s*\{?\d+\}?\s*)?\}\s*\{\s*d[a-z]|\bd(\^\{?\d+\}?)?\/d[a-z]\b|\\(int|lim)(?![A-Za-z])|\b(derivative|differentiate|antiderivative|integral) of\b|\b[a-zA-Z](''+|′+|″|‴)\s*\(\s*[a-z]\s*\)/i;
// dy/dx, d²y/dx², y'' count only with an explicit "y = …" (not implicit
// differentiation or related rates, which TutorBot can't read).
const OF_Y = /\\frac\s*\{\s*d\s*(\^\s*\{?\d+\}?\s*)?y\s*\}\s*\{\s*dx|\bd(\^\{?\d+\}?)?y\/dx\b|\by\s*('+|″|‴)/;
const Y_DEFINED = /(?:^|\b(?:if|for|where|of|when|given|let)\s+\$?\s*|[,:;(]\s*\$?\s*)y\s*=/i;
export function looksComputable(question: string): boolean {
	return OPERATOR.test(question) || (OF_Y.test(question) && Y_DEFINED.test(question));
}

// The explanation's stated result ("Answer: $\frac{4}{(x+1)^2}$"), if it has one.
export function statedAnswer(explanation: string): string | undefined {
	const m = [...explanation.matchAll(/(?:^|[.!?]\s+)\s*(?:\*\*)?(?:final\s+)?answer(?:\*\*)?\s*:\s*(?:\*\*)?(.+?)(?:\*\*)?\s*$/gim)].pop();
	return m?.[1]?.trim() || undefined;
}

// Math the model computed in its head is checked by sympy, whether or not it
// passed verify: for a derivative/integral/limit TutorBot can read, the key must
// be the true answer, some option must be right, and the explanation's stated
// answer must agree. A question TutorBot can't read needs the model's own verify.
export async function checkComputedKey(question: string, candidates: string[], key: number[], explanation: string, hasVerify: boolean, tool: "quiz" | "quiz_typed"): Promise<string | undefined> {
	if (!looksComputable(question)) return undefined;
	// Questions about a step rather than the result ("what is the best $u$?",
	// options like "u = x^2") are left to the model.
	if (/\b(best|which|what|choose|pick|let)\s+\$?\s*[uv]\s*\$?\s*(\?|=|is|should|would)|\bfirst step\b/i.test(question) || candidates.some((c) => /^\s*\$?\s*[a-z]\s*=/i.test(c) && !/^\s*\$?\s*[fy]\s*=/i.test(c)))
		return undefined;
	const stated = statedAnswer(explanation);
	const all = stated ? [...candidates, stated] : candidates;
	const c = await checkMathKey(question, all);
	if (c.status === "unavailable") return undefined;
	if (c.status !== "ok") {
		if (hasVerify) return undefined;
		return `${tool}: TutorBot couldn't compute this question's answer itself, so it must be checked before it's shown. Pass verify {language: "python", mode: "assert", code: <sympy code that computes the answer and asserts your key equals it>} and call ${tool} again.`;
	}
	const truth = /^does not exist/.test(c.truth ?? "") ? String(c.truth) : `${c.antiderivativeOf ? "an antiderivative of " : ""}$${c.truth}$`;
	// An option right everywhere (ln|x|) beats one right only on part of the
	// domain (ln(x)); with no such option, the partly-right one is the key.
	const strict = c.matches.filter((i) => i <= candidates.length);
	const matches = strict.length ? strict : c.loose.filter((i) => i <= candidates.length);
	const fix = "Re-derive it step by step, fix the options/key AND the explanation so all three agree, then call " + tool + " again. Nothing was shown to the learner.";
	if (tool === "quiz_typed") {
		if (!matches.includes(1) && !c.loose.includes(1)) return `quiz_typed answer key is wrong: the ${c.kind} is ${truth}, not "${candidates[0]}". ${fix}`;
	} else if (!matches.length) {
		if (!key.every((i) => c.unparsed.includes(i)))
			return `quiz answer key is wrong and NONE of the options is correct: the ${c.kind} is ${truth}. Put the correct answer among the options, mark it as correctAnswer, and make the distractors plausible mistakes. ${fix}`;
	} else if (matches.length > 1) {
		return `quiz has more than one correct option: options ${matches.join(" and ")} all equal ${truth}. Keep one and replace the others with distinct plausible mistakes. ${fix}`;
	} else if (key.length !== 1 || key[0] !== matches[0]) {
		return `quiz answer key is wrong: the ${c.kind} is ${truth}, which is option ${matches[0]} ("${candidates[matches[0] - 1]}"), not the option you marked. ${fix}`;
	}
	const statedIdx = stated ? all.length : 0;
	if (stated && ![...c.matches, ...c.loose, ...c.unparsed].includes(statedIdx))
		return `${tool}: the explanation's final answer ("${stated}") is wrong — the ${c.kind} is ${truth}. Rewrite the explanation as one clean, correct derivation of the question as asked (no restarts or "wait"), ending with that answer. ${fix}`;
	return undefined;
}
