import { runCode } from "./run-code.ts";

// ────────────────────────────────────────────────────────────────────────────
// math-equiv — is a typed math answer the same as the expected one? Literal
// matching fails on math ("3x/8 + sin(2x)/4" vs "\frac{3}{8}x + \frac14\sin 2x"),
// so typed math answers are compared with sympy: numerically at sample points
// on both sides of 0 (relative tolerance), with a symbolic fallback.
// Antiderivatives compare up to a constant (by their derivatives), so "+ C",
// ln|x| vs ln(x) and different-looking forms all count.
//
// The learner's text is NEVER evaluated as code: it is translated to a small
// math-only token stream (numbers, + - * / ^ ( ), known function names, single-
// letter variables) and anything else is refused before sympy sees it.
// ────────────────────────────────────────────────────────────────────────────

export interface MathSpec {
	variable?: string;
	upToConstant?: boolean;
}

// "unavailable" = no python3/sympy here; "error" = one side couldn't be parsed.
export type MathVerdict = "equal" | "different" | "error" | "unavailable";

// LaTeX/plain math → a safe sympy expression, plus numeric comparison. Shared
// with math-key.ts. Defines clean(s, v), parse(s, v), var(v), same(a, b, v, strict, dom)
// and no_constant(e).
export const PY_MATH = String.raw`
import re
from sympy import (Symbol, Integer, Float, Rational, Function, E, pi, oo, N, simplify, diff,
    sin, cos, tan, sec, csc, cot, asin, acos, atan, asec, acsc, acot,
    sinh, cosh, tanh, asinh, acosh, atanh, log, exp, sqrt, Abs, sign)
from sympy.parsing.sympy_parser import parse_expr, standard_transformations, implicit_multiplication_application, convert_xor

FUNCS = {"sin": sin, "cos": cos, "tan": tan, "sec": sec, "csc": csc, "cot": cot,
    "asin": asin, "acos": acos, "atan": atan, "asec": asec, "acsc": acsc, "acot": acot,
    "sinh": sinh, "cosh": cosh, "tanh": tanh, "asinh": asinh, "acosh": acosh, "atanh": atanh,
    "log": log, "ln": log, "exp": exp, "sqrt": sqrt, "Abs": Abs, "abs": Abs, "sgn": sign, "sign": sign}
TRIG = ["sinh", "cosh", "tanh", "sin", "cos", "tan", "sec", "csc", "cot"]
ARC = ["arcsin", "arccos", "arctan", "arcsec", "arccsc", "arccot"]
GREEK = ["theta", "alpha", "beta", "phi", "omega", "tau", "mu", "sigma", "rho", "psi"]
# Calculus / code words: a learner's answer must be a result, not a request to compute one.
FORBIDDEN = re.compile(r"diff|integr|limit|deriv|subs|lambda|import|eval|exec|symp|simplif|solve|open|system|true|false|none|piecewise|floor|ceil|summation|factorial|doit|print|getattr|class|global", re.I)
SUPER = {"⁰": "0", "¹": "1", "²": "2", "³": "3", "⁴": "4", "⁵": "5", "⁶": "6", "⁷": "7", "⁸": "8", "⁹": "9", "⁻": "-"}
VULGAR = {"½": "(1/2)", "⅓": "(1/3)", "⅔": "(2/3)", "¼": "(1/4)", "¾": "(3/4)", "⅕": "(1/5)", "⅙": "(1/6)", "⅛": "(1/8)"}
# "Answer: 12", "y = ...", "f'(x) = ...", "dy/dx = ...", "\frac{dy}{dx} = ..."
PREFIX = re.compile(r"^\s*(?:(?:final\s+)?answer\s*(?:is\b)?\s*[:=]?\s*|(?:[A-Za-z]\s*'*\s*(?:\(\s*[A-Za-z]\s*\))?|d\^?\{?\d*\}?\s*[A-Za-z]?\s*/\s*d[A-Za-z](?:\^\{?\d+\}?)?|\\frac\s*\{\s*d[^{}]*\}\s*\{\s*d[^{}]*\})\s*=(?!=)\s*)", re.I)

def group_end(s, i):
    # s[i] == "(": the index just past the matching ")".
    depth = 0
    for j in range(i, len(s)):
        if s[j] == "(": depth += 1
        elif s[j] == ")":
            depth -= 1
            if depth == 0: return j + 1
    raise ValueError("unbalanced")

def pipes(s):
    # |x-1| -> Abs(x-1). A bar opens when nothing is open or it follows an operator.
    out, depth = [], 0
    for ch in s:
        if ch != "|": out.append(ch); continue
        prev = "".join(out).rstrip()[-1:]
        if depth == 0 or prev in ("", "(", "+", "-", "*", "/", "^"):
            out.append(" Abs("); depth += 1
        else:
            out.append(")"); depth -= 1
    if depth: raise ValueError("unbalanced |")
    return "".join(out)

def segment(s, v):
    # Split letter runs into known names and single-letter variables: "xsinx" -> "x sin x".
    names = sorted(set(list(FUNCS) + ARC + ["pi", "oo"] + GREEK + ([v] if len(v) > 1 else [])), key=len, reverse=True)
    def split(m):
        w = m.group(0)
        if FORBIDDEN.search(w): raise ValueError("not a math answer: " + w)
        out, i = [], 0
        while i < len(w):
            for n in names:
                if w.startswith(n, i): out.append(n); i += len(n); break
            else:
                out.append(w[i]); i += 1
        return " " + " ".join(out) + " "
    return re.sub(r"[A-Za-z]+", split, s)

def trig_powers(s):
    # sin^2(x) / sin^2 x -> (sin(x))^(2); sin^(-1)(x) -> asin(x), never 1/sin(x).
    pat = re.compile(r"(?<![A-Za-z])(a?(?:" + "|".join(TRIG) + r"))\s*\^\s*(\(\s*-?\s*\d+\s*\)|-?\d+)\s*")
    for _ in range(8):
        m = pat.search(s)
        if not m: return s
        fn, n, rest = m.group(1), m.group(2).strip("() ").replace(" ", ""), s[m.end():]
        if rest.startswith("("):
            end = group_end(rest, 0); arg = rest[1:end - 1]
        else:
            a = re.match(r"(\d*\.?\d*\s*(?:" + "|".join(GREEK) + r"|pi|[A-Za-z])(?![A-Za-z]))", rest)
            if not a: raise ValueError("can't read the argument of " + fn)
            end = a.end(); arg = a.group(1)
        if n == "-1":
            if fn.startswith("a"): raise ValueError("ambiguous inverse")
            new = "a" + fn + "(" + arg + ")"
        else:
            new = "(" + fn + "(" + arg + "))^(" + n + ")"
        s = s[:m.start()] + " " + new + " " + rest[end:]
    return s

def apply_fns(s):
    # Implicit application, right to left: "sin x cos x" -> sin(x) cos(x),
    # "sin 2x" -> sin(2x), "sin x^2" -> sin(x^2), "ln Abs(x)" -> ln(Abs(x)).
    names = "|".join(sorted(FUNCS, key=len, reverse=True))
    for m in reversed(list(re.finditer(r"(?<![A-Za-z])(?:" + names + r")(?![A-Za-z])", s))):
        rest = s[m.end():]
        if re.match(r"\s*[(^]", rest): continue
        f = re.match(r"\s*(?:" + names + r")\s*\(", rest)
        if f:
            end = group_end(rest, f.end() - 1)
        else:
            a = re.match(r"\s*(?:\d+\.?\d*\s*)?(?:(?:" + "|".join(GREEK) + r"|pi|[A-Za-z])(?![A-Za-z])(?:\s*\^\s*(?:\d+|[A-Za-z]|\([^()]*\)))?)?", rest)
            if not a or not a.group(0).strip(): continue
            end = a.end()
        s = s[:m.end()] + "(" + rest[:end] + ")" + rest[end:]
    return s

def clean(s, v="x"):
    s = str(s).strip()
    s = re.sub(r"^\$+|\$+$", "", s).strip()
    s = re.sub(r"^\\[(\[]|\\[)\]]$", "", s).strip()
    for _ in range(2):
        s = PREFIX.sub("", s, count=1).strip()
        s = re.sub(r"^\$+|\$+$", "", s).strip()
    s = re.sub(r"[.;]\s*$", "", s)
    if re.fullmatch(r"-?\d{1,3}(?:,\d{3})+(?:\.\d+)?", s): s = s.replace(",", "")   # 1,000
    s = re.sub(r"(\d+(?:\.\d+)?)\s*\\?%", r"(\1/100)", s)
    s = re.sub(r"([⁰¹²³⁴⁵⁶⁷⁸⁹⁻]+)", lambda m: "^(" + "".join(SUPER[c] for c in m.group(1)) + ")", s)
    for a, b in VULGAR.items(): s = s.replace(a, b)
    for a, b in [("−", "-"), ("–", "-"), ("×", "*"), ("·", "*"), ("⋅", "*"), ("÷", "/"), ("π", " pi "), ("θ", " theta "), ("∞", " oo "), ("√", " sqrt "), ("**", "^")]:
        s = s.replace(a, b)
    for a, b in [("\\left", ""), ("\\right", ""), ("\\displaystyle", ""), ("\\,", " "), ("\\!", ""), ("\\;", " "), ("\\:", " "), ("\\qquad", " "), ("\\quad", " "),
                 ("\\cdot", "*"), ("\\times", "*"), ("\\div", "/"), ("\\dfrac", "\\frac"), ("\\tfrac", "\\frac"), ("\\lvert", "|"), ("\\rvert", "|"), ("\\vert", "|"), ("\\infty", " oo ")]:
        s = s.replace(a, b)
    s = re.sub(r"\\(?:mathrm|operatorname|text)\s*\{\s*([A-Za-z]+)\s*\}", r"\\\1", s)
    s = re.sub(r"\b([CK])_\{?\d+\}?", r"\1", s)                          # C_1 -> C
    for _ in range(8):
        s = re.sub(r"\\frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}", r"((\1)/(\2))", s)
        s = re.sub(r"\\frac\s*(\w)\s*(\w)", r"((\1)/(\2))", s)
        s = re.sub(r"\\sqrt\s*\[([^\[\]]*)\]\s*\{([^{}]*)\}", r"((\2)^(1/(\1)))", s)
        s = re.sub(r"\\sqrt\s*\{([^{}]*)\}", r"sqrt(\1)", s)
    s = re.sub(r"\\sqrt\s*(\w)", r"sqrt(\1)", s)
    s = re.sub(r"\\?(?<![A-Za-z])log_\s*\{([^{}]*)\}", r" (1/log(\1))*log ", s)   # log_2 x
    s = re.sub(r"\\?(?<![A-Za-z])log_\s*(\w)", r" (1/log(\1))*log ", s)
    known = set(FUNCS) | set(ARC) | set(GREEK) | {"pi", "e"}
    s = re.sub(r"\\([A-Za-z]+)", lambda m: " " + m.group(1) + " " if m.group(1) in known else m.group(0), s)
    s = s.replace("{", "(").replace("}", ")")
    s = pipes(s)
    s = segment(s, v)
    s = re.sub(r"(?<![A-Za-z])arc(" + "|".join(TRIG) + r")\b", r"a\1", s)
    s = trig_powers(s)
    s = apply_fns(s)
    s = re.sub(r"\bln\b", "log", s)
    s = re.sub(r"\s+", " ", s).strip()
    # Only math may reach sympy: digits, decimal points, operators, brackets and the names above.
    if not s or not re.fullmatch(r"[0-9A-Za-z+\-*/^(). ]*", s) or re.search(r"\.(?!\d)", s) or "__" in s:
        raise ValueError("not a math expression")
    return s

SAFE = {"__builtins__": {}, "Symbol": Symbol, "Integer": Integer, "Float": Float, "Rational": Rational, "Function": Function, "pi": pi, "oo": oo, "E": E}
SAFE.update(FUNCS)
TR = standard_transformations + (implicit_multiplication_application, convert_xor)

def var(v): return Symbol(v, real=True)

def names_for(v):
    d = {c: Symbol(c, real=True) for c in "abcdfghijklmnopqrstuvwxyzABCDFGHIJKLMNOPQRSTUVWXYZ"}
    for g in GREEK: d[g] = Symbol(g, real=True)
    d["e"] = E; d["E"] = E
    d[v] = var(v)
    return d

def parse(s, v="x"):
    e = parse_expr(clean(s, v), local_dict=names_for(v), global_dict=dict(SAFE), transformations=TR)
    if getattr(e, "is_Boolean", False) or not hasattr(e, "free_symbols"):
        raise ValueError("not an expression")
    return e

PTS = (0.31, 0.77, -0.42, -0.83, 1.13, 1.71, -1.37, 2.29, -2.61, 3.07, 4.7, -5.9, 6.3, 9.1, 13.9)

def value(e, x, p):
    try:
        z = complex(N(e.subs(x, p), 30))
    except Exception:
        return None
    if z != z or abs(z) == float("inf"): return None
    return z

def is_real(z): return abs(z.imag) <= 1e-12 * max(1.0, abs(z))

def same(a, b, v, strict=False, dom=None):
    # a == b as functions of v (b is the reference). A point where only one side
    # is real lies outside that side's domain and is skipped (ln x vs ln|x|),
    # unless strict. dom: in strict mode it must also be real wherever b is.
    x = var(v); ok = 0
    for p in PTS:
        zb = value(b, x, p)
        if zb is None: continue
        za = value(a, x, p)
        if za is None:
            if strict: return False
            continue
        if is_real(za) != is_real(zb):
            if strict and is_real(zb): return False
            continue
        if strict and dom is not None and is_real(zb):
            zd = value(dom, x, p)
            if zd is None or not is_real(zd): return False
        if abs(za - zb) > 1e-11 * max(abs(za), abs(zb)) + 1e-13: return False
        ok += 1
    if ok >= 3: return True
    try: return simplify(a - b) == 0
    except Exception: return False

def no_constant(e):
    # Drop a constant of integration (C, K, c) from an antiderivative.
    return e.subs({Symbol(c, real=True): 0 for c in "CKc"})
`;

