// Builds the progress dashboard's data from TutorBot's files. Pure functions:
// the extension host reads the files and calls build(); tests call it directly.
//
// Proficiency is two honest signals per concept (never one blended %):
//   • memory: FSRS retrievability — today's chance of recall, decaying
//   • proof:  not tested → not yet correct → with help → on your own → checkpoint-proven
// plus "not enough evidence" when there are fewer than 2 graded answers.
//
// Rules shared with extensions/lib/tutor-store.ts (keep them in step):
// FSRS parameters + rating map (fsrs.ts), answer attribution (findConcept),
// local-calendar day counts (daysUntil), "studied" = something taught.
"use strict";
const { fsrs, createEmptyCard, Rating } = require("./ts-fsrs.cjs");

const scheduler = fsrs({ request_retention: 0.9, enable_short_term: false, maximum_interval: 365 });
const GRADED = new Set(["check", "review", "checkpoint"]);
const DAY = 86400000;
const PROOF_LABEL = {
  "not-tested": "Not tested",
  "not-yet": "Not yet correct",
  "with-help": "With help",
  "on-your-own": "On your own",
  proven: "Checkpoint-proven",
};
const OVERCONFIDENT_BELOW = 75; // % correct when "certain" (same as the store)

function slug(t) {
  return String(t || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// Whole local calendar days from `now` to a YYYY-MM-DD date.
function daysUntil(date, now) {
  const [y, m, d] = String(date).split("-").map(Number);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((new Date(y, (m || 1) - 1, d || 1).getTime() - today.getTime()) / DAY);
}

// One answer belongs to exactly one concept: the exact name, else the closest
// loose match. Same rule as TutorStore.findConcept.
function resolver(concepts) {
  const byId = new Map(concepts.map((c) => [c.id, c]));
  const cache = new Map();
  return (subject, name) => {
    const key = `${slug(subject)}/${slug(name)}`;
    if (cache.has(key)) return cache.get(key);
    let found = byId.get(key);
    const s = slug(name);
    if (!found && s.length >= 4) {
      let gap = Infinity;
      for (const c of concepts) {
        const cs = slug(c.name);
        if (cs === s) {
          found = c;
          break;
        }
        if (cs.length < 4 || !(cs.includes(s) || s.includes(cs))) continue;
        const g = Math.abs(cs.length - s.length);
        if (g < gap) [found, gap] = [c, g];
      }
    }
    cache.set(key, found);
    return found;
  };
}

function ratingFor(r) {
  if (r.kind === "explain" || r.purpose === "discovery" || r.outcome === "disputed") return undefined;
  if (r.purpose === "diagnostic") return r.outcome === "correct" && r.confidence !== 1 ? Rating.Good : undefined;
  if (r.outcome !== "correct") return Rating.Again;
  if ((r.hintsUsed || 0) > 0 || r.confidence === 1) return Rating.Hard;
  if (r.purpose === "checkpoint" && r.confidence === 3) return Rating.Easy;
  return Rating.Good;
}

const toCard = (m) => ({ ...m, due: new Date(m.due), last_review: m.last_review ? new Date(m.last_review) : undefined });

// Memory state: the stored FSRS state, or (data from before FSRS) replayed from the log.
function memoryOf(concept, records) {
  if (concept.fsrs && concept.fsrs.reps) return concept.fsrs;
  let card;
  for (const r of records) {
    const rating = ratingFor(r);
    if (rating === undefined) continue;
    const when = new Date(r.ts);
    card = scheduler.next(card || createEmptyCard(when), card && card.last_review && when < card.last_review ? card.last_review : when, rating).card;
  }
  return card ? { ...card, due: card.due.toISOString(), last_review: card.last_review && card.last_review.toISOString(), replayed: true } : undefined;
}

function proofOf(concept, graded) {
  if (concept.verified) return "proven";
  if (!graded.length) return concept.status === "known" ? "on-your-own" : "not-tested";
  const correct = graded.filter((r) => r.outcome === "correct");
  if (correct.some((r) => !(r.hintsUsed || 0) && r.confidence !== 1)) return "on-your-own";
  if (correct.length) return "with-help";
  return "not-yet";
}

function pct(a, b) {
  return b ? Math.round((100 * a) / b) : 0;
}

function conceptView(c, records, link, topicIds, now) {
  const graded = records.filter((r) => GRADED.has(r.purpose) && r.outcome !== "disputed");
  const rated = records.filter((r) => ratingFor(r) !== undefined);
  const mem = memoryOf(c, records);
  const proof = proofOf(c, graded);
  const enough = graded.length >= 2 || Boolean(c.verified);
  // Right after a miss FSRS's recall estimate is ~100% (it was "just
  // reviewed"), which would read as "you know this". Say what happened instead.
  const last = rated[rated.length - 1];
  const missedLast = Boolean(last && last.outcome !== "correct");
  const r = !mem || !mem.reps || missedLast ? null : scheduler.get_retrievability(toCard(mem), now, false);
  // A dashboard link counts only while its topic is still on the course map.
  const linkOk = Boolean(link && topicIds.has(link.topic));
  const autoTopic = c.topic && topicIds.has(c.topic) ? c.topic : null;
  const lastMiss = [...records].reverse().find((x) => x.outcome === "incorrect" && x.misconception);
  const dueDate = mem && mem.replayed ? mem.due : c.due || null;
  return {
    id: c.id,
    name: c.name,
    family: c.family || null,
    summary: c.summary || null,
    memory: r === null ? null : Math.max(0, Math.min(1, r)),
    missedLast,
    enoughEvidence: enough,
    stabilityDays: mem ? Math.max(1, Math.round(mem.stability)) : null,
    proof,
    proofLabel: PROOF_LABEL[proof],
    fromPlacement: !graded.length && proof === "on-your-own",
    checkpointFailed: c.verified === false,
    due: Boolean(dueDate && Date.parse(dueDate) <= now.getTime() && (c.attempts > 0 || rated.length > 0)),
    dueDate,
    answers: graded.length,
    hinted: graded.filter((x) => (x.hintsUsed || 0) > 0).length,
    confidentMisses: c.confidentMisses || 0,
    lastSeen: c.lastSeen || (records.length ? records[records.length - 1].ts : null),
    taughtAt: c.taughtAt || null,
    misconception: lastMiss ? lastMiss.misconception : null,
    topic: linkOk ? link.topic : autoTopic,
    topicConfirmed: Boolean(linkOk && link.confirmed),
  };
}

// How risky a concept is before an exam (higher = worse), with reasons.
function conceptRisk(v) {
  const parts = [];
  const add = (score, reason) => parts.push([score, reason]);
  if (v.missedLast) add(82, "missed last time");
  else if (v.proof === "not-yet") add(80, "not yet correct");
  if (v.checkpointFailed) add(72, "failed last checkpoint");
  if (v.memory !== null && v.enoughEvidence && v.memory < 0.5) add(70 + Math.round((0.5 - v.memory) * 40), `memory ${Math.round(v.memory * 100)}% today`);
  if (v.proof === "not-tested") add(62, "not tested yet");
  if (v.proof === "with-help") add(60, "only right with help");
  if (v.confidentMisses && v.proof !== "proven") add(55, `${v.confidentMisses} confident miss${v.confidentMisses > 1 ? "es" : ""}`);
  if (v.due && !v.missedLast) add(50, "due for review");
  if (!v.enoughEvidence && v.answers === 1 && v.proof !== "proven") add(45, "only 1 answer so far");
  if (!parts.length) return { risk: 0, reasons: [] };
  parts.sort((a, b) => b[0] - a[0]);
  return { risk: parts[0][0] + (parts.length - 1) * 4, reasons: parts.map((p) => p[1]) };
}

const STOP = new Set(["the", "and", "of", "to", "in", "on", "for", "with", "a", "an", "by", "chapter", "ch", "section", "topic", "unit", "exam", "test", "quiz"]);
const words = (t) =>
  String(t || "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map((w) => (w.length > 3 ? w.replace(/s$/, "") : w))
    .filter((w) => w && !STOP.has(w));
const unitNo = (u) => {
  const m = String(u || "").match(/(\d+)/);
  return m ? Number(m[1]) : null;
};

// An exam's free-text topic list → course map topics. Understands unit
// numbers and ranges ("Units 1-3", "unit 4", "units 2, 3 and 5") and topic
// names (a topic matches when more than half of a listed item's words are in
// its title, id or unit).
function matchTopics(spec, topics) {
  const text = String(spec || "").trim();
  if (!text) return { topics: null, unmatched: false };
  const units = new Set();
  const unitRe = /\b(?:units?|ch(?:apters?)?\.?)\s*(\d+)(?:\s*(?:-|–|—|to|through)\s*(\d+))?((?:\s*(?:,|and|&)\s*\d+)*)/gi;
  let m;
  while ((m = unitRe.exec(text))) {
    const a = Number(m[1]);
    const b = m[2] ? Number(m[2]) : a;
    for (let i = Math.min(a, b); i <= Math.max(a, b) && i - Math.min(a, b) < 50; i++) units.add(i);
    for (const extra of (m[3] || "").match(/\d+/g) || []) units.add(Number(extra));
  }
  const items = text
    .replace(unitRe, " ")
    .split(/[,;\n&]|\band\b/i)
    .map(words)
    .filter((w) => w.length && !w.every((x) => /^\d+$/.test(x)));
  const hit = topics.filter((t) => {
    if (units.size && units.has(unitNo(t.unit))) return true;
    const tw = new Set([...words(t.title), ...words(t.id), ...words(t.unit)]);
    return items.some((item) => item.filter((w) => tw.has(w)).length * 2 > item.length);
  });
  return hit.length ? { topics: hit, unmatched: false } : { topics: null, unmatched: true };
}

function weeklyTrend(records, byId, now) {
  const weeks = [];
  for (let i = 7; i >= 0; i--) {
    const end = now.getTime() - i * 7 * DAY;
    weeks.push({ start: new Date(end - 7 * DAY).toISOString(), end: new Date(end).toISOString(), answers: 0, proven: 0 });
  }
  const inWeek = (t) => weeks.find((x) => t > Date.parse(x.start) && t <= Date.parse(x.end));
  const firstProof = new Map();
  for (const r of records) {
    const t = Date.parse(r.ts);
    const w = inWeek(t);
    if (w && GRADED.has(r.purpose) && r.outcome !== "disputed") w.answers++;
    if (r.purpose === "checkpoint" && r.outcome === "correct") for (const id of r._ids) if (!firstProof.has(id)) firstProof.set(id, t);
  }
  // Count a concept as newly proven only if it is still proven.
  for (const [id, t] of firstProof) {
    const w = inWeek(t);
    if (w && byId.get(id) && byId.get(id).verified) w.proven++;
  }
  return weeks;
}

function learning(records, concepts, feedback, subj) {
  const graded = records.filter((r) => GRADED.has(r.purpose) && r.outcome !== "disputed");
  const ok = (r) => r.outcome === "correct";
  const calibration = [1, 2, 3].map((level) => {
    const rs = graded.filter((r) => r.confidence === level);
    return { level, label: ["", "Guess", "Fairly sure", "Certain"][level], n: rs.length, pct: pct(rs.filter(ok).length, rs.length) };
  });
  const practice = graded.filter((r) => r.purpose !== "checkpoint");
  const checkpoints = graded.filter((r) => r.purpose === "checkpoint");
  const approaches = {};
  const A = (name) => (approaches[name] = approaches[name] || { approach: name, concepts: 0, firstChecks: 0, firstOk: 0, clicked: 0, fuzzy: 0 });
  for (const c of concepts) {
    if (!c.approach) continue;
    const a = A(c.approach);
    a.concepts++;
    const first = records.find((r) => r.purpose === "check" && r._ids.includes(c.id));
    if (first && first.outcome !== "disputed") {
      a.firstChecks++;
      if (ok(first) && !(first.hintsUsed || 0)) a.firstOk++;
    }
  }
  for (const f of feedback.filter((x) => x && slug(x.subject) === subj && x.approach)) {
    const a = A(f.approach);
    if (f.rating === "clicked") a.clicked++;
    if (f.rating === "fuzzy") a.fuzzy++;
  }
  const certain = calibration[2];
  return {
    calibration,
    overconfident: certain.n >= 4 && certain.pct < OVERCONFIDENT_BELOW,
    practice: { n: practice.length, pct: pct(practice.filter(ok).length, practice.length), hinted: pct(practice.filter((r) => (r.hintsUsed || 0) > 0).length, practice.length) },
    checkpoints: { n: checkpoints.length, pct: pct(checkpoints.filter(ok).length, checkpoints.length) },
    // Ranked only with at least 3 first checks; fewer is listed, not ranked.
    approaches: Object.values(approaches)
      .map((a) => ({ ...a, firstPct: pct(a.firstOk, a.firstChecks), enough: a.firstChecks >= 3 }))
      .sort((x, y) => Number(y.enough) - Number(x.enough) || (y.enough ? y.firstPct - x.firstPct : 0) || y.concepts - x.concepts),
  };
}

// inputs: { progress, subjects: [{name}], maps: { [subjectName]: {topics:[...]} }, links, now }
function build(inputs) {
  const now = inputs.now || new Date();
  const progress = inputs.progress || {};
  const allConcepts = Object.values(progress.concepts || {}).filter((c) => c && c.id && c.name && c.subject);
  const log = (progress.quizLog || [])
    .filter((r) => r && typeof r.ts === "string" && !isNaN(Date.parse(r.ts)) && Array.isArray(r.concepts))
    .sort((a, b) => a.ts.localeCompare(b.ts));
  const links = inputs.links || {};
  const names = new Map();
  for (const s of inputs.subjects || []) if (s && s.name) names.set(slug(s.name), s.name);
  for (const c of allConcepts) if (!names.has(slug(c.subject))) names.set(slug(c.subject), c.subject);

  const subjects = [...names.entries()].map(([subj, name]) => {
    const concepts = allConcepts.filter((c) => slug(c.subject) === subj);
    const byId = new Map(concepts.map((c) => [c.id, c]));
    const resolve = resolver(concepts);
    // Attribute every answer to exactly one concept per listed name.
    const records = log
      .filter((r) => slug(r.subject) === subj)
      .map((r) => ({ ...r, _ids: [...new Set(r.concepts.map((n) => resolve(r.subject, n)).filter(Boolean).map((c) => c.id))] }));
    const recordsFor = new Map(concepts.map((c) => [c.id, []]));
    for (const r of records) for (const id of r._ids) recordsFor.get(id).push(r);

    const map = (inputs.maps || {})[name] || null;
    const topics = map && Array.isArray(map.topics) ? map.topics.filter((t) => t && t.id && t.title) : [];
    const topicIds = new Set(topics.map((t) => t.id));
    const views = concepts.map((c) => {
      const v = conceptView(c, recordsFor.get(c.id), links[c.id], topicIds, now);
      const r = conceptRisk(v);
      return { ...v, risk: r.risk, riskReasons: r.reasons };
    });

    // Topics (from the course map), or concept families when there's no map.
    const topicViews = topics.length
      ? topics.map((t, i) => ({ id: t.id, title: t.title, unit: t.unit || "Course", order: t.order ?? i, concepts: views.filter((v) => v.topic === t.id) }))
      : (() => {
          const fam = new Map();
          for (const v of views) {
            const k = v.family || "Other concepts";
            if (!fam.has(k)) fam.set(k, []);
            fam.get(k).push(v);
          }
          return [...fam.entries()].map(([k, vs], i) => ({ id: `family:${slug(k)}`, title: k, unit: "Concepts by family", order: i, concepts: vs, synthetic: true }));
        })();
    for (const t of topicViews) {
      const tested = t.concepts.filter((v) => v.answers > 0);
      // not-started: nothing taught · taught: taught, never quizzed · in-progress · proven
      t.status = !t.concepts.length ? "not-started" : !tested.length ? "taught" : t.concepts.every((v) => v.proof === "proven") ? "proven" : "in-progress";
      const mems = t.concepts.filter((v) => v.enoughEvidence && v.memory !== null).map((v) => v.memory);
      t.weakestMemory = mems.length ? Math.min(...mems) : null;
      t.due = t.concepts.filter((v) => v.due).length;
    }
    const units = [];
    for (const t of [...topicViews].sort((a, b) => a.order - b.order)) {
      let u = units.find((x) => x.name === t.unit);
      if (!u) units.push((u = { name: t.unit, topics: [] }));
      u.topics.push(t);
    }
    const unlinked = topics.length ? views.filter((v) => !v.topic) : [];

    // Exams: coverage + at-risk list (never a single readiness %).
    const exams = (progress.assessments || [])
      .filter((a) => a && !a.done && /^\d{4}-\d{2}-\d{2}/.test(String(a.date || "")) && slug(a.subject) === subj)
      .map((a) => ({ ...a, daysLeft: daysUntil(a.date, now) }))
      .filter((a) => a.daysLeft >= 0 && a.daysLeft <= 60)
      .sort((a, b) => a.daysLeft - b.daysLeft)
      .map((a) => {
        const match = topics.length ? matchTopics(a.topics, topicViews) : { topics: null, unmatched: false };
        const scope = match.topics || topicViews;
        const scopeConcepts = scope.flatMap((t) => t.concepts.map((v) => ({ v, t })));
        if (topics.length && !match.topics) for (const v of unlinked) scopeConcepts.push({ v, t: null });
        const atRisk = scopeConcepts
          .filter(({ v }) => v.risk > 0)
          .map(({ v, t }) => ({ id: v.id, title: v.name, topic: t && !t.synthetic ? t.title : null, reasons: v.riskReasons, risk: v.risk, action: v.proof === "not-tested" ? "check" : "practice" }))
          .sort((x, y) => y.risk - x.risk);
        return {
          name: a.name,
          date: a.date,
          kind: a.kind || null,
          daysLeft: a.daysLeft,
          // Coverage needs a course map; family groups can't show gaps.
          coverage: topics.length
            ? { total: scope.length, studied: scope.filter((t) => t.status !== "not-started").length, proven: scope.filter((t) => t.status === "proven").length }
            : null,
          scope: !topics.length ? "no-map" : match.topics ? "listed" : match.unmatched ? "unmatched" : "whole",
          topicsText: a.topics || null,
          notStarted: topics.length ? scope.filter((t) => t.status === "not-started").map((t) => ({ id: t.id, title: t.title })) : [],
          atRisk: atRisk.slice(0, 8),
          moreAtRisk: Math.max(0, atRisk.length - 8),
          // Weakest first, so a capped checkpoint tests what matters most.
          checkpointConcepts: scopeConcepts
            .filter(({ v }) => v.answers > 0)
            .sort((x, y) => y.v.risk - x.v.risk)
            .map(({ v }) => v.name),
        };
      });

    const weekly = weeklyTrend(records, byId, now);
    return {
      name,
      hasMap: Boolean(topics.length),
      summary: {
        topicsTotal: topics.length ? topicViews.length : 0,
        topicsStudied: topics.length ? topicViews.filter((t) => t.status !== "not-started").length : 0,
        topicsProven: topics.length ? topicViews.filter((t) => t.status === "proven").length : 0,
        concepts: views.length,
        conceptsProven: views.filter((v) => v.proof === "proven").length,
        due: views.filter((v) => v.due).length,
        weekly,
        thisWeek: weekly[weekly.length - 1],
      },
      exams,
      units,
      unlinked,
      topicOptions: topics.map((t) => ({ id: t.id, title: t.title, unit: t.unit || "" })),
      learning: learning(records, concepts, progress.lessonFeedback || [], subj),
    };
  });
  subjects.sort((a, b) => b.summary.concepts - a.summary.concepts || a.name.localeCompare(b.name));
  return { generatedAt: now.toISOString(), subjects };
}

module.exports = { build, matchTopics, daysUntil, PROOF_LABEL, slug };
