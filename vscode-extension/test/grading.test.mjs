// Grading: typed math answers, answer-key checks and the quiz tools' guards
// against wrong keys, giveaways and over-loose matching. Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

// quiz.ts imports @sinclair/typebox (installed only with pi): stub it, the
// tool schemas don't matter here.
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "@sinclair/typebox")
      return { url: "data:text/javascript,export const Type = new Proxy({}, { get: () => () => ({}) });", shortCircuit: true };
    return next(specifier, context);
  },
});

const { mathEquivalent } = await import("../../extensions/lib/math-equiv.ts");
const { checkComputedKey, checkMathKey, looksComputable } = await import("../../extensions/lib/math-key.ts");
const { reviewMemory } = await import("../../extensions/lib/fsrs.ts");
const quizExt = (await import("../../extensions/quiz.ts")).default;

const tools = {};
quizExt({ registerTool: (t) => (tools[t.name] = t) });

// Run a tool with a fake panel that answers from `replies` in order.
async function run(tool, params, replies = []) {
  const queue = [...replies];
  const asked = [];
  globalThis.__tutorbotBridge = {
    hasPanel: () => true,
    ask: async (kind, payload) => (asked.push({ kind, payload }), queue.shift() ?? {}),
  };
  const t = tools[tool];
  const r = await t.execute("id1", t.prepareArguments ? t.prepareArguments(params) : params, undefined, () => {}, {});
  return { text: r.content[0].text, details: r.details, asked };
}
const base = { subject: "S", concepts: ["c"], shuffle: false };
const opts = (...labels) => labels.map((label) => ({ label }));
const mc = (params, replies = [{ indices: [1], confidence: 2 }]) => run("quiz", { ...base, ...params }, replies);
// A typed question answered `answer` on every try.
const typed = (params, answer) => run("quiz_typed", { ...base, ...params }, [{ answer, confidence: 2 }, { answer }, { answer }, {}, {}]);
const eq = (a, b, spec = {}) => mathEquivalent(a, b, spec);

// ── 1. definite integrals and limits are key-checked ─────────────────────────
test("\\int_a^b and \\lim_{…} questions are computed and compared", async () => {
  assert.ok(looksComputable("Evaluate $\\int_0^1 x^2\\,dx$"));
  assert.ok(looksComputable("Evaluate $\\lim_{x\\to0} \\frac{\\sin x}{x}$"));
  assert.ok(!looksComputable("Which integer type is wider?"));
  const q = "Evaluate the definite integral: $\\int_0^{\\pi/2} \\sin^2(x) \\cos^3(x) \\, dx$";
  const wrong = await checkComputedKey(q, ["$\\frac{1}{2}$", "$\\frac{2}{15}$"], [1], "Answer: $\\frac{1}{2}$", false, "quiz");
  assert.match(wrong, /option 2/);
  assert.equal(await checkComputedKey(q, ["$\\frac{1}{2}$", "$\\frac{2}{15}$"], [2], "Answer: $\\frac{2}{15}$", false, "quiz"), undefined);
  assert.match(await checkComputedKey("Evaluate $\\lim_{x\\to0}\\frac{\\sin 3x}{x}$", ["1"], [1], "", false, "quiz_typed"), /limit is \$3\$/);
  assert.equal(await checkComputedKey("Evaluate $\\int_0^\\pi \\sin x\\,dx$", ["$2$", "$0$"], [1], "", false, "quiz"), undefined);
});

