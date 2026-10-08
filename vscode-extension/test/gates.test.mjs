// TutorBot's teaching gates: pure checks (lib/gates.ts), the store's evidence
// rules (lib/tutor-store.ts), and the tutor extension's tool_call /
// message_end / before_agent_start handlers driven with a fake pi.
// Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as G from "../../extensions/lib/gates.ts";
import { conceptKey, TutorStore } from "../../extensions/lib/tutor-store.ts";
import { SubjectRegistry } from "../../extensions/lib/subjects.ts";
import { coerceList } from "../../extensions/lib/coerce.ts";

// The tutor extension imports pi and typebox, which only exist inside pi.
register(
	`data:text/javascript,${encodeURIComponent(`
export async function resolve(spec, ctx, next) {
	if (spec === "@mariozechner/pi-coding-agent") return { url: "data:text/javascript,export const SessionManager = {};", shortCircuit: true };
	if (spec === "@sinclair/typebox") return { url: "data:text/javascript," + encodeURIComponent("const f = () => ({}); export const Type = new Proxy({}, { get: () => f });"), shortCircuit: true };
	return next(spec, ctx);
}`)}`,
);
const { default: tutor } = await import("../../extensions/tutor/index.ts");

const tmp = () => mkdtempSync(join(tmpdir(), "tutorgates-"));
const now = () => new Date().toISOString();
const A = (text, calls = []) => ({ type: "message", message: { role: "assistant", content: [{ type: "text", text }, ...calls.map(([id, name, args]) => ({ type: "toolCall", id, name, arguments: args }))] } });
const U = (text) => ({ type: "message", message: { role: "user", content: text } });
const R = (id, toolName, details, isError = false) => ({ type: "message", message: { role: "toolResult", toolCallId: id, toolName, details, isError } });
const filler = (n) => "This explains the idea in plain words and says why it works. ".repeat(n);

// A real lesson: explanation + two worked examples with several lines of working.
const REAL_LESSON =
	`## While loops\nA while loop repeats a block as long as its condition is true. ${filler(6)}\n\n` +
	"**Example 1:** count down from 3.\n```java\nint n = 3;\nwhile (n > 0) {\n    System.out.println(n);\n    n = n - 1;\n}\n```\nEach pass prints n, then lowers it by one, so the loop stops once n reaches 0.\n\n" +
	"**Example 2:** add up 1 to 4.\n```java\nint i = 1;\nint sum = 0;\nwhile (i <= 4) {\n    sum = sum + i;\n    i = i + 1;\n}\nSystem.out.println(sum);\n```\nThe sum grows 1, 3, 6, 10 and the loop ends when i becomes 5.";

// ── Pure gates ──────────────────────────────────────────────────────────────

test("frustration: curly apostrophes, frustrated/frustrating, lost, doesn't make sense", () => {
	for (const s of ["I'm frustrated", "this is frustrating", "I am lost", "I don’t get it", "this doesn't make sense", "im lost", "ugh"]) assert.ok(G.distressKind(s), s);
	for (const s of ["ok thanks", "/stuck", "what's next?", "can you tell me the answer format they want?"]) assert.equal(G.distressKind(s), undefined, s);
});

test("distress: show vs parallel-example routing", () => {
	assert.equal(G.distressKind("just show me"), "show");
	assert.equal(G.distressKind("I give up, just tell me"), "show");
	// confusion (even "confusing X") and frustration get a parallel example, never the solution
	assert.equal(G.distressKind("I'm confusing for and while, which is which?"), "confused");
	assert.equal(G.distressKind("I'm frustrated"), "confused");
	// their graded homework is never solved for them
	assert.equal(G.distressKind("what's the answer to number 3 on my worksheet?"), "confused");
	assert.equal(G.distressKind("just tell me the answer to my homework"), "confused");
});

test("move-on requests must be explicit", () => {
	for (const s of ["let's move on", "skip this topic", "next topic please", "Move on", "ok, let's move on", "can we move on?", "skip ahead please", "got it, next"]) assert.ok(G.MOVE_ON_REQUEST.test(s), s);
	for (const s of ["ok I get it", "I know it's confusing but can you explain again?", "Do I understand this correctly: x is 3?", "can we go on to the example?", "I get it now", "I already know this"]) assert.ok(!G.MOVE_ON_REQUEST.test(s), s);
});