const SCRIPT = String.raw`
import json, sys
try:
    import sympy
except ImportError:
    print("UNAVAILABLE"); sys.exit(0)
A, B, V, UPC = json.loads(sys.stdin.read())
${PY_MATH}
try:
    x = var(V)
    b = parse(B, V)
    a = parse(A, V)
    # Up to a constant only makes sense for a non-constant key: "5" vs "3" is plain equality.
    upc = UPC and x in no_constant(b).free_symbols
    if upc:
        a, b = diff(a, x), diff(b, x)
    if (a - b).free_symbols - {x}:
        print("EQUAL" if simplify(a - b) == 0 else "DIFFERENT")
    else:
        print("EQUAL" if same(a, b, V) else "DIFFERENT")
except Exception as e:
    print("ERROR", str(e)[:200])
`;

export async function mathEquivalent(answer: string, expected: string, spec: MathSpec): Promise<MathVerdict> {
	if (typeof answer !== "string" || typeof expected !== "string") return "error";
	const input = JSON.stringify([answer, expected, spec.variable || "x", Boolean(spec.upToConstant)]);
	const r = await runCode("python", SCRIPT, input);
	const out = r.stdout.trim();
	if (out.startsWith("EQUAL")) return "equal";
	if (out.startsWith("DIFFERENT")) return "different";
	if (out.startsWith("ERROR")) return "error";
	return "unavailable";
}