// ── 2. absolute values ───────────────────────────────────────────────────────
test("|…| is Abs: ln|x| keys pass, ln|x| and ln(x) both accepted for ∫1/x", async () => {
  const q = "Evaluate $\\int \\frac{1}{x}\\,dx$";
  assert.equal(await checkComputedKey(q, ["$\\ln|x| + C$", "$-\\frac{1}{x^2}+C$"], [1], "Answer: $\\ln|x| + C$", false, "quiz"), undefined);
  // With both offered, ln|x| (right on the whole domain) is the key, not ln(x).
  assert.equal(await checkComputedKey(q, ["$\\ln|x| + C$", "$\\ln(x) + C$"], [1], "", false, "quiz"), undefined);
  assert.match(await checkComputedKey(q, ["$\\ln|x| + C$", "$\\ln(x) + C$"], [2], "", false, "quiz"), /option 1/);
  assert.equal(await checkComputedKey(q, ["\\ln|x| + C"], [1], "", false, "quiz_typed"), undefined);
  assert.equal(await checkComputedKey("What is $\\int \\tan(x) \\, dx$?", ["\\ln|\\sec(x)| + C"], [1], "", false, "quiz_typed"), undefined);
  const up = { upToConstant: true };
  assert.equal(await eq("\\ln|x| + C", "\\ln|x| + C", up), "equal");
  assert.equal(await eq("log(abs(x))+C", "\\ln|x| + C", up), "equal");
  assert.equal(await eq("ln(x) + C", "\\ln|x| + C", up), "equal");
  assert.equal(await eq("ln|x+1| + C", "\\ln|x| + C", up), "different");
  // d/dx √(x²) = x/|x|, not 1.
  const d = "What is $\\frac{d}{dx}\\left[\\sqrt{x^2}\\right]$?";
  assert.equal(await checkComputedKey(d, ["$1$", "$\\frac{x}{|x|}$"], [2], "", false, "quiz"), undefined);
  assert.match(await checkComputedKey(d, ["$1$", "$\\frac{x}{|x|}$"], [1], "", false, "quiz"), /option 2/);
  assert.equal(await eq("\\sqrt{x^2}", "x"), "different");
  assert.equal(await eq("sqrt(x^2)", "|x|"), "equal");
});

// ── 3. higher derivatives ────────────────────────────────────────────────────
test("second / nth derivatives are differentiated n times or left alone", async () => {
  for (const q of ["Find the second derivative of $x^3$.", "What is $\\frac{d^2}{dx^2}\\left[x^3\\right]$?", "Find $f''(x)$ if $f(x) = x^3$.", "What is $\\frac{d^2y}{dx^2}$ for $y = x^3$?"]) {
    assert.equal(await checkComputedKey(q, ["$6x$", "$3x^2$"], [1], "", false, "quiz"), undefined, q);
    assert.match(await checkComputedKey(q, ["$6x$", "$3x^2$"], [2], "", false, "quiz"), /option 1/, q);
  }
  assert.equal((await checkMathKey("Find the nth derivative of $e^{2x}$.", ["2^n e^{2x}"])).status, "unrecognized");
  assert.equal((await checkMathKey("Find the antiderivative of $2x$.", ["x^2 + C"])).kind, "integral");
});

// ── 4. inverse trig ──────────────────────────────────────────────────────────
test("tan^{-1} is arctan, not 1/tan", async () => {
  assert.equal(await eq("tan^{-1}(x)", "cot(x)"), "different");
  assert.equal(await eq("\\tan^{-1} x", "\\arctan(x)"), "equal");
  assert.equal(await eq("sin^{-1}(x)", "arcsin(x)"), "equal");
  assert.equal(await eq("\\sin^{-1}(x)", "\\csc x"), "different");
  assert.equal(await checkComputedKey("Evaluate $\\int \\frac{1}{1+x^2}\\,dx$", ["$\\tan^{-1}(x) + C$", "$\\ln(1+x^2)+C$"], [1], "", false, "quiz"), undefined);
});

// ── 5. verify: compile error vs runtime exception ────────────────────────────
test("a runtime exception doesn't satisfy a 'Compile error' key", async () => {
  const code = "System.out.println(1/0);";
  const q = { question: "What happens?", options: opts("ArithmeticException", "Compile error", "Prints 0"), verify: { language: "java", code } };
  const bad = await mc({ ...q, explanation: "Answer: Compile error", correctAnswer: "Compile error" });
  assert.equal(bad.details.status, "unavailable");
  assert.match(bad.text, /correct option is "ArithmeticException"/);
  const good = await mc({ ...q, explanation: "Answer: ArithmeticException", correctAnswer: "ArithmeticException" });
  assert.equal(good.details.status, "answered");
  const named = await mc({ question: "What happens?", options: opts("NullPointerException", "Prints 0"), explanation: "Answer: NullPointerException", correctAnswer: "NullPointerException", verify: { language: "java", code } });
  assert.equal(named.details.status, "unavailable");
});

