// Exercises and quiz code may only use constructs the learner was taught.
// Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { constructsUsed, fencedCode, topicFor, untaughtConstructs } from "../../extensions/lib/constructs.ts";

// The Java course map's first topics, in course order.
const TOPICS = [
  { id: "program-setup", title: "Program setup & first Java program (javac/java, class structure)" },
  { id: "basic-syntax", title: "Basic syntax: declarations, literals, assignment, print/output" },
  { id: "input-scanner", title: "Reading input with Scanner" },
  { id: "arithmetic-ops", title: "Arithmetic operators & Math class (pow, sqrt)" },
  { id: "string-basics", title: "Strings: concatenation, length, charAt, escapes (\\n \\t \")" },
  { id: "if-else", title: "if / if-else selection structures" },
  { id: "switch", title: "switch statement" },
  { id: "boolean-logic", title: "Boolean operators (&&, ||, !) & compound conditions" },
  { id: "math-functions", title: "Math functions & character/string methods" },
  { id: "for-loop", title: "for loop" },
  { id: "while-do", title: "while / do-while loops" },
  { id: "methods-defining", title: "Defining methods: signature, return type, parameters" },
  { id: "arrays-basics", title: "1D arrays: declare, create, populate, iterate" },
  { id: "objects-classes", title: "Objects & classes: constructors, instance fields/methods, this" },
];
// What the learner has actually been taught so far.
const KNOWN = ["program-setup", "basic-syntax", "input-scanner", "arithmetic-ops", "string-basics"].map((n) => ({ name: n, topic: n }));
const ids = (cs) => cs.map((c) => c.id).sort();

const COUNT_A = `import java.util.Scanner;
public class Main {
    public static void main(String[] args) {
        Scanner sc = new Scanner(System.in);
        String input = sc.nextLine();
        int count = 0;
        for (int i = 0; i < input.length(); i++) {
            if (input.charAt(i) == 'a' || input.charAt(i) == 'A') {
                count++;
            }
        }
        System.out.println("Count of 'a': " + count);
    }
}`;

const INNER = `import java.util.Scanner;
public class Main {
    public static void main(String[] args) {
        Scanner sc = new Scanner(System.in);
        // for each character... (a comment, not code)
        String text = sc.nextLine();
        System.out.println("Second: " + text.charAt(1) + " || done");
        System.out.println("Penultimate: " + text.charAt(text.length() - 2));
    }
}`;

test("the Count Letter A solution needs loops, if, || and ++ — none taught yet", () => {
  assert.deepEqual(ids(untaughtConstructs(COUNT_A, "java", KNOWN, TOPICS)), ["boolean-logic", "for-loop", "if-else", "increment"]);
});

test("an exercise inside the toolbox passes (comments, strings and main's args don't count)", () => {
  assert.deepEqual(untaughtConstructs(INNER, "java", KNOWN, TOPICS), []);
});

test("teaching a topic (by name or by course-map tag) covers its construct", () => {
  const more = [...KNOWN, { name: "for loops", topic: undefined }, { name: "selection", topic: "if-else" }, { name: "and/or", topic: "boolean-logic" }];
  assert.deepEqual(ids(untaughtConstructs(COUNT_A, "java", more, TOPICS)), ["increment"]);
});

test("the Math class topic doesn't count as teaching classes; string methods are caught", () => {
  const code = `public class Main { public static void main(String[] args) { String s = "hi"; System.out.println(s.toUpperCase()); } }`;
  assert.deepEqual(ids(untaughtConstructs(code, "java", KNOWN, TOPICS)), ["string-methods"]);
  const twoClasses = `class Dog { } public class Main { public static void main(String[] a) { } }`;
  assert.deepEqual(ids(constructsUsed(twoClasses, "java")), ["classes"]);
});

test("helper methods and arrays are detected", () => {
  const code = `public class Main {
    static int twice(int x) { return x * 2; }
    public static void main(String[] args) { int[] a = new int[3]; System.out.println(twice(a.length)); }
}`;
  assert.deepEqual(ids(constructsUsed(code, "java")), ["arrays", "methods"]);
});