test("ask_user_question: 'you' doesn't exempt questions with a right answer", () => {
	for (const s of ["What do you think 2+2 is?", "Can you tell me what the derivative of x^2 is?", "What is 2+2?", "How would you compute 3*4?", "Ready for a quick question: what is 5/2 in Java?", "What does `System.out.println(5/2);` print?", "How many times does the loop run?"])
		assert.ok(G.looksLikeKnowledgeCheck(s), s);
	for (const s of ["Are you ready to move on?", "What's your goal for this week?", "Which do you prefer: examples or practice first?", "Do you want to practice 2+2 style problems?", "Which topic should we do next?"]) assert.ok(!G.looksLikeKnowledgeCheck(s), s);
});

test("concept keys: aliases match, extra words don't", () => {
	assert.equal(conceptKey("String basics"), conceptKey("strings"));
	assert.equal(conceptKey("For Loops"), conceptKey("for-loop"));
	assert.equal(conceptKey("classes"), conceptKey("class"));
	assert.equal(conceptKey("integer division in Java"), conceptKey("integer division"));
	assert.notEqual(conceptKey("nested loops"), conceptKey("loops"));
	assert.notEqual(conceptKey("while loops"), conceptKey("loops"));
	assert.notEqual(conceptKey("string methods"), conceptKey("strings"));
});

test("fake lessons fail; real lessons (code or inline math, any heading style) pass", () => {
	const gaps = (t, names = ["while loops"]) => G.lessonGaps(G.lessonEvidence(t, names));
	assert.ok(gaps("Example 1: $$x$$\nExample 2: $$y$$\n" + "Lorem ipsum ".repeat(45)).length, "empty labelled examples");
	assert.ok(gaps("Example 1:\n```\n```\nExample 2:\n```\n.\n```" + " filler".repeat(80)).length, "empty code blocks");
	assert.ok(gaps("$$ $$ $$ $$ $$ $$ $$ $$" + "a".repeat(500)).length, "four empty display blocks");
	assert.deepEqual(gaps(REAL_LESSON), []);
	// the lesson must name what it teaches
	assert.match(gaps(REAL_LESSON, ["recursion"]).join(" "), /never mentioned: recursion/);
	const inline =
		`The power rule: to differentiate $x^n$, bring the exponent down and lower it by one. ${filler(6)}\n` +
		"**Worked Example 1** Differentiate $x^3$.\nStep 1: the exponent is $n = 3$, so bring it down: $3x^{3-1}$.\nStep 2: simplify the exponent: $3x^2$.\nSo $\\frac{d}{dx}x^3 = 3x^2$, using the power rule exactly once.\n\n" +
		"Ex. 2 Differentiate $5x^4$.\nStep 1: a constant factor stays put: $5 \\cdot \\frac{d}{dx}x^4$.\nStep 2: the power rule gives $5 \\cdot 4x^3$.\nStep 3: multiply: $20x^3$, so the constant just rides along.";
	assert.deepEqual(gaps(inline, ["power rule"]), []);
	assert.equal(G.lessonEvidence("Worked problem 1:\nfoo\nWorked problem 2:\nbar").labelled, 2);
	assert.equal(G.lessonEvidence("For example, a loop repeats.\nExample usage below").labelled, 0);
});

test("a no-op mark_taught doesn't reset the lesson window", () => {
	const branch = [
		A("lesson", [["m1", "mark_taught", { concepts: [{ name: "loops" }] }]]),
		R("m1", "mark_taught", { concepts: ["loops"], fresh: ["loops"] }),
		A("probe", [["q1", "quiz", { purpose: "diagnostic", concepts: ["arrays"] }]]),
		R("q1", "quiz", { status: "answered", correct: true }),
		A("again", [["m2", "mark_taught", { concepts: [{ name: "loops" }] }]]),
		R("m2", "mark_taught", { concepts: ["loops"], fresh: [] }),
	];
	const l = G.lessonSinceLastMark(branch);
	assert.equal(l.start, 2);
	assert.equal(l.probes, 1);
	assert.deepEqual(l.taught, ["loops"]);
	assert.equal(G.probesOn(branch, "array"), 1);
});

