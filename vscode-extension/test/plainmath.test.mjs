// Math in the chat must always be typeset, even when it arrives as plain text
// ("-sqrt(9-x^2)/x - asin(x/3)") instead of LaTeX. Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { findPlainMath, isMathSubject, repairInputMath, repairMathEscapes } from "../../extensions/lib/plain-math.ts";

const require = createRequire(import.meta.url);
const PlainMath = require("../media/plainmath.js");
const katex = require("../media/vendor/katex.min.js");

const chatSrc = readFileSync(new URL("../media/chat.js", import.meta.url), "utf8");
const extSrc = readFileSync(new URL("../extension.js", import.meta.url), "utf8");
// The chat's own code/math splitter, so these tests track the real webview.
const SEGMENT = eval(/const SEGMENT = (\/.*\/g);/.exec(chatSrc)[1]);

const compiles = (tex) => {
  katex.renderToString(tex, { throwOnError: true });
  return true;
};
const mathSpans = (s) => [...s.matchAll(/\$([^$\n]+?)\$/g)].map((m) => m[1]);
const render = (s) => PlainMath.texifyOutside(s, SEGMENT);

test("answer keys and typed answers become LaTeX", () => {
  const cases = {
    "-sqrt(9-x^2)/x - asin(x/3)": "-\\frac{\\sqrt{9 - x^{2}}}{x} - \\arcsin\\left(\\frac{x}{3}\\right)",
    "-cscxcotx+c": "-\\csc x \\cot x + c",
    "e^tan(x)": "e^{\\tan x}",
    "sec^2(x)": "\\sec^{2} x",
    "x^2+3x-4": "x^{2} + 3 x - 4",
    "(x+1)^3": "\\left(x + 1\\right)^{3}",
    "|x-1|": "\\left|x - 1\\right|",
    "ln|x|+C": "\\ln \\left|x\\right| + C",
    "sin^-1(x/3)": "\\sin^{-1}\\left(\\frac{x}{3}\\right)",
    "-(1/3)cos(3x)+C": "-\\frac{1}{3} \\cos\\left(3 x\\right) + C",
    "-1/(x+1)^2": "-\\frac{1}{\\left(x + 1\\right)^{2}}",
    "sqrt(x)/2 + C": "\\frac{\\sqrt{x}}{2} + C",
    "e^(2x)": "e^{2 x}",
    "x != 2": "x \\ne 2",
    "x² + 1": "x^{2} + 1",
    "2π": "2 \\pi",
    "3*4": "3 \\cdot 4",
    "nlogn": "n \\log n",
    x: "x",
    "2": "2",
  };
  for (const [plain, tex] of Object.entries(cases)) {
    const a = PlainMath.answerTex(plain);
    assert.equal(a.kind, "tex", plain);
    assert.equal(a.tex, tex, plain);
    assert.ok(compiles(a.tex), plain);
  }
});

test("LaTeX answers pass through; code and words are left alone", () => {
  assert.deepEqual(PlainMath.answerTex("$\\frac{1}{x}$"), { kind: "rich" });
  assert.deepEqual(PlainMath.answerTex("\\frac{1}{x} + C"), { kind: "tex", tex: "\\frac{1}{x} + C" });
  for (const s of ["int[] a = new int[5];", "System.out.println(x)", "true", "converges", "for (int i = 0; i < n; i++)", "arr[i] * 2", "i++", '"hello"', "x.length", "O(n log n) time", "a, b and c"]) {
    assert.equal(PlainMath.answerTex(s).kind, "plain", s);
  }
});

test("plain math in prose is wrapped in $…$", () => {
  const cases = {
    "The answer is -sqrt(9-x^2)/x - asin(x/3).": "The answer is $-\\frac{\\sqrt{9 - x^{2}}}{x} - \\arcsin\\left(\\frac{x}{3}\\right)$.",
    "Recall that sec^2(x) * tan(x) is the derivative.": "Recall that $\\sec^{2} x \\tan x$ is the derivative.",
    "Use x = 3sin(theta) here.": "Use $x = 3 \\sin \\theta$ here.",
    "So 2 * sin(x) works": "So $2 \\sin x$ works",
    "Add x + 1 to both sides.": "Add $x + 1$ to both sides.",
    "- sin(x) is odd": "- $\\sin x$ is odd",
    "**x^2** is bold": "**$x^{2}$** is bold",
    "(see sqrt(2))": "(see $\\sqrt{2}$)",
    "about 1/2 of them": "about $\\frac{1}{2}$ of them",
    "so dx = 3cos(theta) dθ here": "so $d x = 3 \\cos \\theta d \\theta$ here",
    "The integral is ∫ cot^2(theta) dθ = -cot(theta) - theta + C.": "The integral is $\\int \\cot^{2} \\theta d \\theta = -\\cot \\theta - \\theta + C$.",
    "Differentiate: d/dx of x^3 is 3x^2.": "Differentiate: $\\frac{d}{dx}$ of $x^{3}$ is $3 x^{2}$.",
    "it integrates to ln|x|.": "it integrates to $\\ln \\left|x\\right|$.",
    "returns x*2 each time": "returns $x \\cdot 2$ each time",
    "Then x^2 do the rest": "Then $x^{2}$ do the rest", // "do" is not a differential
  };
  for (const [src, want] of Object.entries(cases)) assert.equal(render(src), want, src);
});

