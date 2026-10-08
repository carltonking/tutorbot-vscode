// Subject folders: group subjects ("Fall 2026" › Java, Calc II). Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SubjectRegistry } from "../../extensions/lib/subjects.ts";

const fresh = () => {
  const dir = mkdtempSync(join(tmpdir(), "tb-groups-"));
  const r = new SubjectRegistry(dir);
  for (const s of ["Java", "Calculus II", "Cosmology"]) r.ensure(s);
  return { r, dir };
};

test("create a folder, file subjects into it, list folders first", () => {
  const { r } = fresh();
  assert.equal(r.createGroup("  Fall   2026 "), "Fall 2026");
  assert.equal(r.createGroup("fall 2026"), "Fall 2026"); // same folder, any case
  r.setGroup("Java", "Fall 2026");
  r.setGroup("calculus ii", "fall 2026"); // subject and folder names ignore case
  assert.deepEqual(r.groups(), ["Fall 2026"]);
  assert.deepEqual(r.inGroup("Fall 2026").map((s) => s.name).sort(), ["Calculus II", "Java"]);
  assert.deepEqual(r.inGroup(undefined).map((s) => s.name), ["Cosmology"]);
});

test("moving into a new folder creates it; empty folders are kept", () => {
  const { r } = fresh();
  r.setGroup("Cosmology", "Personal");
  r.createGroup("Spring 2027");
  assert.deepEqual(r.groups(), ["Personal", "Spring 2027"]);
  assert.equal(r.inGroup("Spring 2027").length, 0);
  r.setGroup("Cosmology", undefined);
  assert.equal(r.find("Cosmology").group, undefined);
});

test("rename a folder: its subjects follow; collisions are refused", () => {
  const { r } = fresh();
  r.setGroup("Java", "NYU");
  r.createGroup("Personal");
  assert.equal(r.renameGroup("nyu", "NYU Fall"), "NYU Fall");
  assert.equal(r.find("Java").group, "NYU Fall");
  assert.throws(() => r.renameGroup("NYU Fall", "personal"), /already exists/);
  assert.throws(() => r.renameGroup("Nope", "X"), /No folder/);
});

test("delete a folder: subjects move out, nothing else is lost", () => {
  const { r } = fresh();
  r.update("Java", { folders: ["/class/java"] });
  r.setGroup("Java", "NYU");
  assert.equal(r.deleteGroup("NYU"), 1);
  assert.deepEqual(r.groups(), []);
  const java = r.find("Java");
  assert.equal(java.group, undefined);
  assert.deepEqual(java.folders, ["/class/java"]);
});

test("a subject keeps its folder through a rename, and the file stays readable", () => {
  const { r, dir } = fresh();
  r.setGroup("Java", "NYU");
  r.rename("Java", "Java 101");
  assert.equal(r.find("Java 101").group, "NYU");
  const raw = JSON.parse(readFileSync(join(dir, "subjects.json"), "utf8"));
  assert.deepEqual(raw.groups, ["NYU"]);
  assert.throws(() => r.createGroup("   "), /at least one character/);
});

test("removing a class folder from one subject leaves other subjects using it", () => {
  const { r } = fresh();
  r.addFolder("Java", "/classes/shared");
  r.addFolder("Cosmology", "/classes/shared");
  r.removeFolder("/classes/shared", "java");
  assert.deepEqual(r.find("Java").folders, []);
  assert.deepEqual(r.find("Cosmology").folders, ["/classes/shared"]);
  r.removeFolder("/classes/shared"); // no subject: every subject stops using it
  assert.deepEqual(r.find("Cosmology").folders, []);
});