test("solution leak: pasted solution detected, parallel example not", () => {
	const sol = "import java.util.Scanner;\npublic class Main {\n  public static void main(String[] args) {\n    Scanner sc = new Scanner(System.in);\n    String s = sc.nextLine();\n    int n = s.length();\n    char last = s.charAt(n - 1);\n    System.out.println(last);\n  }\n}";
	assert.ok(G.leaksSolution(sol, "Here you go:\n```java\nString s = sc.nextLine();\nint n = s.length();\nchar last = s.charAt(n - 1);\nSystem.out.println(last);\n```"));
	assert.ok(G.leaksSolution(sol, "```java\nint  n = s.length() ;\nchar last = s.charAt(n-1);\nSystem.out.println(last);\n```"), "whitespace-insensitive");
	assert.ok(!G.leaksSolution(sol, "```java\nString w = sc.nextLine();\nchar first = w.charAt(0);\nSystem.out.println(first);\n```"), "parallel example");
	assert.deepEqual(G.hintsWithSolutionLines(["Try `char last = s.charAt(n - 1);`"], sol), ["charlast=s.charAt(n-1);"]);
	assert.deepEqual(G.hintsWithSolutionLines(["What index does the last character have?"], sol), []);
});

test("quiz key leaks: hints/details/question", () => {
	assert.match(G.quizKeyLeak("quiz_typed", { question: "What does it print?", acceptedAnswers: ["Hello1"], hints: ["It prints Hello1"] }), /hint 1/);
	assert.match(G.quizKeyLeak("quiz_typed", { question: "Integrate $2x$. Example answer format: $x^2 + C$", acceptedAnswers: ["x^2 + C"] }), /question/);
	assert.match(G.quizKeyLeak("quiz_typed", { question: "Compute 2+3.", acceptedAnswers: ["5"], hints: ["e.g. 5"] }), /hint 1/);
	assert.match(G.quizKeyLeak("quiz", { question: "Which?", options: [{ label: "int division", value: "a" }, { label: "float", value: "b" }], correctAnswer: "a", details: "Hint: it's int division" }), /details/);
	// code to trace may contain the printed text; True/False labels are not leaks
	assert.equal(G.quizKeyLeak("quiz_typed", { question: "What does `System.out.println(\"hello\")` print?", acceptedAnswers: ["hello"] }), undefined);
	assert.equal(G.quizKeyLeak("quiz", { question: "True or false: ...", options: [{ label: "True" }, { label: "False" }], correctAnswer: "True", details: "True or false?" }), undefined);
	assert.equal(G.quizKeyLeak("quiz_typed", { question: "Compute $5 \\cdot 3$.", acceptedAnswers: ["15"], hints: ["Multiply 5 by 3."] }), undefined);
});

test("notes must actually be answered", () => {
	assert.ok(!G.noteAddressed("why is the integer division rounding down?", "Great, let's keep going with another one."));
	assert.ok(G.noteAddressed("why is the integer division rounding down?", "Integer division drops the fractional part, so 7/2 is 3."));
	assert.ok(G.noteAddressed("??", "No problem: here is what that line does, step by step."));
	assert.ok(G.noteAddressed("why is it 3", "You asked why: because the decimal part is thrown away."));
});

test("skipped card and open exercise detection", () => {
	const ex = [A("", [["e1", "assign_exercise", { title: "Last char", referenceSolution: "x" }]])];
	assert.equal(G.skippedSinceUser([...ex, R("e1", "assign_exercise", { status: "cancelled" })]), "assign_exercise");
	assert.equal(G.skippedSinceUser([...ex, R("e1", "assign_exercise", { status: "cancelled" }), U("give me another")]), undefined);
	assert.equal(G.openExercise([...ex], null)?.title, "Last char");
	assert.equal(G.openExercise([...ex, R("e1", "assign_exercise", { status: "answered", gaveUp: true, title: "Last char" })], null), undefined);
	assert.equal(G.openExercise([], { title: "T", referenceSolution: "x", status: "closed" }), undefined);
	assert.equal(G.openExercise([], { title: "T", referenceSolution: "x", status: "active" })?.title, "T");
});

test("bounce budgets are per question and reset", () => {
	const b = new G.Bounces();
	assert.ok(b.take("math", "q1", 2) && b.take("math", "q1", 2));
	assert.ok(!b.take("math", "q1", 2));
	assert.ok(b.take("math", "q2", 2), "another question has its own budget");
	b.reset();
	assert.ok(b.take("math", "q1", 2));
});

