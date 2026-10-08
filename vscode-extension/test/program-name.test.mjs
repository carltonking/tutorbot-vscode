// Exercise files are named after the exercise, not all Main.java. Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { programName, renameJavaClass } from "../../extensions/lib/program-name.ts";

test("titles become file/class names per language", () => {
  assert.equal(programName("Count Letter A", "java"), "CountLetterA");
  assert.equal(programName("Inner Characters", "java"), "InnerCharacters");
  assert.equal(programName("Sum of digits (v2)!", "java"), "SumOfDigitsV2");
  assert.equal(programName("Count Letter A", "python"), "count_letter_a");
  assert.equal(programName("Count Letter A", "javascript"), "countLetterA");
});

test("names never start with a digit, never empty, never shadow a library class", () => {
  assert.equal(programName("2 Numbers Sum", "java"), "NumbersSum");
  assert.equal(programName("!!!", "java"), "Main");
  assert.equal(programName("Scanner", "java"), "ScannerProgram");
  assert.equal(programName("Random", "python"), "random_program");
});

test("the public class is renamed to match the file; strings are left alone", () => {
  const code = `public class Main {\n  static int twice(int x) { return x * 2; }\n  public static void main(String[] args) {\n    System.out.println("Main menu. " + Main.twice(2));\n  }\n}`;
  const out = renameJavaClass(code, "CountLetterA");
  assert.match(out, /public class CountLetterA \{/);
  assert.match(out, /CountLetterA\.twice\(2\)/);
  assert.match(out, /"Main menu\. "/);
  assert.equal(renameJavaClass("int x = 1;", "Foo"), "int x = 1;");
});

import { exerciseHeader } from "../../extensions/lib/program-name.ts";

test("the file header is a short plain-text summary, not the whole markdown prompt", () => {
  const prompt = "Write a program that reads **two** strings (each on its own line) from the user and then prints:\n1. The two strings concatenated together with a single space between them.\n2. The total number of characters in both strings combined (do **not** count the space you add in the output).\n\n### Output Format\n```text\nCombined: <s1> <s2>\nTotal length: <number>\n```\n\n### Example\n**Input:**\n```text\nHello\nWorld\n```";
  const h = exerciseHeader("Combine Two Strings", prompt, "java");
  assert.match(h, /^\/\*\n \* Combine Two Strings\n \*\n \* Write a program that reads two strings/);
  assert.doesNotMatch(h, /\*\*|```|###|Output Format|Hello/);
  assert.ok(h.split("\n").every((l) => l.length <= 90));
  assert.match(h, /README\.md/);
  assert.match(exerciseHeader("Sum", "Add two numbers.", "python"), /^"""\nSum\n\nAdd two numbers\.\n/);
});

test("non-Latin titles, leading digits, transliteration, all-caps JS words", () => {
  assert.match(programName("计算器", "java"), /^Exercise[A-Za-z0-9]+$/);
  assert.notEqual(programName("计算器", "java"), programName("🎉", "java"));
  assert.match(programName("🎉", "python"), /^exercise_[a-z0-9]+$/);
  assert.equal(programName("2nd Largest", "java"), "Ex2ndLargest");
  assert.equal(programName("3D Shapes", "java"), "Ex3DShapes");
  assert.equal(programName("2nd Largest", "python"), "ex_2nd_largest");
  assert.equal(programName("2024", "java"), "Ex2024");
  assert.equal(programName("Straße", "java"), "Strasse");
  assert.equal(programName("Søren's Æble", "java"), "SorenSAEble");
  assert.equal(programName("Café ☕ Bill", "java"), "CafeBill");
  assert.equal(programName("ABC Test", "javascript"), "abcTest");
  assert.equal(programName("Count Letter A", "javascript"), "countLetterA");
  assert.equal(programName("   ", "java"), "Main");
});

test("names never shadow java.lang, keywords, stdlib modules or Windows device names", () => {
  for (const t of ["Exception", "Override", "Thread", "Process", "Record", "Boolean", "Long", "Error", "Class", "StringBuilder", "Enum", "Object", "Runtime", "Character", "Integer", "Iterable", "Comparable", "Number", "Void", "Short", "Byte", "Float", "Double", "Math", "System", "String"])
    assert.equal(programName(t, "java"), `${t}Program`, t);
  for (const t of ["math", "random", "string", "sys", "os", "time", "json", "re", "io", "collections", "itertools", "statistics", "typing", "turtle", "copy", "types", "code", "token", "queue", "calendar", "datetime", "array", "test", "unittest", "abc", "operator", "If", "class"])
    assert.equal(programName(t, "python"), `${t.toLowerCase()}_program`, t);
  for (const t of ["Con", "Aux", "Nul", "Prn", "Com1", "Lpt1"]) assert.equal(programName(t, "java"), `${t}Program`, t);
  assert.equal(programName("If", "javascript"), "ifProgram");
  assert.equal(programName("Integer Division", "java"), "IntegerDivision");
});

test("renaming covers constructors, type uses, static fields, method refs and any modifiers; strings and comments stay", () => {
  const code = "import java.util.function.*;\npublic abstract class Main {\n  int n;\n  static final int MAX = 3;\n  public Main(int n) { this.n = n; }\n  static int sq(int x) { return x * x; }\n  public static void main(String[] args) {\n    Main m = new Main(3) {};\n    IntUnaryOperator f = Main::sq;\n    System.out.println(\"Main \" + Main.MAX + f.applyAsInt(m.n)); // Main\n  }\n}";
  const out = renameJavaClass(code, "Counter");
  assert.match(out, /public abstract class Counter \{/);
  assert.match(out, /public Counter\(int n\)/);
  assert.match(out, /Counter m = new Counter\(3\)/);
  assert.match(out, /Counter::sq/);
  assert.match(out, /Counter\.MAX/);
  assert.match(out, /"Main " \+/);
  assert.match(out, /\/\/ Main$/m);
  assert.doesNotMatch(out.replace(/"Main "|\/\/ Main/g, ""), /\bMain\b/);
});

test("a title that names a helper class gets a suffix, in programName and renameJavaClass alike", () => {
  const code = "class Dog { }\npublic class Main {\n  public static void main(String[] args) { System.out.println(new Dog()); }\n}";
  const name = programName("Dog", "java", code);
  assert.equal(name, "DogProgram");
  const out = renameJavaClass(code, "Dog");
  assert.match(out, /public class DogProgram \{/);
  assert.match(out, /^class Dog \{ \}/);
  assert.equal(programName("Dog", "java", "public class Main {}"), "Dog");
});

test("headers keep operators and identifiers, drop only markdown", () => {
  const h = exerciseHeader("Ops", "If **x** > 5, print `a * b` and use *snake_case* names like my_var.\n> Note: __really__.", "java");
  assert.match(h, /If x > 5, print a \* b and use snake_case names like my_var\./);
  assert.match(h, /Note: really\./);
  assert.doesNotMatch(exerciseHeader("No blank", "Write a program.\n```text\nHello\n```\nExample input: 5", "java"), /Hello|Example/);
  assert.doesNotMatch(exerciseHeader("No blank", "Write a program.\n### Example\nHello", "python"), /Hello|Example/);
});

test("headers can't break compilation: backslashes and comment/docstring terminators", () => {
  const j = exerciseHeader("Paths \\u", "Print C:\\users\\carlton, then a */ b.", "java");
  assert.doesNotMatch(j.slice(2, -4), /\*\//); // only the real close
  assert.ok(!/(^|[^\\])(\\\\)*\\u/.test(j), "no live \\u escape");
  const p = exerciseHeader("Paths", 'Print C:\\Users\\carlton\\N and """ quotes', "python");
  assert.match(p, /^r"""\n/);
  assert.equal(p.match(/"""/g).length, 2);
  assert.match(exerciseHeader("Sum", 'Add "two" numbers.', "python"), /^"""\nSum\n/);
});
