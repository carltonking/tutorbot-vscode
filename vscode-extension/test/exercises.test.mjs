// assign_exercise / runTests behaviour (no panel, no model). Run: npm test
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { registerHooks } from "node:module";

// pi's UI/schema packages come with pi at runtime; tests only need stand-ins.
const STUBS = {
  "@mariozechner/pi-tui": "export class Text { constructor(t) { this.t = t; } }",
  "@sinclair/typebox": "const f = () => ({}); export const Type = new Proxy({}, { get: () => f });",
};
registerHooks({
  resolve(specifier, context, next) {
    if (STUBS[specifier]) return { url: `data:text/javascript,${encodeURIComponent(STUBS[specifier])}`, shortCircuit: true };
    return next(specifier, context);
  },
});
const { getBridge } = await import("../../extensions/lib/bridge.ts");
const { default: exercises, nextExerciseNumber, runTests, subjectFolder } = await import("../../extensions/exercises/index.ts");

const root = mkdtempSync(join(tmpdir(), "tutorbot-ex-test-"));
const instances = [];
after(() => {
  for (const h of instances) for (const f of h.on.session_shutdown ?? []) f();
  rmSync(root, { recursive: true, force: true });
});

async function make(name) {
  const ws = join(root, name);
  mkdirSync(ws, { recursive: true });
  const tools = {}, on = {}, sent = [];
  const pi = { registerTool: (t) => (tools[t.name] = t), registerCommand: () => {}, on: (e, f) => (on[e] ??= []).push(f), sendMessage: (m) => sent.push(m), sendUserMessage: (m) => sent.push({ user: m }) };
  const bridge = getBridge();
  bridge.emit = () => {};
  exercises(pi);
  const ctx = { cwd: ws, ui: { setWidget: () => {}, notify: () => {} } };
  for (const f of on.session_start) await f({}, ctx);
  const h = { ws, tools, on, sent, ctx, bridge, api: (n, b) => bridge.handlers.get(n)(b) };
  instances.push(h);
  h.assign = (p) => tools.assign_exercise.execute("tc", { concepts: ["c"], language: "python", prompt: "Read n, print 2n.", subject: "Python", title: "Double It", ...p }, undefined, undefined, ctx);
  return h;
}

const PY_REF = "print(int(input()) * 2)\n";
const PY_STARTER = "n = int(input())\n# TODO: print twice n\n";
const TESTS = [{ name: "two", stdin: "2", expectedOutput: "4" }, { name: "five", stdin: "5", expectedOutput: "10", hidden: true }];
const text = (r) => r.content[0].text;

test("runTests: star pattern without leading spaces fails; exit code is explained", async () => {
  const stars = await runTests("python", "for i in range(1, 3):\n    print('*' * i)\n", [{ name: "t", expectedOutput: " *\n**" }]);
  assert.equal(stars.passed, 0);
  const exit = await runTests("python", "import sys\nprint(4)\nsys.exit(3)\n", [{ name: "t", expectedOutput: "4" }]);
  assert.equal(exit.passed, 0);
  assert.match(exit.results[0].detail, /exited with code 3/);
  const java = await runTests("java", "package a.b;\npublic class Foo { public static void main(String[] x) { System.out.println(\"ok\"); } }", [{ name: "t", expectedOutput: "ok" }, { name: "u", expectedOutput: "ok" }]);
  assert.equal(java.passed, 2, JSON.stringify(java));
});

test("folders: subject '.'/'..' stay inside Exercises/, numbering is per subject", () => {
  assert.equal(subjectFolder(".."), "General");
  assert.equal(subjectFolder("."), "General");
  assert.equal(subjectFolder("Java/../x"), "Java-..-x");
  const base = join(root, "numbering");
  mkdirSync(join(base, "01-a"), { recursive: true });
  mkdirSync(join(base, "07-b"), { recursive: true });
  assert.equal(nextExerciseNumber(base), 8);
  assert.equal(nextExerciseNumber(join(root, "nope")), 1);
});

test("assign refuses empty expected output", async () => {
  const h = await make("refusals");
  const empty = await h.assign({ starterCode: PY_STARTER, referenceSolution: PY_REF, tests: [...TESTS, { name: "blank", expectedOutput: "" }] });
  assert.match(text(empty), /NOT assigned.*empty expectedOutput/s);
});