test("coercion: string concepts and options", () => {
	assert.deepEqual(coerceList({ concepts: ["loops"] }, "concepts", "name").concepts, [{ name: "loops" }]);
	assert.deepEqual(coerceList({ concepts: "loops" }, "concepts", "name").concepts, [{ name: "loops" }]);
	assert.deepEqual(coerceList({ concepts: '["a","b"]' }, "concepts", "name").concepts, [{ name: "a" }, { name: "b" }]);
	assert.deepEqual(coerceList({ options: ["Yes", { label: "No" }] }, "options", "label").options, [{ label: "Yes" }, { label: "No" }]);
});

// ── Store evidence rules ────────────────────────────────────────────────────

const diag = (concepts, extra = {}) => ({ ts: now(), subject: "Calc II", concepts, question: "q", purpose: "diagnostic", kind: "typed", outcome: "correct", confidence: 3, hintsUsed: 0, ...extra });

test("diagnostics: one lucky multi-concept answer unlocks nothing; two proofs on one concept do", () => {
	const store = new TutorStore(tmp());
	store.recordQuiz(diag(["integration by parts", "trig substitution", "series convergence"]));
	assert.equal(Object.keys(store.loadProgress().concepts).length, 0);
	store.recordQuiz(diag(["integration by parts"], { kind: "choice" }));
	assert.equal(store.findConceptStrict(store.loadProgress(), "Calc II", "integration by parts"), undefined, "one proof isn't enough");
	store.recordQuiz(diag(["integration by parts"], { confidence: undefined }));
	assert.equal(store.findConceptStrict(store.loadProgress(), "Calc II", "integration by parts"), undefined, "no confidence = unproven");
	store.recordQuiz(diag(["integration by parts"], { hintsUsed: 1 }));
	store.recordQuiz(diag(["integration by parts"], { attempts: 2 }));
	assert.equal(store.findConceptStrict(store.loadProgress(), "Calc II", "integration by parts"), undefined, "hints/retries never prove");
	store.recordQuiz(diag(["integration by parts"]));
	assert.equal(store.findConceptStrict(store.loadProgress(), "Calc II", "integration by parts")?.status, "known");
});

test("mark_taught on a new name creates a new concept", () => {
	const store = new TutorStore(tmp());
	store.markTaught("Java", [{ name: "loops" }]);
	store.markTaught("Java", [{ name: "nested loops" }]);
	store.markTaught("Java", [{ name: "Loops" }]);
	const names = store.conceptsForSubject(store.loadProgress(), "Java").map((c) => c.name).sort();
	assert.deepEqual(names, ["loops", "nested loops"]);
});

test("checkpoint guesses don't verify; retries are assisted; disputes are keyed and never verify", () => {
	const store = new TutorStore(tmp());
	store.markTaught("Java", [{ name: "loops" }]);
	const base = { subject: "Java", concepts: ["loops"], question: "q", kind: "typed", hintsUsed: 0 };
	store.recordQuiz({ ...base, ts: now(), purpose: "checkpoint", outcome: "correct", confidence: 1 });
	assert.ok(!store.findConcept(store.loadProgress(), "Java", "loops").verified, "a guess isn't proof");
	store.recordQuiz({ ...base, ts: now(), purpose: "check", outcome: "correct", confidence: 3, attempts: 2 });
	let c = store.findConcept(store.loadProgress(), "Java", "loops");
	assert.equal(c.assisted, 1, "right on a retry is assisted");
	assert.equal(store.proofLevel(store.loadProgress(), c), "with-help");
	// a future timestamp is clamped
	store.recordQuiz({ ...base, ts: "2099-01-01T00:00:00.000Z", purpose: "checkpoint", outcome: "disputed", confidence: 3, toolCallId: "t1" });
	const rec = store.loadProgress().quizLog.at(-1);
	assert.ok(Date.parse(rec.ts) <= Date.now());
	// another subject's dispute isn't touched
	assert.equal(store.resolveDispute("correct", { subject: "Python" }), undefined);
	assert.equal(store.resolveDispute("correct", { subject: "Java", toolCallId: "other" }), undefined);
	assert.ok(store.resolveDispute("correct", { subject: "Java", toolCallId: "t1" }));
	c = store.findConcept(store.loadProgress(), "Java", "loops");
	assert.ok(!c.verified, "a settled dispute never verifies");
});

