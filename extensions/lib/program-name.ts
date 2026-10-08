import { codeOnly, codeSegments } from "./constructs.ts";
import type { Language } from "./run-code.ts";

// Each exercise's file is named after it ("Count Letter A" → CountLetterA.java
// with `public class CountLetterA`). Every exercise used to be Main.java, and
// several classes named Main in one workspace clash: VS Code ran the first one.

// Names a program must not take: a class named Exception breaks `throws
// Exception`, one named Override breaks `@Override`, a math.py breaks `import
// math`. Compared case-insensitively.
const SHARED = ["main", "test", "con", "prn", "aux", "nul", ...[1, 2, 3, 4, 5, 6, 7, 8, 9].flatMap((n) => [`com${n}`, `lpt${n}`])]; // + Windows device names
const JAVA_LANG =
	"AbstractMethodError Appendable ArithmeticException ArrayIndexOutOfBoundsException ArrayStoreException AssertionError AutoCloseable Boolean BootstrapMethodError Byte CharSequence Character Class ClassCastException ClassCircularityError ClassFormatError ClassLoader ClassNotFoundException ClassValue CloneNotSupportedException Cloneable Comparable Compiler Deprecated Double Enum EnumConstantNotPresentException Error Exception ExceptionInInitializerError Float FunctionalInterface IllegalAccessError IllegalAccessException IllegalArgumentException IllegalCallerException IllegalMonitorStateException IllegalStateException IllegalThreadStateException IncompatibleClassChangeError IndexOutOfBoundsException InheritableThreadLocal InstantiationError InstantiationException Integer InternalError InterruptedException Iterable LayerInstantiationException LinkageError Long MatchException Math Module ModuleLayer NegativeArraySizeException NoClassDefFoundError NoSuchFieldError NoSuchFieldException NoSuchMethodError NoSuchMethodException NullPointerException Number NumberFormatException Object OutOfMemoryError Override Package Process ProcessBuilder ProcessHandle Readable Record ReflectiveOperationException Runnable Runtime RuntimeException RuntimePermission SafeVarargs ScopedValue SecurityException SecurityManager Short StackOverflowError StackTraceElement StackWalker StrictMath String StringBuffer StringBuilder StringIndexOutOfBoundsException SuppressWarnings System Thread ThreadDeath ThreadGroup ThreadLocal Throwable TypeNotPresentException UnknownError UnsatisfiedLinkError UnsupportedClassVersionError UnsupportedOperationException VerifyError VirtualMachineError Void WrongThreadException";
// java.util classes exercises import, and Java keywords.
const JAVA_MORE =
	"Scanner Random Arrays Array List ArrayList LinkedList Map HashMap TreeMap Set HashSet TreeSet Collections Iterator Objects Optional Date Locale Formatter Stack Queue Deque " +
	"abstract assert boolean break byte case catch char class const continue default do double else enum extends final finally float for goto if implements import instanceof int interface long native new package private protected public return short static strictfp super switch synchronized this throw throws transient try void volatile while var record yield sealed permits true false null";
const PYTHON =
	"False None True and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield match case type " +
	"math random string sys os time json re io collections itertools functools operator statistics typing turtle copy types code token tokenize keyword queue calendar datetime array unittest doctest abc enum decimal fractions numbers cmath csv pathlib glob shutil subprocess threading multiprocessing asyncio logging heapq bisect struct select socket signal inspect ast dis pprint textwrap difflib hashlib secrets uuid base64 pickle shelve sqlite3 tkinter platform locale gettext codecs unicodedata warnings contextlib dataclasses weakref gc site builtins traceback timeit argparse getpass tempfile zipfile tarfile gzip zlib email html http urllib xml sched selectors this antigravity graphlib numpy pandas matplotlib list dict set";
const JS =
	"break case catch class const continue debugger default delete do else export extends finally for function if import in instanceof let new return super switch this throw try typeof var void while with yield await enum implements interface package private protected public static null true false undefined arguments eval NaN Infinity";
const lower = (s: string) => s.split(/\s+/).map((w) => w.toLowerCase());
const RESERVED: Record<Language, Set<string>> = {
	java: new Set([...SHARED, ...lower(JAVA_LANG), ...lower(JAVA_MORE)]),
	python: new Set([...SHARED, ...lower(PYTHON)]),
	javascript: new Set([...SHARED, ...lower(JS), "string", "math", "object", "array", "number", "boolean", "json", "date", "map", "set", "promise", "console"]),
};

// Letters NFKD can't split into ASCII + accent.
const TRANSLIT: Record<string, string> = { ß: "ss", ẞ: "SS", æ: "ae", Æ: "AE", ø: "o", Ø: "O", œ: "oe", Œ: "OE", đ: "d", Đ: "D", ł: "l", Ł: "L", þ: "th", Þ: "Th", ð: "d", Ð: "D", ı: "i", ŋ: "ng" };

// Short stable hash, so two non-Latin titles don't both become "Exercise".
function shortHash(s: string): string {
	let h = 0x811c9dc5;
	for (const ch of s) h = Math.imul(h ^ ch.codePointAt(0)!, 0x01000193) >>> 0;
	return h.toString(36).slice(0, 5);
}

const SUFFIX: Record<Language, string> = { java: "Program", python: "_program", javascript: "Program" };

/**
 * A file/class name for an exercise title. Leading number words are dropped
 * ("2 Numbers Sum" → NumbersSum); a name that would still start with a digit
 * gets "Ex" ("2nd Largest" → Ex2ndLargest, "3D Shapes" → Ex3DShapes). A title
 * with no Latin letters/digits ("计算器", "🎉") → "Exercise" + a short hash.
 * Pass the Java code (starter/solution) so the name can't collide with a
 * helper class it declares ("Dog" + `class Dog` → DogProgram).
 */
