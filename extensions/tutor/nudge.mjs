#!/usr/bin/env node
// TutorBot daily nudge — run by launchd (see /nudges in the tutor extension).
// Reads Tutor/.data/progress.json and shows a macOS notification only when it
// is worth one: reviews due, an exam/deadline within a week, or no study for a
// few days. On Sundays it adds a one-line weekly summary.
//
// Usage: node nudge.mjs <vault-root> [--force]
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.argv[2];
const force = process.argv.includes("--force");
if (!root) process.exit(0);

let data;
try {
	data = JSON.parse(readFileSync(join(root, "Tutor", ".data", "progress.json"), "utf8"));
} catch {
	process.exit(0);
}

const now = Date.now();
const concepts = Object.values(data.concepts ?? {});
const due = concepts.filter((c) => c.attempts > 0 && c.due && Date.parse(c.due) <= now);
const bySubject = {};
for (const c of due) bySubject[c.subject] = (bySubject[c.subject] ?? 0) + 1;

const today = new Date(new Date().toISOString().slice(0, 10)).getTime();
const exams = (data.assessments ?? [])
	.filter((a) => !a.done)
	.map((a) => ({ ...a, days: Math.round((Date.parse(a.date) - today) / 86_400_000) }))
	.filter((a) => a.days >= 0 && a.days <= 7)
	.sort((a, b) => a.days - b.days);

const log = data.quizLog ?? [];
const last = log.length ? Date.parse(log[log.length - 1].ts) : 0;
const idleDays = last ? Math.floor((now - last) / 86_400_000) : 0;
const studiedToday = last && new Date(last).toDateString() === new Date().toDateString();

const lines = [];
let subtitle = "";
if (exams.length) {
	const e = exams[0];
	subtitle = `${e.subject} ${e.name} ${e.days === 0 ? "is today" : e.days === 1 ? "is tomorrow" : `in ${e.days} days`}`;
	lines.push(e.days <= 3 ? "Run a no-help /checkpoint and a practice set on its topics." : "Good time for interleaved review (/practice).");
}
if (due.length && !studiedToday) {
	const parts = Object.entries(bySubject).map(([s, n]) => `${s} ${n}`);
	lines.push(`${due.length} review${due.length === 1 ? "" : "s"} due (${parts.join(", ")}). About ${Math.max(5, due.length * 2)} minutes.`);
}
if (!due.length && !exams.length && idleDays >= 3) lines.push(`${idleDays} days since your last session. A short review keeps it fresh.`);
if (new Date().getDay() === 0) {
	const week = log.filter((r) => Date.parse(r.ts) >= now - 7 * 86_400_000 && ["check", "review", "checkpoint"].includes(r.purpose));
	if (week.length) {
		const ok = week.filter((r) => r.outcome === "correct").length;
		lines.push(`This week: ${week.length} answers, ${Math.round((100 * ok) / week.length)}% correct.`);
	}
}

if (!lines.length && !force) process.exit(0);
const message = lines.join(" ") || "Nothing due right now. Nice work.";
if (process.env.TUTORBOT_NUDGE_DRY) {
	console.log(`${subtitle ? `[${subtitle}] ` : ""}${message}`);
	process.exit(0);
}
const esc = (s) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
const script = `display notification "${esc(message)}" with title "TutorBot"${subtitle ? ` subtitle "${esc(subtitle)}"` : ""}`;
execFile("osascript", ["-e", script], () => process.exit(0));