test("renaming onto an existing subject keeps the stronger record", () => {
	const store = new TutorStore(tmp());
	store.markTaught("Calculus II", [{ name: "trigonometric integrals" }]);
	for (let i = 0; i < 4; i++) store.recordQuiz({ ts: now(), subject: "Calculus II", concepts: ["trigonometric integrals"], question: `q${i}`, purpose: "check", kind: "typed", outcome: "correct", confidence: 3 });
	store.markTaught("Calculis II", [{ name: "trigonometric integrals" }]);
	store.recordQuiz({ ts: now(), subject: "Calculis II", concepts: ["trigonometric integrals"], question: "x", purpose: "check", kind: "typed", outcome: "incorrect" });
	store.renameSubject("Calculis II", "Calculus II");
	const cs = store.conceptsForSubject(store.loadProgress(), "Calculus II");
	assert.equal(cs.length, 1);
	assert.equal(cs[0].attempts, 5);
	assert.equal(cs[0].correct, 4);
	assert.ok(cs[0].box >= 3, "stronger record's box kept");
});

test("mastery gate: strict aliases, across sittings, nothing excluded", () => {
	const store = new TutorStore(tmp());
	store.markTaught("Calc I", [{ name: "power rule" }]);
	// yesterday's lesson still gates today
	const data = store.loadProgress();
	Object.values(data.concepts)[0].taughtAt = new Date(Date.now() - 30 * 3_600_000).toISOString();
	store.saveProgress(data);
	assert.equal(G.unmasteredPrevious(store.loadProgress(), "Calc I")?.name, "power rule");
	// checks under a strict alias count
	for (let i = 0; i < 2; i++) store.recordQuiz({ ts: now(), subject: "Calc I", concepts: ["Power Rules"], question: `q${i}`, purpose: "check", kind: "typed", outcome: "correct", confidence: 3, hintsUsed: 0 });
	assert.equal(G.unmasteredPrevious(store.loadProgress(), "Calc I"), undefined);
});

test("escape signals: scoped to subject, end at the next correct check", () => {
	const store = new TutorStore(tmp());
	store.addSignal({ subject: "Java", kind: "asked-for-answer", detail: "x" });
	assert.equal(G.directSignals(store.loadProgress(), "Calculus").length, 0);
	assert.equal(G.directSignals(store.loadProgress(), "Java").length, 1);
	store.markTaught("Java", [{ name: "loops" }]);
	store.recordQuiz({ ts: new Date(Date.now() + 1000).toISOString(), subject: "Java", concepts: ["loops"], question: "q", purpose: "check", kind: "typed", outcome: "correct", confidence: 3 });
	assert.equal(G.directSignals(store.loadProgress(), "Java", 20, Date.now() + 2000).length, 0);
});

// ── The extension's handlers, with a fake pi ────────────────────────────────

function harness(subject = "Java") {
	const dir = tmp();
	const store = new TutorStore(dir);
	if (subject) new SubjectRegistry(join(dir, "Tutor", ".data")).ensure(subject);
	const handlers = {};
	const sent = [];
	const pi = {
		on: (e, f) => (handlers[e] ??= []).push(f),
		registerTool() {},
		registerCommand() {},
		registerProvider() {},
		sendMessage: (m) => sent.push(m),
		sendUserMessage() {},
		appendEntry() {},
		setSessionName() {},
	};
	tutor(pi);
	const branch = subject ? [{ type: "custom", customType: "tutor-subject", data: { subject } }] : [];
	const ctx = {
		cwd: dir,
		mode: "rpc",
		ui: { notify() {}, setStatus() {}, select: async () => undefined, input: async () => undefined },
		sessionManager: { getBranch: () => branch, getSessionFile: () => join(dir, "s.jsonl"), getSessionId: () => "sid", getSessionDir: () => dir, getSessionName: () => undefined },
	};
	const fire = async (e, ev) => {
		for (const f of handlers[e] ?? []) {
			const r = await f(ev, ctx);
			if (r) return r;
		}
	};
	return { dir, branch, ctx, sent, store, fire, call: (toolName, input) => fire("tool_call", { toolName, input, toolCallId: "c" }) };
}

async function started(subject) {
	const h = harness(subject);
	await h.fire("session_start", { reason: "resume" });
	return h;
}

