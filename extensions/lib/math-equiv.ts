import { runCode } from "./run-code.ts";

// ────────────────────────────────────────────────────────────────────────────
// math-equiv — is a typed math answer the same as the expected one? Literal
// matching fails on math ("3x/8 + sin(2x)/4" vs "\frac{3}{8}x + \frac14\sin 2x"),
// so typed math answers are compared with sympy: symbolically, then at a few
// sample points (simplify can miss trig identities). Antiderivatives compare up
// to a constant, so "+ C" and different-looking forms both count.
// ────────────────────────────────────────────────────────────────────────────

export interface MathSpec {
	variable?: string;
	upToConstant?: boolean;
}

// "unavailable" = no python3/sympy here; "error" = one side couldn't be parsed.
export type MathVerdict = "equal" | "different" | "error" | "unavailable";

const SCRIPT = String.raw`
import json, re, sys
try:
    from sympy import Symbol, E, diff, simplify, N
    from sympy.parsing.sympy_parser import parse_expr, standard_transformations, implicit_multiplication_application, convert_xor
except ImportError:
    print("UNAVAILABLE"); sys.exit(0)
A, B, V, UPC = json.loads(sys.stdin.read())

def clean(s):
    s = s.strip().strip("$").strip()
    s = re.sub(r"^\s*[A-Za-z]\s*(\([^()]*\))?\s*=", "", s)           # "y =", "F(x) ="
    for a, b in [("\\left", ""), ("\\right", ""), ("\\,", ""), ("\\!", ""), ("\\cdot", "*"), ("\\times", "*"), ("\\dfrac", "\\frac"), ("\\tfrac", "\\frac")]:
        s = s.replace(a, b)
    for _ in range(6):
        s = re.sub(r"\\frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}", r"((\1)/(\2))", s)
        s = re.sub(r"\\frac\s*(\d)\s*(\d)", r"((\1)/(\2))", s)
        s = re.sub(r"\\sqrt\s*\{([^{}]*)\}", r"sqrt(\1)", s)
    s = re.sub(r"\\(arcsin|arccos|arctan|sinh|cosh|tanh|sin|cos|tan|sec|csc|cot|ln|log|exp|pi)", r" \1", s)
    s = s.replace("{", "(").replace("}", ")").replace("π", "pi").replace("√", "sqrt").replace("·", "*").replace("−", "-")
    s = re.sub(r"\barc(sin|cos|tan)\b", r"a\1", s)
    for _ in range(3):                                               # sin^2(x) -> (sin(x))^2
        s = re.sub(r"\b(a?sin|a?cos|a?tan|sec|csc|cot|sinh|cosh|tanh)\s*\^\s*(\d+|\([^()]*\))\s*\(([^()]*)\)", r"(\1(\3))^\2", s)
    s = re.sub(r"\bln\b", "log", s)
    s = re.sub(r"\+\s*[CK]\s*$", "", s)                              # constant of integration
    return s

x = Symbol(V)
names = {V: x, "e": E, "E": E}
tr = standard_transformations + (implicit_multiplication_application, convert_xor)
try:
    a = parse_expr(clean(A), local_dict=names, transformations=tr)
    b = parse_expr(clean(B), local_dict=names, transformations=tr)
    d = diff(a - b, x) if UPC else a - b
    if simplify(d) == 0:
        print("EQUAL")
    else:
        vals = [complex(N(d.subs(x, p))) for p in (0.31, 0.77, 1.13, -0.42, 2.29)]
        print("EQUAL" if all(abs(v) < 1e-8 for v in vals) else "DIFFERENT")
except Exception as e:
    print("ERROR", str(e)[:200])
`;

export async function mathEquivalent(answer: string, expected: string, spec: MathSpec): Promise<MathVerdict> {
	const input = JSON.stringify([answer, expected, spec.variable || "x", Boolean(spec.upToConstant)]);
	const r = await runCode("python", SCRIPT, input);
	const out = r.stdout.trim();
	if (out.startsWith("EQUAL")) return "equal";
	if (out.startsWith("DIFFERENT")) return "different";
	if (out.startsWith("ERROR")) return "error";
	return "unavailable";
}
