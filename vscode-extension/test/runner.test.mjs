// run-code: sandbox, environment, process control, output comparison. Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { jsFileName, normalizeOutput, prepareProgram, runCode, sameProgramOutput } from "../../extensions/lib/run-code.ts";

const mac = process.platform === "darwin";
const home = homedir();

test("normal Java, Python and JavaScript programs still run", async () => {
  const j = await runCode("java", 'public class Hi { public static void main(String[] a) { System.out.println("héllo java"); } }');
  assert.equal(j.stdout, "héllo java\n", j.stderr);
  const p = await runCode("python", "import sys\nprint('py', sys.stdin.read().strip())", "42");
  assert.equal(p.stdout, "py 42\n", p.stderr);
  const js = await runCode("javascript", "const fs = require('fs'); console.log('js', fs.readFileSync(0, 'utf8').trim())", "7");
  assert.equal(js.stdout, "js 7\n", js.stderr);
  const esm = await runCode("javascript", "import os from 'node:os'; console.log(typeof os.cpus)");
  assert.equal(esm.stdout, "function\n", esm.stderr);
});

test("JavaScript is CommonJS unless it uses import/export", () => {
  assert.equal(jsFileName("const x = require('fs');"), "main.cjs");
  assert.equal(jsFileName("import fs from 'fs';"), "main.mjs");
  assert.equal(jsFileName("export const x = 1;"), "main.mjs");
  assert.equal(jsFileName("const x = await fetchIt();"), "main.mjs");
});

test("a Java package declaration doesn't break the run", async () => {
  const r = await runCode("java", "package com.example;\npublic class Pkg { public static void main(String[] a) { System.out.println(1); } }");
  assert.equal(r.stdout, "1\n", r.stderr);
});

test("secrets in the environment are not visible", async () => {
  process.env.APCA_API_SECRET_KEY = "secret-1";
  process.env.APCA_API_KEY_ID = "secret-2";
  process.env.AWS_SECRET_ACCESS_KEY = "secret-3";
  process.env.DB_PASSWORD = "secret-4";
  process.env.SSH_AUTH_SOCK = "/tmp/fake.sock";
  try {
    const r = await runCode("python", "import os\nprint(sorted(os.environ))\nprint(os.environ['HOME'])");
    assert.equal(r.ok, true, r.stderr);
    assert.doesNotMatch(r.stdout, /APCA|AWS_|PASSWORD|SSH_AUTH_SOCK|secret-/);
    assert.match(r.stdout, /PATH/);
    assert.ok(!r.stdout.includes(`${home}\n`), "HOME is the temp run dir, not the real home");
  } finally {
    for (const k of ["APCA_API_SECRET_KEY", "APCA_API_KEY_ID", "AWS_SECRET_ACCESS_KEY", "DB_PASSWORD", "SSH_AUTH_SOCK"]) delete process.env[k];
  }
});

test("can't read ~/.pi/agent/auth.json or list the home folder", { skip: !mac && "sandbox is macOS-only" }, async () => {
  const r = await runCode("python", `print(open(${JSON.stringify(join(home, ".pi", "agent", "auth.json"))}).read()[:5])`);
  assert.equal(r.ok, false);
  assert.match(r.stderr, /Operation not permitted|PermissionError|FileNotFoundError/);
  const ls = await runCode("javascript", `console.log(require("fs").readdirSync(${JSON.stringify(home)}).length)`);
  assert.equal(ls.ok, false);
  assert.match(ls.stderr, /EPERM|operation not permitted/i);
});

test("can't write outside its temp dir", { skip: !mac && "sandbox is macOS-only" }, async () => {
  const target = join(tmpdir(), `tutorbot-escape-${process.pid}.txt`);
  try {
    const r = await runCode("python", `open(${JSON.stringify(target)}, "w").write("x")\nprint("wrote")`);
    assert.equal(r.ok, false);
    assert.equal(existsSync(target), false);
    // Its own working dir is writable.
    const own = await runCode("python", 'open("out.txt", "w").write("x")\nprint(open("out.txt").read())');
    assert.equal(own.stdout, "x\n", own.stderr);
  } finally {
    rmSync(target, { force: true });
  }
});

test("can't open a network socket", { skip: !mac && "sandbox is macOS-only" }, async () => {
  const r = await runCode("python", 'import socket\ns = socket.socket()\ns.settimeout(3)\ns.connect(("1.1.1.1", 80))\nprint("connected")');
  assert.notEqual(r.stdout, "connected\n");
  assert.equal(r.ok, false);
});

test("a forgotten subprocess doesn't hold the run open; timeouts kill the whole tree", async () => {
  let t = Date.now();
  const r = await runCode("python", 'import subprocess\nsubprocess.Popen(["sleep", "30"])\nprint("ok")');
  assert.equal(r.stdout, "ok\n");
  assert.ok(Date.now() - t < 4000, `took ${Date.now() - t}ms`);
  t = Date.now();
  const loop = await runCode("python", 'import subprocess, time\nsubprocess.Popen(["sleep", "30"])\nwhile True: time.sleep(1)');
  assert.equal(loop.timedOut, true);
  assert.ok(Date.now() - t < 11000, `took ${Date.now() - t}ms`);
});

test("an abort signal kills the run", async () => {
  const ac = new AbortController();
  const t = Date.now();
  setTimeout(() => ac.abort(), 300);
  const r = await runCode("python", "while True: pass", undefined, { signal: ac.signal });
  assert.equal(r.aborted, true);
  assert.ok(Date.now() - t < 3000);
});

test("Python: a run-time SyntaxError isn't a compile error; a real one is", async () => {
  const ok = await prepareProgram("python", "try:\n  eval('1 +')\nexcept SyntaxError:\n  print('caught')\n");
  try {
    assert.equal(ok.failure, undefined);
    assert.equal((await ok.run(undefined)).stdout, "caught\n");
  } finally {
    ok.dispose();
  }
  const bad = await prepareProgram("python", "print('a'\n");
  try {
    assert.equal(bad.failure?.compileError, true);
    assert.match(bad.failure.stderr, /File "main\.py", line \d/);
    assert.doesNotMatch(bad.failure.stderr, /syntax_check/);
  } finally {
    bad.dispose();
  }
});

test("a missing interpreter is reported as missing, not as a failing program", async () => {
  const path = process.env.PATH;
  process.env.PATH = "/nonexistent";
  try {
    const r = await runCode("python", "print(1)");
    assert.equal(r.missing, "python3");
    const p = await prepareProgram("java", "public class A { public static void main(String[] a) {} }");
    p.dispose();
    assert.equal(p.failure?.missing, "java");
  } finally {
    process.env.PATH = path;
  }
});

test("exercise output comparison is strict per line; quiz normalization unchanged", () => {
  assert.equal(sameProgramOutput("1 2 3\n", "1\n2\n3"), false); // print vs println
  assert.equal(sameProgramOutput("*\n**\n", "  *\n **"), false); // leading spaces count
  assert.equal(sameProgramOutput('He said "hi"\n', "He said hi"), false); // quotes count
  assert.equal(sameProgramOutput("hello\n", "Hello"), false);
  assert.equal(sameProgramOutput("  *\r\n **   \r\n\r\n", "  *\n **"), true); // CRLF, trailing spaces/blank lines
  assert.equal(normalizeOutput("1\n2\n3"), "1 2 3");
  assert.equal(normalizeOutput('"hi" (on separate lines)'), "hi");
});
