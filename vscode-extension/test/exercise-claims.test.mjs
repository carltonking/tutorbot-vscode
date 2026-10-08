// A reply claiming an exercise file is open, when none was created. Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { claimsExerciseFile } from "../../extensions/lib/exercise-claims.ts";

test("the false claims from the session log are caught", () => {
  assert.ok(claimsExerciseFile("Your **Combine Two Strings** exercise is already open in the editor (the `Main.java` file you see)."));
  assert.ok(claimsExerciseFile("✅ **Your coding file is ready!** I’ve opened a new file named **`Main.java`** in your editor"));
  assert.ok(claimsExerciseFile("### Starter code (already loaded for you)"));
});

test("ordinary teaching text isn't", () => {
  assert.ok(!claimsExerciseFile("Open the file and read the string with sc.nextLine()."));
  assert.ok(!claimsExerciseFile("A Scanner reads input; once you've opened it with new Scanner(System.in) you can call nextLine()."));
  assert.ok(!claimsExerciseFile("Great job! All tests pass."));
});

import { looksLikeTextExercise } from "../../extensions/lib/exercise-claims.ts";

test("an exercise typed into chat is caught; a worked example isn't", () => {
  const typed = "### Combine Two Strings – Exercise\n**Starter code (copy-paste into `Main.java`)**\n```java\npublic class Main {\n  public static void main(String[] args) {\n    // TODO: Read the first string\n  }\n}\n```\n**Test cases**";
  assert.ok(looksLikeTextExercise(typed));
  const worked = "**Example 1:**\n```java\nString s = \"hi\";\nSystem.out.println(s.length());\n```\nThis prints 2 because…";
  assert.ok(!looksLikeTextExercise(worked));
});

import { fakeExercise } from "../../extensions/lib/exercise-claims.ts";
const F = (code, lang = "java") => "```" + lang + "\n" + code + "\n```";
const SKELETON = (body) => F(`public class Main {\n  public static void main(String[] args) {\n    ${body}\n  }\n}`);

test("no nudge for reviews, file I/O teaching, negated, conditional or future claims", () => {
  const fine = [
    "To read a file, create a Scanner on it. Once you've opened the file with `new Scanner(new File(\"data.txt\"))`, call nextLine().",
    "When the exercise file is ready, I'll tell you its name.",
    "I'll create the exercise now — once it's done the file is open in your editor.",
    "No file is open yet — I haven't opened a file for you. Say 'go' and I'll create one.",
    "The exercise file is not open yet.",
    "Is the file open in your editor?",
    "When the file is open in the editor, read it line by line.",
    "Nice work! Test case 2 failed because of the missing space:\n" + F('System.out.println("Combined: " + a + " " + b);'),
    "In your starter code, line 5 reads:\n" + F("String s = sc.nextLine();") + "\nThat part is fine.",
    "Here's how a placeholder looks in real projects:\n" + F("// TODO: handle empty input\nString s = sc.nextLine();"),
    "Good programmers think about test cases: empty input, one char, all caps.\n" + F('String s = "";\nSystem.out.println(s.length());'),
    "The file is open until you call close().",
    "I created a variable called count.",
  ];
  for (const t of fine) assert.ok(!fakeExercise(t), t);
});

test("claims in other words are caught", () => {
  const claims = [
    "I've just opened CountLetterA.java for you — give it a try!",
    "I have opened the exercise in VS Code.",
    "I've created `CountLetterA.java` in your Exercises folder. Go ahead and code!",
    "Your exercise is ready in the editor — press Check when done.",
    "The file's open on the left; fill in main.",
    "CountLetterA.java is now open in VS Code.",
    "I have opened CountLetterA.java for you, and if you get stuck just ask.",
    "Your file, CountLetterA.java, is now open in the editor.",
    "**Your exercise is ready!**",
  ];
  for (const t of claims) assert.ok(claimsExerciseFile(t), t);
});

test("exercises typed into chat are caught: placeholders in a skeleton, or paste-into-file", () => {
  const typed = [
    "### Exercise: Count A\n" + SKELETON("// Your code here"),
    "Try this:\n" + SKELETON("// todo: read input"),
    "Try:\n" + F("public class Main { public static void main(String[] a) { /* TODO */ } }"),
    "Paste this into `Main.java` and run it:\n" + F("public class Main {\n  public static void main(String[] args) {\n  }\n}"),
    "Copy-paste into **`Main.java`**:\n" + F("public class Main {}"),
    "Try:\r\n```java\r\n// TODO: read input\r\n```",
    "Exercise:\n" + F("s = input()\n# ...write your code below\n", "python"),
    "Your task — complete this function:\n" + F("def count_a(s):\n    pass", "python"),
    "Fill it in:\n~~~java\npublic class Main {\n  public static void main(String[] args) {\n    // TODO\n  }\n}\n~~~",
  ];
  for (const t of typed) assert.ok(looksLikeTextExercise(t), t);
  // Words alone aren't enough.
  assert.ok(!looksLikeTextExercise("**Starter code** and **test cases**:\n" + F('System.out.println("hi");')));
});