test("python constructs", () => {
  const code = `s = input()  # for each letter\ncount = 0\nfor ch in s:\n    if ch == "a" or ch == "A":\n        count += 1\nprint("for and or")`;
  assert.deepEqual(ids(constructsUsed(code, "python")), ["boolean-logic", "for-loop", "if-else", "increment"]);
});

test("each construct maps to the course topic that teaches it, in course order", () => {
  const used = constructsUsed(COUNT_A, "java");
  const t = Object.fromEntries(used.map((c) => [c.id, topicFor(c, TOPICS)?.id]));
  assert.deepEqual(t, { "if-else": "if-else", "boolean-logic": "boolean-logic", "for-loop": "for-loop", increment: undefined });
});

test("fenced code blocks are pulled from quiz text", () => {
  const q = "What does this print?\n```java\nint x = 3;\nif (x > 2) System.out.println(x);\n```";
  assert.deepEqual(fencedCode(q), [{ code: "int x = 3;\nif (x > 2) System.out.println(x);\n", language: "java" }]);
  assert.deepEqual(fencedCode("```\nx++;\n```", "java").length, 1);
});

test("a solution and its starter, each with `public class Main`, aren't 'your own classes'", () => {
  const solution = `import java.util.Scanner;\npublic class Main {\n  public static void main(String[] args) {\n    Scanner sc = new Scanner(System.in);\n    String first = sc.nextLine();\n    String second = sc.nextLine();\n    System.out.println("Combined: " + first + " " + second);\n    System.out.println("Total length: " + (first.length() + second.length()));\n  }\n}`;
  const starter = `import java.util.Scanner;\npublic class Main {\n  public static void main(String[] args) {\n    Scanner sc = new Scanner(System.in);\n    // TODO\n  }\n}`;
  // Scanned one at a time, as the tutor gate does.
  for (const code of [solution, starter]) assert.deepEqual(untaughtConstructs(code, "java", KNOWN, TOPICS), []);
});

// ── Course-map coverage: names that mention a keyword don't teach it ─────────
import { CONSTRUCTS, isCovered, scanText, codeOnly } from "../../extensions/lib/constructs.ts";

// The real Java course map (Java - Topics.json), in course order.
const MAP = [
  ...TOPICS.slice(0, 8),
  { id: "input-validation", title: "Input validation & error handling in selection" },
  { id: "math-functions", title: "Math functions & character/string methods" },
  { id: "string-manipulation", title: "String manipulation (substring, compare, loop over chars)" },
  { id: "for-loop", title: "for loop" },
  { id: "while-do", title: "while / do-while loops" },
  { id: "nested-loops", title: "Nested loops" },
  { id: "loop-patterns", title: "Loop patterns: sum, product, max/min, count, sentinel" },
  { id: "methods-defining", title: "Defining methods: signature, return type, parameters" },
  { id: "method-overloading", title: "Method overloading" },
  { id: "pass-by-value", title: "Pass-by-value (primitives vs. array references)" },
  { id: "variable-scope", title: "Variable scope: local, parameter, class/static" },
  { id: "arrays-basics", title: "1D arrays: declare, create, populate, iterate" },
  { id: "array-algorithms", title: "Array algorithms: search (linear), min/max, sum, shift" },
  { id: "arrays-2d", title: "Multidimensional (2D) arrays" },
  { id: "memory-model", title: "Java memory management: references, objects vs. primitives" },
  { id: "objects-classes", title: "Objects & classes: constructors, instance fields/methods, this" },
  { id: "oop-thinking", title: "Object-oriented thinking: encapsulation, access modifiers" },
  { id: "inheritance", title: "Inheritance: extends, super, overriding" },
  { id: "exception-handling", title: "Exception handling: try/catch/finally, throws" },
  { id: "io-basics", title: "I/O basics: Scanner from files, PrintWriter, BufferedReader" },
  { id: "abstract-interfaces", title: "Abstract classes & interfaces" },
];
const byId = Object.fromEntries(CONSTRUCTS.map((c) => [c.id, c]));
const coveredBy = (name, topic) => CONSTRUCTS.filter((c) => isCovered(c, [{ name, topic }], MAP)).map((c) => c.id);

