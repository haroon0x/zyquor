// Demo Checker for Notice AI marketing replies.
// Runs a small subset of Notice-style checks on a public URL and produces an
// X-reply draft. Terminology mirrors noticeai/src/analysis.py so the free
// result reads like the product's own output.
//
// Checks (v1):
//   1. content_representation — raw vs rendered visible-text comparison
//   2. title_presence         — document title element observations
//   3. meta_description_presence — meta description observations
//
// Honesty rule: the closing line states the real subset size vs the full
// catalog (see FULL_AUDIT_CHECK_FAMILIES), never an invented percentage.

import { createRequire } from "node:module";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { Resolver } from "node:dns/promises";
import net from "node:net";

const require = createRequire(new URL("../../packages/browser/package.json", import.meta.url));
const { chromium } = require("playwright-core");

export const FULL_AUDIT_CHECK_FAMILIES = 50; // ~35 core ids + 15 supplemental families
export const DEMO_CHECK_COUNT = 13;

// Mirrors noticeai/src/discovery.py CrawlerPolicy registry — search crawlers
// only; training-purpose tokens are deliberately excluded from the demo.
const AI_CRAWLERS = [
  "OAI-SearchBot",    // OpenAI search
  "Claude-SearchBot", // Anthropic search
  "PerplexityBot",    // Perplexity search
];

const UA =
  "Mozilla/5.0 (compatible; NoticeDemoChecker/1.0; +https://noticeai.dev/bot)";
const FETCH_TIMEOUT_MS = 15_000;
const RENDER_TIMEOUT_MS = 25_000;
const CDP_URL = process.env.ZYQUOR_BROWSER_CDP_URL ?? "http://172.31.96.1:9223";

// ---------- SSRF guard ----------

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return (
      a === 0 || a === 10 || a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a >= 224
    );
  }
  const v6 = ip.toLowerCase();
  return (
    v6 === "::" || v6 === "::1" ||
    v6.startsWith("fc") || v6.startsWith("fd") ||
    v6.startsWith("fe80")
  );
}

async function assertPublicUrl(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("not a valid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("only http(s) URLs are audited");
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(host)) {
    if (isPrivateIp(host)) throw new Error("private addresses are not audited");
    return url;
  }
  const resolver = new Resolver();
  const addrs = await resolver.resolve4(host).catch(() => []);
  if (addrs.length === 0) throw new Error("could not resolve host");
  for (const addr of addrs) {
    if (isPrivateIp(addr)) throw new Error("private addresses are not audited");
  }
  return url;
}

// ---------- raw view ----------

async function fetchRaw(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { "user-agent": UA, accept: "text/html,application/xhtml+xml" },
      redirect: "follow",
      signal: controller.signal,
    });
    const html = await res.text();
    return { status: res.status, finalUrl: res.url || url, html };
  } finally {
    clearTimeout(timer);
  }
}

export function visibleTextFromHtml(html) {
  return html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|template)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function extractTitle(html) {
  const matches = [...html.matchAll(/<title[^>]*>([\s\S]*?)<\/title>/gi)];
  const nonEmpty = matches.map((m) => m[1].replace(/\s+/g, " ").trim()).filter(Boolean);
  return { elementCount: matches.length, nonEmptyCount: nonEmpty.length, selected: nonEmpty[0] ?? "" };
}

