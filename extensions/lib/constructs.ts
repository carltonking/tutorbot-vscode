// ────────────────────────────────────────────────────────────────────────────
// constructs — which language features a piece of code actually uses.
//
// An exercise tagged "string-basics" can still need a for loop and || to solve.
// The teach-first gate checks the tags; this checks the code. A construct
// counts as taught when a recorded concept's course-map topic is one of the
// construct's canonical `topics`, or when the concept's name (or its topic's
// id/title, for other course maps) matches the construct's `words`. `words`
// are anchored, specific phrases: "Entry point: main method" contains "try"
// and "Formatting output for printing" contains "for", but neither teaches it.
// ────────────────────────────────────────────────────────────────────────────

export type CodeLanguage = "java" | "python" | "javascript";

export interface Construct {
	id: string;
	label: string; // how the learner would recognise it
	words: RegExp; // matches a concept name or course-map topic id/title that teaches it
	topics?: string[]; // course-map topic ids that teach it (checked first)
	java?: RegExp;
	python?: RegExp;
	javascript?: RegExp;
}

// ── Tokenizer ────────────────────────────────────────────────────────────────
// One left-to-right pass, so `"http://x"`, `"/*"` or `'"'` can't swallow the
// code after them (separate regex passes did, in whichever order they ran).

export interface CodeSegment {
	kind: "code" | "comment" | "string" | "char"; // char: a Java char literal
	text: string; // the original text; segments concatenate back to the input
}

type Push = (kind: CodeSegment["kind"], text: string) => void;

const isIdent = (ch: string | undefined) => !!ch && /[\w$]/.test(ch);

/** Split code into code / comment / string-literal segments. */
export function codeSegments(code: string, language: CodeLanguage): CodeSegment[] {
	const segs: CodeSegment[] = [];
	const push: Push = (kind, text) => {
		if (!text) return;
		const last = segs[segs.length - 1];
		if (last && last.kind === kind && kind === "code") last.text += text;
		else segs.push({ kind, text });
	};
	scan(code, 0, language, false, push);
	return segs;
}