test("incidental words in concept names don't count as teaching", () => {
  const cases = {
    "Entry point: main method": ["exceptions"], "Geometry formulas": ["exceptions"], "Retry input prompt": ["exceptions"],
    "Formatting output for printing": ["for-loop"], "Variables for storing data": ["for-loop"], "for-each preview": ["for-loop"],
    "if you get stuck": ["if-else"], "What if the input is empty?": ["if-else"], "Expressions & conditional output": ["if-else"],
    "Primitive types: int, double, boolean, char": ["boolean-logic"], "Logical errors": ["boolean-logic"],
    "Creating a Scanner object": ["classes"], "String objects": ["classes"],
    "String concatenation with +=": ["increment"], "Increment by hand: x = x + 1": ["increment"],
    "Escape characters": ["character-methods"], "Meanwhile…": ["while-loop"], "Equals sign vs assignment": ["string-methods"],
    "2D coordinates": ["arrays-2d", "arrays"], "Math class (pow, sqrt)": ["classes"], "Selection sort": ["if-else"],
  };
  for (const [name, wrong] of Object.entries(cases)) for (const id of wrong) assert.ok(!isCovered(byId[id], [{ name }], MAP), `${name} → ${id}`);
  // The learner's real concepts cover none of the later constructs (casting rides on arithmetic).
  const real = KNOWN.flatMap((k) => coveredBy(k.name, k.topic));
  assert.deepEqual([...new Set(real)], ["casting"]);
});

test("real course-map topics (by id, and by title alone) cover their constructs", () => {
  const want = {
    "if-else": "if-else", "boolean-logic": "boolean-logic", "for-loop": "for-loop", "while-do": "while-loop", "methods-defining": "methods",
    "arrays-basics": "arrays", "arrays-2d": "arrays-2d", "objects-classes": "classes", "exception-handling": "exceptions",
    "string-manipulation": "string-methods", "math-functions": "character-methods", switch: "switch", inheritance: "inheritance", "abstract-interfaces": "interfaces",
  };
  for (const [topic, id] of Object.entries(want)) {
    assert.ok(isCovered(byId[id], [{ name: "x", topic }], MAP), `topic ${topic} → ${id}`);
    const title = MAP.find((t) => t.id === topic).title;
    assert.ok(isCovered(byId[id], [{ name: title }], []), `title "${title}" → ${id}`);
  }
  for (const id of ["string-methods", "formatted-output", "parse-numbers"]) assert.ok(isCovered(byId[id], [{ name: "x", topic: "math-functions" }], MAP));
  for (const name of ["for loops", "The for loop", "while loops", "do-while", "if-else statements", "try/catch", "Exceptions", "Boolean operators", "&& and ||", "ternary operator", "Increment and decrement operators", "Defining methods", "2D arrays", "Arrays", "Objects and classes", "Constructors", "switch statement", "String methods", "printf"])
    assert.ok(CONSTRUCTS.some((c) => isCovered(c, [{ name }], [])), name);
});

test("topicFor picks the canonical course topic, not a title that mentions the word", () => {
  const t = (id) => topicFor(byId[id], MAP)?.id;
  assert.equal(t("arrays"), "arrays-basics");
  assert.equal(t("classes"), "objects-classes");
  assert.equal(t("while-loop"), "while-do");
  assert.equal(t("methods"), "methods-defining");
  assert.equal(t("exceptions"), "exception-handling");
  assert.equal(t("arrays-2d"), "arrays-2d");
  assert.equal(t("string-methods"), "math-functions"); // first in course order
  assert.equal(t("casting"), "arithmetic-ops");
});