function extractMetaDescription(html) {
  const matches = [
    ...html.matchAll(
      /<meta[^>]+name\s*=\s*["']description["'][^>]*>/gi
    ),
  ];
  const contents = matches
    .map((m) => /content\s*=\s*["']([^"']*)["']/i.exec(m[0])?.[1]?.trim() ?? "")
    .filter(Boolean);
  return { elementCount: matches.length, nonEmptyCount: contents.length, selected: contents[0] ?? "" };
}

// Render through the already-running Windows Chrome over CDP (no extra
// browser installs needed). Opens a throwaway tab, measures, closes it.
async function renderVisibleCharsViaCdp(url) {
  const browser = await chromium.connectOverCDP(CDP_URL);
  try {
    const ctx = browser.contexts()[0];
    const page = await ctx.newPage();
    try {
      await page.goto(url, { waitUntil: "networkidle", timeout: RENDER_TIMEOUT_MS });
      await page.waitForTimeout(1200);
      const text = await page.evaluate(() => document.body?.innerText ?? "");
      return text.replace(/\s+/g, " ").trim().length;
    } finally {
      await page.close();
    }
  } finally {
    await browser.close(); // disconnects only; the real Chrome stays up
  }
}

async function renderVisibleChars(url) {
  try {
    const browser = await chromium.launch({ headless: true });
    return await renderInBrowser(browser, url);
  } catch {
    // Local chromium missing system libs or binary — fall back to CDP Chrome.
    return renderVisibleCharsViaCdp(url);
  }
}

async function renderInBrowser(browser, url) {
  try {
    const page = await browser.newPage({ userAgent: UA });
    await page.goto(url, { waitUntil: "networkidle", timeout: RENDER_TIMEOUT_MS });
    await page.waitForTimeout(1200); // settle late hydration
    const text = await page.evaluate(() => document.body?.innerText ?? "");
    return text.replace(/\s+/g, " ").trim().length;
  } finally {
    await browser.close();
  }
}

// ---------- checks (mirroring noticeai analysis.py formats) ----------

function contentRepresentationCheck(rawChars, renderedChars, representation) {
  const observed =
    `Raw visible text ${rawChars} characters; ` +
    `rendered visible text ${renderedChars} characters`;
  const delta =
    renderedChars > 0 ? Math.max(0, Math.round((1 - rawChars / renderedChars) * 100)) : 0;
  const outcome =
    representation === "rendered" && delta >= 20 ? "warning" : "pass";
  return {
    id: "content_representation",
    label: "Content representation",
    outcome,
    observed: `${observed}; raw-vs-rendered gap ${delta}%`,
    why: "Important content available only after JavaScript can be harder or more expensive for crawlers to retrieve.",
    fix: outcome === "warning" ? "Render essential page content in the initial HTML response." : null,
    delta,
  };
}

function titlePresenceCheck(titleInfo) {
  let outcome = "pass";
  let fix = null;
  if (!titleInfo.nonEmptyCount) {
    outcome = "fail";
    fix = "Add one descriptive title element that identifies this page.";
  } else if (titleInfo.nonEmptyCount > 1) {
    outcome = "warning";
    fix = "Keep one non-empty title element with the page's selected title.";
  }
  return {
    id: "title_presence",
    label: "Document title",
    outcome,
    observed: `${titleInfo.elementCount} element(s); ${titleInfo.nonEmptyCount} non-empty; selected ${titleInfo.selected.length} characters`,
    why: "The title identifies the page in search results, browser interfaces, and retrieval systems.",
    fix,
  };
}

function metaDescriptionCheck(metaInfo) {
  let outcome = "pass";
  let fix = null;
  if (!metaInfo.nonEmptyCount) {
    outcome = "warning";
    fix = "Add a concise page-specific meta description.";
  } else if (metaInfo.nonEmptyCount > 1) {
    outcome = "warning";
    fix = "Keep one meta description with the page's selected summary.";
  }
  return {
    id: "meta_description_presence",
    label: "Meta description",
    outcome,
    observed: `${metaInfo.elementCount} element(s); ${metaInfo.nonEmptyCount} non-empty`,
    why: "A page-specific summary helps people and retrieval systems decide what the page offers.",
    fix,
  };
}

function viewportMetaCheck(html) {
  const match = /<meta[^>]+name\s*=\s*["']viewport["'][^>]*>/i.exec(html);
  const content = match ? (/content\s*=\s*["']([^"']*)["']/i.exec(match[0])?.[1] ?? "") : null;
  const hasWidthDevice = Boolean(content && /width\s*=\s*device-width/i.test(content));
  const outcome = !match ? "warning" : hasWidthDevice ? "pass" : "warning";
  return {
    id: "viewport_meta",
    label: "Viewport",
    outcome,
    observed: match
      ? `present${hasWidthDevice ? " with width=device-width" : ` (${(content ?? "").slice(0, 40) || "empty content"})`}`
      : "no viewport meta tag found",
    why: "Without a viewport meta tag, mobile browsers and reader views scale the page instead of laying it out.",
    fix: outcome === "warning" ? "Add <meta name=viewport content='width=device-width, initial-scale=1'>." : null,
  };
}

function h1HeadingCheck(html) {
  const h1s = [...html.matchAll(/<h1[\s>]/gi)].length;
  const allHeadings = [...html.matchAll(/<h[1-6][\s>]/gi)].length;
  const outcome = h1s === 1 ? "pass" : "warning";
  return {
    id: "h1_presence",
    label: "H1 heading",
    outcome,
    observed: `${h1s} h1 element(s); ${allHeadings} heading(s) total`,
    why: "One clear h1 anchors what the page is about for readers, search engines, and retrieval systems.",
    fix: outcome === "warning" ? (h1s === 0 ? "Add one h1 that states the page's subject." : "Use exactly one h1; demote the rest to h2/h3.") : null,
  };
}

function imageAltCoverageCheck(html) {
  const imgs = [...html.matchAll(/<img\b[^>]*>/gi)];
  if (imgs.length === 0) {
    return {
      id: "image_alt_coverage",
      label: "Image alt text",
      outcome: "unavailable",
      observed: "no <img> elements in initial HTML",
      why: "Alt text makes images legible to screen readers and to systems that cannot render the page.",
      fix: null,
    };
  }
  const withAlt = imgs.filter((m) => /\balt\s*=\s*["'][^"']+ ["']/i.test(m[0]) || /\balt\s*=\s*["'][^"']+["']/i.test(m[0])).length;
  const coverage = Math.round((withAlt / imgs.length) * 100);
  const outcome = coverage >= 90 ? "pass" : coverage >= 50 ? "warning" : "fail";
  return {
    id: "image_alt_coverage",
    label: "Image alt text",
    outcome,
    observed: `${withAlt}/${imgs.length} images (${coverage}%) have alt text`,
    why: "Alt text makes images legible to screen readers and to systems that cannot render the page.",
    fix: outcome === "pass" ? null : `Describe the ${imgs.length - withAlt} unlabeled image(s) with alt attributes.`,
  };
}

function socialCardCheck(html) {
  const meta = (name) => {
    const m = new RegExp(`<meta[^>]+property\\s*=\\s*["']og:${name}["'][^>]*>`, "i").exec(html)
      ?? new RegExp(`<meta[^>]+name\\s*=\\s*["']${name === "card" ? "twitter:card" : name}["'][^>]*>`, "i").exec(html);
    return m ? (/content\s*=\s*["']([^"']*)["']/i.exec(m[0])?.[1]?.trim() ?? "") : null;
  };
  const parts = { title: meta("title"), description: meta("description"), image: meta("image"), card: meta("card") };
  const present = Object.values(parts).filter(Boolean).length;
  const outcome = present >= 3 && parts.image ? "pass" : present > 0 ? "warning" : "fail";
  const missing = Object.entries(parts).filter(([, v]) => !v).map(([k]) => k);
  return {
    id: "social_card",
    label: "Social card (OG)",
    outcome,
    observed: `${present}/4 card tags present${missing.length ? `; missing: ${missing.join(", ")}` : ""}`,
    why: "Open Graph tags decide how the link previews on X and other platforms; a bare URL gets no image or summary.",
    fix: outcome === "pass" ? null : `Add og:${missing[0] ?? "title"}${missing.length > 1 ? " and the other missing tags" : ""}.`,
  };
}

function structuredDataCheck(html) {
  const blocks = [...html.matchAll(/<script[^>]+type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  const types = [];
  for (const block of blocks.slice(0, 10)) {
    try {
      const parsed = JSON.parse(block[1]);
      const nodes = Array.isArray(parsed) ? parsed : [parsed, ...(parsed?.["@graph"] ?? [])];
      for (const node of nodes) {
        const t = node?.["@type"];
        if (typeof t === "string") types.push(t);
        else if (Array.isArray(t)) types.push(...t.filter((x) => typeof x === "string"));
      }
    } catch {
      types.push("invalid-json");
    }
  }
  const unique = [...new Set(types)].slice(0, 5);
  const outcome = unique.length > 0 ? "pass" : "warning";
  return {
    id: "structured_data",
    label: "Structured data",
    outcome,
    observed: unique.length ? `${blocks.length} JSON-LD block(s): ${unique.join(", ")}` : "no JSON-LD structured data found",
    why: "Structured data states explicitly what entities a page describes, which retrieval systems reward with richer surfaces.",
    fix: outcome === "warning" ? "Add JSON-LD (e.g. Organization, Article, or Product schema)." : null,
  };
}

function canonicalLinkCheck(html, finalUrl) {
  const match = /<link[^>]+rel\s*=\s*["']canonical["'][^>]*>/i.exec(html);
  const href = match ? (/href\s*=\s*["']([^"']*)["']/i.exec(match[0])?.[1] ?? "") : null;
  if (!href) {
    return {
      id: "canonical_link",
      label: "Canonical URL",
      outcome: "warning",
      observed: "no canonical link element",
      why: "A canonical link tells retrieval systems which URL to credit when the same content is reachable several ways.",
      fix: "Add <link rel=canonical> pointing at the preferred URL.",
    };
  }
  let absolute = false;
  try {
    absolute = Boolean(new URL(href, finalUrl));
  } catch {
    absolute = false;
  }
  return {
    id: "canonical_link",
    label: "Canonical URL",
    outcome: absolute ? "pass" : "warning",
    observed: `canonical present${absolute ? "" : " but not a resolvable URL"}: ${href.slice(0, 60)}`,
    why: "A canonical link tells retrieval systems which URL to credit when the same content is reachable several ways.",
    fix: absolute ? null : "Point the canonical link at an absolute URL.",
  };
}

function langAttributeCheck(html) {
  const match = /<html\b[^>]*>/i.exec(html)?.[0] ?? "";
  const lang = /\blang\s*=\s*["']([a-zA-Z-]+)["']/i.exec(match)?.[1] ?? null;
  const outcome = lang ? "pass" : "warning";
  return {
    id: "lang_attribute",
    label: "Language attribute",
    outcome,
    observed: lang ? `html lang="${lang}"` : "<html> has no lang attribute",
    why: "Declaring the page language helps screen readers pick the right voice and retrieval systems classify content.",
    fix: outcome === "warning" ? 'Add lang="en" (or the page language) to the html element.' : null,
  };
}

function httpsMixedContentCheck(html, finalUrl) {
  if (!finalUrl.startsWith("https://")) {
    return {
      id: "https_mixed_content",
      label: "HTTPS integrity",
      outcome: "fail",
      observed: "page itself served over plain HTTP",
      why: "Plain HTTP pages are tamperable in transit and are flagged down by browsers and search features.",
      fix: "Serve the site over HTTPS with a redirect from HTTP.",
    };
  }
  const insecureRefs = [...html.matchAll(/(?:src|href)\s*=\s*["']http:\/\/[^"']+["']/gi)].length;
  const outcome = insecureRefs === 0 ? "pass" : "warning";
  return {
    id: "https_mixed_content",
    label: "HTTPS integrity",
    outcome,
    observed: insecureRefs ? `${insecureRefs} insecure http:// reference(s) on an https page` : "no mixed content detected",
    why: "Browsers block or warn on http:// subresources inside https pages, breaking scripts, images, and styles.",
    fix: outcome === "warning" ? "Serve every referenced asset over HTTPS." : null,
  };
}

// ---------- robots.txt parsing (AI crawler probe + sitemaps) ----------

function parseRobotsTxt(text) {
  const groups = [];
  const sitemaps = new Set();
  let current = null;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;
    const [keyRaw, ...rest] = line.split(":");
    const key = keyRaw.trim().toLowerCase();
    const value = rest.join(":").trim();
    if (key === "user-agent") {
      if (!current || current.sealed) {
        current = { agents: [], allows: [], disallows: [], sealed: false };
        groups.push(current);
      }
      current.agents.push(value);
    } else if (key === "allow" || key === "disallow") {
      if (!current) continue;
      const list = key === "allow" ? current.allows : current.disallows;
      list.push(value);
      current.sealed = true; // later user-agent lines start a new group
    } else if (key === "sitemap" && value) {
      sitemaps.add(value);
    }
  }
  return { groups, sitemaps: [...sitemaps] };
}

function pathAllowedForAgent(robots, agentToken, path = "/") {
  // Longest-match wins within the most specific applicable group.
  const specific = robots.groups.find((g) =>
    g.agents.some((a) => a.toLowerCase() === agentToken.toLowerCase())
  );
  const wildcard = robots.groups.find((g) => g.agents.includes("*"));
  const group = specific ?? wildcard;
  if (!group || (group.allows.length === 0 && group.disallows.length === 0)) {
    return { allowed: true, basis: specific ? "explicit" : "no rules" };
  }
  let best = null; // {len, allow}
  for (const rule of [
    ...group.disallows.map((d) => ({ p: d, allow: false })),
    ...group.allows.map((a) => ({ p: a, allow: true })),
  ]) {
    if (rule.p === "") continue; // empty disallow = nothing blocked
    if (path.startsWith(rule.p)) {
      if (!best || rule.p.length > best.len) best = { len: rule.p.length, allow: rule.allow };
    }
  }
  if (!best) return { allowed: true, basis: specific ? "explicit" : "wildcard" };
  return { allowed: best.allow, basis: specific ? "explicit" : "wildcard" };
}

async function aiCrawlerAccessProbe(origin, rawHtml) {
  let robotsText = null;
  const inline = /<meta[^>]+name\s*=\s*["']robots["'][^>]*>/i.exec(rawHtml)?.[0] ?? null;
  try {
    const res = await fetch(`${origin}/robots.txt`, {
      headers: { "user-agent": UA },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (res.ok && (res.headers.get("content-type") ?? "").includes("text/plain")) {
      robotsText = await res.text();
    } else if (res.ok) {
      robotsText = await res.text(); // some servers mislabel; still parseable
    }
  } catch {
    robotsText = null;
  }

  const results = {};
  let blockedCount = 0;
  if (robotsText) {
    const robots = parseRobotsTxt(robotsText);
    for (const token of AI_CRAWLERS) {
      const verdict = pathAllowedForAgent(robots, token, "/");
      results[token] = verdict;
      if (!verdict.allowed) blockedCount += 1;
    }
    return {
      id: "ai_crawler_access",
      label: "AI crawler access (robots.txt)",
      outcome: blockedCount > 0 ? "warning" : "pass",
      observed:
        `${blockedCount} of ${AI_CRAWLERS.length} AI crawlers are disallowed at /` +
        (inline ? "; meta robots present in HTML" : ""),
      why: "AI assistants and search features retrieve pages through these crawlers; blocking changes whether a page can be surfaced or cited.",
      fix: blockedCount > 0 ? "Review robots.txt rules for the disallowed crawler tokens." : null,
      detail: results,
    };
  }
  return {
    id: "ai_crawler_access",
    label: "AI crawler access (robots.txt)",
    outcome: "pass",
    observed: `No robots.txt found${inline ? "; meta robots present in HTML" : ""}; all ${AI_CRAWLERS.length} tracked AI crawlers are unrestricted at /`,
    why: "AI assistants and search features retrieve pages through these crawlers; blocking changes whether a page can be surfaced or cited.",
    fix: null,
  };
}

async function sitemapDiscoveryCheck(origin, robotsText) {
  const declared = [];
  if (robotsText) {
    declared.push(...parseRobotsTxt(robotsText).sitemaps);
  }
  const candidates = [...new Set([...declared, `${origin}/sitemap.xml`, `${origin}/sitemap_index.xml`])].slice(0, 4);
  const found = [];
  for (const candidate of candidates) {
    try {
      const res = await fetch(candidate, {
        method: "GET",
        headers: { "user-agent": UA },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      const body = res.ok ? (await res.text()).slice(0, 500) : "";
      if (res.ok && /<(urlset|sitemapindex)/i.test(body)) {
        found.push(candidate);
      }
    } catch {
      // unreachable candidate — not found
    }
  }
  const outcome = found.length > 0 ? "pass" : "warning";
  return {
    id: "discovery_surfaces",
    label: "Optional machine-readable surfaces",
    outcome,
    observed: found.length
      ? `${found.length} sitemap(s) responded: ${found.join(", ")}`
      : `No sitemap responded at probed locations${declared.length ? " despite robots.txt declarations" : ""}`,
    why: "A sitemap helps retrieval systems discover pages beyond what crawling links alone finds.",
    fix: outcome === "warning" ? "Publish a sitemap and reference it from robots.txt." : null,
  };
}

// ---------- public API ----------

export async function runDemoChecks(rawUrl) {
  const url = await assertPublicUrl(rawUrl);

  const raw = await fetchRaw(url);
  const rawText = visibleTextFromHtml(raw.html);
  const rawChars = rawText.length;

  let renderedChars;
  let renderFailed = false;
  try {
    renderedChars = await renderVisibleChars(raw.finalUrl);
  } catch {
    renderFailed = true;
  }

  // Mirror acquisition.representation semantics: raw suffices unless rendering
  // materially adds visible text.
  let representation = "raw";
  if (!renderFailed && renderedChars > rawChars * 1.2 && renderedChars > 500) {
    representation = "rendered";
  }

  const checks = [];
  if (renderFailed) {
    checks.push({
      id: "content_representation",
      label: "Content representation",
      outcome: "unavailable",
      observed: `Raw visible text ${rawChars} characters; rendered view unavailable (likely bot protection)`,
      why: "Important content available only after JavaScript can be harder or more expensive for crawlers to retrieve.",
      fix: null,
      delta: null,
    });
  } else {
    checks.push(contentRepresentationCheck(rawChars, renderedChars, representation));
  }

  const titleInfo = extractTitle(raw.html);
  const metaInfo = extractMetaDescription(raw.html);
  checks.push(titlePresenceCheck(titleInfo));
  checks.push(metaDescriptionCheck(metaInfo));
  checks.push(viewportMetaCheck(raw.html));
  checks.push(h1HeadingCheck(raw.html));
  checks.push(imageAltCoverageCheck(raw.html));
  checks.push(socialCardCheck(raw.html));
  checks.push(structuredDataCheck(raw.html));
  checks.push(canonicalLinkCheck(raw.html, raw.finalUrl));
  checks.push(langAttributeCheck(raw.html));
  checks.push(httpsMixedContentCheck(raw.html, raw.finalUrl));

  const origin = new URL(raw.finalUrl).origin;
  const robotsRes = await fetch(`${origin}/robots.txt`, {
    headers: { "user-agent": UA },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  }).catch(() => null);
  const robotsText = robotsRes?.ok ? await robotsRes.text().catch(() => null) : null;
  checks.push(await aiCrawlerAccessProbe(origin, raw.html));
  checks.push(await sitemapDiscoveryCheck(origin, robotsText));

  return {
    url: raw.finalUrl,
    auditedAt: new Date().toISOString(),
    checks,
  };
}