test("shell and file tools are blocked", async () => {
	const h = await started();
	for (const t of ["bash", "read", "edit", "write"]) assert.match((await h.call(t, { command: "ls" }))?.reason ?? "", /can't run commands or touch files/, t);
});

test("mark_taught: fake lesson, too many, mastery bypass, course order, topic required", async () => {
	const h = await started();
	h.branch.push(U("teach me"), A("Example 1: $$x$$\nExample 2: $$y$$\n" + "Lorem ipsum ".repeat(45)));
	assert.match((await h.call("mark_taught", { subject: "Java", concepts: [{ name: "while loops" }] })).reason, /fully worked examples/);
	h.branch.push(A(REAL_LESSON));
	assert.equal(await h.call("mark_taught", { subject: "Java", concepts: [{ name: "while loops" }] }), undefined);
	h.store.markTaught("Java", [{ name: "variables" }]);
	// re-listing the unmastered previous concept doesn't get around the gate
	assert.match((await h.call("mark_taught", { subject: "Java", concepts: [{ name: "variables" }, { name: "print function" }] })).reason, /hasn't mastered "variables"/);
	h.branch.push(U("ok I get it"));
	assert.match((await h.call("mark_taught", { subject: "Java", concepts: [{ name: "print function" }] })).reason, /hasn't mastered/);
	// course order + topic required
	h.store.writeTopicMap("Java", { topics: [{ id: "basic-syntax", title: "Basic syntax", order: 1 }, { id: "for-loop", title: "for loop", order: 2 }, { id: "while-do", title: "while / do-while loops", order: 3 }] });
	h.branch.push(U("let's move on"));
	assert.match((await h.call("mark_taught", { subject: "Java", concepts: [{ name: "print function" }] })).reason, /needs `topic`/);
	assert.match((await h.call("mark_taught", { subject: "Java", concepts: [{ name: "do while", topic: "while-do" }] })).reason, /Course order/);
	h.branch.push(U("let's move on, teach me do-while loops"));
	assert.equal(await h.call("mark_taught", { subject: "Java", concepts: [{ name: "do while", topic: "while-do" }] }), undefined);
});

test("diagnostics: one concept each, capped per concept", async () => {
	const h = await started();
	assert.match((await h.call("quiz_typed", { subject: "Java", purpose: "diagnostic", concepts: ["loops", "arrays"], question: "q?" })).reason, /exactly one/);
	for (let i = 0; i < 3; i++) h.branch.push(A("", [[`d${i}`, "quiz_typed", { purpose: "diagnostic", concepts: ["loops"] }]]), R(`d${i}`, "quiz_typed", { status: "answered", correct: false }), U("ok"));
	assert.match((await h.call("quiz_typed", { subject: "Java", purpose: "diagnostic", concepts: ["Loops"], question: "q2?" })).reason, /probed 3 times/);
});

test("check gates: strict names, guided first after a lesson, skip, notes, exercises need a correct check", async () => {
	const h = await started();
	h.store.markTaught("Java", [{ name: "loops" }]);
	const quiz = (extra = {}) => ({ subject: "Java", concepts: ["loops"], question: "What prints?", explanation: "Trace it: the loop runs three times, printing 0, 1 and 2, because i starts at 0 and stops before 3. Answer: 012", ...extra });
	assert.match((await h.call("quiz_typed", quiz({ concepts: ["nested loops"] }))).reason, /Not taught yet/);
	// right after a fresh mark_taught: guided practice, for checkpoint too
	h.branch.push(A("", [["m", "mark_taught", {}]]), R("m", "mark_taught", { concepts: ["loops"], fresh: ["loops"] }));
	assert.match((await h.call("quiz_typed", quiz({ purpose: "checkpoint" }))).reason, /guided practice/);
	assert.equal(await h.call("quiz_typed", quiz({ hints: ["Where does i start?"] })), undefined);
	// exercise before any correct check
	const ex = { subject: "Java", concepts: ["loops"], title: "Count", language: "java", referenceSolution: "public class Main { public static void main(String[] a) { System.out.println(1); } }" };
	assert.match((await h.call("assign_exercise", ex)).reason, /no correct check/);
	h.store.recordQuiz({ ts: now(), subject: "Java", concepts: ["loops"], question: "q", purpose: "check", kind: "typed", outcome: "correct", confidence: 3 });
	h.branch.push(A("", [["q1", "quiz_typed", quiz()]]), R("q1", "quiz_typed", { status: "answered", correct: true, note: "why does the loop stop at 2?" }), A("Nice work, on to the next one."));
	assert.match((await h.call("quiz_typed", quiz({ question: "Next?" }))).reason, /left a note/);
	h.branch.push(A("The loop stops at 2 because the condition i < 3 fails when i becomes 3."));
	assert.equal(await h.call("assign_exercise", ex), undefined);
	h.branch.push(A("", [["e1", "assign_exercise", ex]]), R("e1", "assign_exercise", { status: "cancelled" }));
	assert.match((await h.call("assign_exercise", { ...ex, title: "Another" })).reason, /just skipped/);
	assert.match((await h.call("quiz_typed", quiz({ question: "Q3?" }))).reason, /just skipped/);
	h.branch.push(U("give me a different exercise"));
	assert.equal(await h.call("assign_exercise", { ...ex, title: "Another" }), undefined);
});

test("solution pasted into chat during an open exercise → hidden nudge; not after giving up", async () => {
	const h = await started();
	const sol = "public class Main {\n  public static void main(String[] args) {\n    int a = 7;\n    int b = a % 2;\n    System.out.println(b);\n  }\n}";
	globalThis.__tutorExercise = { id: "x", title: "Parity", subject: "Java", referenceSolution: sol, status: "active" };
	try {
		await h.fire("message_end", { message: { role: "user", content: "just show me" } });
		await h.fire("message_end", { message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Sure:\n```java\nint a = 7;\nint b = a % 2;\nSystem.out.println(b);\n```" }] } });
		assert.equal(h.sent.length, 1);
		assert.match(h.sent[0].content, /solution .* open, graded exercise "Parity"/);
		assert.equal(h.store.loadProgress().signals.at(-1).kind, "solution-leak");
		globalThis.__tutorExercise = { ...globalThis.__tutorExercise, status: "closed" };
		await h.fire("message_end", { message: { role: "user", content: "ok" } });
		await h.fire("message_end", { message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "```java\nint a = 7;\nint b = a % 2;\nSystem.out.println(b);\n```" }] } });
		assert.equal(h.sent.length, 1);
	} finally {
		globalThis.__tutorExercise = undefined;
	}
});

test("lesson code with untaught constructs → nudge; the lesson's own construct is fine", async () => {
	const h = await started();
	h.store.markTaught("Java", [{ name: "variables" }, { name: "if statements" }]);
	await h.fire("message_end", { message: { role: "user", content: "teach me if" } });
	await h.fire("message_end", { message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "**Example 1:**\n```java\nif (a > 0 || b > 0) {\n  System.out.println(a);\n}\n```" }] } });
	assert.match(h.sent.at(-1)?.content ?? "", /logical operators/);
	const n = h.sent.length;
	await h.fire("message_end", { message: { role: "user", content: "teach me while" } });
	await h.fire("message_end", { message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "## While loops\n**Example 1:**\n```java\nwhile (a > 0) {\n  a = a - 1;\n}\n```\nEach pass lowers a by one until it reaches 0." }] } });
	assert.equal(h.sent.slice(n).filter((m) => /hasn't been taught/.test(m.content)).length, 0);
});