// ── Quiz text: output isn't code ────────────────────────────────────────────
const scanIds = (text) => [...new Set(scanText(text, "java").flatMap((s) => untaughtConstructs(s.code, s.language, KNOWN, MAP).map((c) => c.id)))].sort();

test("program output in quiz text isn't scanned as Java", () => {
  assert.deepEqual(scanIds('What does `System.out.println("Hello" + "!");` print? Answer: `Hello!`'), []);
  assert.deepEqual(scanIds("`Hello, World!`"), []);
  assert.deepEqual(scanIds("Given input 5, the program prints:\n```text\nEnter a number? 5\nResult: 10\n```"), []);
  assert.deepEqual(scanIds("```console\n$ java Main\n-- Menu --\nScore: 10/10\n```"), []);
  assert.deepEqual(scanIds("```output\n!!! a ? b : c\n```"), []);
  assert.deepEqual(scanIds("The program asks `Name?` then prints `Hi: Bob`"), []);
  assert.deepEqual(scanIds("The output is `[1, 2, 3]`"), []);
  assert.deepEqual(scanIds("```\nEnter a number? 5\nResult: 10\n```"), []); // untagged, but not code
});

test("real code in quiz text is still scanned, in any fence style", () => {
  assert.deepEqual(scanIds("Fix: `System.out.println(\"don't\")` and `x++`"), ["increment"]);
  assert.deepEqual(scanIds("What is `x > 2 ? 1 : 0`; when `int x = 3;`?"), ["ternary"]);
  assert.deepEqual(scanIds("What prints?\r\n```java\r\nint i = 0;\r\nfor (i = 0; i < 3; i = i + 1) {}\r\n```"), ["for-loop"]);
  assert.deepEqual(scanIds('```java title="Main.java"\nfor (int i=0;i<3;i=i+1){}\n```'), ["for-loop"]);
  assert.deepEqual(scanIds("~~~java\nwhile (true) {}\n~~~"), ["while-loop"]);
  assert.deepEqual(scanIds("```Java \nif (x > 1) {}\n```"), ["if-else"]);
  assert.deepEqual(scanIds("```jshell\njshell> if (x > 1) x = 2\n```"), ["if-else"]);
  assert.deepEqual(scanIds("````java\nint[] a = {1};\n````"), ["arrays"]);
  assert.deepEqual(scanText("```py\nfor c in s: print(c)\n```").map((s) => s.language), ["python"]);
  assert.deepEqual(scanText("inline `x++` needs a fallback"), []);
});

test("inline spans are scanned one at a time (a `?` in one, a `:` in another)", () => {
  assert.deepEqual(scanIds("Is `int x = a;` right? Note: `int y = b;`"), []);
});

// ── Tokenizer ────────────────────────────────────────────────────────────────
const W = (s) => `public class Main {\n  public static void main(String[] args) {\n${s}\n  }\n}`;
const used = (code, lang = "java") => ids(constructsUsed(code, lang));

