// Formats demo-check findings into an X reply draft under the Notice AI
// style_business constraints: numbers first, evidence quoted, no CTAs,
// honest subset disclosure, never "sign up".
//
// Budget strategy for 280 chars: problems first (they are the value), clean
// checks collapse into a single summary line, and the honesty closing line is
// dropped last. The trimmer removes the longest low-priority line per pass.

import { DEMO_CHECK_COUNT, FULL_AUDIT_CHECK_FAMILIES } from "./checker.mjs";

const OUTCOME_MARK = { pass: "pass", warning: "warning", fail: "fail", unavailable: "n/a" };

function blockedCount(aiCheck) {
  return Object.values(aiCheck.detail ?? {}).filter((v) => !v.allowed).length;
}

function problemLines(findings) {
  const lines = [];

  const rep = findings.checks.find((c) => c.id === "content_representation");
  if (rep && rep.outcome !== "pass" && typeof rep.delta === "number" && rep.delta >= 20) {
    lines.push(
      `${findings.url} — ${rep.delta}% of its visible text exists only after JavaScript runs.`
    );
  } else if (rep && rep.outcome === "unavailable") {
    lines.push(`${findings.url} — rendered view unavailable (likely bot protection).`);
  }

  const namedProblems = [];
  for (const check of findings.checks) {
    if (check.outcome === "pass" || check.outcome === "unavailable") continue;
    if (check.id === "ai_crawler_access") {
      const blocked = Object.entries(check.detail ?? {})
        .filter(([, v]) => !v.allowed)
        .map(([token]) => token);
      if (!blocked.length) continue;
      namedProblems.push(`AI crawlers blocked: ${blocked.slice(0, 3).join(", ")}${blocked.length > 3 ? "+" : ""}`);
      continue;
    }
    const detail = check.fix ?? check.observed;
    namedProblems.push(`${check.label}: ${detail}`);
  }
  lines.push(...namedProblems);
  return lines;
}

function cleanSummaryLine(findings) {
  const clean = findings.checks.filter((c) => {
    if (c.outcome !== "pass") return false;
    if (c.id === "content_representation") return false;
    // ai_crawler_access is reported separately when it matters; fold the
    // all-clear case into the summary to save budget.
    return true;
  });
  const crawlerCheck = findings.checks.find((c) => c.id === "ai_crawler_access");
  const labels = clean.map((c) => shortLabel(c));
  if (crawlerCheck?.outcome === "pass" && !crawlerCheck.detail) {
    labels.unshift(`AI crawlers: none blocked`);
  } else if (crawlerCheck?.outcome === "pass" && crawlerCheck.detail && blockedCount(crawlerCheck) === 0) {
    labels.unshift(`AI crawlers: none blocked`);
  }
  if (labels.length === 0) return null;
  return `Clean (${labels.length}): ${labels.join(", ")}.`;
}

function shortLabel(check) {
  switch (check.id) {
    case "viewport_meta": return "viewport";
    case "h1_presence": return "h1";
    case "image_alt_coverage": return "image alt";
    case "social_card": return "social card";
    case "structured_data": return "structured data";
    case "canonical_link": return "canonical";
    case "lang_attribute": return "lang";
    case "https_mixed_content": return "https";
    case "discovery_surfaces": return "sitemap";
    default: return check.label.toLowerCase();
  }
}

export function formatDemoReply(findings) {
  const lines = [`${findings.url} —`];
  lines.push(...problemLines(findings));

  const clean = cleanSummaryLine(findings);
  if (clean) lines.push(clean);

  const closing = `These are ${DEMO_CHECK_COUNT} of the ${FULL_AUDIT_CHECK_FAMILIES}+ checks a full audit runs.`;
  lines.push(closing);

  // X limit guard: drop the longest non-closing line first; keep the URL line
  // and the honesty line as long as possible.
  let text = lines.join("\n");
  while (text.length > 280 && lines.length > 2) {
    let longestIdx = 1;
    for (let i = 1; i < lines.length - 1; i++) {
      if (lines[i].length > lines[longestIdx].length) longestIdx = i;
    }
    lines.splice(longestIdx, 1);
    text = lines.join("\n");
  }
  return text.slice(0, 280);
}