// ── 6. the learner's answer is never run as code ─────────────────────────────
test("code in a typed answer is refused and never executed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tutorbot-rce-"));
  const flag = join(dir, "PWNED");
  try {
    for (const payload of [`__import__('os').system('touch ${flag}')`, `(lambda: __import__('os').system('touch ${flag}'))()`, `x + getattr(x, 'subs')`]) {
      assert.notEqual(await eq(payload, "x"), "equal", payload);
      assert.ok(!existsSync(flag), payload);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  assert.equal(await eq("diff(x^3,x)", "3x^2"), "error");
  assert.equal(await eq("integrate(2*x,x)", "x^2", { upToConstant: true }), "error");
  assert.equal(await eq("Derivative(x**3,x).doit()", "3x^2"), "error");
  assert.equal(await eq("3x^2", "3x^2"), "equal");
});

// ── 7. tolerance and +C ──────────────────────────────────────────────────────
test("+C only counts for antiderivatives; tolerance is relative; no booleans", async () => {
  assert.equal(await eq("2x + C", "2x"), "different");
  assert.equal(await eq("x^2 + C", "x^2 + C", { upToConstant: true }), "equal");
  assert.equal(await eq("x^2", "x^2 + C", { upToConstant: true }), "equal");
  assert.equal(await eq("x + 1e-9", "x"), "different");
  assert.equal(await eq("1.0000000001", "1"), "different");
  assert.equal(await eq("0", "1e-9*x"), "different");
  assert.equal(await eq("True", "1"), "error");
  assert.equal(await eq("0.5", "1/2"), "equal");
  // A constant key isn't "up to a constant": any number would pass.
  assert.equal(await eq("5", "3", { upToConstant: true }), "different");
  assert.equal(await eq("3", "3", { upToConstant: true }), "equal");
});

// ── 8. right answers in other notations ──────────────────────────────────────
test("prefixes, implicit application, unicode, roots and log bases parse", async () => {
  for (const [a, b] of [
    ["Answer: 12", "12"], ["f'(x) = 2x", "2x"], ["dy/dx = 2x", "2x"], ["y = 2x", "2x"],
    ["\\sin^2 x", "1 - cos(x)^2"], ["\\cos^4 x", "cos(x)^4"], ["e^{\\tan x}\\sec^2 x", "exp(tan(x))*sec(x)^2"],
    ["sinx", "sin(x)"], ["x³/3", "x^3/3"], ["½", "1/2"], ["1,000", "1000"], ["\\sqrt[3]{x}", "x^(1/3)"],
    ["\\log_2 x", "ln(x)/ln(2)"], ["2\\sin x\\cos x", "sin(2x)"], ["12.0", "12"],
  ]) assert.equal(await eq(a, b), "equal", `${a} vs ${b}`);
  for (const [a, b] of [["sin x^2", "sin(x)^2"], ["2,5", "2.5"], ["12 or 13", "12"], ["x^2, x^3", "x^2"]]) assert.notEqual(await eq(a, b), "equal", `${a} vs ${b}`);
  assert.equal(await checkComputedKey("What is $\\frac{d}{dx}[\\cos^4 x]$?", ["-4\\cos^3 x \\sin x"], [1], "", false, "quiz_typed"), undefined);
  // Typed, no math spec: 12.0 = 12 and "Answer: 12" for a numeric key.
  for (const t of ["12.0", "Answer: 12", "12"]) assert.equal((await typed({ question: "What is $3 \\cdot 4$?", acceptedAnswers: ["12"], explanation: "Answer: 12" }, t)).details.correct, true, t);
  assert.equal((await typed({ question: "What is $3 \\cdot 4$?", acceptedAnswers: ["12"], explanation: "Answer: 12" }, "13")).details.correct, false);
});