export function programName(title: string, language: Language, code?: string | string[]): string {
	let words = title
		.replace(/[^\x00-\x7f]/g, (ch) => TRANSLIT[ch] ?? ch)
		.normalize("NFKD")
		.replace(/[^A-Za-z0-9]+/g, " ")
		.trim()
		.split(/\s+/)
		.filter(Boolean);
	if (words.some((w) => /\D/.test(w))) while (/^\d+$/.test(words[0])) words.shift();
	if (!words.length) {
		if (!/[\p{L}\p{N}\p{Extended_Pictographic}]/u.test(title)) return language === "java" ? "Main" : "main";
		words = ["Exercise", shortHash(title.trim())];
	}
	if (/^\d/.test(words[0])) words.unshift("Ex");
	const cap = (w: string) => w[0].toUpperCase() + w.slice(1);
	let name: string;
	if (language === "python") name = words.map((w) => w.toLowerCase()).join("_");
	else if (language === "javascript") name = words.map((w, i) => (i ? cap(w) : w.length > 1 && w === w.toUpperCase() ? w.toLowerCase() : w[0].toLowerCase() + w.slice(1))).join("");
	else name = words.map(cap).join("");
	name = name.slice(0, 48).replace(/_+$/, "");
	if (RESERVED[language].has(name.toLowerCase())) name += SUFFIX[language];
	if (language === "java" && code) name = freeJavaName([code].flat().join("\n"), name);
	return name;
}

// Types the code declares other than its public class.
function helperTypes(src: string): Set<string> {
	const pub = publicClass(src);
	return new Set([...src.matchAll(/\b(?:class|interface|enum|record)\s+([\w$]+)/g)].map((m) => m[1]).filter((n) => n !== pub));
}

function publicClass(src: string): string | undefined {
	return /\bpublic\s+(?:(?:abstract|final|static|strictfp|sealed|non-sealed)\s+)*class\s+([\w$]+)/.exec(src)?.[1];
}

function freeJavaName(code: string, name: string): string {
	const taken = helperTypes(codeOnly(code, "java"));
	if (!taken.has(name)) return name;
	let n = `${name}Program`;
	for (let i = 2; taken.has(n); i++) n = `${name}Program${i}`;
	return n;
}

// Java's public class must match the file name: rename the code's public class
// everywhere it's used (constructors, `Main m`, `Main.MAX`, `Main::sq`), but not
// inside strings or comments. If `name` is already a helper class in the code,
// it becomes `${name}Program` — call programName(title, "java", code) for the
// file name so the two agree.
export function renameJavaClass(code: string, name: string): string {
	const old = publicClass(codeOnly(code, "java"));
	if (!old) return code;
	const target = freeJavaName(code, name);
	if (old === target) return code;
	const re = new RegExp(`(?<![\\w$])${old.replace(/\$/g, "\\$")}(?![\\w$])`, "g");
	return codeSegments(code, "java")
		.map((s) => (s.kind === "code" ? s.text.replace(re, target) : s.text))
		.join("");
}

// Markdown → plain text, keeping operators: `a * b`, `x > 5` and snake_case stay.
function plainText(md: string): string {
	return md
		.replace(/^[ \t]*(?:#{1,6}[ \t]+|>[ \t]?)/gm, "") // headings, quotes
		.replace(/^([ \t]*)[*+][ \t]+/gm, "$1- ") // bullets
		.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1") // links
		.replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, "$2") // **bold**
		.replace(/(^|[\s(])([*_])(?=[^\s*_])((?:(?!\2)[^\n])*?\S)\2(?=$|[\s).,;:!?])/gm, "$1$3") // *em*
		.replace(/`+/g, "");
}

// Comment-safe text. Java: javac reads \u escapes even in comments ("C:\users"
// → illegal unicode escape), and "*/" would end the comment. Python: the
// docstring is raw (r""") when it has backslashes, so "\N" or "\U" can't break it.
function commentSafe(s: string, language: Language): string {
	if (language === "python") return s.replace(/"""/g, '"" "').replace(/\\+$/, (m) => `${m} `);
	let out = s.replace(/\*\//g, "* /");
	if (language === "java") out = out.replace(/\\+(?=u)/g, (m) => (m.length % 2 ? `${m}\\` : m));
	return out;
}

// The comment at the top of a new exercise file: title and a one-paragraph
// summary in plain text. The full prompt (formats, examples) lives in the
// TutorBot panel and README.md, so the code doesn't open with 25 lines of markdown.
export function exerciseHeader(title: string, prompt: string, language: Language): string {
	// The first paragraph, stopping at a code fence or heading even with no blank line before it.
	const first = plainText((prompt.replace(/\r\n?/g, "\n").split(/\n\s*\n|\n(?=\s*#)|```|~~~/)[0] ?? "").trim());
	// Wrap at ~80 columns, keeping list items ("1. …") on their own lines.
	const lines: string[] = [];
	for (const para of first.split("\n").map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean)) {
		const start = lines.length;
		for (const word of para.split(" ")) {
			const last = lines[lines.length - 1];
			if (lines.length > start && last.length + word.length < 80) lines[lines.length - 1] = `${last} ${word}`;
			else lines.push(lines.length > start && /^(\d+\.|-)/.test(para) ? `   ${word}` : word);
		}
	}
	const body = [title.trim(), ...(lines.length ? ["", ...lines] : []), "", "Full instructions and examples: the TutorBot panel, or README.md in this folder."].map((l) => commentSafe(l, language));
	if (language === "python") return [body.some((l) => l.includes("\\")) ? 'r"""' : '"""', ...body, '"""', ""].join("\n");
	return ["/*", ...body.map((l) => ` * ${l}`.trimEnd()), " */", ""].join("\n");
}