test("prose that isn't math is untouched", () => {
  for (const s of [
    "See https://a.com/b/c and/or the notes.",
    "Due 10/06/2026, w/o notes, n/a otherwise.",
    "The 1st and 2nd terms; a 3D plot.",
    "Pros - cons: it is a trade-off.",
    "A - B testing is common.",
    "It costs $5 and x^2 is cheap.", // stray $ — leave the line alone
    "Run `x = y*2` and `sin(x)` in code.",
    "```\ny = sin(x)^2\n```",
    "Already $x^2$ and $$\\int f$$ here.",
    "I think it is fine.",
    "| Rule | Result |\n| --- | --- |\n| power | works |", // markdown table
    "Write a loop and return arr.length / 2.",
    "Set count = count + 1 each time.",
  ]) {
    assert.equal(render(s), s, s);
  }
});

// Model-style messages: after rendering, the server's own plain-math detector
// must find nothing left outside $…$, and every $…$ must compile.
const CORPUS = [
  "Not quite. The correct answer is -sqrt(9-x^2)/x - asin(x/3).",
  "Let x = 3sin(theta), so dx = 3cos(theta) dθ and sqrt(9-x^2) = 3cos(theta).",
  "The integral becomes ∫ cot^2(theta) dθ = -cot(theta) - theta + C.",
  "Then e^tan(x) * sec^2(x) is the derivative of e^tan(x).",
  "We get ln|x| + C, since 1/x integrates to ln|x|.",
  "Differentiate: d/dx of x^3 is 3x^2.",
  "So csc(x)cot(x) is the derivative of -csc(x).",
  "Try u = x^2 + 1, then du = 2x dx.",
  "The limit of sin(x)/x as x approaches 0 is 1.",
  "Area = πr² for a circle of radius r.",
  "Since 9 - x^2 >= 0 we need |x| <= 3.",
  "Answer: (1/2)x^2 + 3x + C",
  "Check: 2*3 = 6 and 6/3 = 2.",
  "Hint: write tan^2(x) as sec^2(x) - 1.",
];

test("no raw math survives in model text", () => {
  for (const msg of CORPUS) {
    const out = render(msg);
    assert.deepEqual(findPlainMath(out), [], `${msg}\n→ ${out}`);
    for (const span of mathSpans(out)) assert.ok(compiles(span), span);
  }
});

// Random expressions in the plain syntax models and learners actually type.
test("random plain-math expressions always typeset", () => {
  let seed = 42;
  const rnd = (n) => ((seed = (seed * 1103515245 + 12345) % 2147483648), seed % n);
  const pick = (a) => a[rnd(a.length)];
  const FNS = ["sin", "cos", "tan", "sec", "csc", "cot", "ln", "log", "sqrt", "asin", "atan", "exp", "arcsin"];
  const gen = (d) => {
    if (d <= 0) return pick(["x", "y", "2", "3", "10", "pi", "t", "1.5"]);
    switch (rnd(8)) {
      case 0: return `${gen(d - 1)}${pick(["+", "-", " + ", " - "])}${gen(d - 1)}`;
      case 1: return `${gen(d - 1)}${pick(["*", "/", " * ", " / "])}${gen(d - 1)}`;
      case 2: return `${pick(["x", "e", "(x+1)", "2"])}^${pick(["2", "3", "(2x)", "x", "-1"])}`;
      case 3: return `${pick(FNS)}(${gen(d - 1)})`;
      case 4: return `${pick(["sin", "cos", "tan", "sec"])}^2(${gen(d - 1)})`;
      case 5: return `(${gen(d - 1)})`;
      case 6: return `-${gen(d - 1)}`;
      default: return `${pick(["2", "3", ""])}${pick(["x", "sin(x)", "sqrt(x)", "e^x"])}`;
    }
  };
  for (let i = 0; i < 3000; i++) {
    const expr = gen(1 + rnd(4));
    const a = PlainMath.answerTex(expr);
    assert.equal(a.kind, "tex", expr);
    assert.ok(compiles(a.tex), `${expr} → ${a.tex}`);
    const out = render(`The answer is ${expr}.`);
    assert.deepEqual(findPlainMath(out), [], `${expr}\n→ ${out}`);
  }
});

