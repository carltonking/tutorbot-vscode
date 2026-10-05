// TutorBot progress dashboard (editor tab). Renders the data built by
// lib/dashboard-data.js in the extension host; every action goes back to the
// host, which runs it in the chat.
(function () {
  "use strict";
  const vscode = acquireVsCodeApi();
  const saved = vscode.getState() || {};
  const S = {
    data: null,
    active: null,
    subject: saved.subject || null,
    filter: saved.filter || "all",
    open: saved.open || {}, // disclosure key -> expanded?
    changing: {}, // concept id -> topic chooser shown for a confirmed link
    staged: {}, // concept id -> topic picked but not confirmed yet
    error: null,
    pending: false, // data arrived while the learner was in a control
  };
  const persist = () => vscode.setState({ subject: S.subject, filter: S.filter, open: S.open });

  // ── helpers ─────────────────────────────────────────────────────────────
  const $ = (sel, root = document) => root.querySelector(sel);
  const esc = (s) =>
    String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const plural = (n, w, p) => `${n} ${n === 1 ? w : p || w + "s"}`;
  const pct = (x) => `${Math.round(x * 100)}%`;
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const day = (d) => `${MONTHS[d.getMonth()]} ${d.getDate()}`;
  const localDate = (ymd) => {
    const [y, m, d] = String(ymd).split("-").map(Number);
    return new Date(y, (m || 1) - 1, d || 1);
  };
  // Calendar days, not elapsed hours: 23:00 yesterday is "yesterday" at 09:00.
  const relDay = (iso) => {
    if (!iso) return "never";
    const d = new Date(iso);
    const n = new Date();
    const days = Math.round((new Date(n.getFullYear(), n.getMonth(), n.getDate()) - new Date(d.getFullYear(), d.getMonth(), d.getDate())) / 86400000);
    return days <= 0 ? "today" : days === 1 ? "yesterday" : days < 14 ? `${days} days ago` : day(d);
  };
  const json = (x) => esc(JSON.stringify(x));

  // Text with $…$ / \(…\) / $$…$$ math, typeset with KaTeX; everything else
  // escaped. Inline $…$ follows the pandoc rule (no space just inside the
  // dollars, no digit right after), so "$5 and $10" stays text.
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

  function math(text) {
    const s = repairMath(String(text ?? ""));
    if (!window.katex || !/[$\\]/.test(s)) return esc(s);
    const re = /\$\$([\s\S]+?)\$\$|\\\(([\s\S]+?)\\\)|\$(?!\s)([^$\n]+?)(?<!\s)\$(?!\d)/g;
    let out = "";
    let last = 0;
    let m;
    while ((m = re.exec(s))) {
      out += esc(s.slice(last, m.index));
      const tex = m[1] ?? m[2] ?? m[3];
      try {
        out += window.katex.renderToString(tex, { throwOnError: false, displayMode: false });
      } catch {
        out += esc(m[0]);
      }
      last = re.lastIndex;
    }
    return out + esc(s.slice(last));
  }

  const subject = () => (S.data ? S.data.subjects.find((s) => s.name === S.subject) : null);

  // ── filters ─────────────────────────────────────────────────────────────
  const FILTERS = [
    ["all", "All"],
    ["due", "Due"],
    ["risk", "At risk"],
    ["notStarted", "Not started"],
    ["unconfirmed", "Unconfirmed"],
  ];
  const conceptMatch = (v, f) => f === "all" || (f === "due" && v.due) || (f === "risk" && v.risk > 0) || (f === "unconfirmed" && !v.topicConfirmed);
  function topicVisible(t, f) {
    if (f === "all") return true;
    if (f === "notStarted") return t.status === "not-started" && !t.synthetic;
    return t.concepts.some((v) => conceptMatch(v, f));
  }
  function filterCount(s, f) {
    if (f === "all") return null;
    const topics = s.units.flatMap((u) => u.topics);
    if (f === "notStarted") return topics.filter((t) => t.status === "not-started" && !t.synthetic).length;
    return topics.flatMap((t) => t.concepts).concat(s.unlinked).filter((v) => conceptMatch(v, f)).length;
  }

  // ── pieces ──────────────────────────────────────────────────────────────
  function memoryCell(v) {
    if (v.missedLast) return `<div class="mem thin">missed last time</div>`;
    if (v.memory === null || !v.enoughEvidence)
      return `<div class="mem thin" title="Memory is shown after 2 graded answers">not enough evidence</div>`;
    const next = v.dueDate ? (v.due ? "due now" : `next review ${day(new Date(v.dueDate))}`) : "";
    const tip = `Chance you'd recall this today: ${pct(v.memory)}. After a review it stays above 90% for about ${plural(v.stabilityDays || 1, "day")}${next ? `; ${next}` : ""}.`;
    return `<div class="mem" title="${esc(tip)}"><div class="bar" role="img" aria-label="Memory today ${pct(v.memory)}"><span style="width:${(v.memory * 100).toFixed(1)}%"></span></div><span class="pct">${pct(v.memory)}</span></div>`;
  }

  function proofCell(v) {
    const weak = ["not-tested", "not-yet", "with-help"].includes(v.proof);
    const q = v.fromPlacement ? " <small>(placement)</small>" : v.proof !== "proven" && v.answers === 1 ? " <small>(1 answer)</small>" : "";
    return `<div class="proof${weak ? " weak" : ""}">${esc(v.proofLabel)}${q}</div>`;
  }

  function evidenceLine(v) {
    const parts = [v.answers ? plural(v.answers, "graded answer") : "not quizzed yet"];
    if (v.hinted) parts.push(`${v.hinted} with hints`);
    if (v.confidentMisses) parts.push(plural(v.confidentMisses, "confident miss", "confident misses"));
    if (v.checkpointFailed) parts.push("failed last checkpoint");
    parts.push(v.lastSeen || !v.taughtAt ? `last seen ${relDay(v.lastSeen)}` : `taught ${relDay(v.taughtAt)}`);
    if (v.due) parts.push(v.missedLast ? "due again now" : "due for review");
    else if (v.dueDate && v.answers) parts.push(`next review ${day(new Date(v.dueDate))}`);
    return parts.join(" · ");
  }

  function topicName(s, id) {
    const t = s.topicOptions.find((x) => x.id === id);
    return t ? t.title : "";
  }

  // Topic link: unconfirmed → chooser + Confirm; confirmed → name + "change".
  function tagLine(s, v) {
    if (!s.hasMap) return "";
    if (v.topicConfirmed && !S.changing[v.id])
      return `<div class="tagline"><span class="confirmed">Topic: ${math(topicName(s, v.topic))}</span><button class="link" data-change="${esc(v.id)}" aria-label="Change topic for ${esc(v.name)}">change</button><button class="link" data-clear="${esc(v.id)}" aria-label="Clear the topic you confirmed for ${esc(v.name)}">clear</button></div>`;
    const pick = S.staged[v.id] ?? v.topic ?? "";
    const opts = s.topicOptions
      .map((t) => `<option value="${esc(t.id)}"${t.id === pick ? " selected" : ""}>${esc(t.unit ? `${t.unit} · ${t.title}` : t.title)}</option>`)
      .join("");
    const chip = v.topicConfirmed ? "changing topic" : v.topic ? "topic not confirmed" : "no topic";
    return `<div class="tagline"><span class="chip">${chip}</span>
      <select class="tag-select" data-key="sel:${esc(v.id)}" data-concept="${esc(v.id)}" aria-label="Topic for ${esc(v.name)}">${pick ? "" : '<option value="" selected>Choose a topic…</option>'}${opts}</select>
      <button class="btn" data-key="ok:${esc(v.id)}" data-confirm="${esc(v.id)}"${pick ? "" : " disabled"}>Confirm</button>
      ${S.changing[v.id] ? `<button class="link" data-cancel-change="${esc(v.id)}">cancel</button>` : ""}</div>`;
  }

  function conceptRow(s, v) {
    const act = v.proof === "not-tested" ? "check" : v.proof === "on-your-own" && !v.missedLast ? "checkpoint" : "practice";
    const label = { check: "Check", practice: "Practice", checkpoint: "Checkpoint" }[act];
    return `<li class="concept">
      <div class="name">${math(v.name)}</div>
      ${memoryCell(v)}
      ${proofCell(v)}
      <div class="cact"><button class="btn" data-key="a:${esc(v.id)}" data-act="${act}" data-concepts="${json([v.name])}">${label}</button></div>
      <div class="evidence">${esc(evidenceLine(v))}</div>
      ${v.misconception ? `<div class="mis">Last mistake: ${math(v.misconception)}</div>` : ""}
      ${tagLine(s, v)}
    </li>`;
  }

  function topicStatus(t) {
    if (!t.concepts.length) return "not started";
    const proven = t.concepts.filter((v) => v.proof === "proven").length;
    const parts = [t.status === "proven" ? "proven" : t.status === "taught" ? "taught, not quizzed yet" : `${proven} of ${t.concepts.length} proven`];
    if (t.weakestMemory !== null && t.status !== "taught") parts.push(`weakest ${pct(t.weakestMemory)}`);
    if (t.due) parts.push(`${t.due} due`);
    return parts.join(" · ");
  }

  function topicBlock(s, t) {
    const visible = t.concepts.filter((v) => conceptMatch(v, S.filter === "notStarted" ? "all" : S.filter));
    const key = `t:${s.name}:${t.id}`;
    const open = S.open[key] ?? true;
    let acts = "";
    if (!t.synthetic && !t.concepts.length) acts = `<button class="btn" data-key="teach:${esc(t.id)}" data-act="teach" data-topic="${esc(t.title)}" data-topic-id="${esc(t.id)}">Teach me</button>`;
    else if (t.concepts.length) {
      const untested = t.concepts.filter((v) => v.proof === "not-tested").map((v) => v.name);
      acts = untested.length
        ? `<button class="btn" data-key="tc:${esc(t.id)}" data-act="check" data-concepts="${json(untested)}">Check</button>`
        : `<button class="btn" data-key="tk:${esc(t.id)}" data-act="checkpoint" data-concepts="${json(t.concepts.map((v) => v.name))}" title="One no-help question per concept">Checkpoint</button>`;
    }
    if (!t.synthetic) acts = `<button class="link rename" data-key="rn:${esc(t.id)}" data-rename="${esc(t.id)}" aria-label="Rename topic ${esc(t.title)}">rename</button>` + acts;
    const has = visible.length > 0;
    const disc = has
      ? `<button class="disc" data-key="d:${esc(key)}" data-toggle="${esc(key)}" aria-expanded="${open}"><span class="chev" aria-hidden="true">›</span><span class="tt">${math(t.title)}</span></button>`
      : `<div class="disc"><span class="chev" aria-hidden="true">›</span><span class="tt">${math(t.title)}</span></div>`;
    return `<div class="topic${has ? "" : " empty"}" data-topic-row="${esc(t.id)}">
      <div class="topic-head">${disc}<span class="status">${esc(topicStatus(t))}</span><span class="acts">${acts}</span></div>
      ${has && open ? `<ul class="concepts">${visible.map((v) => conceptRow(s, v)).join("")}</ul>` : ""}</div>`;
  }

  function unitBlock(s, u) {
    const topics = u.topics.filter((t) => topicVisible(t, S.filter));
    if (!topics.length) return "";
    const key = `u:${s.name}:${u.name}`;
    const open = S.open[key] ?? true;
    const real = u.topics.filter((t) => !t.synthetic);
    const meta = real.length
      ? `${real.filter((t) => t.status !== "not-started").length} of ${real.length} studied · ${real.filter((t) => t.status === "proven").length} proven`
      : plural(u.topics.reduce((n, t) => n + t.concepts.length, 0), "concept");
    return `<div class="unit"><div class="unit-head"><button class="disc" data-key="d:${esc(key)}" data-toggle="${esc(key)}" aria-expanded="${open}"><span class="chev" aria-hidden="true">›</span><span>${math(u.name)}</span></button><span class="meta">${esc(meta)}</span></div>
      ${open ? topics.map((t) => topicBlock(s, t)).join("") : ""}</div>`;
  }

  function sparkline(weeks) {
    const W = 200;
    const H = 30;
    const max = Math.max(1, ...weeks.map((w) => w.answers));
    const x = (i) => 4 + (i * (W - 8)) / (weeks.length - 1);
    const y = (n) => H - 3 - (n / max) * (H - 8);
    const pts = weeks.map((w, i) => `${x(i).toFixed(1)},${y(w.answers).toFixed(1)}`).join(" ");
    const marks = weeks
      .map((w, i) => {
        const tip = `7 days to ${day(new Date(w.end))}: ${plural(w.answers, "graded answer")}${w.proven ? `, ${w.proven} newly proven` : ""}`;
        return `<rect class="hit" x="${(x(i) - W / weeks.length / 2).toFixed(1)}" y="0" width="${(W / weeks.length).toFixed(1)}" height="${H}" data-tip="${esc(tip)}"></rect><circle class="pt${i === weeks.length - 1 ? " last" : ""}" cx="${x(i).toFixed(1)}" cy="${y(w.answers).toFixed(1)}" r="3"></circle>`;
      })
      .join("");
    return `<svg class="spark" viewBox="0 0 ${W} ${H}" role="img" aria-label="Graded answers per 7 days, last 8 weeks: ${weeks.map((w) => w.answers).join(", ")}">
      <line class="base" x1="0" x2="${W}" y1="${H - 3}" y2="${H - 3}"></line><polyline class="line" points="${pts}" vector-effect="non-scaling-stroke"></polyline>${marks}</svg>`;
  }

  function summary(s) {
    const m = s.summary;
    const tw = m.thisWeek;
    const course = s.hasMap
      ? `<div class="k">Course topics studied</div><div class="v">${m.topicsStudied} <small>of ${m.topicsTotal}</small></div><div class="s">${m.topicsProven} fully proven</div>`
      : `<div class="k">Concepts learned</div><div class="v">${m.concepts}</div><div class="s">no course map yet</div>`;
    return `<div class="summary">
      <div class="tile">${course}</div>
      <div class="tile"><div class="k">Checkpoint-proven</div><div class="v">${m.conceptsProven} <small>of ${m.concepts}</small></div><div class="s">concepts passed with no help</div></div>
      <div class="tile"><div class="k">Due for review</div><div class="row"><div class="v">${m.due}</div>${m.due ? `<button class="btn" data-key="review" data-act="review">Review</button>` : ""}</div><div class="s">${m.due ? "faded below 90%, or missed last time" : "nothing due"}</div></div>
      <div class="tile"><div class="k">Last 7 days</div><div class="v">${tw.answers} <small>graded answers</small></div>${sparkline(m.weekly)}<div class="s">${tw.proven ? `${tw.proven} newly proven` : "8-week trend"}</div></div>
    </div>`;
  }

  function examCard(e) {
    const when = e.daysLeft === 0 ? "today" : e.daysLeft === 1 ? "tomorrow" : `in ${e.daysLeft} days`;
    let coverage;
    if (!e.coverage) {
      coverage = `<p class="note">No course map yet, so coverage is unknown: TutorBot only knows the concepts you've studied, not what the exam includes. <button class="link" data-act="courseMap" data-key="cm:${esc(e.name)}">Build course map</button></p>`;
    } else {
      const c = e.coverage;
      const studied = c.studied - c.proven;
      const left = c.total - c.studied;
      const w = (n) => (c.total ? (100 * n) / c.total : 0);
      const scopeNote =
        e.scope === "listed"
          ? "topics listed for this exam"
          : e.scope === "unmatched"
            ? `couldn't match "${e.topicsText}" to the course map; showing the whole course`
            : "whole course (no topic list for this exam)";
      coverage = `<div class="coverage"><div class="line">Studied <b>${c.studied}</b> of ${c.total} topics · proven <b>${c.proven}</b> <span class="why">· ${esc(scopeNote)}</span></div>
        <div class="stack" role="img" aria-label="${c.proven} proven, ${studied} studied, ${left} not started">${c.proven ? `<span class="proven" style="width:${w(c.proven)}%"></span>` : ""}${studied ? `<span class="studied" style="width:${w(studied)}%"></span>` : ""}${left ? `<span class="left" style="flex:1"></span>` : ""}</div>
        <div class="legend"><span><i class="proven"></i>proven ${c.proven}</span><span><i class="studied"></i>studied ${studied}</span><span><i class="left"></i>not started ${left}</span></div></div>`;
    }
    const rows = e.atRisk
      .map((r) => {
        const btn = `<button class="btn" data-key="er:${esc(e.name)}:${esc(r.id)}" data-act="${r.action}" data-concepts="${json([r.title])}">${r.action === "check" ? "Check" : "Practice"}</button>`;
        return `<li><div class="what"><div class="t">${math(r.title)}${r.topic ? ` <span class="why">· ${math(r.topic)}</span>` : ""}</div><div class="why">${esc(r.reasons.join(" · "))}</div></div>${btn}</li>`;
      })
      .join("");
    const ns = e.notStarted || [];
    const nsRows = ns
      .slice(0, 3)
      .map((t) => `<li><div class="what"><div class="t">${math(t.title)}</div><div class="why">not started</div></div><button class="btn" data-key="en:${esc(e.name)}:${esc(t.id)}" data-act="teach" data-topic="${esc(t.title)}" data-topic-id="${esc(t.id)}">Teach me</button></li>`)
      .join("");
    const cp = e.checkpointConcepts || [];
    return `<div class="exam">
      <div class="exam-head"><span class="name">${esc(e.name)}</span><span class="when">${esc(day(localDate(e.date)))} · ${when}</span><span class="spacer"></span>
        ${cp.length ? `<button class="btn${e.daysLeft <= 3 ? " primary" : ""}" data-key="ecp:${esc(e.name)}" data-act="checkpoint" data-concepts="${json(cp.slice(0, 12))}" title="One no-help question per studied concept in this exam's scope">Checkpoint${cp.length > 12 ? ` (weakest 12 of ${cp.length})` : ""}</button>` : ""}</div>
      ${coverage}
      ${rows ? `<div class="risk-title">Weak spots, most urgent first</div><ul class="risk">${rows}${e.moreAtRisk ? `<li class="more">and ${e.moreAtRisk} more</li>` : ""}</ul>` : cp.length ? `<p class="note">No weak spots among the concepts you've studied for this.</p>` : ""}
      ${nsRows ? `<div class="risk-title">Not started yet</div><ul class="risk">${nsRows}${ns.length > 3 ? `<li class="more">and ${ns.length - 3} more not started</li>` : ""}</ul>` : ""}
    </div>`;
  }

  function learnSection(s) {
    const L = s.learning;
    const calib = L.calibration
      .map(
        (c) =>
          `<tr><td>${c.label}</td><td class="num">${c.n}</td><td>${c.n ? `<div class="mem"><div class="bar"><span style="width:${c.pct}%"></span></div><span class="pct">${c.pct}%</span></div>` : '<span class="why">no answers</span>'}</td></tr>`,
      )
      .join("");
    const certain = L.calibration[2];
    const calibNote = L.overconfident
      ? `When you're certain you're right ${certain.pct}% of the time; slow down on "certain" answers.`
      : certain.n >= 4
        ? "Your confidence is a good guide to what you know."
        : "Not enough rated answers yet: rate your confidence when you answer.";
    const appr = L.approaches.filter((a) => a.concepts || a.clicked || a.fuzzy);
    const apprRows = appr
      .map(
        (a) =>
          `<tr><td>${esc(a.approach)}</td><td class="num">${a.concepts}</td><td class="num">${a.firstChecks ? `${a.firstOk} of ${a.firstChecks}` : "–"}</td><td class="num">${a.clicked} / ${a.fuzzy}</td></tr>`,
      )
      .join("");
    const ranked = appr.some((a) => a.enough);
    return `<section><h2>How you learn</h2><div class="learn">
      <div class="panel"><h3>Confidence vs. correct</h3>
        <table><thead><tr><th>You said</th><th class="num">Answers</th><th>Correct</th></tr></thead><tbody>${calib}</tbody></table>
        <p class="note" style="margin-top:8px">${esc(calibNote)}</p></div>
      <div class="panel"><h3>What works for you</h3>
        ${
          apprRows
            ? `<table><thead><tr><th>Teaching approach</th><th class="num">Concepts</th><th class="num">Right on first check</th><th class="num">Clicked / fuzzy</th></tr></thead><tbody>${apprRows}</tbody></table>
               <p class="note" style="margin-top:8px">${ranked ? "Ranked where there are at least 3 first checks." : "Too few first checks to rank approaches yet (3 each needed)."}</p>`
            : '<p class="note">TutorBot records how it teaches each concept; rate lessons in the chat to see what works best.</p>'
        }
        <p class="note">Practice: ${L.practice.n ? `${L.practice.pct}% correct over ${plural(L.practice.n, "answer")}, ${L.practice.hinted}% with hints` : "none yet"} · Checkpoints: ${L.checkpoints.n ? `${L.checkpoints.pct}% over ${plural(L.checkpoints.n, "question")}` : "none yet"}</p></div>
    </div></section>`;
  }

  // ── render ──────────────────────────────────────────────────────────────
  function render() {
    // Keep keyboard focus across re-renders (live updates arrive after every answer).
    const focusKey = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.key : null;
    draw();
    if (focusKey) {
      const el = document.querySelector(`[data-key="${CSS.escape(focusKey)}"]`);
      if (el) el.focus();
    }
    S.pending = false;
  }

  function draw() {
    const app = $("#app");
    if (!S.data) {
      app.innerHTML = `<div class="empty-state">${S.error ? esc(S.error) : "Loading…"}</div>`;
      return;
    }
    const subs = S.data.subjects;
    if (!subs.length) {
      app.innerHTML = `<div class="top"><h1>Progress</h1></div>${S.error ? `<div class="error" role="alert">${esc(S.error)}</div>` : ""}<div class="empty-state">Nothing to show yet. Pick a subject in the TutorBot chat and learn a concept; it will appear here.</div>`;
      return;
    }
    if (!S.subject || !subs.some((x) => x.name === S.subject)) S.subject = (subs.find((x) => x.name === S.active) || subs[0]).name;
    const s = subject();
    if ((S.filter === "unconfirmed" || S.filter === "notStarted") && !s.hasMap) S.filter = "all";
    const tabs = subs
      .map(
        (x) =>
          `<button class="tab" role="tab" id="tab-${subs.indexOf(x)}" data-key="tab:${esc(x.name)}" aria-selected="${x.name === s.name}" aria-controls="panel" tabindex="${x.name === s.name ? 0 : -1}" data-subject="${esc(x.name)}">${esc(x.name)}${x.summary.due ? `<span class="badge">${x.summary.due} due</span>` : ""}</button>`,
      )
      .join("");
    const callout = !s.hasMap
      ? `<div class="callout"><p>${
          s.hasFolder
            ? "No course map yet. TutorBot can build one from your class folder, so this shows the whole course, including the topics you haven't started."
            : "Add your class folder so TutorBot can map the whole course, including the topics you haven't started. Until then, concepts are grouped by family."
        }</p><button class="btn primary" data-key="callout" data-act="${s.hasFolder ? "courseMap" : "folder"}">${s.hasFolder ? "Build course map" : "Choose class folder"}</button></div>`
      : "";
    const exams = s.exams.length ? `<section><h2>Upcoming</h2><div class="exams">${s.exams.map(examCard).join("")}</div></section>` : "";
    const filters = FILTERS.filter(([f]) => s.hasMap || (f !== "unconfirmed" && f !== "notStarted"))
      .map(([f, label]) => {
        const n = filterCount(s, f);
        return `<button class="filter" data-key="f:${f}" aria-pressed="${S.filter === f}" data-filter="${f}">${label}${n === null ? "" : `<span class="n">${n}</span>`}</button>`;
      })
      .join("");
    const units = s.units.map((u) => unitBlock(s, u)).join("");
    const unlinked = S.filter === "notStarted" ? [] : s.unlinked.filter((v) => conceptMatch(v, S.filter));
    const unlinkedBlock = unlinked.length
      ? `<div class="unit"><div class="unit-head"><div class="disc"><span>Not linked to a course topic</span></div><span class="meta">${plural(unlinked.length, "concept")}</span></div><ul class="concepts">${unlinked.map((v) => conceptRow(s, v)).join("")}</ul></div>`
      : "";
    const map = units || unlinkedBlock ? units + unlinkedBlock : `<p class="note">Nothing matches this filter.</p>`;
    app.innerHTML = `
      <div class="top"><h1>Progress</h1><span class="updated">updated ${new Date(S.data.generatedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</span><span class="spacer"></span><button class="link" data-key="pmd" data-open-file="progress">Open Progress.md</button></div>
      <div class="tabs" role="tablist" aria-label="Subjects">${tabs}</div>
      <div id="panel" role="tabpanel" aria-labelledby="tab-${subs.indexOf(s)}">
      ${S.error ? `<div class="error" role="alert">${esc(S.error)}</div>` : ""}
      ${summary(s)}
      ${callout}
      ${exams}
      <section><h2>${s.hasMap ? "Course map" : "Concepts"}</h2>
        <p class="note">Memory is your chance of recalling it today; it fades between reviews. Proof is the best you've shown: with help, on your own, or in a no-help checkpoint. Memory needs 2 graded answers before it's shown.</p>
        <div class="filters" role="toolbar" aria-label="Filter">${filters}</div>
        ${map}</section>
      ${learnSection(s)}</div>`;
  }

  // ── events ──────────────────────────────────────────────────────────────
  function selectSubject(name, focus) {
    S.subject = name;
    vscode.postMessage({ type: "select", subject: name });
    persist();
    render();
    if (focus) {
      const el = document.querySelector(`[data-key="${CSS.escape(`tab:${name}`)}"]`);
      if (el) el.focus();
    }
  }

  document.addEventListener("click", (e) => {
    const t = e.target.closest("button");
    if (!t || t.disabled) return;
    const d = t.dataset;
    if (d.subject) return selectSubject(d.subject);
    if (d.filter) {
      S.filter = d.filter;
      persist();
      return render();
    }
    if (d.toggle) {
      S.open[d.toggle] = t.getAttribute("aria-expanded") !== "true";
      persist();
      return render();
    }
    if (d.openFile) return vscode.postMessage({ type: "openFile", which: d.openFile });
    if (d.change) {
      S.changing[d.change] = true;
      render();
      const sel = document.querySelector(`[data-key="${CSS.escape(`sel:${d.change}`)}"]`);
      return sel && sel.focus();
    }
    if (d.clear) return vscode.postMessage({ type: "confirmTopic", conceptId: d.clear, topic: null });
    if (d.cancelChange) {
      delete S.changing[d.cancelChange];
      delete S.staged[d.cancelChange];
      return render();
    }
    if (d.confirm) {
      const sel = document.querySelector(`[data-key="${CSS.escape(`sel:${d.confirm}`)}"]`);
      if (!sel || !sel.value) return;
      delete S.changing[d.confirm];
      delete S.staged[d.confirm];
      return vscode.postMessage({ type: "confirmTopic", conceptId: d.confirm, topic: sel.value });
    }
    if (d.rename) return startRename(t);
    if (d.act) {
      let concepts = [];
      try {
        concepts = d.concepts ? JSON.parse(d.concepts) : [];
      } catch {}
      vscode.postMessage({ type: "action", action: d.act, subject: S.subject, concepts, topic: d.topic, topicId: d.topicId });
    }
  });

  // Picking a topic only stages it; Confirm commits.
  document.addEventListener("change", (e) => {
    const sel = e.target.closest("select.tag-select");
    if (!sel) return;
    S.staged[sel.dataset.concept] = sel.value;
    const ok = document.querySelector(`[data-key="${CSS.escape(`ok:${sel.dataset.concept}`)}"]`);
    if (ok) ok.disabled = !sel.value;
  });

  // Subject tabs: arrow keys move between them.
  document.addEventListener("keydown", (e) => {
    const tab = e.target.closest && e.target.closest('[role="tab"]');
    if (!tab || !S.data) return;
    const names = S.data.subjects.map((x) => x.name);
    const i = names.indexOf(tab.dataset.subject);
    let j = -1;
    if (e.key === "ArrowRight") j = (i + 1) % names.length;
    else if (e.key === "ArrowLeft") j = (i - 1 + names.length) % names.length;
    else if (e.key === "Home") j = 0;
    else if (e.key === "End") j = names.length - 1;
    if (j < 0) return;
    e.preventDefault();
    selectSubject(names[j], true);
  });

  // While the learner is in a dropdown or the rename box, hold live updates
  // and apply them when they leave it.
  const busyControl = () => {
    const a = document.activeElement;
    return a && (a.tagName === "SELECT" || a.classList.contains("title-input"));
  };
  document.addEventListener("focusout", () => setTimeout(() => S.pending && !busyControl() && render(), 0));

  function startRename(btn) {
    const row = btn.closest(".topic-head");
    const s = subject();
    const topic = s && s.topicOptions.find((t) => t.id === btn.dataset.rename);
    if (!row || !topic) return;
    const input = document.createElement("input");
    input.className = "title-input";
    input.value = topic.title;
    input.maxLength = 120;
    input.setAttribute("aria-label", "Topic name. Enter to save, Escape to cancel");
    row.querySelector(".disc").replaceWith(input);
    input.focus();
    input.select();
    let done = false;
    const finish = (save) => {
      if (done) return;
      done = true;
      const title = input.value.trim();
      if (save && title && title !== topic.title) vscode.postMessage({ type: "renameTopic", subject: S.subject, topicId: topic.id, title });
      render();
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") finish(true);
      if (e.key === "Escape") finish(false);
    });
    input.addEventListener("blur", () => finish(true));
  }

  // Sparkline hover tooltip.
  let tip;
  document.addEventListener("mousemove", (e) => {
    const hit = e.target.closest && e.target.closest(".hit");
    document.querySelectorAll(".pt.on").forEach((p) => p.classList.remove("on"));
    if (!hit) {
      if (tip) tip.hidden = true;
      return;
    }
    if (!tip) {
      tip = document.createElement("div");
      tip.className = "tip";
      document.body.appendChild(tip);
    }
    const pt = hit.nextElementSibling;
    if (pt) pt.classList.add("on");
    tip.textContent = hit.dataset.tip;
    tip.hidden = false;
    const r = tip.getBoundingClientRect();
    tip.style.left = `${Math.max(4, Math.min(window.innerWidth - r.width - 4, e.clientX - r.width / 2))}px`;
    tip.style.top = `${e.clientY - r.height - 10}px`;
  });

  window.addEventListener("message", (e) => {
    const m = e.data;
    if (m.type === "data") {
      S.data = m.data;
      S.active = m.active;
      S.error = null;
      if (!S.subject) S.subject = m.selected || m.active || null;
      if (busyControl()) S.pending = true;
      else render();
    } else if (m.type === "error") {
      S.error = m.text;
      if (busyControl()) S.pending = true;
      else render();
    }
  });

  render();
  vscode.postMessage({ type: "ready" });
})();