test("strings and comments can't hide the code after them", () => {
  assert.deepEqual(used(W('String u = "http://x.com"; if (u.length() > 3) System.out.println(u);')), ["if-else"]);
  assert.deepEqual(used(W('System.out.println("/*"); for (int i=0;i<3;i=i+1) System.out.println(i); System.out.println("*/");')), ["for-loop"]);
  assert.deepEqual(used(W(`char q = '"'; int n = 0; n++; if (q == 'a') n = 1;`)), ["if-else", "increment"]);
  assert.deepEqual(used(W(`char q = '\\''; int n = 0; n++;`)), ["increment"]);
  assert.deepEqual(used(W('String t = """\n  He said "hi" for (\n  if (x) && y\n  """;\nSystem.out.println(t);')), []);
  assert.deepEqual(used(W('String s = "a \\" for ( b"; /* if ( */ // while (\nint x = 1;')), []);
  assert.deepEqual(used('x = int(input())\ns = "#" if x else "-"\nprint(s)', "python"), ["ternary"]);
  assert.deepEqual(used(`x = 3\nprint(f"{'big' if x > 2 else 'small'}")`, "python"), ["ternary"]);
  assert.deepEqual(used('s = """for x in y:\n  if a or b:\n"""\nprint(s)  # while x:', "python"), []);
  assert.deepEqual(used("print(f\"{{x}} or {y!r:>5}\")\nprint(r'\\d+ and ')", "python"), []);
  assert.deepEqual(used("const t = `a ${x ? 1 : 2} for (`;", "javascript"), ["ternary"]);
  assert.deepEqual(used("const re = /\\/\\//; if (re.test(x)) y++;", "javascript"), ["if-else", "increment"]);
  assert.deepEqual(used("const half = a / 2; const b = c / 3; // for (", "javascript"), []);
  assert.equal(codeOnly('a = "x" + \'y\'; // c', "java"), "a = \"\" + 'x';  ");
});

// ── Constructs that used to slip through ─────────────────────────────────────
test("Java: try-with-resources, collections, lambdas, formatting, casting, var, throw, args[0], OOP", () => {
  assert.deepEqual(used("public class Main {\n public static void main(String[] args) {\n try (Scanner sc = new Scanner(System.in)) { System.out.println(sc.nextLine()); }\n }\n}"), ["exceptions"]);
  assert.deepEqual(used(W('ArrayList<Integer> xs = new ArrayList<>(); xs.add(1); List<String> l = List.of("a");')), ["collections"]);
  assert.deepEqual(used(W("System.out.println(IntStream.rangeClosed(1,5).map(x -> x*x).sum());")), ["lambdas"]);
  assert.deepEqual(used(W("Runnable r = Main::run;")), ["lambdas"]);
  assert.deepEqual(used(W('String s = "ab"; System.out.println(s.repeat(3) + s.strip() + s.concat("x"));')), ["string-methods"]);
  assert.deepEqual(used(W('System.out.printf("%d%n", 3); String t = String.format("%.2f", 1.5);')), ["formatted-output"]);
  assert.deepEqual(used(W("int n = Integer.parseInt(s);")), ["parse-numbers"]);
  assert.deepEqual(used(W("double d = (double) n / 2; char c = (char)('a' + n);")), ["casting"]);
  assert.deepEqual(used(W('var s = "5";')), ["var"]);
  assert.deepEqual(used('public class Main {\n public static void main(String[] args) throws Exception {\n throw new IllegalArgumentException("x");\n }\n}'), ["exceptions"]);
  assert.deepEqual(used("public class Main {\n public static void main(String... args) { System.out.println(args[0]); }\n}"), ["arrays"]);
  assert.deepEqual(used("public class Main {\n int x;\n Main(int x) { this.x = x; }\n int get() { return x; }\n public static void main(String[] args) { Main m = new Main(5); System.out.println(m.get()); }\n}"), ["classes", "methods"]);
  assert.deepEqual(used("public class Main {\n void hi() {}\n public static void main(String[] args) { new Main().hi(); }\n}"), ["classes", "methods"]);
  assert.deepEqual(used("public class Main {\n record P(int x) {}\n enum C { R, G }\n public static void main(String[] args) { }\n}"), ["classes"]);
  assert.deepEqual(used("interface Shape { double area(); }\npublic class Main { public static void main(String[] a) { } }"), ["classes", "interfaces"]);
  assert.deepEqual(used("class A {}\nclass B extends A { @Override public String toString() { return super.toString(); } }"), ["classes", "inheritance", "methods"]);
  assert.deepEqual(used("public class Main {\n static <T> void show(T t) { System.out.println(t); }\n public static void main(String[] args) { show(1); }\n}"), ["methods"]);
  assert.deepEqual(used("public class Main {\n static Map<String, Integer> mk() { return null; }\n public static void main(String[] args) { }\n}"), ["collections", "methods"]);
  assert.deepEqual(used(W('StringBuilder sb = new StringBuilder(); sb.append("a");')), ["string-methods"]);
});