// ── 9. program output is graded exactly ──────────────────────────────────────
test("verify output: case, quotes and $ count; prose stays lenient", async () => {
  const java = (code) => ({ question: "What does this print?", explanation: "Trace it.", verify: { language: "java", code } });
  assert.equal((await typed(java('System.out.println(3 > 2);'), "True")).details.correct, false);
  assert.equal((await typed(java('System.out.println(3 > 2);'), "true")).details.correct, true);
  assert.equal((await typed(java('System.out.println("Hello");'), "HELLO")).details.correct, false);
  assert.equal((await typed(java('System.out.println("Hello");'), '"Hello"')).details.correct, false);
  assert.equal((await typed(java('System.out.println("a");'), "a (on separate lines)")).details.correct, false);
  assert.equal((await typed(java('System.out.println(1);\nSystem.out.println(2);'), "1\n2")).details.correct, true);
  // Prose: case-insensitive, $…$ delimiters ignored — but a lone "$5" is not "5".
  const prose = { question: "Name the keyword that ends a loop early.", acceptedAnswers: ["break"], explanation: "Answer: break" };
  assert.equal((await typed(prose, "Break")).details.correct, true);
  assert.equal((await typed({ question: "How much?", acceptedAnswers: ["$5"], explanation: "Answer: $5" }, "5")).details.correct, false);
  // "?" as the KEY is an answer, not "I don't know".
  const r = await typed({ question: "Which character ends a Java ternary's condition?", acceptedAnswers: ["?"], explanation: "Answer: ?" }, "?");
  assert.equal(r.details.dontKnow, false);
  assert.equal(r.details.correct, true);
  assert.equal((await typed(prose, "?")).details.dontKnow, true);
});