test("escape hatch: scoped by subject, parallel example during an open exercise", async () => {
	const h = await started();
	const prompt = async (p) => (await h.fire("before_agent_start", { prompt: p, systemPrompt: "" })).systemPrompt;
	assert.match(await prompt("just show me"), /walk through the solution/);
	assert.match(await prompt("I'm confusing for and while"), /PARALLEL problem/);
	globalThis.__tutorExercise = { title: "Parity", referenceSolution: "x\ny", status: "active" };
	try {
		const p = await prompt("just show me");
		assert.doesNotMatch(p, /walk through the solution/);
		assert.match(p, /Give up button/);
		assert.equal(globalThis.__tutorEscape?.subject, "Java");
	} finally {
		globalThis.__tutorExercise = undefined;
	}
	// a Java "show me" signal doesn't follow the learner into another subject
	h.store.addSignal({ subject: "Java", kind: "asked-for-answer", detail: "x" });
	const other = await started("Calculus");
	assert.doesNotMatch((await other.fire("before_agent_start", { prompt: "hi", systemPrompt: "" })).systemPrompt, /ESCAPE HATCH/);
	assert.equal(globalThis.__tutorEscape, undefined);
});

test("no subject selected: adopts the one passed (or blocks)", async () => {
	const h = await started(null);
	const r = await h.call("mark_taught", { concepts: [{ name: "x" }] });
	assert.match(r?.reason ?? "", /No subject is selected/);
	const input = { subject: "Biology", concepts: [{ name: "cells" }] };
	await h.call("mark_taught", input);
	assert.equal(input.subject, "Biology");
});