test("Java code the learner has been taught stays clean", () => {
  const taught = W([
    "Scanner sc = new Scanner(System.in);", "String name = sc.nextLine();", "int n = sc.nextInt();", "double d = sc.nextDouble();",
    "System.out.println(\"Hi, \" + name + \"!\");", "System.out.print(name.length() + \" \" + name.charAt(0));",
    "System.out.println(Math.pow(2, 3) + Math.sqrt(16) + Math.max(1, 2) + Math.abs(-3) + Math.round(2.5));",
    "int x = -1; int y = x - -2; System.out.println(x * -y + n % 2);", 'System.out.println("a\\tb\\n\\"q\\" \\\\ \'");',
  ].join("\n"));
  assert.deepEqual(untaughtConstructs(taught, "java", KNOWN, MAP), []);
  // Comparisons aren't logic or shortcut operators.
  assert.deepEqual(used(W("boolean b = x != 1; boolean c = x >= 2; boolean e = x <= 3; boolean f = x == 4;")), []);
  assert.deepEqual(used(W("for (List<?> l : ls) {}")), ["collections", "for-loop"]);
});

test("held up: do-while, enhanced for, switch expressions", () => {
  assert.deepEqual(used(W("int i=0; do { i = i + 1; } while(i<3);")), ["while-loop"]);
  assert.deepEqual(used(W("for (int v : nums) System.out.println(v);")), ["for-loop"]);
  assert.deepEqual(used(W('int d=2; String n = switch (d) { case 1 -> "a"; default -> "b"; };')), ["switch"]);
});

test("Python: comprehensions, one-line blocks, string methods, slicing, lambda, dicts", () => {
  assert.deepEqual(used('s = input()\nprint(sum(1 for c in s if c == "a"))', "python"), ["comprehensions"]);
  assert.deepEqual(used("xs = [c.upper() for c in s]", "python"), ["arrays", "comprehensions", "string-methods"]);
  assert.deepEqual(used('x = int(input())\nif x > 0: print("pos")', "python"), ["if-else"]);
  assert.deepEqual(used("while x > 0: x = x - 1", "python"), ["while-loop"]);
  assert.deepEqual(used("for c in input(): print(c)", "python"), ["for-loop"]);
  assert.deepEqual(used("s = input()\nprint(s[::-1])", "python"), ["string-methods"]);
  assert.deepEqual(used('print(s.replace("a", "b"))', "python"), ["string-methods"]);
  assert.deepEqual(used("f = lambda x: x * 2", "python"), ["lambdas"]);
  assert.deepEqual(used('d = {"a": 1}', "python"), ["collections"]);
  assert.deepEqual(used("try: x = int(input())\nexcept ValueError: x = 0", "python"), ["exceptions"]);
  assert.deepEqual(used("def f():\n    return 1", "python"), ["methods"]);
  // Held up / taught: print(end=), while True, is not, indexing, len.
  assert.deepEqual(used('s = input()\nprint(s[0], len(s), end="")\nprint(x is not None, x not in s)', "python"), []);
  assert.deepEqual(used("while True:\n    break", "python"), ["while-loop"]);
});

test("JavaScript: optional chaining and ?? aren't ternaries; string methods are caught", () => {
  assert.deepEqual(used("const o = { a: p?.b, y: 2 };", "javascript"), []);
  assert.deepEqual(used("const v = { a: x ?? y, b: 1 };", "javascript"), []);
  assert.deepEqual(used("const v = a ? b : c;", "javascript"), ["ternary"]);
  assert.deepEqual(used('const s = "ab"; console.log(s.toUpperCase(), s.slice(1));', "javascript"), ["string-methods"]);
  assert.deepEqual(used("if (a !== b && c === d) {}", "javascript"), ["boolean-logic", "if-else"]);
});
