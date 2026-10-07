// TutorBot chat view — a Claude Code–style transcript + composer.
// Receives pi RPC events (relayed by the extension host) and bridge "asks"
// (quiz / typed / question cards), and sends prompts, answers and dialog
// responses back.
(function () {
  "use strict";
  const vscode = acquireVsCodeApi();
  const $ = (sel, root = document) => root.querySelector(sel);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
  const MOD = IS_MAC ? "⌘" : "Ctrl";

  // ── icons (inline SVG, codicon-like) ────────────────────────────────────
  const ICON = {
    home: '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M8 1.6 1.3 7.2l.7.8.9-.8V14h4v-4h2.2v4h4V7.2l.9.8.7-.8L8 1.6zm3.7 11.4H10V9H6v4H3.9V6.4L8 2.9l3.7 3.3V13z"/></svg>',
    plus: '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M14 7.5H8.5V2h-1v5.5H2v1h5.5V14h1V8.5H14v-1z"/></svg>',
    send: '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M8 2.3 3 7.3l.8.8L7.4 4.5V14h1.2V4.5l3.6 3.6.8-.8-5-5z"/></svg>',
    stop: '<svg viewBox="0 0 16 16" fill="currentColor"><rect x="4" y="4" width="8" height="8" rx="1.2"/></svg>',
    chart: '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M2 2h1v11h11v1H2V2zm3 7h1.5v3H5V9zm3-3h1.5v6H8V6zm3-2h1.5v8H11V4z"/></svg>',
    book: '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M3 2h7.5A2.5 2.5 0 0 1 13 4.5V14H4.5A1.5 1.5 0 0 1 3 12.5V2zm1 1v8.3c.15-.05.32-.08.5-.08H12V4.5A1.5 1.5 0 0 0 10.5 3H4zm.5 9.2a.5.5 0 0 0 0 .8H12v-.8H4.5z"/></svg>',
    cap: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4.5 2 9.5l10 5 10-5-10-5z"/><path d="M6 11.5v4.5c0 1.4 2.7 3 6 3s6-1.6 6-3v-4.5"/><path d="M22 9.5v5.5"/></svg>',
    list: '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M2 3h12v1H2V3zm0 4.5h12v1H2v-1zM2 12h12v1H2v-1z"/></svg>',
    pencil: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linejoin="round"><path d="M10.8 2.7l2.5 2.5-7.6 7.6-3.1.6.6-3.1 7.6-7.6z"/></svg>',
    close: '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M8 7.3 12.6 2.7l.7.7L8.7 8l4.6 4.6-.7.7L8 8.7l-4.6 4.6-.7-.7L7.3 8 2.7 3.4l.7-.7L8 7.3z"/></svg>',
    trash: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linejoin="round"><path d="M2.5 4h11M6 4V2.5h4V4M4 4l.7 9.5h6.6L12 4M6.6 6.5v5M9.4 6.5v5"/></svg>',
    folder: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linejoin="round"><path d="M1.8 4.2c0-.6.5-1 1-1h3.3l1.5 1.6h5.6c.6 0 1 .4 1 1v6.4c0 .6-.4 1-1 1H2.8c-.5 0-1-.4-1-1V4.2z"/></svg>',
  };
  const CONF = ["", "Guess", "Fairly sure", "Certain"];
  const RATINGS = [
    ["clicked", "Clicked"],
    ["fuzzy", "Still fuzzy"],
    ["too-fast", "Too fast"],
    ["too-slow", "Too slow"],
  ];
  const SPIN = '<span class="spinner" aria-hidden="true"></span>';
  const VERBS = ["Thinking", "Pondering", "Working it out", "Preparing", "Connecting ideas", "Tutoring"];
  const MAX_ITEMS = 600;
  const SHORT_MODEL_ERROR = "Couldn't get a reply. The AI provider may be busy; send your message again in a moment.";
  // Handled by the chat itself, never sent to pi.
  const LOCAL_COMMANDS = [{ name: "cleanmode", description: "Turn clean mode on or off (hide thinking and tool steps)", source: "local" }];

  // ── state ──────────────────────────────────────────────────────────────
  const S = {
    items: [],
    byId: new Map(), // id (and tool call id aliases) → item
    nodes: new Map(),
    live: new Set(), // ids of items waiting for the learner
    seq: 0,
    curMsg: null,
    running: false,
    runStart: 0,
    runTokens: 0,
    msgTokens: 0,
    verb: "Thinking",
    activity: "",
    commands: [],
    subject: null,
    model: "freellmapi/auto",
    statuses: {},
    widgets: {},
    exercise: null,
    folders: [],
    connection: "starting",
    queue: [],
    history: [],
    histPos: -1,
    histDraft: "",
    slash: { open: false, list: [], idx: 0 },
    // Conversations view. editing: { kind: "subject" | "session", key, original }
    convos: { open: false, data: null, loadError: "", error: "", editing: null },
    stuck: true, // follow new output unless the learner scrolled up
    hideWorking: true, // hide thinking and tool rows; only answers and cards show
  };
  const nextId = (p) => `${p}${++S.seq}`;

  // ── markdown + math + code ─────────────────────────────────────────────
  const md = window.markdownit({ html: false, linkify: true, breaks: false });
  md.renderer.rules.fence = (tokens, idx) => {
    const t = tokens[idx];
    const lang = (t.info || "").trim().split(/\s+/)[0];
    let body;
    try {
      body = lang && window.hljs && hljs.getLanguage(lang) ? hljs.highlight(t.content, { language: lang, ignoreIllegals: true }).value : esc(t.content);
    } catch {
      body = esc(t.content);
    }
    return `<div class="codeblock"><div class="cb-head"><span>${esc(lang || "text")}</span><button class="link-btn" data-copy>Copy</button></div><pre><code>${body}</code></pre></div>`;
  };
  // Remote images are blocked by the CSP: show them as links instead.
  md.renderer.rules.image = (tokens, idx) => {
    const t = tokens[idx];
    const src = t.attrGet("src") || "";
    return `<a href="${esc(src)}">Image: ${esc(t.content || src)}</a>`;
  };
  const SEGMENT = /(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]+`)|\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]|\\\(([\s\S]+?)\\\)|\$([^$\n]+?)\$/g;
  // Private-use sentinels: can't collide with real text (a literal "@@X0@@" used to).
  const MATH_OPEN = "";
  const MATH_CLOSE = "";
  function looksLikeMath(s) {
    if (/\\[A-Za-z]+/.test(s)) return true;
    if (/[_^=+*/<>()\[\]{}|±≤≥≠≈∈→⇒∞∫∑√]/.test(s)) return true;
    return !/\s/.test(s);
  }
  // Tool arguments are JSON, so a model writing "\tan" or "\frac" with a single
  // backslash delivers TAB + "an" / form feed + "rac". Inside math (never inside
  // code) turn those control characters back into the LaTeX commands.
  const MATH_REPAIR = /(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`)|\$\$[\s\S]+?\$\$|\$[^$]+?\$|\\\[[\s\S]+?\\\]|\\\([\s\S]+?\\\)/g;
  const CTRL = { "\t": "\\t", "\f": "\\f", "\b": "\\b", "\v": "\\v", "\r": "\\r" };
  function repairMath(text) {
    if (!/[\t\f\b\v\r\n]|\\\\[A-Za-z]/.test(text) || !/[$\\]/.test(text)) return text;
    return text.replace(MATH_REPAIR, (span, code) =>
      code
        ? span
        : span
            .replace(/[\t\f\b\v\r]/g, (c) => CTRL[c])
            .replace(/\n(?=(?:eq|abla|ot|u|i|eg|eqslant|leq|geq|mid|parallel|subseteq)(?![A-Za-z]))/g, "\\n")
            // Over-escaped: "\\tan" reaches KaTeX as a line break + "tan".
            .replace(/\\\\(?=[A-Za-z]{2,})/g, "\\"),
    );
  }

  function renderRich(text, inline) {
    const math = [];
    const src = texifyOutside(repairMath(String(text ?? ""))
      .replace(/[]/g, ""))
      .replace(SEGMENT, (m, code, dd, db, ip, id) => {
        if (code) return m;
        const display = dd !== undefined || db !== undefined;
        const body = dd ?? db ?? ip ?? id;
        if (id !== undefined && !looksLikeMath(body)) return m;
        try {
          math.push(katex.renderToString(body.trim(), { displayMode: display, throwOnError: false, output: "html" }));
          return `${MATH_OPEN}${math.length - 1}${MATH_CLOSE}`;
        } catch {
          return m;
        }
      });
    const html = inline ? md.renderInline(src) : md.render(src);
    return html.replace(/(\d+)/g, (_, i) => math[Number(i)] ?? "");
  }

  // Plain-text math ("-sqrt(9-x^2)/x") outside code and $…$ spans becomes $…$,
  // so math is typeset even when the model forgot the delimiters.
  const texifyOutside = (src) => PlainMath.texifyOutside(src, SEGMENT);

  // An answer or answer key: one expression, typeset. Graded answers are plain
  // text ("-cscxcotx+c", "-sqrt(9-x^2)/x - asin(x/3)"); LaTeX keys pass through.
  // Anything that isn't math (code, words) falls back to `fallback`.
  function answerHtml(s, fallback = "code") {
    const raw = String(s ?? "").trim();
    const a = PlainMath.answerTex(raw);
    if (a.kind === "tex") return `<span class="answer-math" title="${esc(raw)}">${katex.renderToString(a.tex, { throwOnError: false, output: "html" })}</span>`;
    if (a.kind === "rich" || fallback !== "code") return renderRich(raw, true);
    return `<code>${esc(raw)}</code>`;
  }

  // ── tool presentation ──────────────────────────────────────────────────
  const base = (p) => String(p || "").split("/").pop();
  const first = (s, n = 80) => {
    const line = String(s ?? "").split("\n")[0];
    return line.length > n ? `${line.slice(0, n - 1)}…` : line;
  };
  // [row title, arg summary, spinner verb]
  const TOOLS = {
    rate_explanation: ["Rated your explanation", (a) => ({ good: "solid", partial: "on the right track", missing: "no reasoning yet" })[a.quality] || a.quality, "Reviewing your explanation"],
    course_style_sources: ["Read your class assessments", (a) => a.subject, "Studying how your teacher asks questions"],
    save_course_style: ["Saved course style", (a) => a.subject, "Saving the course style"],
    teacher_examples: ["Teacher's questions", (a) => `"${a.topic}"`, "Finding your teacher's questions"],
    set_assessment: ["Added to calendar", (a) => `${a.name} · ${a.date}`, "Noting the date"],
    assessment_result: ["Recorded result", (a) => a.name, "Recording the result"],
    read: ["Read", (a) => base(a.path || a.file_path), "Reading"],
    bash: ["Bash", (a) => first(a.command), "Running"],
    edit: ["Edit", (a) => base(a.path || a.file_path), "Editing"],
    write: ["Write", (a) => base(a.path || a.file_path), "Writing"],
    grep: ["Search", (a) => a.pattern, "Searching"],
    find: ["Find", (a) => a.pattern || a.path, "Searching"],
    ls: ["List", (a) => a.path || ".", "Looking around"],
    search_resources: ["Search class materials", (a) => `"${a.query}"`, "Searching your class materials"],
    read_resource: ["Read class material", (a) => `${base(a.path)}${a.fromPage ? ` p.${a.fromPage}${a.toPage ? `–${a.toPage}` : ""}` : ""}`, "Reading your class materials"],
    mark_taught: ["Marked taught", (a) => (a.concepts || []).map((c) => c.name).join(", "), "Updating your progress"],
    tutor_progress: ["Checked progress", (a) => a.subject || "", "Checking your progress"],
    update_learner_profile: ["Updated learner profile", (a) => a.section, "Updating your learner profile"],
    resolve_dispute: ["Settled dispute", (a) => a.verdict, "Judging your answer"],
    assign_exercise: ["Assigned exercise", (a) => a.title, "Setting up an exercise"],
    check_exercise: ["Checked your code", () => "", "Checking your code"],
    web_search: ["Web search", (a) => a.query, "Searching the web"],
    web_fetch: ["Fetch", (a) => a.url, "Reading a web page"],
    subagent: ["Subagent", (a) => a.agent || a.name || first(a.task || a.prompt, 50), "Working with a helper"],
    quiz: ["Quiz", (a) => first(a.question, 60), "Writing a question"],
    quiz_typed: ["Quiz", (a) => first(a.question, 60), "Writing a question"],
    ask_user_question: ["Question", (a) => first(a.question, 60), "Writing a question"],
  };
  const CARD_TOOLS = new Set(["quiz", "quiz_typed", "ask_user_question", "explain_back", "assign_exercise"]);

  function toolInfo(name, args) {
    const t = TOOLS[name];
    if (t) {
      let arg = "";
      try {
        arg = t[1](args || {}) || "";
      } catch {}
      return { title: t[0], arg, verb: t[2] };
    }
    const a = args && typeof args === "object" ? Object.values(args).find((v) => typeof v === "string") : "";
    return { title: name, arg: first(a || "", 60), verb: "Working" };
  }

  function resultText(result) {
    const c = result && result.content;
    if (!Array.isArray(c)) return "";
    return c.filter((b) => b && b.type === "text").map((b) => b.text).join("\n");
  }

  function resultSummary(item) {
    const text = resultText(item.result).trim();
    if (item.status === "running") return item.partial ? first(item.partial, 90) : "";
    if (item.status === "error") return first(text || "Failed", 120);
    const lines = text ? text.split("\n").length : 0;
    switch (item.name) {
      case "read":
        return `Read ${lines} line${lines === 1 ? "" : "s"}`;
      case "bash":
        return text ? `${first(text, 90)}${lines > 1 ? `  (+${lines - 1} lines)` : ""}` : "(no output)";
      case "search_resources": {
        const n = (text.match(/^\d+\. /gm) || []).length;
        return n ? `Found ${n} passage${n === 1 ? "" : "s"}` : first(text, 90);
      }
      default:
        return first(text, 110);
    }
  }

  // ── transcript container + sticky scrolling ────────────────────────────
  const scroller = () => $(".transcript");
  const feed = () => $(".feed");
  let emptyShown = false;

  function nearBottom() {
    const t = scroller();
    return t.scrollHeight - t.scrollTop - t.clientHeight < 40;
  }
  function pin() {
    const t = scroller();
    t.scrollTop = t.scrollHeight;
  }
  function scrollToBottom(force) {
    if (force) S.stuck = true;
    if (S.stuck) pin();
  }

  // ── items ──────────────────────────────────────────────────────────────
  // A multiple-choice question the model typed into chat before re-asking it as
  // a quiz card: keep its lead-in, drop the A) B) C) lines (the card has them).
  const TEXT_OPTION = /^\s*(?:[-*]\s*)?(?:\*\*)?\(?([A-Fa-f])(?:\)|\.|:)(?:\*\*)?\s+\S/;
  function textQuizOptions(text) {
    const lines = String(text || "").split("\n");
    let run = 0;
    let prev = -1;
    for (const line of lines) {
      const m = line.match(TEXT_OPTION);
      if (!m) {
        if (line.trim()) (run = 0), (prev = -1);
        continue;
      }
      const idx = "abcdef".indexOf(m[1].toLowerCase());
      run = idx === prev + 1 ? run + 1 : idx === 0 ? 1 : 0;
      prev = idx;
      if (run >= 3) return true;
    }
    return false;
  }
  function supersedeTextQuiz() {
    for (let i = S.items.length - 1; i >= 0; i--) {
      const it = S.items[i];
      if (it.kind === "user") return;
      if (it.kind === "text" && !it.superseded && textQuizOptions(it.text)) {
        it.superseded = true;
        return renderItem(it);
      }
    }
  }

  function addItem(item) {
    if (item.kind === "tool" && (item.name === "quiz" || item.name === "quiz_typed")) supersedeTextQuiz();
    S.items.push(item);
    S.byId.set(item.id, item);
    const node = document.createElement("div");
    node.className = "item";
    node.dataset.id = item.id;
    S.nodes.set(item.id, node);
    feed().appendChild(node);
    hideEmpty();
    renderItem(item);
    trim();
    return item;
  }

  function removeItem(id) {
    const item = S.byId.get(id);
    if (!item) return;
    S.nodes.get(item.id)?.remove();
    S.nodes.delete(item.id);
    for (const [k, v] of S.byId) if (v === item) S.byId.delete(k);
    S.live.delete(item.id);
    S.items = S.items.filter((i) => i !== item);
  }

  // Long sessions: keep the DOM bounded (never drop something still waiting).
  function trim() {
    while (S.items.length > MAX_ITEMS) {
      const old = S.items.find((i) => !S.live.has(i.id));
      if (!old) break;
      removeItem(old.id);
    }
  }

  function clearTranscript() {
    S.items = [];
    S.byId.clear();
    S.nodes.clear();
    S.live.clear();
    S.curMsg = null;
    feed().innerHTML = "";
    emptyShown = false;
    maybeShowEmpty();
  }

  let renderQueue = new Set();
  let rafPending = false;
  function scheduleRender(id) {
    renderQueue.add(id);
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      for (const i of renderQueue) {
        const it = S.byId.get(i);
        if (it) renderItem(it);
      }
      renderQueue.clear();
    });
  }

  // Re-rendering replaces a card's DOM; keep keyboard focus (and the caret)
  // where it was so a streaming update never drops the learner's input.
  function renderItem(item) {
    const node = S.nodes.get(item.id);
    if (!node) return;
    const active = document.activeElement;
    let restore = null;
    if (active && node.contains(active)) {
      const key = ["data-explain", "data-typed", "data-qtext", "data-qothertext", "data-dinput", "data-note"].find((a) => active.hasAttribute(a));
      restore = { key, start: active.selectionStart, end: active.selectionEnd };
    }
    paint(node, item);
    node.classList.toggle("working", isWorking(node, item));
    if (restore) {
      const el = restore.key ? node.querySelector(`[${restore.key}]`) : null;
      if (el) {
        el.focus({ preventScroll: true });
        try {
          el.setSelectionRange(restore.start, restore.end);
        } catch {}
      } else node.querySelector(".card")?.focus({ preventScroll: true });
    }
  }

  // Behind-the-scenes steps the learner can hide: thinking, agent notices
  // (retries, compaction, extension errors), and plain tool rows (not cards).
  // A tool row still asking for a rating keeps just its rating buttons.
  function isWorking(node, item) {
    if (item.kind === "thinking") return true;
    if (item.kind === "notice") return Boolean(item.internal);
    if (item.kind !== "tool" || !node.querySelector(":scope > .tool")) return false;
    const rate = node.querySelector(".rate");
    node.classList.toggle("rate-only", Boolean(rate) && !rate.classList.contains("done"));
    return !node.classList.contains("rate-only");
  }

  function paint(node, item) {
    switch (item.kind) {
      case "user":
        node.innerHTML = `<div class="user">${esc(item.text)}</div>`;
        return;
      case "command":
        node.innerHTML = `<div class="command"><span class="prompt">❯</span> ${esc(item.text)}</div>`;
        return;
      case "text":
        if (item.superseded) {
          const lead = item.text.split("\n").filter((l) => !TEXT_OPTION.test(l)).join("\n").trim();
          node.innerHTML = `<div class="text">${renderRich(lead)}</div><div class="moved">Answer in the quiz card below.</div>`;
          return;
        }
        node.innerHTML = `<div class="text${item.streaming ? " streaming-caret" : ""}">${renderRich(item.text)}</div>`;
        return;
      case "thinking": {
        const open = node.querySelector("details")?.open || false;
        const secs = item.secs ? ` for ${item.secs}s` : "";
        node.innerHTML = `<details class="thinking"${open ? " open" : ""}><summary>${item.streaming ? "Thinking…" : `Thought${secs}`}</summary><div class="body">${esc(item.text)}</div></details>`;
        return;
      }
      case "tool":
        return CARD_TOOLS.has(item.name) ? paintCardTool(node, item) : paintToolRow(node, item);
      case "notice": {
        const glyph = item.level === "error" ? "✗" : item.level === "warning" ? "!" : "⎿";
        const body = item.short ? `<span class="full">${renderRich(item.text, true)}</span><span class="short">${esc(item.short)}</span>` : `<span>${renderRich(item.text, true)}</span>`;
        node.innerHTML = `<div class="notice ${esc(item.level)}"><span class="glyph">${glyph}</span>${body}</div>`;
        return;
      }
      case "dialog":
        return paintDialog(node, item);
      case "setup":
        node.innerHTML = `<div class="conn-error"><strong>Connect an AI provider to start.</strong><p>TutorBot runs on your own API key (Anthropic, OpenAI, Google Gemini, OpenRouter and others). It's stored in your system keychain.</p><div class="actions"><button class="btn small" data-act="connect-key">Connect API key</button></div></div>`;
        return;
      case "connection":
        node.innerHTML = `<div class="conn-error"><strong>TutorBot stopped.</strong>${item.detail ? `<pre>${esc(item.detail)}</pre>` : ""}<div class="actions"><button class="btn small" data-act="restart">Restart TutorBot</button><button class="btn small secondary" data-act="log">Show log</button></div></div>`;
        return;
      default:
        return;
    }
  }

  // ── tool rows ──────────────────────────────────────────────────────────
  function paintToolRow(node, item) {
    const { title, arg } = toolInfo(item.name, item.args);
    const dot = item.status === "running" ? "running" : item.status === "error" ? "error" : "done";
    const summary = resultSummary(item);
    const out = (item.status === "running" ? item.partial : resultText(item.result)) || "";
    const canExpand = Boolean(out.trim());
    const expanded = Boolean(item.expanded) && canExpand;
    node.innerHTML =
      `<div class="tool">` +
      `<div class="row" ${canExpand ? `data-toggle role="button" tabindex="0" aria-expanded="${expanded}"` : ""} title="${esc(item.name)}"><span class="dot ${dot}">●</span><span class="name">${esc(title)}</span>${arg ? `<span class="arg">${esc(arg)}</span>` : ""}${canExpand ? `<span class="chev${expanded ? " open" : ""}">›</span>` : ""}</div>` +
      (summary ? `<div class="result${item.status === "error" ? " error" : ""}"><span class="elbow">⎿</span><span>${esc(summary)}</span></div>` : "") +
      (expanded ? `<div class="output">${esc(out.slice(0, 20000))}</div>` : "") +
      rateBlock(item) +
      `</div>`;
  }

  // After a lesson ("Marked taught"), the learner can rate how it went. TutorBot
  // adapts right away and learns which teaching approaches work for them.
  function rateBlock(item) {
    if (item.name !== "mark_taught" || item.status !== "done" || item.fromHistory) return "";
    if (item.rated) return `<div class="rate done">Noted: ${esc((RATINGS.find((r) => r[0] === item.rated) || [])[1] || "")}</div>`;
    return `<div class="rate"><span class="rate-q">How was that explanation?</span>${RATINGS.map(([k, label]) => `<button class="seg" data-act="rate" data-rating="${k}">${label}</button>`).join("")}</div>`;
  }

  // ── quiz / typed / question cards ──────────────────────────────────────
  function paintCardTool(node, item) {
    const a = item.args || {};
    const d = item.result && item.result.details;
    // Exercises are cards only once they reach the learner (older/terminal ones stay rows).
    if (item.name === "assign_exercise") return item.ask || (d && d.kind === "code") ? paintCodeCard(node, item, a, d) : paintToolRow(node, item);
    const answered = d && d.status === "answered";
    // Blocked / failed / cancelled: a compact tool row (or a short note).
    if (item.status !== "running" && !answered) {
      const txt = resultText(item.result);
      // Shown-then-skipped/interrupted: keep the question, add the outcome.
      if (item.ask || item.skipReason || /cancel/i.test(txt)) {
        const reason = item.skipReason || (/cancel/i.test(txt) ? "Skipped" : first(txt, 80) || "Skipped");
        const label = item.name === "ask_user_question" ? "Question" : item.name === "explain_back" ? "Explain it back" : "Quiz";
        node.innerHTML = `<div class="card" tabindex="-1">${cardHead(label, a.purpose, false)}<div class="q">${renderRich(a.question || a.prompt)}</div><div class="answered-summary"><span>⎿</span><span>${esc(reason)}</span></div></div>`;
      } else {
        // Never shown (blocked / unavailable): a failure, not a success.
        const failed = item.status === "error" || ["unavailable", "error"].includes(d && d.status);
        paintToolRow(node, { ...item, status: failed ? "error" : "done" });
      }
      return;
    }
    if (item.name === "ask_user_question") return paintQuestionCard(node, item, a, d, answered);
    if (item.name === "explain_back") return paintExplainCard(node, item, a, d, answered);
    if (item.name === "quiz_typed") return paintTypedCard(node, item, a, d, answered);
    return paintQuizCard(node, item, a, d, answered);
  }

  function cardHead(label, purpose, live) {
    const p = purpose === "checkpoint" ? "no-help checkpoint" : purpose;
    return `<div class="label">${esc(label)}${p ? ` · ${esc(p)}` : ""}</div>`;
  }

  // ── shared card blocks: hints, confidence, explain-it-back, answer meta ─
  function hintsBlock(ask) {
    if (!ask || ask.checkpoint) return ask && ask.checkpoint ? `<div class="meta-line">No hints in a checkpoint. Answer on your own.</div>` : "";
    const hints = ask.hints || [];
    const shown = ask.hintsShown || 0;
    let h = "";
    if (shown) h += `<div class="hints">${hints.slice(0, shown).map((x, i) => `<div class="hint-row"><span class="hint-n">Hint ${i + 1}</span><span class="hint-t">${renderRich(x, true)}</span></div>`).join("")}</div>`;
    return h;
  }
  function hintButton(ask) {
    if (!ask || ask.checkpoint) return "";
    const left = (ask.hints || []).length - (ask.hintsShown || 0);
    return left > 0 ? `<button class="link-btn" data-act="hint">Hint (${left} left)</button>` : "";
  }
  function confidenceBlock() {
    return `<div class="confidence"><span class="c-q">How sure are you?</span><span class="c-opts">${[1, 2, 3].map((n) => `<button class="seg" data-act="conf" data-level="${n}"><span class="k">${n}</span>${CONF[n]}</button>`).join("")}</span></div><div class="actions"><button class="link-btn" data-act="conf-back">Change answer</button><button class="link-btn" data-act="conf-skip">Skip</button>${keyHint(["1 · 2 · 3", "Esc skips"])}</div>`;
  }
  function explainBlock(ex) {
    const head = ex.correct
      ? `<div class="verdict good">Correct, but you said it was a guess.</div><div class="eb-prompt">Before the explanation: in your own words, why is it right?</div>`
      : `<div class="verdict bad">Not quite. The correct answer is ${answerHtml(ex.correctAnswer, "rich")}.</div><div class="eb-prompt">Before the explanation: in your own words, why is that the answer, or where did your reasoning go wrong?</div>`;
    return `<div class="explain-back">${head}<textarea rows="2" data-explain placeholder="Explain in your own words…">${esc(ex.draft || "")}</textarea><div class="actions"><button class="btn small" data-act="eb-submit">Submit</button><button class="btn small secondary" data-act="eb-direct">Just show me</button><button class="link-btn" data-act="eb-skip">Skip</button>${keyHint(["Enter submits", "Esc skips"])}</div></div>`;
  }
  function answerMeta(d) {
    const bits = [];
    if (d.confidence) bits.push(`You said: ${CONF[d.confidence]}`);
    if (d.hintsUsed) bits.push(`${d.hintsUsed} hint${d.hintsUsed === 1 ? "" : "s"} used`);
    if (d.checkpoint) bits.push("no-help checkpoint");
    let h = bits.length ? `<div class="meta-line">${esc(bits.join(" · "))}</div>` : "";
    if (d.wantsDirect) h += `<div class="answer-line">You asked to be shown.</div>`;
    else if (d.selfExplanation) h += `<div class="your-explain"><span class="ye-l">Your explanation</span>${renderRich(d.selfExplanation, true)}</div>`;
    return h;
  }
  function preparing(item) {
    const p = item.partial && /verif/i.test(item.partial) ? "Checking the answer key…" : "Preparing question…";
    return `<div class="pending-line">${SPIN}${p}</div>`;
  }
  function optionRow(o, i, extra) {
    const { cls = "", mark = "", box = "", num = `${o.index}.`, attrs = "", desc = "" } = extra;
    return `<li class="opt${cls}" role="option" aria-selected="${/checked|key|focused/.test(cls)}" data-pos="${i}" ${attrs}><span class="cursor">❯</span>${box}<span class="num">${num}</span><span class="lbl">${renderRich(o.label, true)}${desc ? `<span class="desc">${renderRich(desc, true)}</span>` : ""}</span>${mark ? `<span class="mark">${mark}</span>` : ""}</li>`;
  }
  const keyHint = (parts) => `<span class="hint">${parts.join(" · ")}</span>`;

  function paintQuizCard(node, item, a, d, answered) {
    const ask = item.ask;
    const ex = item.explain;
    const stage = ask && !ask.done ? ask.stage || "select" : "";
    const live = Boolean(!answered && ((ask && !ask.done) || (ex && !ex.done)));
    const multi = Boolean((ask && ask.multiSelect) || a.multiSelect);
    let html = `<div class="card${live ? " live" : ""}" tabindex="-1">${cardHead(multi ? "Quiz · select all that apply" : "Quiz", a.purpose, live)}<div class="q">${renderRich(a.question)}</div>`;
    if (a.details) html += `<div class="q ctx">${renderRich(a.details)}</div>`;
    const options = (answered ? d.options : ask && ask.options) || null;
    if (!options) {
      node.innerHTML = `${html}${preparing(item)}</div>`;
      return;
    }
    if (!answered && stage === "select") html += hintsBlock(ask);
    const pendingIdx = ask && ask.pending ? ask.pending.indices || [] : [];
    const sel = new Set(answered ? (d.answers || []).map((x) => x.index) : stage === "confidence" || (ask && ask.done) ? pendingIdx.length ? pendingIdx : ask.checked || [] : (ask && ask.checked) || []);
    const key = new Set(answered ? d.correctIndices || [] : []);
    const descOf = (o) => (ask && ask.options ? (ask.options.find((x) => x.index === o.index) || {}).description : "");
    const locked = answered || !ask || ask.done || stage === "confidence";
    html += `<ul class="opts" role="listbox" aria-multiselectable="${multi}">`;
    options.forEach((o, i) => {
      let cls = "";
      let mark = "";
      if (answered) {
        cls += " locked";
        if (key.has(o.index)) [cls, mark] = [`${cls} key`, "Correct"];
        else if (sel.has(o.index)) [cls, mark] = [`${cls} wrong`, "Your answer"];
        else cls += " dim";
      } else if (locked) cls += ` locked${sel.has(o.index) ? " checked" : " dim"}`;
      else {
        if (ask.focus === i) cls += " focused";
        if (multi && sel.has(o.index)) cls += " checked";
      }
      const box = !answered && multi ? '<span class="check"></span>' : "";
      html += optionRow(o, i, { cls, mark, box, attrs: `data-opt="${o.index}" data-num="${i + 1}"`, desc: descOf(o) });
    });
    if (!answered && !locked) {
      const pos = options.length;
      html += `<li class="opt dim${ask.focus === pos ? " focused" : ""}" role="option" data-dontknow data-pos="${pos}"><span class="cursor">❯</span><span class="num">?</span><span class="lbl">I don't know</span></li>`;
    }
    html += `</ul>`;
    if (answered) {
      const v = d.dontKnow ? ["warn", "You said: I don't know"] : d.correct ? ["good", "Correct"] : ["bad", "Not quite"];
      html += `<div class="verdict ${v[0]}">${v[1]}</div>`;
      html += answerMeta(d);
      if (d.note) html += `<div class="answer-line">Your note: ${esc(d.note)}</div>`;
      if (d.explanation) html += `<div class="explain text">${renderRich(d.explanation)}</div>`;
    } else if (ex && !ex.done) html += explainBlock(ex);
    else if (ex) html += `<div class="pending-line">${SPIN}Revealing the explanation…</div>`;
    else if (stage === "confidence") html += confidenceBlock();
    else if (ask.done) html += `<div class="pending-line">${SPIN}Checking your answer…</div>`;
    else {
      html += `<div class="actions">${multi ? '<button class="btn small" data-act="quiz-submit">Submit</button>' : ""}${hintButton(ask)}${ask.noteOpen ? "" : '<button class="link-btn" data-act="note">Add a note</button>'}${keyHint(multi ? ["↑↓", "Space toggles", "Enter submits", ...(hintButton(ask) ? ["H hint"] : []), "Esc skips"] : ["↑↓", "Enter", "1–" + options.length, ...(hintButton(ask) ? ["H hint"] : []), "Esc skips"])}</div>`;
      if (ask.noteOpen) html += `<textarea rows="2" data-note placeholder="Optional note for TutorBot (what you were thinking, what's unclear)…">${esc(ask.note || "")}</textarea>`;
    }
    node.innerHTML = `${html}</div>`;
  }

  function typedResult(r, withButtons) {
    let h = `<div class="answer-line">Your answer: ${r.dontKnow ? "<code>(I don't know)</code>" : r.answer ? answerHtml(r.answer) : "<code>(empty)</code>"}</div>`;
    const v = r.dontKnow ? ["warn", "You said: I don't know"] : r.correct ? ["good", "Correct"] : r.disputed ? ["warn", "Disputed — TutorBot will judge it"] : ["bad", "Not a match"];
    h += `<div class="verdict ${v[0]}">${v[1]}${r.correct && r.attempts > 1 ? ` on try ${r.attempts}` : ""}</div>`;
    if (r.earlierTries && r.earlierTries.length) h += `<div class="meta-line">Earlier tries: ${r.earlierTries.map((t) => answerHtml(t)).join(" · ")}</div>`;
    if (!r.correct) h += `<div class="answer-line">Expected: ${answerHtml(r.expected)}</div>`;
    h += answerMeta(r);
    if (r.explanation) h += `<div class="explain text">${renderRich(r.explanation)}</div>`;
    if (withButtons) {
      h += `<div class="actions"><button class="btn small" data-act="fb-continue">Continue</button>`;
      if (!r.correct && !r.dontKnow) h += `<button class="btn small secondary" data-act="fb-dispute">My answer is equivalent</button>`;
      h += keyHint(["Enter continues", ...(!r.correct && !r.dontKnow ? ["D disputes"] : [])]) + `</div>`;
    }
    return h;
  }

  function paintTypedCard(node, item, a, d, answered) {
    const ask = item.ask;
    const fb = item.feedback;
    const ex = item.explain;
    const stage = ask && !ask.done ? ask.stage || "select" : "";
    const live = !answered && Boolean((ask && !ask.done) || (fb && !fb.done) || (ex && !ex.done));
    let html = `<div class="card${live ? " live" : ""}" tabindex="-1">${cardHead("Type your answer", a.purpose, live)}<div class="q">${renderRich(a.question)}</div>`;
    if (a.details) html += `<div class="q ctx">${renderRich(a.details)}</div>`;
    const yours = (txt) => `<div class="answer-line">Your answer: ${txt ? answerHtml(txt) : "<code></code>"}</div>`;
    if (answered) html += typedResult(d, false);
    else if (fb && !fb.done) html += typedResult(fb, true);
    else if (fb) html += `${typedResult(fb, false)}<div class="pending-line">${SPIN}Saving…</div>`;
    else if (ex && !ex.done) html += yours(ask && ask.draft) + explainBlock(ex);
    else if (ex) html += yours(ask && ask.draft) + `<div class="pending-line">${SPIN}Revealing the explanation…</div>`;
    else if (stage === "confidence") html += yours(ask.draft) + confidenceBlock();
    else if (ask && !ask.done && ask.retry) {
      const left = ask.retry.of - ask.retry.attempt + 1;
      html += `<div class="verdict bad">Not quite: ${answerHtml(ask.retry.previous)}</div>`;
      html += `<div class="meta-line">Try again: fix your answer below${hintButton(ask) ? ", or take a hint" : ""}. ${left === 1 ? "Last try." : `${left} tries left.`}</div>`;
      html += hintsBlock(ask);
      html += `<textarea class="mono" rows="2" data-typed placeholder="Type your answer…">${esc(ask.draft || "")}</textarea>`;
      html += `<div class="actions"><button class="btn small" data-act="typed-submit">Check again</button>${hintButton(ask)}<button class="link-btn" data-act="typed-reveal">Show answer</button>${keyHint(["Enter submits", "⇧Enter newline", "Esc skips"])}</div>`;
    } else if (ask && !ask.done) {
      html += hintsBlock(ask);
      html += `<textarea class="mono" rows="2" data-typed placeholder="Type your answer…">${esc(ask.draft || "")}</textarea>`;
      html += `<div class="actions"><button class="btn small" data-act="typed-submit">Submit</button><button class="btn small secondary" data-act="typed-dontknow">I don't know</button>${hintButton(ask)}${keyHint(["Enter submits", "⇧Enter newline", "Esc skips"])}</div>`;
    } else if (ask) html += yours(ask.draft) + `<div class="pending-line">${SPIN}Grading…</div>`;
    else html += preparing(item);
    node.innerHTML = `${html}</div>`;
  }

  // ── "write a program" card (assign_exercise) ───────────────────────────
  function codeResults(r) {
    if (r.compileError) return `<pre class="code-err">${esc(r.compileError)}</pre>`;
    return `<ul class="code-tests">${(r.results || [])
      .map((x) => `<li class="${x.pass ? "ok" : "no"}"><span class="m">${x.pass ? "Pass" : "Fail"}</span><span>${esc(x.name)}${!x.pass && x.detail ? `<div class="detail">${esc(x.detail)}</div>` : ""}</span></li>`)
      .join("")}</ul>`;
  }
  // Live test status from the exercise state (tests re-run as the learner types).
  function codeLiveLine(file) {
    const ex = S.exercise;
    const s = ex && ex.file === file ? ex.status : null;
    if (!s) return `<div class="meta-line">Tests run as you type.</div>`;
    const t = s.running ? "running tests…" : s.compileError ? "doesn't compile yet" : `${s.passed}/${s.total} tests passing`;
    return `<div class="meta-line">As you type: ${esc(t)}</div>`;
  }
  function paintCodeCard(node, item, a, d) {
    const ask = item.ask;
    const answered = d && d.status === "answered";
    const live = Boolean(!answered && ask && !ask.done && item.status === "running");
    const title = a.title || (ask && ask.title) || "";
    const prompt = a.prompt || (ask && ask.prompt) || "";
    let html = `<div class="card${live ? " live" : ""}" tabindex="-1">${cardHead("Write a program", a.language || (ask && ask.language), live)}`;
    html += `<div class="code-title">${esc(title)}</div><div class="q">${renderRich(prompt)}</div>`;
    if (answered) {
      html += d.correct ? `<div class="verdict good">Correct — all ${d.total} tests pass</div>` : `<div class="verdict warn">Solution shown</div>`;
      const bits = [`${d.attempts} check${d.attempts === 1 ? "" : "s"}`];
      if (d.hintsUsed) bits.push(`${d.hintsUsed} hint${d.hintsUsed === 1 ? "" : "s"} used`);
      html += `<div class="meta-line">${esc(bits.join(" · "))}</div>`;
      if (!d.correct && d.last) html += codeResults(d.last);
      if (d.solution) html += `<div class="ye-l">Reference solution</div>${renderRich("```" + (d.language || "") + "\n" + String(d.solution).trimEnd() + "\n```")}`;
      if (d.explanation) html += `<div class="explain text">${renderRich(d.explanation)}</div>`;
    } else if (d && d.status === "help") {
      html += `<div class="answered-summary"><span>⎿</span><span>You asked TutorBot for help. The exercise stays open; press Submit in the editor when you're ready.</span></div>`;
    } else if (item.status !== "running" || (d && d.status === "cancelled")) {
      html += `<div class="answered-summary"><span>⎿</span><span>${esc(item.skipReason || "Skipped")}</span></div>`;
    } else if (live) {
      html += `<div class="code-file"><button class="link-btn file" data-act="ex-open">${esc(ask.fileName || "your file")}</button> is open in the editor. Write your program there, then press Check.</div>`;
      if (ask.last) {
        html += `<div class="verdict bad">Not yet: ${ask.last.compileError ? "your code doesn't compile" : `${ask.last.passed}/${ask.last.total} tests pass`}</div>${codeResults(ask.last)}`;
      }
      html += codeLiveLine(ask.file);
      html += hintsBlock(ask);
      html += `<div class="actions"><button class="btn small" data-act="code-check">Check</button>${hintButton(ask)}<button class="btn small secondary" data-act="code-help">Ask TutorBot</button><button class="link-btn" data-act="code-giveup">Show solution</button>${keyHint([`${MOD}+Enter checks`, "Esc skips"])}</div>`;
    } else if (ask) html += `<div class="pending-line">${SPIN}Running your code…</div>`;
    else html += `<div class="pending-line">${SPIN}Checking the exercise…</div>`;
    node.innerHTML = `${html}</div>`;
  }
  function codeAction(item, action) {
    const ask = item.ask;
    if (!ask || ask.done) return;
    sendAnswer(ask, { action, hintsUsed: ask.hintsShown || 0 });
    afterAnswer(item);
  }

  // Standalone explain-it-back (explain_back tool).
  function paintExplainCard(node, item, a, d, answered) {
    const ex = item.explain;
    const live = Boolean(!answered && ex && !ex.done);
    let html = `<div class="card${live ? " live" : ""}" tabindex="-1">${cardHead("Explain it back", "", live)}<div class="q">${renderRich(a.prompt)}</div>`;
    if (a.details) html += `<div class="q ctx">${renderRich(a.details)}</div>`;
    if (answered) {
      if (d.wantsDirect) html += `<div class="answer-line">You asked to be shown.</div>`;
      else html += d.text ? `<div class="your-explain"><span class="ye-l">Your explanation</span>${renderRich(d.text, true)}</div>` : `<div class="meta-line">You skipped this one.</div>`;
      if (d.reference) html += `<div class="explain text"><div class="ye-l">TutorBot's explanation</div>${renderRich(d.reference)}</div>`;
    } else if (live) {
      html += `<textarea rows="3" data-explain placeholder="Explain in your own words…">${esc(ex.draft || "")}</textarea><div class="actions"><button class="btn small" data-act="eb-submit">Submit</button><button class="btn small secondary" data-act="eb-direct">Just show me</button><button class="link-btn" data-act="eb-skip">Skip</button>${keyHint(["Enter submits", "⇧Enter newline", "Esc skips"])}</div>`;
    } else if (ex) html += `<div class="pending-line">${SPIN}Comparing with the explanation…</div>`;
    else html += `<div class="pending-line">${SPIN}Preparing…</div>`;
    node.innerHTML = `${html}</div>`;
  }

  function paintQuestionCard(node, item, a, d, answered) {
    const ask = item.ask;
    if (answered) {
      const vals = (d.answers || []).map((x) => (x.type === "option" ? `${x.index}. ${x.label}` : x.label)).join(", ");
      node.innerHTML = `<div class="card" tabindex="-1"><div class="q">${renderRich(a.question)}</div><div class="answered-summary"><span>⎿</span><span>You said: <span class="val">${renderRich(vals, true)}</span></span></div></div>`;
      return;
    }
    const live = Boolean(ask && !ask.done);
    let html = `<div class="card${live ? " live" : ""}" tabindex="-1">${cardHead("Question", "", live)}<div class="q">${renderRich(a.question)}</div>`;
    if (a.details) html += `<div class="q ctx">${renderRich(a.details)}</div>`;
    if (!ask) {
      node.innerHTML = `${html}${preparing(item)}</div>`;
      return;
    }
    if (ask.done) {
      node.innerHTML = `${html}<div class="pending-line">Sent.</div></div>`;
      return;
    }
    if (ask.mode === "text") {
      html += `<textarea rows="2" data-qtext placeholder="Type your answer…">${esc(ask.draft || "")}</textarea><div class="actions"><button class="btn small" data-act="q-send">Send</button>${keyHint(["Enter sends", "⇧Enter newline", "Esc skips"])}</div>`;
    } else {
      const multi = ask.mode === "multi-select";
      const sel = new Set(ask.checked || []);
      html += `<ul class="opts" role="listbox" aria-multiselectable="${multi}">`;
      ask.options.forEach((o, i) => {
        const cls = `${ask.focus === i ? " focused" : ""}${sel.has(o.index) ? " checked" : ""}`;
        html += optionRow(o, i, { cls, box: multi ? '<span class="check"></span>' : "", attrs: `data-qopt="${o.index}" data-num="${i + 1}"`, desc: o.description });
      });
      const pos = ask.options.length;
      html += `<li class="opt dim${ask.focus === pos ? " focused" : ""}" role="option" data-qother data-pos="${pos}"><span class="cursor">❯</span><span class="num"></span><span class="lbl">Other…</span></li></ul>`;
      if (ask.otherOpen) html += `<input type="text" data-qothertext placeholder="Type your own answer, Enter to send" value="${esc(ask.other || "")}">`;
      html += `<div class="actions">${multi ? '<button class="btn small" data-act="q-send">Submit</button>' : ""}${keyHint(multi ? ["↑↓", "Space toggles", "Enter submits", "Esc skips"] : ["↑↓", "Enter", "1–" + ask.options.length, "Esc skips"])}</div>`;
    }
    node.innerHTML = `${html}</div>`;
  }

  // ── dialogs (select / confirm / input / editor from extensions) ────────
  function paintDialog(node, item) {
    const r = item.request;
    if (item.done) {
      node.innerHTML = `<div class="answered-summary"><span>⎿</span><span>${esc(first(r.title, 70))}: <span class="val">${esc(item.answerText ?? "dismissed")}</span></span></div>`;
      return;
    }
    let html = `<div class="card live" tabindex="-1"><div class="label">${r.method === "confirm" ? "Confirm" : "TutorBot"}</div><div class="q">${renderRich(r.title || "")}</div>`;
    if (r.message) html += `<div class="q ctx">${renderRich(r.message)}</div>`;
    if (r.method === "select") {
      html += `<ul class="opts" role="listbox">`;
      (r.options || []).forEach((o, i) => {
        html += `<li class="opt${item.focus === i ? " focused" : ""}" role="option" aria-selected="${item.focus === i}" data-dopt="${i}" data-num="${i + 1}" data-pos="${i}"><span class="cursor">❯</span><span class="num">${i + 1}.</span><span class="lbl">${esc(o)}</span></li>`;
      });
      html += `</ul><div class="actions">${keyHint(["↑↓", "Enter", "Esc dismisses"])}</div>`;
    } else if (r.method === "confirm") {
      html += `<div class="actions"><button class="btn small" data-act="d-yes">Yes</button><button class="btn small secondary" data-act="d-no">No</button>${keyHint(["Y / Enter", "N / Esc"])}</div>`;
    } else {
      const multi = r.method === "editor";
      html += multi
        ? `<textarea rows="5" data-dinput placeholder="${esc(r.placeholder || "")}">${esc(item.draft ?? r.prefill ?? "")}</textarea>`
        : `<input type="text" data-dinput placeholder="${esc(r.placeholder || "")}" value="${esc(item.draft ?? r.prefill ?? "")}">`;
      html += `<div class="actions"><button class="btn small" data-act="d-ok">${multi ? "Submit" : "OK"}</button><button class="btn small secondary" data-act="d-cancel">Cancel</button>${keyHint([multi ? `${MOD}+Enter submits` : "Enter submits", "Esc cancels"])}</div>`;
    }
    node.innerHTML = `${html}</div>`;
  }

  // ── the live (waiting-for-learner) element ─────────────────────────────
  function setLive(item, on) {
    if (on) S.live.add(item.id);
    else S.live.delete(item.id);
  }
  function isLive(it) {
    if (it.kind === "dialog") return !it.done;
    return Boolean((it.ask && !it.ask.done) || (it.feedback && !it.feedback.done) || (it.explain && !it.explain.done));
  }
  function liveItem() {
    let newest = null;
    for (const id of S.live) {
      const it = S.byId.get(id);
      if (!it || !isLive(it)) {
        S.live.delete(id);
        continue;
      }
      newest = it;
    }
    return newest;
  }

  // Move focus into the live card — but never yank it away from a composer
  // the learner is typing in (their next key would answer the question).
  function focusLive(force) {
    const it = liveItem();
    if (!it) return false;
    const node = S.nodes.get(it.id);
    if (!node) return false;
    const composer = input();
    if (!force && document.activeElement === composer && composer.value.trim()) {
      updateStatusline();
      return false;
    }
    const field = node.querySelector("textarea[data-explain], textarea[data-typed], textarea[data-qtext], [data-dinput], input[data-qothertext]");
    if (field) {
      field.focus({ preventScroll: true });
      const v = field.value;
      try {
        field.setSelectionRange(v.length, v.length);
      } catch {}
    } else node.querySelector(".card")?.focus({ preventScroll: true });
    scrollToBottom(true);
    return true;
  }

  function sendAnswer(ask, value) {
    ask.done = true;
    vscode.postMessage({ type: "answer", id: ask.id, value });
  }
  function skipAsk(item) {
    // Explain-it-back skipped: the tool continues and reveals the explanation.
    if (item.explain && !item.explain.done) {
      sendAnswer(item.explain, { text: "" });
      return afterAnswer(item);
    }
    const ask = item.feedback && !item.feedback.done ? item.feedback : item.ask;
    if (!ask || ask.done) return;
    ask.done = true;
    if (ask === item.ask) item.skipReason = "Skipped";
    if (ask === item.feedback) vscode.postMessage({ type: "answer", id: ask.id, value: { disputed: false } });
    else vscode.postMessage({ type: "answer", id: ask.id, cancelled: true });
    afterAnswer(item);
  }
  function afterAnswer(item) {
    renderItem(item);
    updateStatusline();
    if (!focusLive()) input().focus();
  }

  function answerDialog(item, response, answerText) {
    if (item.done) return;
    item.done = true;
    item.answerText = answerText;
    clearTimeout(item.timer);
    DEADLINES.delete(item.request.id);
    vscode.postMessage({ type: "uiResponse", response: { id: item.request.id, ...response } });
    afterAnswer(item);
  }

  // Close everything still waiting (process stopped, interrupted, timed out).
  function expireLive(reason) {
    for (const id of [...S.live]) {
      const it = S.byId.get(id);
      if (!it) continue;
      if (it.kind === "dialog" && !it.done) {
        it.done = true;
        it.answerText = reason;
        clearTimeout(it.timer);
        DEADLINES.delete(it.request.id);
        // Tell pi (and the host's pending list) so nothing stays blocked on it.
        vscode.postMessage({ type: "uiResponse", response: { id: it.request.id, cancelled: true } });
      }
      if (it.kind === "tool" && ((it.ask && !it.ask.done) || (it.feedback && !it.feedback.done))) it.skipReason = reason === "interrupted" ? "Interrupted" : reason;
      if (it.ask) it.ask.done = true;
      if (it.feedback) it.feedback.done = true;
      if (it.explain) it.explain.done = true;
      renderItem(it);
    }
    S.live.clear();
    updateStatusline();
  }

  // ── RPC event handling ─────────────────────────────────────────────────
  function textOf(content) {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return content.filter((b) => b && b.type === "text").map((b) => b.text).join("\n\n");
  }
  function startAssistant() {
    S.curMsg = { key: nextId("m"), blocks: new Map(), thinkStart: new Map() };
    S.msgTokens = 0;
  }
  function blockItem(ci, kind) {
    if (!S.curMsg) startAssistant();
    const m = S.curMsg;
    let id = m.blocks.get(ci);
    if (!id) {
      id = `${m.key}:${ci}`;
      m.blocks.set(ci, id);
      addItem({ id, kind, text: "", streaming: true });
      if (kind === "thinking") m.thinkStart.set(ci, Date.now());
    }
    return S.byId.get(id);
  }
  function toolItem(callId, name, args) {
    let it = S.byId.get(callId);
    // A card may exist already because its ask (bridge) arrived before the
    // tool event (RPC): adopt it instead of drawing a second card.
    if (!it && CARD_TOOLS.has(name)) {
      it = S.items.find((i) => i.orphan && i.name === name && (i.ask?.toolCallId === callId || !i.ask?.toolCallId));
      if (it) {
        it.orphan = false;
        it.callId = callId;
        S.byId.set(callId, it);
      }
    }
    if (!it) it = addItem({ id: callId, callId, kind: "tool", name, args: args || {}, status: "running" });
    else {
      if (name) it.name = name;
      if (args && Object.keys(args).length) it.args = args;
    }
    return it;
  }

  function onRpc(ev) {
    switch (ev.type) {
      case "agent_start":
        setRunning(true);
        break;
      case "agent_settled":
        // Only "settled" means done: agent_end can be followed by a retry or a
        // queued follow-up turn, and the spinner shouldn't flicker in between.
        setRunning(false);
        // No tool can still be waiting on an answer once pi has settled.
        for (const id of [...S.live]) {
          const it = S.byId.get(id);
          if (it && it.kind === "tool") {
            if (it.ask) it.ask.done = true;
            if (it.feedback) it.feedback.done = true;
            if (it.explain) it.explain.done = true;
            S.live.delete(id);
            renderItem(it);
          }
        }
        updateStatusline();
        break;
      case "message_start": {
        const m = ev.message || {};
        if (m.role === "assistant") startAssistant();
        else if (m.role === "user") {
          const text = textOf(m.content).trim();
          if (text) {
            addItem({ id: nextId("u"), kind: "user", text });
            scrollToBottom(true);
          }
        }
        break;
      }
      case "message_update": {
        if (ev.usage && typeof ev.usage.output === "number") S.msgTokens = ev.usage.output;
        const e = ev.assistantMessageEvent || {};
        if (e.type === "text_delta") {
          const it = blockItem(e.contentIndex, "text");
          it.text += e.delta || "";
          S.activity = "";
          scheduleRender(it.id);
        } else if (e.type === "text_end") {
          const it = blockItem(e.contentIndex, "text");
          if (typeof e.content === "string") it.text = e.content;
          it.streaming = false;
          scheduleRender(it.id);
        } else if (e.type === "thinking_delta") {
          const it = blockItem(e.contentIndex, "thinking");
          it.text += e.delta || "";
          scheduleRender(it.id);
        } else if (e.type === "thinking_end") {
          const it = blockItem(e.contentIndex, "thinking");
          it.streaming = false;
          const t0 = S.curMsg && S.curMsg.thinkStart.get(e.contentIndex);
          if (t0) it.secs = Math.max(1, Math.round((Date.now() - t0) / 1000));
          scheduleRender(it.id);
        } else if (e.type === "toolcall_start" && e.id) {
          toolItem(e.id, e.toolName, {});
          S.activity = toolInfo(e.toolName, {}).verb;
        } else if (e.type === "toolcall_end" && e.toolCall) {
          scheduleRender(toolItem(e.toolCall.id, e.toolCall.name, e.toolCall.arguments).id);
        }
        break;
      }
      case "message_end": {
        const m = ev.message || {};
        if (m.role !== "assistant" || !S.curMsg) break;
        if (m.usage && typeof m.usage.output === "number") S.runTokens += m.usage.output;
        S.msgTokens = 0;
        (m.content || []).forEach((b, ci) => {
          if (b.type === "text" || b.type === "thinking") {
            const body = b.type === "text" ? b.text : b.thinking;
            const id = S.curMsg.blocks.get(ci);
            if (!body || !body.trim()) {
              if (id) removeItem(id);
              return;
            }
            const it = id ? S.byId.get(id) : blockItem(ci, b.type);
            it.text = body;
            it.streaming = false;
            scheduleRender(it.id);
          } else if (b.type === "toolCall") scheduleRender(toolItem(b.id, b.name, b.arguments).id);
        });
        if (m.stopReason === "error" && m.errorMessage) addItem({ id: nextId("n"), kind: "notice", level: "error", text: m.errorMessage, short: SHORT_MODEL_ERROR });
        if (m.stopReason === "aborted") addItem({ id: nextId("n"), kind: "notice", level: "info", text: "Interrupted by user" });
        S.curMsg = null;
        break;
      }
      case "tool_execution_start": {
        const it = toolItem(ev.toolCallId, ev.toolName, ev.args);
        it.status = "running";
        it.executing = true;
        S.activity = toolInfo(ev.toolName, ev.args).verb;
        scheduleRender(it.id);
        break;
      }
      case "tool_execution_update": {
        const it = toolItem(ev.toolCallId, ev.toolName, ev.args);
        it.partial = resultText(ev.partialResult);
        scheduleRender(it.id);
        break;
      }
      case "tool_execution_end": {
        const it = toolItem(ev.toolCallId, ev.toolName);
        it.status = ev.isError ? "error" : "done";
        it.executing = false;
        it.result = ev.result;
        if (it.ask) it.ask.done = true;
        if (it.feedback) it.feedback.done = true;
        if (it.explain) it.explain.done = true;
        setLive(it, false);
        scheduleRender(it.id);
        S.activity = "";
        updateStatusline();
        break;
      }
      case "queue_update":
        S.queue = [...(ev.steering || []), ...(ev.followUp || [])];
        renderQueueStrip();
        break;
      case "auto_retry_start":
        addItem({ id: nextId("n"), kind: "notice", level: "warning", internal: true, text: `Retrying (${ev.attempt || ""}${ev.maxAttempts ? `/${ev.maxAttempts}` : ""})${ev.errorMessage ? `: ${first(ev.errorMessage, 120)}` : ""}` });
        break;
      case "compaction_start":
        addItem({ id: nextId("n"), kind: "notice", level: "info", internal: true, text: "Compacting the conversation…" });
        break;
      case "extension_error":
        addItem({ id: nextId("n"), kind: "notice", level: "error", internal: true, text: `Extension error (${base(ev.extensionPath)}): ${first(ev.error, 200)}` });
        break;
      default:
        break;
    }
  }

  // Rebuild the transcript from a session's messages (startup / switch / reload).
  function loadHistory(messages, streaming) {
    // Questions/dialogs still waiting survive the rebuild (the host also
    // re-sends them; onAsk/onDialog ignore duplicates).
    const carry = [];
    for (const id of S.live) {
      const it = S.byId.get(id);
      if (!it || !isLive(it)) continue;
      if (it.kind === "dialog") carry.push(() => onDialog(it.request));
      else {
        if (it.ask && !it.ask.done) carry.push(() => onAsk(it.ask));
        if (it.explain && !it.explain.done) carry.push(() => onAsk(it.explain));
        if (it.feedback && !it.feedback.done) carry.push(() => onAsk(it.feedback));
      }
    }
    clearTranscript();
    const tools = new Map();
    for (const m of messages) {
      if (m.role === "user") {
        const t = textOf(m.content).trim();
        if (t) addItem({ id: nextId("u"), kind: "user", text: t });
      } else if (m.role === "assistant") {
        const key = nextId("m");
        (m.content || []).forEach((b, ci) => {
          if (b.type === "text" && b.text && b.text.trim()) addItem({ id: `${key}:${ci}`, kind: "text", text: b.text });
          else if (b.type === "thinking" && b.thinking && b.thinking.trim()) addItem({ id: `${key}:${ci}`, kind: "thinking", text: b.thinking });
          else if (b.type === "toolCall") tools.set(b.id, addItem({ id: b.id, callId: b.id, kind: "tool", name: b.name, args: b.arguments || {}, status: "running", fromHistory: true }));
        });
        if (m.stopReason === "error" && m.errorMessage) addItem({ id: nextId("n"), kind: "notice", level: "error", text: m.errorMessage, short: SHORT_MODEL_ERROR });
      } else if (m.role === "toolResult") {
        const it = tools.get(m.toolCallId);
        if (it) {
          it.status = m.isError ? "error" : "done";
          it.result = { content: m.content, details: m.details };
          renderItem(it);
        }
      } else if (m.role === "custom" && m.display) {
        addItem({ id: nextId("n"), kind: "notice", level: "info", text: textOf(m.content) });
      }
    }
    // Result-less tools: still running if pi is mid-turn (their ask is re-sent
    // right after this), otherwise they were cut off by an interrupted session.
    for (const it of tools.values()) {
      if (it.status !== "running") continue;
      if (streaming) it.executing = true;
      else {
        it.status = "error";
        it.result = { content: [{ type: "text", text: "Interrupted" }] };
      }
      renderItem(it);
    }
    setRunning(Boolean(streaming));
    for (const reapply of carry) reapply();
    maybeShowEmpty();
    updateStatusline();
    scrollToBottom(true);
  }

  // ── bridge asks ────────────────────────────────────────────────────────
  const DEADLINES = new Map();
  const ASK_TOOL = { quiz: "quiz", typed: "quiz_typed", question: "ask_user_question", explain: "explain_back", code: "assign_exercise" };
  function findAskTarget(ask, toolName) {
    // Exact: the tool call this question belongs to.
    if (ask.toolCallId && S.byId.has(ask.toolCallId)) return S.byId.get(ask.toolCallId);
    // Fallback (older TutorBot): the earliest executing card of that tool with
    // no ask — preferring one whose question text matches exactly.
    const open = S.items.filter((i) => i.kind === "tool" && i.name === toolName && i.status === "running" && i.executing && !i.ask);
    return open.find((i) => ask.question && i.args.question === ask.question) || open[0];
  }

  function onAsk(raw) {
    const ask = { ...raw, focus: 0, done: false };
    // A typed answer that missed comes back for another try: keep the
    // learner's answer to edit and the hints they already opened.
    if (ask.retry) Object.assign(ask, { draft: ask.retry.previous || "", hintsShown: ask.retry.hintsShown || 0 });
    // Explain-it-back: either the second step of a quiz/typed card, or the
    // standalone explain_back tool. Either way it lives in item.explain.
    if (ask.kind === "explain_back" || ask.kind === "explain") {
      let it = ask.toolCallId && S.byId.get(ask.toolCallId);
      if (!it && ask.kind === "explain") it = findAskTarget(ask, "explain_back");
      if (!it && ask.kind === "explain") {
        it = addItem({ id: `ask-${ask.id}`, kind: "tool", name: "explain_back", orphan: true, args: { prompt: ask.prompt, details: ask.context }, status: "running" });
        if (ask.toolCallId) S.byId.set(ask.toolCallId, it);
      }
      if (!it || (it.explain && it.explain.id === ask.id)) return;
      it.explain = ask;
      setLive(it, true);
      renderItem(it);
      updateStatusline();
      scrollToBottom(true);
      focusLive();
      return;
    }
    if (ask.kind === "typed_feedback") {
      const it = findAskTarget(ask, "quiz_typed") || [...S.items].reverse().find((i) => i.kind === "tool" && i.name === "quiz_typed" && i.status === "running");
      if (!it || (it.feedback && it.feedback.id === ask.id)) return;
      it.feedback = ask;
      setLive(it, true);
      renderItem(it);
      updateStatusline();
      focusLive();
      return;
    }
    const tool = ASK_TOOL[ask.kind];
    let it = findAskTarget(ask, tool);
    if (it && it.ask && it.ask.id === ask.id) return; // re-sent after a reload; already shown
    if (!it) {
      it = addItem({ id: `ask-${ask.id}`, kind: "tool", name: tool, orphan: true, args: { question: ask.question, details: ask.context, purpose: ask.purpose, multiSelect: ask.multiSelect }, status: "running" });
      if (ask.toolCallId) S.byId.set(ask.toolCallId, it);
    }
    it.ask = ask;
    setLive(it, true);
    renderItem(it);
    updateStatusline();
    scrollToBottom(true);
    focusLive();
  }

  function onAskDone(id) {
    for (const it of S.items) {
      if (it.kind !== "tool") continue;
      let hit = false;
      if (it.ask && it.ask.id === id) hit = it.ask.done = true;
      if (it.feedback && it.feedback.id === id) hit = it.feedback.done = true;
      if (it.explain && it.explain.id === id) hit = it.explain.done = true;
      if (hit) {
        if (!isLive(it)) S.live.delete(it.id);
        renderItem(it);
      }
    }
    updateStatusline();
  }

  function onDialog(req) {
    const id = `d-${req.id}`;
    if (S.byId.has(id)) return;
    const item = addItem({ id, kind: "dialog", request: req, focus: 0 });
    setLive(item, true);
    // pi auto-resolves a dialog when its timeout passes; mirror that, keeping
    // the original deadline when the card is re-created after a reload.
    if (req.timeout) {
      if (!DEADLINES.has(req.id)) DEADLINES.set(req.id, Date.now() + req.timeout);
      const left = DEADLINES.get(req.id) - Date.now();
      item.timer = setTimeout(() => answerDialog(item, { cancelled: true }, "timed out"), Math.max(0, left));
    }
    scrollToBottom(true);
    updateStatusline();
    focusLive();
  }

  // ── layout ─────────────────────────────────────────────────────────────
  function shell() {
    $("#app").innerHTML = `
      <div class="header">
        <div class="brand"><span class="logo">${ICON.cap}</span><span>TutorBot</span></div>
        <div class="spacer"></div>
        <button class="icon-btn" data-act="dashboard" title="Progress: what you know, what's fading, what's left before exams" aria-label="Progress">${ICON.chart}</button>
        <button class="icon-btn" data-act="home" title="Home — switch subject, new subject, or just chat" aria-label="Home">${ICON.home}</button>
      </div>
      <div class="convos" hidden role="region" aria-label="Conversations"></div>
      <div class="exercise" hidden></div>
      <div class="transcript" role="log" aria-live="polite"><div class="feed"></div></div>
      <div class="statusline"></div>
      <div class="composer">
        <div class="slash" hidden role="listbox"></div>
        <div class="widgets" hidden></div>
        <div class="queue" hidden></div>
        <div class="box">
          <textarea rows="1" placeholder="Ask TutorBot…  (/ for commands)" aria-label="Message TutorBot"></textarea>
          <div class="bar">
            <button class="chip" data-act="subject" title="Switch subject (/home)">${ICON.book}<span class="subj">No subject</span></button>
            <button class="chip" data-act="folder" title="Class folder for this subject: TutorBot learns your teacher's question style from it" hidden>${ICON.folder}<span class="fld">Add class folder</span></button>
            <button class="chip" data-act="model" title="Change model"><span class="mdl"></span><span class="caret">▾</span></button>
            <div class="spacer"></div>
            <button class="send" data-act="send" title="Send (Enter)" aria-label="Send" disabled>${ICON.send}</button>
          </div>
        </div>
        <div class="footer"><span class="status"></span></div>
      </div>`;
    const t = scroller();
    // Stick to the bottom only while the learner hasn't scrolled up.
    t.addEventListener("scroll", () => {
      S.stuck = nearBottom();
    });
    // Async growth (KaTeX fonts, expanding details, code blocks) keeps us pinned.
    new ResizeObserver(() => {
      if (S.stuck) pin();
    }).observe(feed());
    maybeShowEmpty();
  }

  function maybeShowEmpty() {
    const f = feed();
    if (!f) return;
    if (S.items.length) return hideEmpty();
    const conn = S.connection === "starting" ? `<p class="starting">${SPIN}Starting TutorBot…</p>` : "";
    const html = `<div class="empty"><div class="big">${ICON.cap}</div><h2>TutorBot</h2><div>Learn anything, one solid idea at a time.</div>
      <ul><li><kbd>/home</kbd> pick a subject, add one, or just chat</li><li>Math is typeset — ask about any formula</li><li>Coding exercises open in the editor and test as you type</li><li><kbd>${MOD}+Esc</kbd> jumps here from the editor</li></ul>${conn}</div>`;
    const existing = f.querySelector(".empty");
    if (existing) existing.outerHTML = html;
    else f.insertAdjacentHTML("afterbegin", html);
    emptyShown = true;
  }
  function hideEmpty() {
    if (!emptyShown) return;
    emptyShown = false;
    feed().querySelector(".empty")?.remove();
  }

  function renderExercise() {
    const el = $(".exercise");
    const ex = S.exercise;
    if (!ex) {
      el.hidden = true;
      return;
    }
    el.hidden = false;
    const s = ex.status;
    let score = "not run yet";
    let cls = "";
    if (s && s.running) score = "testing…";
    else if (s && s.compileError) [score, cls] = ["doesn't compile", "fail"];
    else if (s) [score, cls] = [`${s.passed}/${s.total} tests`, s.passed === s.total ? "pass" : "fail"];
    const open = el.querySelector("details")?.open || false;
    el.innerHTML =
      `<div class="ex-top"><span class="ex-title" title="${esc(ex.title)}">${esc(ex.title)}</span><span class="ex-score ${cls}">${esc(score)}</span></div>` +
      (s && (s.results?.length || s.compileError)
        ? `<details${open ? " open" : ""}><summary>Details</summary>${s.compileError ? `<div class="compile">${esc(s.compileError)}</div>` : ""}<ul class="tests">${(s.results || [])
            .map((r) => `<li><span class="${r.pass ? "ok" : "no"}">${r.pass ? "✓" : "✗"}</span><span>${esc(r.name)}${!r.pass && r.detail ? `<div class="detail">${esc(r.detail)}</div>` : ""}</span></li>`)
            .join("")}</ul></details>`
        : "") +
      `<div class="ex-actions"><button class="btn small secondary" data-act="ex-open">Open file</button><button class="btn small secondary" data-act="ex-hint">Hint</button><button class="btn small" data-act="ex-submit">Submit</button></div>`;
  }

  function renderFooter() {
    $(".subj").textContent = S.subject || "No subject";
    const fchip = $('[data-act="folder"]');
    if (fchip) {
      fchip.hidden = !S.subject;
      $(".fld").textContent = S.folders.length ? S.folders.map((f) => f.name).join(", ") : "Add class folder";
      fchip.classList.toggle("empty-folder", !S.folders.length);
    }
    $(".mdl").textContent = String(S.model || "auto").replace(/^freellmapi\//, "");
    const st = Object.entries(S.statuses)
      .filter(([k]) => k !== "tutorbot-home")
      .map(([, v]) => v);
    $(".footer .status").textContent = st.join(" · ");
    $(".footer").hidden = !st.length;
    const wl = Object.entries(S.widgets)
      .filter(([k]) => k !== "tutorbot-exercise")
      .flatMap(([, v]) => v);
    const w = $(".widgets");
    w.hidden = !wl.length;
    w.textContent = wl.join("\n");
  }

  function renderQueueStrip() {
    const q = $(".queue");
    q.hidden = !S.queue.length;
    q.innerHTML = S.queue.length ? `<span class="q-label">Queued</span> ${S.queue.map((x) => `<span class="q-item">${esc(first(x, 60))}</span>`).join("")}<span class="q-hint">Stop to edit</span>` : "";
  }

  // ── conversations (browse, open, rename) ───────────────────────────────
  function fmtDate(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    const now = new Date();
    if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    return d.toLocaleDateString([], { month: "short", day: "numeric", ...(d.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}) });
  }

  function openConvos() {
    Object.assign(S.convos, { open: true, error: "", editing: null });
    $("#app").classList.add("convos-open");
    $(".convos").hidden = false;
    paintConvos();
    vscode.postMessage({ type: "sessions" });
  }
  function closeConvos() {
    Object.assign(S.convos, { open: false, editing: null });
    $("#app").classList.remove("convos-open");
    $(".convos").hidden = true;
    input().focus();
  }
  function openConversation(file) {
    const c = S.convos.data && S.convos.data.sessions.find((x) => x.path === file);
    if (c && !c.current) vscode.postMessage({ type: "openSession", path: file });
    closeConvos();
  }

  const renameField = (value, label) => `<input type="text" class="rename-input" value="${esc(value)}" aria-label="${esc(label)}" maxlength="120" spellcheck="false">`;

  function convRow(c) {
    const ed = S.convos.editing;
    if (ed && ed.kind === "session" && ed.key === c.path) return `<li class="conv editing">${renameField(c.title, "Rename conversation")}</li>`;
    return (
      `<li class="conv${c.current ? " current" : ""}" data-path="${esc(c.path)}" tabindex="0" role="button" title="${esc(c.title)}">` +
      `<span class="c-title">${esc(c.title)}</span><span class="c-meta">${c.current ? "Open" : esc(fmtDate(c.modified))}</span>` +
      `<button class="icon-btn small" data-act="rename-session" title="Rename conversation" aria-label="Rename conversation">${ICON.pencil}</button>` +
      `<button class="icon-btn small" data-act="delete-session" title="Delete conversation" aria-label="Delete conversation">${ICON.trash}</button></li>`
    );
  }

  function convGroup(name, list, renamable) {
    const ed = S.convos.editing;
    const head =
      renamable && ed && ed.kind === "subject" && ed.key === name
        ? renameField(name, `Rename subject ${name}`)
        : `<span class="grp-name">${esc(name)}</span>${S.convos.data.activeSubject === name ? '<span class="tag">Current</span>' : ""}` +
          (renamable ? `<button class="icon-btn small" data-act="rename-subject" data-subject="${esc(name)}" title="Rename subject" aria-label="Rename subject ${esc(name)}">${ICON.pencil}</button>` : "");
    const rows = list.length ? list.map(convRow).join("") : '<li class="conv-empty">No conversations yet</li>';
    return `<section class="grp"><div class="grp-head">${head}</div><ul class="conv-list">${rows}</ul></section>`;
  }

  function paintConvos() {
    const { data, loadError, error } = S.convos;
    let body;
    if (!data) body = `<div class="convos-note">${loadError ? esc(loadError) : `${SPIN}Loading…`}</div>`;
    else {
      // Subjects in registry order (most recent first), then untagged chats.
      const groups = new Map(data.subjects.map((x) => [x.name, []]));
      const loose = [];
      for (const c of data.sessions) {
        if (!c.subject) loose.push(c);
        else if (groups.has(c.subject)) groups.get(c.subject).push(c);
        else groups.set(c.subject, [c]);
      }
      body = [...groups].map(([name, list]) => convGroup(name, list, true)).join("") + (loose.length ? convGroup("No subject", loose, false) : "");
      if (!body) body = '<div class="convos-note">No conversations yet.</div>';
    }
    const el = $(".convos");
    el.innerHTML =
      `<div class="convos-head"><span class="convos-title">Conversations</span><div class="spacer"></div>` +
      `<button class="icon-btn" data-act="convos-close" title="Back to chat (Esc)" aria-label="Back to chat">${ICON.close}</button></div>` +
      (error ? `<div class="convos-error">${esc(error)}</div>` : "") +
      `<div class="convos-body">${body}</div>`;
    const field = el.querySelector(".rename-input");
    if (field) {
      field.focus();
      field.select();
    }
  }

  function startRename(kind, key, original) {
    Object.assign(S.convos, { editing: { kind, key, original }, error: "" });
    paintConvos();
  }
  function cancelRename() {
    S.convos.editing = null;
    paintConvos();
  }
  // Optimistic: show the new name now; the host re-sends the list afterwards.
  function commitRename(value) {
    const ed = S.convos.editing;
    if (!ed) return;
    S.convos.editing = null;
    const v = String(value || "").trim();
    const d = S.convos.data;
    if (v && v !== ed.original && d) {
      if (ed.kind === "subject") {
        vscode.postMessage({ type: "renameSubject", from: ed.key, to: v });
        for (const x of d.subjects) if (x.name === ed.key) x.name = v;
        for (const c of d.sessions) if (c.subject === ed.key) c.subject = v;
        if (d.activeSubject === ed.key) d.activeSubject = v;
      } else {
        vscode.postMessage({ type: "renameSession", path: ed.key, name: v });
        for (const c of d.sessions) if (c.path === ed.key) Object.assign(c, { title: v, named: true });
      }
    }
    paintConvos();
  }

  // ── running state + spinner ────────────────────────────────────────────
  let spinTimer;
  function setRunning(on) {
    if (on === S.running) return;
    S.running = on;
    if (on) {
      S.runStart = Date.now();
      S.runTokens = 0;
      S.msgTokens = 0;
      S.verb = VERBS[Math.floor(Math.random() * VERBS.length)];
      S.activity = "";
      clearInterval(spinTimer);
      spinTimer = setInterval(updateStatusline, 250);
    } else {
      clearInterval(spinTimer);
      for (const it of S.items)
        if ((it.kind === "text" || it.kind === "thinking") && it.streaming) {
          it.streaming = false;
          renderItem(it);
        }
    }
    updateSendButton();
    updateStatusline();
  }

  const fmtTokens = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
  function updateStatusline() {
    const el = $(".statusline");
    const waiting = liveItem();
    if (waiting) {
      const composerBusy = document.activeElement === input() && input().value.trim();
      el.innerHTML = `<span class="glyph wait">❯</span><span class="meta">Waiting for your answer${composerBusy ? ` · ${IS_MAC ? "⌥" : "Alt"}↓ to answer` : ""}</span>`;
      el.classList.add("on");
      return;
    }
    if (!S.running) {
      el.innerHTML = "";
      el.classList.remove("on");
      return;
    }
    const secs = Math.floor((Date.now() - S.runStart) / 1000);
    const tokens = S.runTokens + S.msgTokens;
    const verb = (!S.hideWorking && S.activity) || S.verb;
    // Update text in place so the CSS spinner keeps animating smoothly.
    if (!el.querySelector(".spinner")) el.innerHTML = `${SPIN}<span class="verb"></span><span class="meta"></span>`;
    el.querySelector(".verb").textContent = `${verb}…`;
    el.querySelector(".meta").textContent = `(${secs}s${tokens ? ` · ↓ ${fmtTokens(tokens)} tokens` : ""} · esc to interrupt)`;
    el.classList.add("on");
  }

  // ── composer ───────────────────────────────────────────────────────────
  const input = () => $(".box textarea");
  function autosize() {
    const t = input();
    t.style.height = "auto";
    t.style.height = `${Math.min(t.scrollHeight, window.innerHeight * 0.4)}px`;
  }
  // Send arrow when there's text; stop square only when running with an empty box.
  function updateSendButton() {
    const btn = $(".send");
    const hasText = Boolean(input().value.trim());
    const stop = S.running && !hasText;
    btn.classList.toggle("stop", stop);
    btn.innerHTML = stop ? ICON.stop : ICON.send;
    btn.title = stop ? "Stop (Esc)" : S.running ? "Queue message (Enter)" : "Send (Enter)";
    btn.setAttribute("aria-label", stop ? "Stop" : "Send");
    btn.disabled = !stop && !hasText;
  }

  function send() {
    const t = input();
    const text = t.value.trim();
    if (!text) return;
    S.history.push(text);
    S.histPos = -1;
    S.histDraft = "";
    t.value = "";
    autosize();
    closeSlash();
    updateSendButton();
    const clean = text.match(/^\/cleanmode(?:\s+(on|off))?$/i);
    if (clean) {
      addItem({ id: nextId("c"), kind: "command", text });
      vscode.postMessage({ type: "toggleWorking", value: clean[1] ? clean[1].toLowerCase() === "on" : undefined });
      return scrollToBottom(true);
    }
    // Slash commands don't become user messages; echo them like Claude Code.
    if (text.startsWith("/") && isExtCommand(text)) addItem({ id: nextId("c"), kind: "command", text });
    S.stuck = true;
    vscode.postMessage({ type: "send", text });
  }

  // Skills/templates expand into a real user message, so only extension
  // commands (which don't) get the "❯ /cmd" echo.
  function isExtCommand(text) {
    const name = text.slice(1).split(/\s/)[0];
    const c = S.commands.find((x) => x.name === name);
    if (c) return c.source === "extension";
    // Commands not loaded yet: echo only TutorBot's own.
    return !S.commands.length && ["home", "subject", "review", "submit", "hint", "exercise", "tutor", "tutor-resources", "tutor-index", "tutor-reflect", "board"].includes(name);
  }

  function interrupt() {
    vscode.postMessage({ type: "abort" });
    expireLive("interrupted");
  }

  function updateSlash() {
    const v = input().value;
    const m = v.match(/^\/(\S*)$/);
    if (!m) return closeSlash();
    const q = m[1].toLowerCase();
    const list = [...LOCAL_COMMANDS, ...S.commands]
      .filter((c) => c.name.toLowerCase().includes(q))
      .sort((a, b) => (a.name.toLowerCase().startsWith(q) ? 0 : 1) - (b.name.toLowerCase().startsWith(q) ? 0 : 1))
      .slice(0, 50);
    if (!list.length) return closeSlash();
    S.slash = { open: true, list, idx: Math.min(S.slash.idx, list.length - 1) };
    paintSlash();
  }
  function paintSlash() {
    const el = $(".slash");
    el.hidden = false;
    el.innerHTML = S.slash.list
      .map((c, i) => `<div class="cmd${i === S.slash.idx ? " active" : ""}" role="option" aria-selected="${i === S.slash.idx}" data-cmd="${esc(c.name)}" data-i="${i}"><span class="n">/${esc(c.name)}</span><span class="d">${esc(c.description)}</span></div>`)
      .join("");
    el.querySelector(".active")?.scrollIntoView({ block: "nearest" });
  }
  function closeSlash() {
    S.slash.open = false;
    S.slash.idx = 0;
    const el = $(".slash");
    if (el) el.hidden = true;
  }
  function completeSlash(name, run) {
    input().value = `/${name}${run ? "" : " "}`;
    closeSlash();
    autosize();
    updateSendButton();
    if (run) send();
    else input().focus();
  }

  // ↑/↓ walk sent messages when the caret is on the first/last line.
  function historyNav(dir) {
    const t = input();
    const before = t.value.slice(0, t.selectionStart);
    const after = t.value.slice(t.selectionEnd);
    if (dir < 0 && before.includes("\n")) return false;
    if (dir > 0 && after.includes("\n")) return false;
    if (!S.history.length) return false;
    if (dir < 0) {
      if (S.histPos < 0) {
        S.histDraft = t.value;
        S.histPos = S.history.length - 1;
      } else if (S.histPos > 0) S.histPos--;
      else return true;
      t.value = S.history[S.histPos];
    } else {
      if (S.histPos < 0) return false;
      if (S.histPos < S.history.length - 1) {
        S.histPos++;
        t.value = S.history[S.histPos];
      } else {
        S.histPos = -1;
        t.value = S.histDraft;
      }
    }
    autosize();
    updateSendButton();
    t.setSelectionRange(t.value.length, t.value.length);
    return true;
  }

  // ── option handling shared by mouse and keyboard ───────────────────────
  function holderOf(item) {
    return item.kind === "dialog" ? item : item.ask;
  }
  function moveFocus(item, pos) {
    const holder = holderOf(item);
    if (!holder || holder.focus === pos) return;
    holder.focus = pos;
    const node = S.nodes.get(item.id);
    // Cheap: move the ❯ without re-rendering (keeps math/DOM intact).
    node?.querySelectorAll(".opt").forEach((li) => li.classList.toggle("focused", Number(li.dataset.pos) === pos && !li.classList.contains("locked")));
  }

  function activateOption(item, li) {
    if (!li || li.classList.contains("locked")) return;
    if (item.kind === "dialog") {
      const i = Number(li.dataset.dopt);
      return answerDialog(item, { value: item.request.options[i] }, item.request.options[i]);
    }
    const ask = item.ask;
    if (!ask || ask.done) return;
    ask.focus = Number(li.dataset.pos);
    if (li.dataset.dontknow !== undefined) return finishQuiz(item, { dontKnow: true, indices: [] });
    if (li.dataset.opt !== undefined) {
      const idx = Number(li.dataset.opt);
      if (ask.multiSelect) return toggleCheck(item, idx);
      ask.checked = [idx];
      return finishQuiz(item, { dontKnow: false, indices: [idx] });
    }
    if (li.dataset.qopt !== undefined) {
      const idx = Number(li.dataset.qopt);
      if (ask.mode === "multi-select") return toggleCheck(item, idx);
      sendAnswer(ask, { indices: [idx] });
      return afterAnswer(item);
    }
    if (li.dataset.qother !== undefined) {
      ask.otherOpen = true;
      renderItem(item);
      S.nodes.get(item.id).querySelector("[data-qothertext]")?.focus();
    }
  }

  function toggleCheck(item, idx) {
    const ask = item.ask;
    const set = new Set(ask.checked || []);
    set.has(idx) ? set.delete(idx) : set.add(idx);
    ask.checked = [...set];
    renderItem(item);
    S.nodes.get(item.id)?.querySelector(".card")?.focus({ preventScroll: true });
  }

  function noteOf(item) {
    const n = S.nodes.get(item.id)?.querySelector("[data-note]");
    return n ? n.value.trim() : (item.ask.note || "").trim();
  }
  // Choosing an answer first asks how sure the learner is (Guess / Fairly sure
  // / Certain); "I don't know" is sent straight away (nothing to rate).
  function finishQuiz(item, value) {
    const ask = item.ask;
    if (ask.multiSelect && !value.dontKnow) value.indices = ask.checked || [];
    value.note = noteOf(item) || undefined;
    value.hintsUsed = ask.hintsShown || 0;
    if (value.dontKnow) {
      sendAnswer(ask, value);
      return afterAnswer(item);
    }
    ask.pending = value;
    ask.stage = "confidence";
    renderItem(item);
    S.nodes.get(item.id)?.querySelector(".card")?.focus({ preventScroll: true });
    updateStatusline();
  }
  function confirmConfidence(item, level) {
    const ask = item.ask;
    if (!ask || ask.done || ask.stage !== "confidence") return;
    const value = { ...(ask.pending || {}), confidence: level || undefined, hintsUsed: ask.hintsShown || 0 };
    ask.stage = undefined;
    sendAnswer(ask, value);
    afterAnswer(item);
  }
  function backToAnswer(item) {
    const ask = item.ask;
    if (!ask || ask.done) return;
    ask.stage = undefined;
    ask.pending = undefined;
    renderItem(item);
    const ta = S.nodes.get(item.id)?.querySelector("[data-typed]");
    (ta || S.nodes.get(item.id)?.querySelector(".card"))?.focus({ preventScroll: true });
  }
  function revealHint(item) {
    const ask = item.ask;
    if (!ask || ask.done || ask.checkpoint || (ask.hintsShown || 0) >= (ask.hints || []).length) return;
    ask.hintsShown = (ask.hintsShown || 0) + 1;
    renderItem(item);
  }
  function submitExplain(item, opts = {}) {
    const ex = item.explain;
    if (!ex || ex.done) return;
    if (opts.direct) {
      sendAnswer(ex, { wantsDirect: true });
      return afterAnswer(item);
    }
    const ta = S.nodes.get(item.id)?.querySelector("[data-explain]");
    const text = (ta ? ta.value : ex.draft || "").trim();
    if (!text) return ta?.focus();
    ex.draft = text;
    sendAnswer(ex, { text });
    afterAnswer(item);
  }
  function submitQuiz(item) {
    if (!(item.ask.checked || []).length) return;
    finishQuiz(item, { dontKnow: false });
  }
  function submitTyped(item, dontKnow) {
    const ask = item.ask;
    const ta = S.nodes.get(item.id)?.querySelector("[data-typed]");
    ask.draft = ta ? ta.value : ask.draft || "";
    if (dontKnow) {
      sendAnswer(ask, { dontKnow: true, hintsUsed: ask.hintsShown || 0 });
      return afterAnswer(item);
    }
    if (!ask.draft.trim()) return ta?.focus();
    // Retries skip the confidence question: it was asked on the first try.
    if (ask.retry) {
      sendAnswer(ask, { answer: ask.draft, hintsUsed: ask.hintsShown || 0 });
      return afterAnswer(item);
    }
    ask.pending = { answer: ask.draft };
    ask.stage = "confidence";
    renderItem(item);
    S.nodes.get(item.id)?.querySelector(".card")?.focus({ preventScroll: true });
    updateStatusline();
  }
  function submitQuestion(item) {
    const ask = item.ask;
    const node = S.nodes.get(item.id);
    if (ask.mode === "text") {
      const v = node.querySelector("[data-qtext]").value.trim();
      if (!v) return;
      sendAnswer(ask, { text: v });
    } else {
      const other = node.querySelector("[data-qothertext]")?.value.trim() || "";
      const indices = ask.checked || [];
      if (!indices.length && !other) return;
      sendAnswer(ask, { indices, other: other || undefined });
    }
    afterAnswer(item);
  }
  function feedbackChoice(item, disputed) {
    if (!item.feedback || item.feedback.done) return;
    sendAnswer(item.feedback, { disputed });
    afterAnswer(item);
  }

  // ── events: clicks ─────────────────────────────────────────────────────
  document.addEventListener("click", (e) => {
    const t = e.target;
    const copy = t.closest("[data-copy]");
    if (copy) {
      const code = copy.closest(".codeblock")?.querySelector("code")?.innerText || "";
      navigator.clipboard?.writeText(code);
      copy.textContent = "Copied";
      setTimeout(() => (copy.textContent = "Copy"), 1200);
      return;
    }
    const link = t.closest("a[href]");
    if (link) {
      e.preventDefault();
      vscode.postMessage({ type: "openLink", href: link.getAttribute("href") });
      return;
    }
    const cmd = t.closest("[data-cmd]");
    if (cmd) return completeSlash(cmd.dataset.cmd, true);
    const conv = !t.closest("[data-act]") && t.closest(".conv[data-path]");
    if (conv) return openConversation(conv.dataset.path);

    const itemNode = t.closest(".item");
    const item = itemNode && S.byId.get(itemNode.dataset.id);
    const act = t.closest("[data-act]")?.dataset.act;

    if (act) {
      switch (act) {
        case "convos":
          return S.convos.open ? closeConvos() : openConvos();
        case "convos-close":
          return closeConvos();
        case "rename-subject":
          return startRename("subject", t.closest("[data-subject]").dataset.subject, t.closest("[data-subject]").dataset.subject);
        case "rename-session": {
          const row = t.closest(".conv");
          const c = S.convos.data && S.convos.data.sessions.find((x) => x.path === row.dataset.path);
          return c && startRename("session", c.path, c.title);
        }
        case "delete-session": {
          const row = t.closest(".conv");
          return row && vscode.postMessage({ type: "deleteSession", path: row.dataset.path });
        }
        case "connect-key":
          return vscode.postMessage({ type: "connectKey" });
        case "dashboard":
          return vscode.postMessage({ type: "dashboard" });
        case "home":
        case "subject":
          if (S.convos.open) closeConvos();
          addItem({ id: nextId("c"), kind: "command", text: "/home" });
          S.stuck = true;
          return vscode.postMessage({ type: "home" });
        case "new":
          if (S.convos.open) closeConvos();
          return vscode.postMessage({ type: "newChat" });
        case "model":
          return vscode.postMessage({ type: "chooseModel" });
        case "send":
          if (S.running && !input().value.trim()) return interrupt();
          return send();
        case "restart":
          return vscode.postMessage({ type: "restart" });
        case "log":
          return vscode.postMessage({ type: "showLog" });
        case "ex-open":
          return vscode.postMessage({ type: "exercise", action: "open" });
        case "ex-hint":
          return vscode.postMessage({ type: "exercise", action: "hint" });
        case "ex-submit":
          return vscode.postMessage({ type: "exercise", action: "submit" });
        case "folder":
          return vscode.postMessage({ type: "pickFolder" });
      }
      if (!item) return;
      if (item.kind === "tool" && item.ask) {
        if (act === "hint") return revealHint(item);
        if (act === "code-check") return codeAction(item, "check");
        if (act === "code-help") return codeAction(item, "help");
        if (act === "code-giveup") return codeAction(item, "giveUp");
        if (act === "conf") return confirmConfidence(item, Number(t.closest("[data-level]").dataset.level));
        if (act === "conf-skip") return confirmConfidence(item, undefined);
        if (act === "conf-back") return backToAnswer(item);
      }
      if (item.kind === "tool" && item.explain) {
        if (act === "eb-submit") return submitExplain(item);
        if (act === "eb-direct") return submitExplain(item, { direct: true });
        if (act === "eb-skip") return skipAsk(item);
      }
      if (act === "rate" && item.kind === "tool" && !item.rated) {
        item.rated = t.closest("[data-rating]").dataset.rating;
        const concepts = ((item.args && item.args.concepts) || []).map((c) => (typeof c === "string" ? c : c.name)).filter(Boolean);
        vscode.postMessage({ type: "lessonFeedback", rating: item.rated, concepts });
        return renderItem(item);
      }
      if (item.kind === "tool" && item.ask) {
        if (act === "note") {
          item.ask.noteOpen = true;
          renderItem(item);
          S.nodes.get(item.id).querySelector("[data-note]")?.focus();
          return;
        }
        if (act === "quiz-submit") return submitQuiz(item);
        if (act === "typed-submit") return submitTyped(item, false);
        if (act === "typed-dontknow") return submitTyped(item, true);
        if (act === "typed-reveal") {
          sendAnswer(item.ask, { reveal: true, hintsUsed: item.ask.hintsShown || 0 });
          return afterAnswer(item);
        }
        if (act === "q-send") return submitQuestion(item);
      }
      if (item.kind === "tool" && (act === "fb-continue" || act === "fb-dispute")) return feedbackChoice(item, act === "fb-dispute");
      if (item.kind === "dialog") {
        if (act === "d-yes") return answerDialog(item, { confirmed: true }, "Yes");
        if (act === "d-no") return answerDialog(item, { confirmed: false }, "No");
        if (act === "d-cancel") return answerDialog(item, { cancelled: true }, "cancelled");
        if (act === "d-ok") {
          const v = S.nodes.get(item.id).querySelector("[data-dinput]").value;
          return answerDialog(item, { value: v }, item.request.method === "editor" ? first(v, 60) : v || "(empty)");
        }
      }
      return;
    }
    if (!item) return;
    if (item.kind === "tool" && !CARD_TOOLS.has(item.name) && t.closest("[data-toggle]")) {
      item.expanded = !item.expanded;
      return renderItem(item);
    }
    const li = t.closest(".opt");
    if (li) activateOption(item, li);
  });

  // The ❯ follows the mouse, like a picker.
  document.addEventListener("mouseover", (e) => {
    const li = e.target.closest(".opt");
    if (li && !li.classList.contains("locked")) {
      const node = li.closest(".item");
      const item = node && S.byId.get(node.dataset.id);
      if (item && isLive(item)) moveFocus(item, Number(li.dataset.pos));
    }
    const cmd = e.target.closest(".slash .cmd");
    if (cmd && S.slash.open) {
      const i = Number(cmd.dataset.i);
      if (i !== S.slash.idx) {
        S.slash.idx = i;
        $(".slash").querySelectorAll(".cmd").forEach((c, j) => c.classList.toggle("active", j === i));
      }
    }
  });

  // ── events: typing keeps drafts ────────────────────────────────────────
  document.addEventListener("input", (e) => {
    const t = e.target;
    if (t === input()) {
      autosize();
      updateSlash();
      updateSendButton();
      if (liveItem()) updateStatusline();
      return;
    }
    const node = t.closest(".item");
    const item = node && S.byId.get(node.dataset.id);
    if (!item) return;
    if (t.matches("[data-explain]") && item.explain) item.explain.draft = t.value;
    else if (t.matches("[data-typed],[data-qtext]") && item.ask) item.ask.draft = t.value;
    else if (t.matches("[data-note]") && item.ask) item.ask.note = t.value;
    else if (t.matches("[data-qothertext]") && item.ask) item.ask.other = t.value;
    else if (t.matches("[data-dinput]")) item.draft = t.value;
  });

  // ── events: keyboard ───────────────────────────────────────────────────
  document.addEventListener("keydown", (e) => {
    const t = e.target;
    const composer = input();
    const live = liveItem();
    const liveNode = live && S.nodes.get(live.id);

    // 0) Conversations view: rename fields, open a row, Esc goes back to chat.
    if (S.convos.open) {
      if (t.matches(".rename-input")) {
        if (e.key === "Enter" && !e.isComposing) return e.preventDefault(), commitRename(t.value);
        if (e.key === "Escape") return e.preventDefault(), cancelRename();
        return;
      }
      if (e.key === "Escape") return e.preventDefault(), closeConvos();
      if ((e.key === "Enter" || e.key === " ") && t.matches(".conv[data-path]")) return e.preventDefault(), openConversation(t.dataset.path);
      return;
    }

    // 1) Composer: slash menu, send, history, interrupt, jump to the card.
    if (t === composer) {
      if (S.slash.open) {
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          e.preventDefault();
          const n = S.slash.list.length;
          S.slash.idx = (S.slash.idx + (e.key === "ArrowDown" ? 1 : n - 1)) % n;
          return paintSlash();
        }
        if (e.key === "Tab") {
          e.preventDefault();
          return completeSlash(S.slash.list[S.slash.idx].name, false);
        }
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          return completeSlash(S.slash.list[S.slash.idx].name, true);
        }
        if (e.key === "Escape") {
          e.preventDefault();
          return closeSlash();
        }
      }
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        return send();
      }
      if (e.key === "Escape") {
        // A question is waiting: Esc goes to it (its own Esc skips it). With
        // nothing waiting, Esc interrupts — same as the Stop button.
        if (live) {
          e.preventDefault();
          return focusLive(true);
        }
        if (S.running) {
          e.preventDefault();
          return interrupt();
        }
        return;
      }
      if (e.key === "ArrowDown" && e.altKey && live) {
        e.preventDefault();
        return focusLive(true);
      }
      if (e.key === "ArrowUp" || e.key === "ArrowDown") {
        if (!e.altKey && !e.shiftKey && !e.metaKey && !e.ctrlKey && historyNav(e.key === "ArrowUp" ? -1 : 1)) e.preventDefault();
      }
      return;
    }

    // 2) Text fields inside cards: Enter submits (⇧Enter newline), Esc skips.
    if (t.matches("textarea,input[type=text]")) {
      const node = t.closest(".item");
      const item = node && S.byId.get(node.dataset.id);
      if (!item) return;
      const plainEnter = e.key === "Enter" && !e.shiftKey && !e.isComposing;
      const modEnter = e.key === "Enter" && (e.metaKey || e.ctrlKey);
      if (t.matches("[data-explain]")) {
        if (plainEnter) return e.preventDefault(), submitExplain(item);
        if (e.key === "Escape") return e.preventDefault(), skipAsk(item);
      } else if (t.matches("[data-typed]")) {
        if (plainEnter) return e.preventDefault(), submitTyped(item, false);
        if (e.key === "Escape") return e.preventDefault(), skipAsk(item);
      } else if (t.matches("[data-qtext]")) {
        if (plainEnter) return e.preventDefault(), submitQuestion(item);
        if (e.key === "Escape") return e.preventDefault(), skipAsk(item);
      } else if (t.matches("[data-qothertext]")) {
        if (plainEnter) return e.preventDefault(), submitQuestion(item);
        if (e.key === "Escape") return e.preventDefault(), (item.ask.otherOpen = false), renderItem(item), node.querySelector(".card")?.focus();
      } else if (t.matches("[data-dinput]")) {
        if ((t.tagName === "INPUT" && plainEnter) || modEnter) return e.preventDefault(), answerDialog(item, { value: t.value }, item.request.method === "editor" ? first(t.value, 60) : t.value || "(empty)");
        if (e.key === "Escape") return e.preventDefault(), answerDialog(item, { cancelled: true }, "cancelled");
      } else if (t.matches("[data-note]")) {
        if (e.key === "Escape") return e.preventDefault(), node.querySelector(".card")?.focus();
      }
      return;
    }

    // 3) Picker keys apply only inside the live card, or with nothing else
    //    focused — never to a focused button/link elsewhere (Enter on "New
    //    chat" must not answer the quiz).
    if (e.defaultPrevented) return;
    // Modified keys belong to VS Code (⌘1, Ctrl+N, …), never to the picker.
    // ⌘/Ctrl+Enter checks a waiting exercise card.
    const liveCode = liveItem();
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && liveCode && liveCode.name === "assign_exercise") return e.preventDefault(), codeAction(liveCode, "check");
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const inLive = liveNode && liveNode.contains(t);
    // Anything focusable outside the live card keeps its own keys.
    const interactive = t.closest("button,a,summary,input,select,textarea,[role=button],[tabindex='0']");
    const idle = !interactive && (t === document.body || t === document.documentElement || t.matches(".transcript,.feed") || Boolean(t.closest(".card:not(.live)")));
    if (e.key === "Escape" && !inLive) {
      // Esc anywhere else in the panel: go to the waiting card, or interrupt.
      e.preventDefault();
      if (live) return focusLive(true);
      if (S.running) interrupt();
      return;
    }
    if (!live || !(inLive || idle)) return;
    if (inLive && t.matches("button") && (e.key === "Enter" || e.key === " ")) return; // the focused button acts

    // Confidence step: 1 / 2 / 3, Esc skips the rating (the answer still counts).
    if (live.kind === "tool" && live.ask && !live.ask.done && live.ask.stage === "confidence") {
      if (/^[123]$/.test(e.key)) return e.preventDefault(), confirmConfidence(live, Number(e.key));
      if (e.key === "Escape") return e.preventDefault(), confirmConfidence(live, undefined);
      return;
    }
    // Explain box waiting but focus is on the card: Enter jumps into the box.
    if (live.kind === "tool" && live.explain && !live.explain.done) {
      if (e.key === "Enter") return e.preventDefault(), S.nodes.get(live.id)?.querySelector("[data-explain]")?.focus();
      if (e.key === "Escape") return e.preventDefault(), skipAsk(live);
      return;
    }
    if ((e.key === "h" || e.key === "H") && live.kind === "tool" && live.ask && !live.ask.done) return e.preventDefault(), revealHint(live);

    if (e.key === "Escape") {
      e.preventDefault();
      if (live.kind === "dialog") return answerDialog(live, { cancelled: true }, live.request.method === "confirm" ? "No" : "dismissed");
      if (live.feedback && !live.feedback.done) return feedbackChoice(live, false);
      return skipAsk(live);
    }
    if (live.kind === "dialog" && live.request.method === "confirm") {
      if (e.key === "Enter" || e.key.toLowerCase() === "y") return e.preventDefault(), answerDialog(live, { confirmed: true }, "Yes");
      if (e.key.toLowerCase() === "n") return e.preventDefault(), answerDialog(live, { confirmed: false }, "No");
      return;
    }
    if (live.feedback && !live.feedback.done) {
      if (e.key === "Enter") return e.preventDefault(), feedbackChoice(live, false);
      if (e.key.toLowerCase() === "d" && !live.feedback.correct && !live.feedback.dontKnow) return e.preventDefault(), feedbackChoice(live, true);
      return;
    }
    const rows = [...liveNode.querySelectorAll(".opt:not(.locked)")];
    if (!rows.length) return;
    const holder = holderOf(live);
    const cur = Math.min(holder.focus || 0, rows.length - 1);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      return moveFocus(live, (cur + (e.key === "ArrowDown" ? 1 : rows.length - 1)) % rows.length);
    }
    if (/^[1-9]$/.test(e.key)) {
      // Digits pick numbered options only (never "I don't know" / "Other…").
      const li = liveNode.querySelector(`.opt[data-num="${e.key}"]:not(.locked)`);
      if (!li) return;
      e.preventDefault();
      moveFocus(live, Number(li.dataset.pos));
      return activateOption(live, li);
    }
    const multi = live.ask && (live.ask.multiSelect || live.ask.mode === "multi-select");
    if (e.key === " " && multi) {
      e.preventDefault();
      return activateOption(live, rows[cur]);
    }
    if (e.key === "Enter") {
      e.preventDefault();
      if (multi) {
        const li = rows[cur];
        if (li && (li.dataset.dontknow !== undefined || li.dataset.qother !== undefined)) return activateOption(live, li);
        return live.ask.mode === "multi-select" ? submitQuestion(live) : submitQuiz(live);
      }
      return activateOption(live, rows[cur]);
    }
  });

  // Clicking away from a rename field keeps the new name.
  document.addEventListener("focusout", (e) => {
    if (e.target.matches && e.target.matches(".rename-input")) commitRename(e.target.value);
  });

  // Keyboard on focused tool rows (role=button).
  document.addEventListener("keydown", (e) => {
    const row = e.target.closest && e.target.closest("[data-toggle]");
    if (!row || (e.key !== "Enter" && e.key !== " ")) return;
    e.preventDefault();
    row.click();
  });

  // ── messages from the extension host ───────────────────────────────────
  window.addEventListener("message", (e) => {
    const m = e.data || {};
    switch (m.type) {
      case "rpc":
        return onRpc(m.event);
      case "history":
        return loadHistory(m.messages || [], Boolean(m.state && m.state.isStreaming));
      case "dialog":
        return onDialog(m.request);
      case "ask":
        return onAsk(m.ask);
      case "askDone":
        return onAskDone(m.id);
      case "notice":
        addItem({ id: nextId("n"), kind: "notice", level: m.level || "info", text: m.text || "" });
        return scrollToBottom();
      case "statuses":
        S.statuses = m.statuses || {};
        return renderFooter();
      case "widgets":
        S.widgets = m.widgets || {};
        return renderFooter();
      case "subject":
        S.subject = m.subject;
        if (S.convos.open) vscode.postMessage({ type: "sessions" });
        return renderFooter();
      case "sessions":
        if (m.error) S.convos.loadError = m.error;
        else Object.assign(S.convos, { data: m.data, loadError: "" });
        if (S.convos.open && !S.convos.editing) paintConvos();
        return;
      case "showConvos":
        return S.convos.open ? paintConvos() : openConvos();
      case "renameError":
        S.convos.error = m.error || "Rename failed";
        if (S.convos.open && !S.convos.editing) paintConvos();
        return;
      case "model":
        S.model = m.model;
        return renderFooter();
      case "hideWorking":
        S.hideWorking = Boolean(m.value);
        document.body.classList.toggle("hide-working", S.hideWorking);
        return;
      case "needsKey":
        if (!S.byId.has("setup-key")) addItem({ id: "setup-key", kind: "setup" });
        return;
      case "folders":
        S.folders = m.folders || [];
        return renderFooter();
      case "exercise":
        S.exercise = m.exercise;
        // A waiting exercise card shows the live test count too.
        for (const it of S.items) if (it.kind === "tool" && it.name === "assign_exercise" && it.ask && !it.ask.done) scheduleRender(it.id);
        return renderExercise();
      case "commands":
        S.commands = m.commands || [];
        return;
      case "connection":
        S.connection = m.state;
        if (m.state === "stopped") {
          setRunning(false);
          expireLive("TutorBot stopped");
          addItem({ id: nextId("c"), kind: "connection", detail: m.detail });
          scrollToBottom(true);
        }
        return maybeShowEmpty();
      case "clear":
        S.connection = "starting";
        setRunning(false);
        return clearTranscript();
      case "setInput":
      case "restoreInput": {
        const t = input();
        t.value = m.type === "restoreInput" && t.value.trim() ? `${m.text}\n${t.value}` : m.text || "";
        autosize();
        updateSendButton();
        return t.focus();
      }
      case "focus":
        // Open Chat: put the cursor where the learner acts next.
        if (!focusLive()) input().focus();
        return;
      case "insertContext": {
        const t = input();
        t.value = (t.value ? `${t.value}\n` : "") + m.text;
        autosize();
        updateSendButton();
        t.focus();
        t.setSelectionRange(t.value.length, t.value.length);
        return;
      }
      default:
        return;
    }
  });

  shell();
  document.body.classList.toggle("hide-working", S.hideWorking);
  renderFooter();
  autosize();
  input().focus();
  vscode.postMessage({ type: "ready" });
})();