// The webview has to actually use the converter everywhere math is shown.
test("chat webview routes all math through the converter", () => {
  assert.match(extSrc, /src="\$\{uri\("plainmath\.js"\)\}"><\/script>\s*<script[^>]*src="\$\{uri\("chat\.js"\)\}"/, "plainmath.js loads before chat.js");
  assert.match(chatSrc, /function renderRich[\s\S]{0,200}texifyOutside\(/, "renderRich texifies prose");
  assert.match(chatSrc, /The correct answer is \$\{answerHtml\(/);
  assert.match(chatSrc, /Expected: \$\{answerHtml\(/);
  assert.match(chatSrc, /Not quite: \$\{answerHtml\(/);
  // No answer-ish value printed as raw code text.
  assert.doesNotMatch(chatSrc, /<code>\$\{esc\([^)]*(answer|expected|previous|correctAnswer|draft|txt|earlierTries|\bt\b)/i);
});

// The server-side gate bounces quiz calls with plain-text math. It must not
// bounce code, arrows or ordinary prose, and must not "repair" code.
test("plain-math gate: code and prose pass, real plain math is caught", () => {
  for (const s of [
    "So $x \\to 0$ → the limit is $1$.",
    "Find the integral of $x\\cos x$.",
    "What does a^b print in Java?",
    "Compute x*y where x=2",
    "Java: int r = n % 2; r*2",
    "See https://example.com/a/b?x=1&y=2^3",
    "Press Ctrl^C to stop.",
    "Big-O: O(n^2) comparisons",
    "Use log x to debug",
    "cos 2 points",
    "Rate is 5/s",
    "for (int i = 0; i <= 4; i++) {",
    "\tSystem.out.println(i * 2);",
    "Open file_name.txt and data_v2.csv",
  ]) assert.deepEqual(findPlainMath(s), [], s);
  for (const s of ["\\frac{1}{2} without dollars", "x_1 + x_2", "3x + 2 = 5", "e^tan(x) * sec^2(x)", "sin x over x", "x² + 1", "dy/dx", "sqrt(x)"])
    assert.notDeepEqual(findPlainMath(s), [], s);
});

test("escape repair only rebuilds real LaTeX commands, never code", () => {
  assert.equal(repairMathEscapes("$e^{\tan x}$"), "$e^{\\tan x}$");
  assert.equal(repairMathEscapes("$\theta + \frac{1}{2}$"), "$\\theta + \\frac{1}{2}$");
  assert.equal(repairMathEscapes("Output: $5\t$6"), "Output: $5\t$6"); // a real tab
  assert.equal(repairMathEscapes("Price is $5 and\tthe $total"), "Price is $5 and\tthe $total");
  const code = { question: "What prints?", details: 'if (x > 0) {\n\tSystem.out.println("$" + x);\n} else {\n\tSystem.out.println("-$" + (-x));\n}' };
  const before = code.details;
  repairInputMath(code);
  assert.equal(code.details, before);
  const typed = { question: "What prints?", acceptedAnswers: ["$5\t$6"], verify: { language: "java", code: 'System.out.println("$5\\t$6");' } };
  repairInputMath(typed);
  assert.deepEqual(typed.acceptedAnswers, ["$5\t$6"]);
  const mathQ = { question: "What is $\frac{d}{dx}$ of $\tan x$?" };
  repairInputMath(mathQ);
  assert.equal(mathQ.question, "What is $\\frac{d}{dx}$ of $\\tan x$?");
});

test("isMathSubject", () => {
  for (const s of ["Calc II", "Linear Algebra", "Statistics", "Physics 1"]) assert.equal(isMathSubject(s), true, s);
  for (const s of ["Java", "Intro to Python", "CS 101", "Data Structures", "", undefined]) assert.equal(isMathSubject(s), false, String(s));
});