// Scans code from i. Inside an interpolation (`${…}` / f"{…}") it stops at the
// closing brace and returns its index.
function scan(src: string, i: number, lang: CodeLanguage, interp: boolean, push: Push): number {
	const n = src.length;
	let start = i;
	let depth = 0;
	const flush = (to: number) => push("code", src.slice(start, to));
	while (i < n) {
		const ch = src[i];
		const two = src.slice(i, i + 2);
		if (interp && ch === "{") depth++;
		if (interp && ch === "}") {
			if (depth === 0) {
				flush(i);
				return i;
			}
			depth--;
		}
		let end = -1;
		let kind: CodeSegment["kind"] = "comment";
		if (lang !== "python" && two === "//") end = lineEnd(src, i);
		else if (lang !== "python" && two === "/*") {
			const e = src.indexOf("*/", i + 2);
			end = e < 0 ? n : e + 2;
		} else if (lang === "python" && ch === "#") end = lineEnd(src, i);
		else if (lang === "javascript" && ch === "/" && regexAllowed(src, i)) {
			end = regexEnd(src, i);
			kind = "string";
		} else if (lang === "java" && src.startsWith('"""', i)) {
			end = quoteEnd(src, i + 3, '"""', true);
			kind = "string";
		} else if (lang !== "python" && (ch === '"' || ch === "'")) {
			end = quoteEnd(src, i + 1, ch, false);
			kind = lang === "java" && ch === "'" ? "char" : "string";
		}
		if (end >= 0) {
			flush(i);
			push(kind, src.slice(i, end));
			i = start = end;
			continue;
		}
		if (lang === "javascript" && ch === "`") {
			flush(i);
			i = start = interpolated(src, i, i + 1, "`", lang, push);
			continue;
		}
		if (lang === "python" && !isIdent(src[i - 1])) {
			const m = /^([rRbBuUfF]{0,2})("""|'''|"|')/.exec(src.slice(i, i + 5));
			if (m) {
				flush(i);
				const q = m[2];
				const body = i + m[0].length;
				if (/f/i.test(m[1])) i = interpolated(src, i, body, q, lang, push);
				else {
					const e = quoteEnd(src, body, q, q.length === 3);
					push("string", src.slice(i, e));
					i = e;
				}
				start = i;
				continue;
			}
		}
		i++;
	}
	flush(n);
	return n;
}

const lineEnd = (src: string, i: number) => {
	const e = src.indexOf("\n", i);
	return e < 0 ? src.length : e;
};

// End (exclusive) of a quoted literal whose body starts at i. Single-line
// literals stop at a newline, so an unclosed quote can't eat the file.
function quoteEnd(src: string, i: number, q: string, multiline: boolean): number {
	while (i < src.length) {
		if (src[i] === "\\") i += 2;
		else if (src.startsWith(q, i)) return i + q.length;
		else if (!multiline && src[i] === "\n") return i;
		else i++;
	}
	return src.length;
}

// A template literal / f-string: literal parts are strings, `${…}` / `{…}` code.
function interpolated(src: string, from: number, i: number, q: string, lang: CodeLanguage, push: Push): number {
	const js = lang === "javascript";
	const multiline = js || q.length === 3;
	let start = from;
	while (i < src.length) {
		if (src[i] === "\\") i += 2;
		else if (src.startsWith(q, i)) {
			push("string", src.slice(start, i + q.length));
			return i + q.length;
		} else if (!multiline && src[i] === "\n") break;
		else if (!js && src.startsWith("{{", i)) i += 2;
		else if ((js && src.startsWith("${", i)) || (!js && src[i] === "{")) {
			const open = i + (js ? 2 : 1);
			push("string", src.slice(start, open));
			i = scan(src, open, lang, true, push);
			start = i; // the closing brace belongs to the next literal part
			i++;
		} else i++;
	}
	const end = Math.min(i, src.length);
	push("string", src.slice(start, end));
	return end;
}

// JS: `/` starts a regex literal after an operator or keyword, else it divides.
function regexAllowed(src: string, i: number): boolean {
	if (src[i + 1] === "/" || src[i + 1] === "*") return false;
	let j = i - 1;
	while (j >= 0 && /\s/.test(src[j])) j--;
	if (j < 0) return true;
	if (/[(,=:[!&|?{};+\-*%<>~^]/.test(src[j])) return true;
	return /\b(return|typeof|case|do|else|in|of|void|yield|await)$/.test(src.slice(Math.max(0, j - 6), j + 1));
}

function regexEnd(src: string, i: number): number {
	let cls = false;
	for (let j = i + 1; j < src.length; j++) {
		const c = src[j];
		if (c === "\n") return j;
		if (c === "\\") j++;
		else if (c === "[") cls = true;
		else if (c === "]") cls = false;
		else if (c === "/" && !cls) {
			let k = j + 1;
			while (isIdent(src[k])) k++;
			return k;
		}
	}
	return src.length;
}

// Strip comments and string/char literals so `"a || b"` or `// for each` don't
// count. Interpolated expressions (f"{a if b else c}", `${x ? 1 : 2}`) stay.
export function codeOnly(code: string, language: CodeLanguage): string {
	return codeSegments(code, language)
		.map((s) => (s.kind === "code" ? s.text : s.kind === "comment" ? ` ${s.text.replace(/[^\n]/g, "")}` : s.kind === "char" ? "'x'" : '""'))
		.join("");
}

// ── Constructs ───────────────────────────────────────────────────────────────

const C_LOOP_FOR = /\bfor\s*\(/;
const C_LOOP_WHILE = /\bwhile\s*\(/;
const C_IF = /\bif\s*\(/;
const C_LOGIC = /&&|\|\||!(?!=)/;
const C_INC = /\+\+|--|[+\-*/%&|^]=(?!=)|<<=|>>>?=/;
const C_SWITCH = /\bswitch\s*\(/;
// `?` … `:`, but not optional chaining `p?.b`, `a ?? b`, or a generic wildcard `<?>`.
const C_TERNARY = /(?<![?<]\s*)\?(?![.?>]|\s*(extends|super)\b)[^?:;]*:/;

const JAVA_STRING_METHODS =
	/\.(substring|indexOf|lastIndexOf|equals|equalsIgnoreCase|compareTo|compareToIgnoreCase|toUpperCase|toLowerCase|contains|split|replace|replaceAll|replaceFirst|trim|strip|stripLeading|stripTrailing|startsWith|endsWith|isEmpty|isBlank|toCharArray|repeat|concat|matches|chars|lines|codePointAt|regionMatches)\s*\(|\bString\.(valueOf|join|copyValueOf)\s*\(|\bString(Builder|Buffer)\b/;
const PY_STRING_METHODS =
	/\.(upper|lower|find|rfind|index|rindex|replace|split|rsplit|strip|lstrip|rstrip|join|startswith|endswith|count|isdigit|isalpha|isalnum|isspace|isupper|islower|isnumeric|title|capitalize|swapcase|format|zfill|center|ljust|rjust|partition|splitlines|casefold)\s*\(|\[[^\][{}\n]*:[^\]\n]*\]/;
const JS_STRING_METHODS = /\.(toUpperCase|toLowerCase|slice|substring|substr|indexOf|lastIndexOf|includes|split|replace|replaceAll|trim|trimStart|trimEnd|startsWith|endsWith|repeat|padStart|padEnd|charCodeAt|codePointAt|concat|match|matchAll|localeCompare)\s*\(/;

// Deliberately NOT constructs (taught in the learner's first topics, or too
// basic to gate): Scanner calls (sc.nextLine/nextInt), System.out.print/println,
// string concatenation, length()/charAt(), Math.* (arithmetic-ops covers the
// Math class), Python's input()/int()/len()/print(end=…)/s[i], `is not`.
export const CONSTRUCTS: Construct[] = [
	{
		id: "if-else",
		label: "if / else",
		topics: ["if-else", "if-statements", "selection", "conditionals", "if-elif-else"],
		words: /\bif[- ]?(else|elif|statements?)\b|\bif\s*\/\s*(if[- ])?else\b|\bselection( statements?| structures?)?\b(?! sort)|\bconditional statements?\b|^conditionals?$|\bbranching\b/i,
		java: C_IF,
		javascript: C_IF,
		python: /^[ \t]*(if|elif)\b[^\n]*:/m,
	},
	{
		id: "switch",
		label: "switch statement",
		topics: ["switch", "switch-statement", "match-case"],
		words: /\bswitch( statements?| expressions?| case)?\b|\bmatch[- ](statements?|case)\b/i,
		java: C_SWITCH,
		javascript: C_SWITCH,
		python: /^[ \t]*match\b[^\n]*:\s*$/m,
	},
	{
		id: "boolean-logic",
		label: "logical operators (&&, ||, !)",
		topics: ["boolean-logic", "logical-operators", "boolean-operators"],
		words: /\b(boolean|logical) (operators?|logic|expressions?)\b|&&|\|\||\bcompound (boolean )?conditions?\b|\band\s*\/\s*or\b|\blogical (and|or|not)\b/i,
		java: C_LOGIC,
		javascript: C_LOGIC,
		// `is not` / `not in` are comparisons, not logic.
		python: /\b(and|or)\b|(?<!\bis\s+)\bnot\b(?!\s+in\b)/,
	},
	{
		id: "ternary",
		label: "the ternary operator (a ? b : c)",
		topics: ["ternary", "ternary-operator", "conditional-operator", "conditional-expressions"],
		words: /\bternary\b|\bconditional (operator|expressions?)\b/i,
		java: C_TERNARY,
		javascript: C_TERNARY,
		python: /\bif\b[^:\n]*\belse\b/,
	},
	{
		id: "increment",
		label: "shortcut operators (++, --, +=)",
		topics: ["increment", "increment-decrement", "compound-assignment", "augmented-assignment", "shortcut-operators"],
		words: /\b(increment|decrement)( (and|&) decrement)? op(erator)?s?\b|^(increment|decrement)s?$|\+\+|\b(augmented|compound) assignments?\b|\bshortcut (assignment )?op(erator)?s?\b/i,
		java: C_INC,
		javascript: C_INC,
		python: /[+\-*/%&|^@]=(?!=)|\/\/=|\*\*=|<<=|>>=/,
	},
	{
		id: "for-loop",
		label: "for loop",
		topics: ["for-loop", "for-loops", "counting-loops"],
		words: /^(the |a )?for[- ]?loops?\b|\bfor[- ]loops?\b|\bfor[- ]each loops?\b|\benhanced for\b|\bfor statements?\b|\bcounting loops?\b/i,
		java: C_LOOP_FOR,
		javascript: C_LOOP_FOR,
		python: /^[ \t]*(async\s+)?for\b[^\n]*:/m,
	},
	{
		id: "while-loop",
		label: "while / do-while loop",
		topics: ["while-do", "while-loop", "while-loops", "do-while"],
		words: /\bwhile[- ]?loops?\b|\bdo[- ]?while\b|\bwhile statements?\b|\bsentinel[- ]controlled loops?\b/i,
		java: C_LOOP_WHILE,
		javascript: C_LOOP_WHILE,
		python: /^[ \t]*while\b[^\n]*:/m,
	},
	{
		id: "methods",
		label: "defining your own methods",
		topics: ["methods-defining", "methods", "functions", "defining-methods", "defining-functions", "user-defined-functions"],
		words: /\bdefin\w* (your own )?(methods?|functions?)\b|\b(writing|creating) (your own )?(methods|functions)\b|\buser[- ]defined (methods?|functions?)\b|\bmethod (signatures?|headers?|overloading)\b|^(methods?|functions?)$|\bmethods-defining\b|\bdef\b/i,
	},
	{
		id: "arrays",
		label: "arrays / lists",
		topics: ["arrays-basics", "arrays", "arrays-1d", "lists", "array-algorithms"],
		words: /^(1d |one[- ]dimensional |python )?(arrays?|lists)\b(?! references)|\b(1d|one[- ]dimensional) arrays?\b|\barrays? (basics|algorithms)\b|^lists?( and |:| basics)/i,
		java: /\[/, // main's args removed first, so any `[` is an array type or an index
		javascript: /=\s*\[|\bnew Array\b|\bArray\.|\.(push|pop|shift|unshift|map|filter|reduce|forEach)\s*\(/,
		python: /(?:^|[=(,:[{+*]|\breturn|\bin)[ \t]*\[|\.append\s*\(|\blist\s*\(/m,
	},
	{
		id: "arrays-2d",
		label: "2D arrays",
		topics: ["arrays-2d", "2d-arrays", "multidimensional-arrays", "nested-lists"],
		words: /\b(2d|two[- ]dimensional|multi[- ]?dimensional) (arrays?|lists?)\b|\(2d\) (arrays?|lists?)\b|\bnested lists?\b/i,
		java: /\]\s*\[/,
		javascript: /\[\s*\[|\]\s*\[/,
		python: /\[\s*\[|\]\s*\[/,
	},
	{
		id: "string-methods",
		label: "String methods beyond length/charAt",
		topics: ["math-functions", "string-manipulation", "string-methods"],
		words: /\bstring (methods|manipulation|functions|processing|comparison)\b|\bsubstring\b|\bindexof\b|\bcomparing strings\b|\.equals\b|\bequals\(\)|\bstringbuilder\b|\bslicing\b|\bcharacter\/string methods\b/i,
		java: JAVA_STRING_METHODS,
		python: PY_STRING_METHODS,
		javascript: JS_STRING_METHODS,
	},
	{
		id: "character-methods",
		label: "Character methods (isDigit, isLetter, …)",
		topics: ["math-functions", "character-methods"],
		words: /\bcharacter (class|methods?)\b|\bchar(acter)? methods\b|\bcharacter\/string methods\b|\bisdigit\b|\bisletter\b/i,
		java: /\bCharacter\.\w+\s*\(/,
	},
	{
		id: "formatted-output",
		label: "formatted output (printf, String.format)",
		// Liang ch. 4 (math functions, characters and strings) teaches printf.
		topics: ["math-functions", "formatted-output", "printf", "string-formatting"],
		words: /\bprintf\b|\bstring\.format\b|\bformatt(ed|ing) (console )?output\b|\bformat specifiers?\b/i,
		java: /\bprintf\s*\(|\bString\.format\s*\(|\.formatted\s*\(/,
	},
	{
		id: "parse-numbers",
		label: "converting text to numbers (Integer.parseInt, …)",
		// Also Liang ch. 4; with only Scanner taught, use nextInt()/nextDouble().
		topics: ["math-functions", "wrapper-classes", "parsing-numbers"],
		words: /\bparse(int|double)\b|\bwrapper classes?\b|\bconverting strings? to numbers\b/i,
		java: /\b(Integer|Double|Long|Float|Short|Byte|Boolean)\.(parse\w+|valueOf)\s*\(/,
	},
	{
		id: "casting",
		label: "type casting ((int) x)",
		// Casting and char arithmetic come with arithmetic (Liang 2.11, numeric
		// type conversions), so arithmetic-ops covers this.
		topics: ["arithmetic-ops", "casting", "type-conversion"],
		words: /\b(type )?cast(ing|s)?\b|\b(numeric|type) (type )?conversions?\b/i,
		java: /\(\s*(int|double|char|long|float|short|byte)\s*\)\s*[\w(.'"+-]/,
	},
	{
		id: "var",
		label: "`var` (type inference)",
		topics: ["type-inference"],
		words: /\bvar\b|\btype inference\b/i,
		java: /\bvar\s+[A-Za-z_$][\w$]*\s*[=:]/,
	},
	{
		id: "exceptions",
		label: "try / catch",
		topics: ["exception-handling", "exceptions", "try-catch", "try-except"],
		words: /\btry[- ]?(\/\s*)?(catch|except)\b|\bexceptions?\b|\bexception handling\b/i,
		java: /\btry\s*[({]|\bcatch\s*\(|\bthrows?\b/,
		javascript: /\btry\s*\{|\bthrow\b/,
		python: /^[ \t]*(try|finally)\s*:|^[ \t]*except\b|\braise\b/m,
	},
	{
		id: "collections",
		label: "ArrayList / collections (List, Map, Set)",
		topics: ["arraylist", "collections", "array-lists", "dictionaries"],
		words: /\barray ?lists?\b|\bcollections( framework)?\b|\bhash ?(maps?|sets?)\b|\bdictionar(y|ies)\b/i,
		java: /\b(ArrayList|LinkedList|HashMap|TreeMap|LinkedHashMap|HashSet|TreeSet|LinkedHashSet|List|Map|Set|Queue|Deque|ArrayDeque|PriorityQueue|Collections|Iterator)\b|\bArrays\.asList\b/,
		javascript: /\bnew (Map|Set)\b/,
		python: /\{[^}\n]*:|\b(dict|set)\s*\(|=\s*\{\s*\}/,
	},
	{
		id: "lambdas",
		label: "lambdas / streams",
		topics: ["lambdas", "lambda-expressions", "streams", "functional-programming"],
		words: /\blambdas?( expressions?)?\b|\bstreams? api\b|\bmethod references?\b|\bfunctional (interfaces?|programming)\b/i,
		python: /\blambda\b/,
	},
	{
		id: "comprehensions",
		label: "comprehensions / generator expressions",
		topics: ["comprehensions", "list-comprehensions"],
		words: /\bcomprehensions?\b|\bgenerator expressions?\b/i,
		python: /[[({](?:[^[\](){}\n]|\([^()\n]*\))*\bfor\b[^[\](){}\n]*\bin\b/,
	},
	{
		id: "classes",
		label: "writing your own classes / objects",
		topics: ["objects-classes", "classes", "classes-objects", "oop", "object-oriented"],
		words: /^(objects?|classes)( (and|&) (classes|objects))?\b|\b(objects? (and|&) classes|classes (and|&) objects)\b|\bdefining (a |your own )?class(es)?\b|\bconstructors?\b|\boop\b|\bobject[- ]oriented\b|\binstance (fields|methods|variables)\b/i,
		python: /^[ \t]*class\s+\w+/m,
	},
	{
		id: "inheritance",
		label: "inheritance (extends, super)",
		topics: ["inheritance"],
		words: /\binheritance\b|\bsub-?class(es)?\b|\bsuper-?class(es)?\b|\boverriding\b/i,
		java: /\bclass\s+\w+(\s*<[^>{]*>)?\s+extends\b|\binterface\s+\w+[^{]*\bextends\b|\bsuper\s*[.(]|@Override\b/,
		javascript: /\bclass\s+\w+\s+extends\b|\bsuper\s*[.(]/,
		python: /^[ \t]*class\s+\w+\s*\(\s*\w|\bsuper\s*\(/m,
	},
	{
		id: "interfaces",
		label: "interfaces / abstract classes",
		topics: ["abstract-interfaces", "interfaces", "abstract-classes"],
		words: /\babstract (classes?|methods?)\b|^interfaces?\b|\binterfaces? (and|&)\b|\b(and|&) interfaces?\b|\bimplementing interfaces?\b/i,
		java: /\binterface\s+\w+|\babstract\s+(class\b|[\w<>[\]]+\s+\w+\s*\()|\bimplements\b/,
	},
];

// ── Detection ────────────────────────────────────────────────────────────────

const NOT_A_NAME = new Set(["if", "for", "while", "switch", "catch", "synchronized", "return", "new", "else", "try", "do", "throw", "case", "assert", "record"]);

// Java method declarations: [modifiers] [<T>] Type name(params) [throws …] {
function javaMethods(code: string): { name: string; isStatic: boolean }[] {
	const re = /(?:^|[;{}])\s*(?:@[\w$.]+(?:\([^()]*\))?\s+)*((?:(?:public|private|protected|static|final|abstract|synchronized|native|default|strictfp)\s+)*)(?:<[^;{}()]*>\s*)?([\w$.]+(?:\s*<[^;{}()]*>)?(?:\s*\[\s*\])*)\s+([\w$]+)\s*\([^;{}]*\)\s*(?:throws\s+[\w$.,\s]+)?\{/g;
	const out: { name: string; isStatic: boolean }[] = [];
	for (const m of code.matchAll(re)) {
		const type = m[2].replace(/\s*<[\s\S]*/, "");
		if (NOT_A_NAME.has(type) || NOT_A_NAME.has(m[3])) continue;
		out.push({ name: m[3], isStatic: /\bstatic\b/.test(m[1]) });
	}
	return out;
}

function javaUsesClasses(code: string): boolean {
	const declared = [...code.matchAll(/\b(class|interface|enum|record)\s+([\w$]+)/g)];
	if (declared.length > 1 || declared.some((d) => d[1] === "enum" || d[1] === "record")) return true;
	// One class used as a class: `this`, an anonymous class, instance methods, a constructor, `new Main(…)`.
	if (/\bthis\s*[.(]/.test(code) || /\bnew\s+[\w$.]+\s*(<[^>]*>)?\s*\([^;{}()]*\)\s*\{/.test(code)) return true;
	if (javaMethods(code).some((m) => !m.isStatic)) return true;
	return declared.some(([, , name]) => new RegExp(`(?<![\\w$.]|\\bnew\\s+)${name}\\s*\\([^;{}]*\\)\\s*\\{|\\bnew\\s+${name}\\s*\\(`).test(code));
}

function javaUsesLambdas(code: string): boolean {
	// Switch arrows (`case 1 ->`, `default ->`) aren't lambdas.
	const src = code.replace(/\b(case\b[^;{}]*?|default\s*)->/g, ":");
	return /->|::|\b(Int|Long|Double)?Stream\b|\.stream\s*\(|\.forEach\s*\(/.test(src);
}

/** Constructs the code uses (comments and string literals ignored). */
export function constructsUsed(code: string, language: CodeLanguage): Construct[] {
	let src = codeOnly(code, language);
	// main's `String[] args` is boilerplate, not an array the learner works with.
	if (language === "java") src = src.replace(/\bmain\s*\(\s*(?:final\s+)?String\s*(?:\[\s*\]|\.\.\.)\s*\w+\s*\)|\bmain\s*\(\s*(?:final\s+)?String\s+\w+\s*\[\s*\]\s*\)/g, "main()");
	return CONSTRUCTS.filter((c) => {
		if (c.id === "methods") {
			if (language === "java") return javaMethods(src).some((m) => m.name !== "main");
			if (language === "python") return /^[ \t]*(async\s+)?def\s+\w+/m.test(src);
			return /\bfunction\b|=>/.test(src);
		}
		if (c.id === "classes" && language === "java") return javaUsesClasses(src);
		if (c.id === "classes" && language === "javascript") return /\bclass\s+\w+/.test(src);
		if (c.id === "lambdas" && language === "java") return javaUsesLambdas(src);
		const re = c[language];
		return re ? re.test(src) : false;
	});
}

// ── Coverage ─────────────────────────────────────────────────────────────────

export interface KnownConcept {
	name: string;
	topic?: string; // course-map topic id
}
export interface MapTopic {
	id: string;
	title: string;
}

/** Whether some recorded concept (by its course topic, or its name) covers the construct. */
export function isCovered(c: Construct, known: KnownConcept[], topics: MapTopic[] = []): boolean {
	const byId = new Map(topics.map((t) => [t.id, t]));
	return known.some((k) => {
		if (k.topic && c.topics?.includes(k.topic)) return true;
		if (c.words.test(k.name)) return true;
		const t = k.topic ? byId.get(k.topic) : undefined;
		return Boolean(k.topic && (c.words.test(k.topic) || (t && c.words.test(t.title))));
	});
}

/** The course-map topic that teaches a construct (first in course order), if any. */
export function topicFor(c: Construct, topics: MapTopic[]): MapTopic | undefined {
	return topics.find((t) => c.topics?.includes(t.id)) ?? topics.find((t) => c.words.test(t.id) || c.words.test(t.title));
}

/** Untaught constructs the code relies on. */
export function untaughtConstructs(code: string, language: CodeLanguage, known: KnownConcept[], topics: MapTopic[] = []): Construct[] {
	return constructsUsed(code, language).filter((c) => !isCovered(c, known, topics));
}

// ── Markdown ─────────────────────────────────────────────────────────────────

const TAGS: Record<string, CodeLanguage> = { java: "java", jshell: "java", python: "python", python3: "python", py: "python", js: "javascript", javascript: "javascript", mjs: "javascript", jsx: "javascript", node: "javascript", ts: "javascript", typescript: "javascript" };

// Inline spans / untagged blocks are scanned only if they look like code:
// `Hello!` or `Enter a number? 5` are program output, not Java.
export function looksLikeCode(s: string): boolean {
	return /[;(){}=]|\w\s*(<|>|[<>=!]=)\s*\w|\w(\+\+|--)|(\+\+|--)\w|&&|\|\||\b(int|double|boolean|char|var|let|const|def|elif|lambda|void|static|public|null|None|True|False|true|false|String|System|println|printf)\b/.test(s);
}

export interface Fence {
	tag: string; // lowercase first word of the info string ("" when untagged)
	code: string;
}

/** ``` / ~~~ fences (any length, info strings like ```java title="…", CRLF), and the text outside them. */
export function markdownFences(text: string): { blocks: Fence[]; rest: string } {
	const lines = text.replace(/\r\n?/g, "\n").split("\n");
	const blocks: Fence[] = [];
	const rest: string[] = [];
	let open: { marker: string; tag: string; body: string[] } | undefined;
	for (const line of lines) {
		if (!open) {
			const m = /^ {0,3}(`{3,}|~{3,})\s*([^`\s]*)[^`]*$/.exec(line);
			if (m) open = { marker: m[1], tag: m[2].replace(/^\{?\.?|\}$/g, "").toLowerCase(), body: [] };
			else rest.push(line);
			continue;
		}
		const close = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(line);
		if (close && close[1][0] === open.marker[0] && close[1].length >= open.marker.length) {
			blocks.push({ tag: open.tag, code: open.body.length ? `${open.body.join("\n")}\n` : "" });
			open = undefined;
		} else open.body.push(line);
	}
	if (open) blocks.push({ tag: open.tag, code: open.body.join("\n") });
	return { blocks, rest: rest.join("\n") };
}

/** Fenced code blocks in markdown text, with their language. Output fences (```text, ```console…) are skipped. */
export function fencedCode(text: string, fallback?: CodeLanguage): { code: string; language: CodeLanguage }[] {
	const out: { code: string; language: CodeLanguage }[] = [];
	for (const f of markdownFences(text).blocks) {
		// Untagged: the subject's language, if it looks like code. Other tags (text, console, output, shell…) aren't code.
		const language = f.tag ? TAGS[f.tag] : fallback && looksLikeCode(f.code) ? fallback : undefined;
		if (!language) continue;
		// jshell transcripts: drop the prompts.
		const code = f.tag === "jshell" ? f.code.replace(/^(jshell>|\s*\.\.\.>)\s?/gm, "") : f.code;
		out.push({ code, language });
	}
	return out;
}

/** Code worth scanning in markdown/quiz text: code fences, plus each inline `code` span that looks like code (inline spans need a fallback language). */
export function scanText(text: string, fallback?: CodeLanguage): { code: string; language: CodeLanguage }[] {
	const out = fencedCode(text, fallback);
	if (!fallback) return out;
	// Each span on its own, so a `?` in one and a `:` in the next can't pair up.
	for (const m of markdownFences(text).rest.matchAll(/(`+)([^`\n]+?)\1(?!`)/g)) {
		const span = m[2].trim();
		if (span && looksLikeCode(span)) out.push({ code: span, language: fallback });
	}
	return out;
}

/** Guess the code language of a subject from its name. */
export function subjectLanguage(subject: string): CodeLanguage | undefined {
	const s = subject.toLowerCase();
	if (/\bjava\b(?!script)/.test(s)) return "java";
	if (/python/.test(s)) return "python";
	if (/javascript|\bjs\b/.test(s)) return "javascript";
	return undefined;
}
