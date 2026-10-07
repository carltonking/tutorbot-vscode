// ────────────────────────────────────────────────────────────────────────────
// plainmath — typeset math written as plain text ("-sqrt(9-x^2)/x - asin(x/3)",
// "-cscxcotx+c", "e^tan(x)") by turning it into LaTeX for KaTeX.
//
// toTex(s)        whole string as one expression → LaTeX, or null when it isn't
//                 unambiguously math (code, words, sentences stay as they are).
// texifyProse(s)  plain-math runs inside prose → "$…$"; everything else untouched.
//
// Loaded by the chat webview (window.PlainMath) and by the tests (require).
// ────────────────────────────────────────────────────────────────────────────
(function (root) {
  "use strict";

  // Function names, longest first so "arcsin" wins over "sin" and "sech" over "sec".
  const FNS = [
    "arcsin", "arccos", "arctan", "arcsec", "arccsc", "arccot",
    "asinh", "acosh", "atanh", "asin", "acos", "atan",
    "sinh", "cosh", "tanh", "sech", "csch", "coth",
    "sqrt", "cbrt", "sin", "cos", "tan", "sec", "csc", "cot",
    "exp", "abs", "log", "ln", "lg",
  ].sort((a, b) => b.length - a.length);
  const FN_TEX = {
    asin: "\\arcsin", acos: "\\arccos", atan: "\\arctan",
    arcsin: "\\arcsin", arccos: "\\arccos", arctan: "\\arctan",
    arcsec: "\\operatorname{arcsec}", arccsc: "\\operatorname{arccsc}", arccot: "\\operatorname{arccot}",
    asinh: "\\operatorname{arsinh}", acosh: "\\operatorname{arcosh}", atanh: "\\operatorname{artanh}",
    sech: "\\operatorname{sech}", csch: "\\operatorname{csch}",
    lg: "\\lg", exp: "\\exp", log: "\\log", ln: "\\ln",
  };
  const fnTex = (f) => FN_TEX[f] || `\\${f}`;
  const CONSTS = { pi: "\\pi", theta: "\\theta", alpha: "\\alpha", beta: "\\beta", infinity: "\\infty", inf: "\\infty", infty: "\\infty" };
  const CONST_NAMES = Object.keys(CONSTS).sort((a, b) => b.length - a.length);

  // ── tokenizer ─────────────────────────────────────────────────────────────
  const UNI = { "∫": " int ", "−": "-", "–": "-", "×": "*", "·": "*", "⋅": "*", "÷": "/", "²": "^2", "³": "^3", "√": "sqrt", "π": "pi", "θ": "theta", "∞": "inf", "≤": "<=", "≥": ">=", "≠": "!=" };

  function tokenize(src) {
    const s = src.replace(/[∫−–×·⋅÷²³√πθ∞≤≥≠]/g, (c) => UNI[c]).replace(/\*\*/g, "^");
    const out = [];
    let i = 0;
    while (i < s.length) {
      const c = s[i];
      if (/\s/.test(c)) { i++; continue; }
      const deriv = /^d([a-z]?)\/d([a-z])(?![A-Za-z])/.exec(s.slice(i)); // d/dx, dy/dx
      if (deriv) { out.push({ t: "var", v: `\\frac{d${deriv[1]}}{d${deriv[2]}}` }); i += deriv[0].length; continue; }
      const num = /^(?:\d+\.?\d*|\.\d+)/.exec(s.slice(i));
      if (num) { out.push({ t: "num", v: num[0] }); i += num[0].length; continue; }
      const two = s.slice(i, i + 2);
      if (two === "<=" || two === ">=" || two === "!=") { out.push({ t: "op", v: two }); i += 2; continue; }
      if ("+-*/^=<>".includes(c)) { out.push({ t: "op", v: c }); i++; continue; }
      if ("()".includes(c) || c === ",") { out.push({ t: c }); i++; continue; }
      if (c === "|") { out.push({ t: "|" }); i++; continue; }
      if (/[A-Za-z]/.test(c)) {
        const word = /^[A-Za-z]+/.exec(s.slice(i))[0];
        const parts = splitWord(word);
        if (!parts) return null;
        out.push(...parts);
        i += word.length;
        continue;
      }
      return null; // ; { } [ ] . " ' etc.: not plain math
    }
    return out;
  }

  // "cscxcotx" → csc x cot x; "nlogn" → n log n; "pi" → π. Longer runs of
  // letters that aren't functions/constants are words, not math ("true", "converges").
  function splitWord(w) {
    const out = [];
    let i = 0;
    let loose = 0; // single-letter variables in a row
    while (i < w.length) {
      const rest = w.slice(i).toLowerCase();
      if (i === 0 && w === "int") { out.push({ t: "int" }); i = 3; continue; }
      const fn = FNS.find((f) => rest.startsWith(f));
      if (fn) { out.push({ t: "fn", v: fn }); i += fn.length; loose = 0; continue; }
      const k = CONST_NAMES.find((f) => rest.startsWith(f));
      if (k) { out.push({ t: "var", v: CONSTS[k] }); i += k.length; loose = 0; continue; }
      if (++loose > 3) return null;
      out.push({ t: "var", v: w[i] });
      i++;
    }
    // A bare run of 3+ letters with no function in it ("abc", "the") is a word.
    if (out.length >= 3 && out.every((t) => t.t === "var" && t.v.length === 1)) return null;
    return out;
  }

  // ── parser ────────────────────────────────────────────────────────────────
  // rel   := sum (relop sum)*
  // sum   := term (("+"|"-") term)*
  // term  := unary (("*"|"/") unary | implicit unary)*
  // unary := "-" unary | "+" unary | power
  // power := atom ("^" unary)?
  // atom  := num | var | "(" rel ")" | "|" rel "|" | fn ["^" atom] (atom-ish arg)
  function parse(tokens) {
    let p = 0;
    const peek = () => tokens[p];
    const isOp = (v) => peek() && peek().t === "op" && peek().v === v;
    const fail = () => { throw new Error("parse"); };

    function rel() {
      let left = sum();
      while (peek() && peek().t === "op" && ["=", "<", ">", "<=", ">=", "!="].includes(peek().v)) {
        const op = tokens[p++].v;
        left = { k: "bin", op, a: left, b: sum() };
      }
      return left;
    }
    function sum() {
      let left = term();
      while (isOp("+") || isOp("-")) {
        const op = tokens[p++].v;
        left = { k: "bin", op, a: left, b: term() };
      }
      return left;
    }
    const startsAtom = () => {
      const t = peek();
      return t && (t.t === "num" || t.t === "var" || t.t === "fn" || t.t === "(");
    };
    function term() {
      if (peek() && peek().t === "int") { p++; return { k: "int", a: term() }; }
      if (isOp("-")) { p++; return { k: "neg", a: term() }; }
      if (isOp("+")) { p++; return term(); }
      let left = unary();
      for (;;) {
        if (isOp("*") || isOp("/")) {
          const op = tokens[p++].v;
          left = { k: "bin", op, a: left, b: unary() };
        } else if (startsAtom()) {
          left = { k: "bin", op: "imp", a: left, b: power() };
        } else return left;
      }
    }
    function unary() {
      if (isOp("-")) { p++; return { k: "neg", a: unary() }; }
      if (isOp("+")) { p++; return unary(); }
      return power();
    }
    function power() {
      const base = atom();
      if (isOp("^")) { p++; return { k: "pow", a: base, b: unary() }; }
      return base;
    }
    function atom() {
      const t = peek();
      if (!t) fail();
      if (t.t === "num" || t.t === "var") { p++; return { k: t.t, v: t.v }; }
      if (t.t === "(") {
        p++;
        const e = rel();
        if (!peek() || peek().t !== ")") fail();
        p++;
        return { k: "paren", a: e };
      }
      if (t.t === "|") {
        p++;
        const e = rel();
        if (!peek() || peek().t !== "|") fail();
        p++;
        return { k: "abs", a: e };
      }
      if (t.t === "fn") {
        p++;
        // sin^2(x), sin^-1(x)
        let exp = null;
        if (isOp("^")) { p++; exp = isOp("-") ? (p++, { k: "neg", a: atom() }) : atom(); }
        // log_b? not supported. Argument: (…) or the next power ("sin x", "csc x cot x").
        let arg;
        if (peek() && peek().t === "|") arg = atom(); // ln|x|
        else if (peek() && peek().t === "(") {
          p++;
          const args = [rel()];
          while (peek() && peek().t === ",") { p++; args.push(rel()); }
          if (!peek() || peek().t !== ")") fail();
          p++;
          arg = args.length === 1 ? { k: "paren", a: args[0] } : { k: "args", list: args };
        } else if (startsAtom()) arg = power();
        else fail();
        return { k: "fn", f: t.v, exp, a: arg };
      }
      fail();
    }

    const tree = rel();
    if (p !== tokens.length) fail();
    return tree;
  }

  // ── LaTeX ─────────────────────────────────────────────────────────────────
  const strip = (n) => (n.k === "paren" ? n.a : n);
  const REL_TEX = { "=": "=", "<": "<", ">": ">", "<=": "\\le", ">=": "\\ge", "!=": "\\ne" };

  function tex(n) {
    switch (n.k) {
      case "num": return n.v;
      case "var": return n.v;
      case "paren": return `\\left(${tex(n.a)}\\right)`;
      case "abs": return `\\left|${tex(n.a)}\\right|`;
      case "int": return `\\int ${tex(n.a)}`;
      case "args": return n.list.map(tex).join(", ");
      case "neg": {
        const inner = n.a.k === "bin" && (n.a.op === "+" || n.a.op === "-") ? `\\left(${tex(n.a)}\\right)` : tex(n.a);
        return `-${inner}`;
      }
      case "pow": {
        let base = tex(n.a);
        if (n.a.k === "neg" || n.a.k === "bin" || n.a.k === "pow") base = `\\left(${base}\\right)`;
        else if (n.a.k === "fn") base = `\\left(${base}\\right)`;
        return `${base}^{${tex(strip(n.b))}}`;
      }
      case "fn": {
        const a = strip(n.a);
        if (n.f === "sqrt") return `\\sqrt{${tex(a)}}${n.exp ? `^{${tex(strip(n.exp))}}` : ""}`;
        if (n.f === "cbrt") return `\\sqrt[3]{${tex(a)}}`;
        if (n.f === "abs") return `\\left|${tex(a)}\\right|`;
        const head = fnTex(n.f) + (n.exp ? `^{${tex(strip(n.exp))}}` : "");
        // Keep parentheses around anything bigger than a single symbol: sin(2x), ln(x+1).
        const simple = n.a.k === "var" || n.a.k === "num" || n.a.k === "abs" || (n.a.k === "paren" && (a.k === "var" || a.k === "num"));
        if (n.f === "exp" && !n.exp) return `e^{${tex(a)}}`;
        return simple ? `${head} ${tex(a)}` : `${head}\\left(${tex(a)}\\right)`;
      }
      case "bin": {
        if (n.op === "/") return `\\frac{${tex(strip(n.a))}}{${tex(strip(n.b))}}`;
        if (REL_TEX[n.op]) return `${tex(n.a)} ${REL_TEX[n.op]} ${tex(n.b)}`;
        if (n.op === "+") return `${tex(n.a)} + ${tex(n.b)}`;
        if (n.op === "-") {
          const b = n.b.k === "bin" && (n.b.op === "+" || n.b.op === "-") ? `\\left(${tex(n.b)}\\right)` : tex(n.b);
          return `${tex(n.a)} - ${b}`;
        }
        const wrap = (x) => {
          if (x.k === "bin" && (x.op === "+" || x.op === "-")) return `\\left(${tex(x)}\\right)`;
          if (x.k === "paren" && x.a.k === "bin" && x.a.op === "/") return tex(x.a); // (1/3)cos(3x)
          return tex(x);
        };
        if (n.op === "*") {
          // Number times number needs a visible dot; otherwise juxtapose.
          const dot = startsWithDigit(n.b);
          return `${wrap(n.a)}${dot ? " \\cdot " : " "}${wrap(n.b)}`;
        }
        // implicit
        return `${wrap(n.a)}${startsWithDigit(n.b) ? " \\cdot " : " "}${wrap(n.b)}`;
      }
    }
    throw new Error("tex");
  }
  function startsWithDigit(n) {
    if (n.k === "num") return true;
    if (n.k === "pow" || n.k === "bin") return startsWithDigit(n.a);
    return false;
  }

  // Something worth typesetting: an operator, a function, a constant, or a digit
  // next to a letter. A lone word or number stays plain.
  function hasMathSignal(tokens) {
    return tokens.some((t) => t.t === "op" || t.t === "fn" || t.t === "|" || (t.t === "var" && t.v.startsWith("\\"))) ||
      (tokens.some((t) => t.t === "num") && tokens.some((t) => t.t === "var"));
  }

  /** Plain-text math → LaTeX, or null when `s` isn't plain math. */
  function toTex(s, opts) {
    const src = String(s ?? "").trim();
    if (!src || src.length > 400) return null;
    if (/[$\\]/.test(src)) return null; // already LaTeX, or not ours to touch
    const tokens = tokenize(src);
    if (!tokens || !tokens.length) return null;
    // A single variable or number counts when the caller knows it's an answer.
    if (!(opts && opts.answer) && !hasMathSignal(tokens)) return null;
    if (opts && opts.answer && !hasMathSignal(tokens) && !(tokens.length === 1 && (tokens[0].t === "var" || tokens[0].t === "num"))) return null;
    try {
      return tex(parse(tokens));
    } catch {
      return null;
    }
  }

  // ── prose ─────────────────────────────────────────────────────────────────
  // A word is strong math when it plainly can't be English: a known function
  // call, an exponent, or a symbol like √/π/². Runs of words joined by spaced
  // operators ("sec^2(x) * tan(x)", "2 * sin(x)") are typeset as one expression.
  const STRONG = new RegExp(`\\^|[√π²³∞∫θ≤≥≠]|(?:^|[^A-Za-z])(?:${FNS.join("|")})\\s*[(|]|[A-Za-z0-9)]/[A-Za-z0-9(]|[A-Za-z0-9)]\\*[A-Za-z0-9(]`);
  // Slashes in prose that aren't fractions: w/o, n/a, and/or, dates.
  const NOT_MATH = /^(?:w\/o|w\/|n\/a|y\/n|i\/o|s\/he|he\/she|and\/or|\d+\/\d+\/\d+|0\d*\/\d+|\d+\/0\d+)$/i;
  const OPERATOR = /^(?:[-+*/=<>×÷·−]|<=|>=|!=|≤|≥|≠)$/;

  // Peel markdown/sentence punctuation off a word: "(sin(x))." → "(", "sin(x)", ")."
  function splitPunct(w) {
    let lead = /^[*_"'“‘\[]*/.exec(w)[0];
    let core = w.slice(lead.length);
    let trail = /[*_"'”’.,;:!?\]]*$/.exec(core)[0];
    core = core.slice(0, core.length - trail.length);
    const count = (c) => core.split(c).length - 1;
    while (core.startsWith("(") && count("(") > count(")")) { lead += "("; core = core.slice(1); }
    while (core.endsWith(")") && count(")") > count("(")) { trail = ")" + trail; core = core.slice(0, -1); }
    const more = /[.,;:!?]*$/.exec(core)[0]; // "x^2)." after peeling ")"
    if (more) { trail = more + trail; core = core.slice(0, -more.length); }
    return { lead, core, trail };
  }

  function texifyLine(line) {
    const parts = line.replace(/∫\s+/g, "∫").split(/(\s+)/); // words at even indices
    const words = [];
    for (let i = 0; i < parts.length; i += 2) words.push({ i, w: parts[i] });
    const out = parts.slice();
    let k = 0;
    const word = (x) => /^[A-Za-z]{2,}$/.test(x) && !CONSTS[x] && !/^d[a-z]$/.test(x);
    const differential = (x) => /^d(?:[xyztuvrsw]|θ|theta)$/.test(x); // not "do", "dB"
    const operand = (x) => x !== undefined && (differential(x) || !NOT_MATH.test(x) && !word(x) && !/^(?:a|A|I)$/.test(x) && toTex(x, { answer: true }) !== null);
    while (k < words.length) {
      const here = splitPunct(words[k].w);
      // Seed: a word that is plainly math, or "operand op operand" with a letter in it ("x + 1").
      const strong = here.core && !NOT_MATH.test(here.core) && STRONG.test(here.core) && toTex(here.core) !== null;
      const next = k + 1 < words.length ? splitPunct(words[k + 1].w) : null;
      const pair = !strong && k >= 1 && next && OPERATOR.test(words[k].w) && !next.lead &&
        operand(words[k - 1].w) && operand(next.core) && /[A-Za-z]/.test(words[k - 1].w + next.core);
      if (!strong && !pair) { k++; continue; }
      const seed = pair ? k - 1 : k;
      const w0 = pair ? splitPunct(words[seed].w) : here;
      // Grow left over "operand op" pairs and right over "op operand" pairs.
      let a = seed;
      let b = seed;
      if (!w0.lead) while (a >= 2 && OPERATOR.test(words[a - 1].w) && operand(words[a - 2].w)) a -= 2;
      let lastTrail = w0.trail;
      for (;;) {
        if (lastTrail) break;
        // A differential right after math belongs to it: "∫ cot^2(theta) dθ", "3cos(theta) dθ".
        if (b + 1 < words.length) {
          const nx = splitPunct(words[b + 1].w);
          if (!nx.lead && differential(nx.core)) { b += 1; lastTrail = nx.trail; continue; }
        }
        if (b + 2 >= words.length || !OPERATOR.test(words[b + 1].w)) break;
        const nx = splitPunct(words[b + 2].w);
        if (nx.lead || !operand(nx.core)) break;
        b += 2;
        lastTrail = nx.trail;
      }
      const first = a === seed ? w0 : splitPunct(words[a].w);
      const last = b === seed ? w0 : splitPunct(words[b].w);
      const pieces = [];
      for (let j = a; j <= b; j++) pieces.push(j === a ? first.core : j === b ? last.core : words[j].w);
      const t = toTex(pieces.join(" "));
      if (t === null) { k++; continue; }
      out[words[a].i] = `${first.lead}$${t}$${last.trail}`;
      for (let j = a + 1; j <= b; j++) {
        out[words[j].i] = "";
        out[words[j].i - 1] = "";
      }
      k = b + 1;
    }
    return out.join("");
  }

  /** Wrap plain-math runs in prose with $…$. Call only on text outside code/math spans. */
  function texifyProse(text) {
    if (!text || !/[\^√π²³∞∫θ≤≥≠*\/=+\-<>(|]/.test(text)) return text;
    return text.split("\n").map((line) => {
      // Markdown structure at the start of a line (lists, headings, quotes) is not math.
      const lead = /^\s*(?:[-*+]\s+|\d+[.)]\s+|#{1,6}\s+|>\s*)*/.exec(line)[0];
      return lead + texifyLine(line.slice(lead.length));
    }).join("\n");
  }

  // texifyProse on every stretch of `src` outside the spans `segment` matches
  // (code and existing math). A stretch with a stray "$" (a price) is left
  // alone: an inserted "$" would pair with it.
  function texifyOutside(src, segment) {
    const gap = (t) => (t.includes("$") ? t : texifyProse(t));
    const re = new RegExp(segment.source, segment.flags.includes("g") ? segment.flags : `${segment.flags}g`);
    let out = "";
    let last = 0;
    for (const m of src.matchAll(re)) {
      out += gap(src.slice(last, m.index)) + m[0];
      last = m.index + m[0].length;
    }
    return out + gap(src.slice(last));
  }

  // How to show an answer / answer key:
  //   { kind: "tex", tex }  one expression to typeset
  //   { kind: "rich" }      has $…$ / \(…\) already: render as rich text
  //   { kind: "plain" }     not math (code, words)
  function answerTex(s) {
    const raw = String(s ?? "").trim();
    if (!raw) return { kind: "plain" };
    if (/\$|\\[([]/.test(raw)) return { kind: "rich" };
    if (/\\[A-Za-z]/.test(raw) && !/\n/.test(raw)) return { kind: "tex", tex: raw }; // bare LaTeX: "\\frac{1}{x}"
    const tex = toTex(raw, { answer: true });
    return tex === null ? { kind: "plain" } : { kind: "tex", tex };
  }

  const api = { toTex, texifyProse, texifyOutside, answerTex };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.PlainMath = api;
})(typeof self !== "undefined" ? self : this);