// ── 10. multiple-choice gaps ─────────────────────────────────────────────────
test("MC: multiSelect verify, empty asserts, duplicates, 'all of the above', missing Answer line", async () => {
  const ms = { question: "Which values are printed?", multiSelect: true, options: opts("1", "2", "3"), explanation: "x", verify: { language: "python", code: "print(1)\nprint(3)" } };
  assert.equal((await mc({ ...ms, correctAnswer: ["1", "2"] })).details.status, "unavailable");
  assert.equal((await mc({ ...ms, correctAnswer: ["1", "3"] }, [{ indices: [1, 3], confidence: 2 }])).details.correct, true);

  const am = { question: "What is $7 \\cdot 8$?", options: opts("54", "56"), explanation: "Answer: 56", correctAnswer: "56" };
  assert.match((await mc({ ...am, verify: { language: "python", mode: "assert", code: "x = 1" } })).text, /checks nothing/);
  assert.match((await mc({ ...am, verify: { language: "python", mode: "assert", code: "assert 7 * 8 == 7 * 8" } })).text, /never mentions your key/);
  assert.equal((await mc({ ...am, verify: { language: "python", mode: "assert", code: "assert 7 * 8 == 56" } })).details.status, "answered");

  assert.match((await mc({ question: "q?", options: [{ label: "6", value: "a" }, { label: "6", value: "b" }], explanation: "Answer: 6", correctAnswer: "a" })).text, /same label/);
  assert.match((await mc({ question: "Which are loops?", options: opts("for", "while", "All of the above"), explanation: "Answer: All of the above", correctAnswer: "All of the above" })).text, /concrete answer/);

  const arr = { question: "What is `a[1]` for `int[] a = {5, 6, 7}`?", options: opts("5", "6", "7") };
  assert.match((await mc({ ...arr, explanation: "Arrays are zero-indexed.", correctAnswer: "5" })).text, /no final `Answer:/);
  assert.match((await mc({ ...arr, explanation: "So the answer is 5, not 6.", correctAnswer: "6" })).text, /self-contradiction/);
  assert.match((await mc({ ...arr, explanation: "Zero-indexed.\nAnswer: 6", correctAnswer: "5" })).text, /self-contradiction/);
  assert.equal((await mc({ ...arr, explanation: "Zero-indexed, so the second element.\nAnswer: 6", correctAnswer: "6" }, [{ indices: [2], confidence: 2 }])).details.correct, true);
});

// ── 11. giveaways ────────────────────────────────────────────────────────────
test("hints/details/question may not reveal the answer", async () => {
  const q = { question: "What is $6 \\cdot 2$?", acceptedAnswers: ["12"], explanation: "Answer: 12" };
  assert.match((await typed({ ...q, hints: ["The answer is 12"] }, "12")).text, /gives the answer away/);
  assert.match((await typed({ ...q, details: "Hint: it's 12" }, "12")).text, /contains the answer/);
  assert.match((await typed({ ...q, hints: ["Multiply to get 12"] }, "12")).text, /contains the answer/);
  assert.equal((await typed({ ...q, hints: ["Think of 6 + 6."] }, "12")).details.correct, true);
  const calc = { question: "Evaluate $\\int x\\sin x\\,dx$. Type your answer (e.g. `-x cos(x) + sin(x) + C`).", acceptedAnswers: ["-x\\cos x + \\sin x + C"], math: { upToConstant: true }, explanation: "Answer: $-x\\cos x + \\sin x + C$" };
  assert.match((await typed(calc, "x")).text, /shows the answer/);
  assert.equal((await typed({ ...calc, question: "Evaluate $\\int x\\sin x\\,dx$. Type it like `3x^2 + C`." }, "-x cos(x) + sin(x) + C")).details.correct, true);
  // Program text in details is not a giveaway.
  const code = 'int x = 12;\nSystem.out.println("Answer: " + x);';
  assert.equal((await typed({ question: "What does this print?", details: code, explanation: "Trace it.", verify: { language: "java", code } }, "Answer: 12")).details.correct, true);
  // MC: details stating the key.
  assert.match((await mc({ question: "What prints?", details: "(it's 6)", options: opts("5", "6"), explanation: "Answer: 6", correctAnswer: "6" })).text, /contains the answer/);
});

// ── 12. FSRS ─────────────────────────────────────────────────────────────────
test("a future timestamp doesn't freeze scheduling", () => {
  const now = new Date();
  let m = reviewMemory(undefined, 3, new Date("2030-01-01T00:00:00Z"));
  assert.ok(Date.parse(m.last_review) <= Date.now() + 1000);
  m = reviewMemory({ ...m, last_review: "2030-01-01T00:00:00Z", due: "2030-02-01T00:00:00Z" }, 1, now);
  assert.ok(Date.parse(m.last_review) <= Date.now() + 1000, m.last_review);
  assert.ok(Date.parse(m.due) < Date.parse("2029-01-01"), m.due);
  // Out-of-order past reviews still can't go back in time.
  const a = reviewMemory(undefined, 3, new Date(now.getTime() - 86400e3));
  const b = reviewMemory(a, 3, new Date(now.getTime() - 3 * 86400e3));
  assert.ok(Date.parse(b.last_review) >= Date.parse(a.last_review));
});

// ── 14. input prompts in verify output ───────────────────────────────────────
test("a verify program that prints an input prompt is refused at creation", async () => {
  const code = 'java.util.Scanner sc = new java.util.Scanner(System.in);\nSystem.out.print("Enter your age: ");\nint age = sc.nextInt();\nSystem.out.println(age < 18 ? "You are a minor." : "You are an adult.");';
  const r = await typed({ question: "What does this print for input 15?", explanation: "15 < 18", verify: { language: "java", code, stdin: "15" } }, "You are a minor.");
  assert.equal(r.details.status, "unavailable");
  assert.match(r.text, /input prompt \("Enter your age:"\)/);
  const noPrompt = code.replace('System.out.print("Enter your age: ");\n', "");
  assert.equal((await typed({ question: "What does this print for input 15?", explanation: "15 < 18", verify: { language: "java", code: noPrompt, stdin: "15" } }, "You are a minor.")).details.correct, true);
  const py = await mc({ question: "Output for input 3?", options: opts("9", "Enter n: 9"), explanation: "Answer: 9", correctAnswer: "9", verify: { language: "python", code: "n = int(input('Enter n: '))\nprint(n * n)", stdin: "3" } });
  assert.match(py.text, /input prompt/);
});

// ── 15. option letters ───────────────────────────────────────────────────────
test("model-written A./B) prefixes are stripped; the key still maps", async () => {
  const r = await mc({ question: "Which keyword exits a loop?", options: opts("A. continue", "B. break", "C) return", "(D) exit"), explanation: "Answer: break", correctAnswer: "B" }, [{ indices: [2], confidence: 2 }]);
  assert.deepEqual(r.asked[0].payload.options.map((o) => o.label), ["continue", "break", "return", "exit"]);
  assert.equal(r.details.correct, true);
  const byLabel = await mc({ question: "Which keyword exits a loop?", options: opts("A. continue", "B. break"), explanation: "Answer: B. break", correctAnswer: "B. break" }, [{ indices: [2], confidence: 2 }]);
  assert.equal(byLabel.details.correct, true);
  // Not every option lettered: labels are left alone.
  const mixed = await mc({ question: "Pick one", options: opts("a) is wrong", "neither"), explanation: "Answer: neither", correctAnswer: "neither" }, [{ indices: [2], confidence: 2 }]);
  assert.equal(mixed.asked[0].payload.options[0].label, "a) is wrong");
});