test("the learner writes from scratch: the file is the summary + 'Start code here:', whatever starterCode says", async () => {
  const h = await make("scratch");
  // Even a starter that gives the answer away never reaches the file.
  const py = await h.assign({ title: "Double Py", starterCode: PY_REF, referenceSolution: PY_REF, tests: TESTS });
  assert.equal(py.details.assigned, true, text(py));
  const pyFile = readFileSync(py.details.file, "utf8");
  assert.match(pyFile, /# Start code here:\n$/);
  assert.doesNotMatch(pyFile, /input\(|print\(/);
  const ref = "import java.util.*;\npublic class Main {\n  public static void main(String[] a) {\n    Scanner s = new Scanner(System.in);\n    System.out.println(s.nextInt() * 2);\n  }\n}\n";
  const java = await h.assign({ language: "java", subject: "Java", title: "Largest Of Two", referenceSolution: ref, tests: TESTS });
  assert.equal(java.details.assigned, true, text(java));
  const javaFile = readFileSync(java.details.file, "utf8");
  assert.match(javaFile, /^\/\*\n \* Largest Of Two\n[\s\S]* \*\/\n\n\/\/ Start code here:\n$/);
  assert.doesNotMatch(javaFile, /import|class|Scanner|TODO/);
  // The class name the file needs is in the instructions (panel + README).
  assert.match(readFileSync(join(dirname(java.details.file), "README.md"), "utf8"), /Name your class `LargestOfTwo`/);
});

test("assign: missing interpreter is reported as such, not as a broken reference", async () => {
  const h = await make("missing");
  const path = process.env.PATH;
  process.env.PATH = "/nonexistent";
  try {
    const r = await h.assign({ starterCode: PY_STARTER, referenceSolution: PY_REF, tests: TESTS });
    assert.match(text(r), /python3 isn't installed or isn't on PATH/);
    assert.doesNotMatch(text(r), /fails your own tests/);
  } finally {
    process.env.PATH = path;
  }
});

test("assign numbers exercises 01, 02… across titles and publishes __tutorExercise", async () => {
  const h = await make("numbering-ws");
  const a = await h.assign({ title: "First", starterCode: PY_STARTER, referenceSolution: PY_REF, tests: TESTS });
  assert.equal(a.details.assigned, true, text(a));
  const b = await h.assign({ title: "Second", starterCode: PY_STARTER, referenceSolution: PY_REF, tests: TESTS });
  assert.equal(b.details.assigned, true, text(b));
  assert.deepEqual(readdirSync(join(h.ws, "Exercises", "Python")).sort(), ["01-first", "02-second"]);
  const shared = globalThis.__tutorExercise;
  assert.equal(shared.title, "Second");
  assert.equal(shared.referenceSolution, PY_REF);
  assert.equal(shared.status, "active");
});

test("Java: the renamed reference is what gets validated", async () => {
  const h = await make("java-rename");
  const ref = "import java.util.*;\npublic class Main {\n  public static void main(String[] a) {\n    Scanner s = new Scanner(System.in);\n    System.out.println(s.nextInt() * 2);\n  }\n}\n";
  const starter = "import java.util.*;\npublic class Main {\n  public static void main(String[] a) {\n    // TODO\n  }\n}\n";
  const r = await h.assign({ language: "java", subject: "Java", title: "Double Java", starterCode: starter, referenceSolution: ref, tests: TESTS });
  assert.equal(r.details.assigned, true, text(r));
  assert.match(r.details.file, /DoubleJava\.java$/);
  assert.match(globalThis.__tutorExercise.referenceSolution, /public class DoubleJava/);
});

test("deleted exercise file: submit and check_exercise say so instead of grading ''", async () => {
  const h = await make("deleted");
  const r = await h.assign({ starterCode: PY_STARTER, referenceSolution: PY_REF, tests: TESTS });
  rmSync(r.details.file);
  assert.match((await h.api("submit")).message, /was deleted/);
  const c = await h.tools.check_exercise.execute("x", {}, undefined, undefined, h.ctx);
  assert.match(text(c), /was deleted/);
});

test("passing with the escape hatch on is recorded as assisted", async () => {
  const h = await make("escape");
  const r = await h.assign({ starterCode: PY_STARTER, referenceSolution: PY_REF, tests: TESTS });
  writeFileSync(r.details.file, PY_REF);
  globalThis.__tutorEscape = { subject: "python", since: Date.now() };
  try {
    assert.match((await h.api("submit")).message, /all tests pass/);
  } finally {
    globalThis.__tutorEscape = undefined;
  }
  const log = JSON.parse(readFileSync(join(h.ws, "Tutor", ".data", "progress.json"), "utf8")).quizLog;
  const rec = log.at(-1);
  assert.equal(rec.outcome, "correct");
  assert.ok(rec.hintsUsed >= 1, JSON.stringify(rec));
  assert.equal(rec.attempts, 1);
  assert.equal(globalThis.__tutorExercise, undefined, "solved: no active exercise");
});

test("hint with the card's ladder used up says to press Ask TutorBot", async () => {
  const h = await make("card-hint");
  const b = h.bridge;
  const hasPanel = b.hasPanel;
  const ask = b.ask;
  let answer;
  b.hasPanel = () => true;
  b.ask = (_kind, _payload, signal) => new Promise((res) => {
    answer = res;
    signal?.addEventListener("abort", () => res(null), { once: true });
  });
  try {
    const p = h.assign({ starterCode: PY_STARTER, referenceSolution: PY_REF, tests: TESTS, hints: ["think about *"] });
    while (!answer) await new Promise((r) => setTimeout(r, 20));
    assert.match((await h.api("hint", {})).message, /next hint on the exercise card/);
    await new Promise((r) => setTimeout(r, 20));
    assert.match((await h.api("hint", {})).message, /No more hints on the card — press Ask TutorBot/);
    assert.equal(h.sent.length, 0, "no hidden follow-up that can't be delivered");
    answer({ action: "skip" });
    const res = await p;
    assert.equal(res.details.status, "cancelled");
  } finally {
    b.hasPanel = hasPanel;
    b.ask = ask;
  }
});

test("the 'Coding exercise (current state)' prompt is scoped to the subject", async () => {
  const h = await make("prompt");
  await h.assign({ title: "Scoped", starterCode: PY_STARTER, referenceSolution: PY_REF, tests: TESTS });
  const prompt = async () => (await h.on.before_agent_start[0]({ systemPrompt: "BASE" })).systemPrompt;
  const prev = h.bridge.getState("subject");
  try {
    h.bridge.state.subject = "Python";
    assert.match(await prompt(), /## Coding exercise \(current state\)\nActive exercise: "Scoped"/);
    h.bridge.state.subject = "Java";
    assert.match(await prompt(), /No exercise in this subject.*unfinished Python exercise, "Scoped"/s);
  } finally {
    h.bridge.state.subject = prev;
  }
});
