// A reply that announces a question and then stops ("Now let's test it:")
// gets a nudge to finish. Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { endsOnLeadIn } from "../../extensions/lib/plain-math.ts";

test("replies that stop on an announcement are caught", () => {
  for (const t of [
    "**Answer: $3$**\n\n---\n\nNow let's test it:",
    "Great work.\n\nNow let's test it:\n\n---\n",
    "**Let's try one more:**",
    "That's the chain rule.\n\nLet's practice with another problem.",
    "Here's a quick check question.",
    "Okay, now I'll quiz you on that.",
    "Moving on to the next question.",
    "Now let's try **Problem 1** from your `6.3_problems.pdf`. Let me read it first.",
    "Next, let's see if you can apply it.",
  ]) assert.equal(endsOnLeadIn(t), true, t);
});

test("finished replies are left alone", () => {
  for (const t of [
    "",
    "**Answer: $3$**",
    "Want to try another one?",
    "Let me know if you want to try another problem.",
    "We'll practice this next time.",
    "So the limit is $3$. Nice work today.",
    "Let's try one more: what is $\\lim_{x\\to 0} \\frac{\\sin 5x}{x}$?",
    "```python\nfor x in y:\n```",
    "What does this print?\n\n```java\nint x = 5;\n```\n\n**Your answer:**",
  ]) assert.equal(endsOnLeadIn(t), false, t);
});
