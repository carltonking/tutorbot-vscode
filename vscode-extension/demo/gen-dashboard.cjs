// Made-up "Calculus I" progress for the demo's dashboard scene, built with the
// dashboard's own data code. Writes demo/build/dashboard-data.json.
"use strict";
const fs = require("fs");
const path = require("path");
const { build } = require("../lib/dashboard-data.js");

const SUBJECT = "Calculus I";
const now = new Date("2026-10-05T15:00:00");
const daysAgo = (d, h = 0) => new Date(now.getTime() - d * 86400000 - h * 3600000).toISOString();

const topics = [
  ["limits", "Limits & continuity", "Unit 1 · Limits"],
  ["limit-laws", "Limit laws", "Unit 1 · Limits"],
  ["deriv-def", "Definition of the derivative", "Unit 2 · Derivatives"],
  ["power-rule", "Power & sum rules", "Unit 2 · Derivatives"],
  ["product-quotient", "Product & quotient rules", "Unit 2 · Derivatives"],
  ["chain-rule", "Chain rule", "Unit 2 · Derivatives"],
  ["implicit", "Implicit differentiation", "Unit 2 · Derivatives"],
  ["related-rates", "Related rates", "Unit 3 · Applications"],
  ["optimization", "Optimization", "Unit 3 · Applications"],
  ["integrals", "Antiderivatives", "Unit 4 · Integrals"],
];

// [name, topic, taught days ago, answers: [daysAgo, outcome, purpose, confidence, hints]]
const concepts = [
  ["Limit of a polynomial", "limits", 30, [[30, "correct", "check", 3], [22, "correct", "review", 3], [9, "correct", "checkpoint", 3]]],
  ["One-sided limits", "limits", 29, [[29, "incorrect", "check", 2], [28, "correct", "check", 2], [18, "correct", "review", 3]]],
  ["Limit laws", "limit-laws", 27, [[27, "correct", "check", 2, 1], [20, "correct", "review", 3]]],
  ["Derivative as a limit", "deriv-def", 21, [[21, "correct", "check", 2], [14, "correct", "review", 3], [6, "correct", "checkpoint", 3]]],
  ["Power rule", "power-rule", 19, [[19, "correct", "check", 3], [12, "correct", "review", 3], [5, "correct", "review", 3]]],
  ["Product rule", "product-quotient", 12, [[12, "incorrect", "check", 3], [12, "correct", "check", 2], [6, "correct", "review", 2]]],
  ["Quotient rule", "product-quotient", 10, [[10, "correct", "check", 1, 1], [4, "incorrect", "review", 3]]],
  ["Chain rule", "chain-rule", 0, [[0, "correct", "check", 3]]],
];

const progress = { version: 1, concepts: {}, quizLog: [], assessments: [{ id: "midterm", subject: SUBJECT, name: "Midterm 1", date: "2026-10-16", kind: "exam", topics: "Units 1–2" }] };
const slug = (t) => t.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
for (const [name, topic, taught, answers] of concepts) {
  const id = `${slug(SUBJECT)}/${slug(name)}`;
  progress.concepts[id] = {
    id,
    subject: SUBJECT,
    name,
    status: "learning",
    taughtAt: daysAgo(taught, 1),
    box: 1,
    attempts: answers.length,
    correct: answers.filter((a) => a[1] === "correct").length,
    lastSeen: daysAgo(answers[answers.length - 1][0]),
    topic,
    family: "derivative rules",
  };
  for (const [d, outcome, purpose, confidence, hintsUsed] of answers) {
    progress.quizLog.push({ ts: daysAgo(d), subject: SUBJECT, concepts: [name], question: `${name} question`, purpose, kind: "choice", outcome, confidence, hintsUsed: hintsUsed || 0 });
  }
}

const data = build({
  progress,
  subjects: [{ name: SUBJECT, folders: ["MATH 151"] }],
  maps: { [SUBJECT]: { subject: SUBJECT, topics: topics.map(([id, title, unit], order) => ({ id, title, unit, order })) } },
  links: {},
  now,
});
for (const s of data.subjects) s.hasFolder = true;
const out = path.join(__dirname, "build", "dashboard-data.json");
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(data));
console.log(`dashboard data: ${data.subjects.length} subject(s), ${data.subjects[0].units.length} units → ${path.relative(process.cwd(), out)}`);
