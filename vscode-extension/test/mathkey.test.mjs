// Quiz answer keys for derivatives, integrals and limits are checked with sympy
// before the learner sees them. Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkComputedKey } from "../../extensions/lib/math-key.ts";

const Q = "Using the quotient rule, what is $\\frac{d}{dx}\\left[\\frac{3x-1}{x+1}\\right]$?";
const quiz = (q, opts, key, expl = "") => checkComputedKey(q, opts, key, expl, false, "quiz");

test("no correct option is caught (the screenshot's question)", async () => {
  const err = await quiz(Q, ["$\\frac{3x-2}{(x+1)^2}$", "$\\frac{3x+2}{(x+1)^2}$", "$\\frac{2x}{x+1}$", "$\\frac{3}{(x+1)^2}$"], [1], "Answer: $\\frac{3x-2}{(x+1)^2}$");
  assert.match(err, /NONE of the options is correct/);
  assert.match(err, /\\frac\{4\}/);
});

test("a wrong key is caught and the right option named", async () => {
  const err = await quiz(Q, ["$\\frac{3}{(x+1)^2}$", "$\\frac{4}{(x+1)^2}$"], [1]);
  assert.match(err, /option 2/);
});

test("a correct key passes", async () => {
  assert.equal(await quiz(Q, ["$\\frac{3}{(x+1)^2}$", "$\\frac{4}{(x+1)^2}$"], [2], "**Answer:** $\\frac{4}{(x+1)^2}$"), undefined);
  assert.equal(await quiz("Evaluate $\\lim_{x \\to 0} \\frac{\\sin(3x)}{x}$", ["$0$", "$1$", "$3$", "$\\infty$"], [3]), undefined);
  assert.equal(await quiz("Evaluate $\\int \\cos^2(x) \\, dx$", ["$\\frac{x}{2} + \\frac{\\sin(2x)}{4} + C$", "$\\sin^2(x) + C$"], [1]), undefined);
});

test("an explanation that ends on the wrong answer is caught", async () => {
  const err = await quiz(Q, ["$\\frac{3}{(x+1)^2}$", "$\\frac{4}{(x+1)^2}$"], [2], "Answer: $\\frac{3}{(x+1)^2}$");
  assert.match(err, /explanation's final answer/);
});

test("typed answers are checked too", async () => {
  const err = await checkComputedKey("Find the derivative of $f(x) = \\sin(x^2)$.", ["cos(x^2)"], [1], "", false, "quiz_typed");
  assert.match(err, /2 x \\cos/);
});

test("two equivalent options are caught", async () => {
  const err = await quiz("What is $\\int \\frac{1}{\\sqrt{1 - x^2}} \\, dx$?", ["$-\\arccos(x) + C$", "$\\arcsin(x) + C$", "$\\arctan(x) + C$"], [2]);
  assert.match(err, /more than one correct option/);
});

test("word options and non-computable questions are left alone", async () => {
  assert.equal(await quiz("Which rule do you use for $\\frac{d}{dx}\\left[\\frac{x}{x+1}\\right]$?", ["Quotient rule", "Chain rule"], [1]), undefined);
  assert.equal(await quiz("At $x = 3$, is $f(x) = \\frac{x^2 - 9}{x - 3}$ continuous?", ["Yes", "No"], [2]), undefined);
});
