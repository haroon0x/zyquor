# Spec: X home-feed observation lane (x-feed)

## Goal

New automated lane: deterministically fetch the user's X home feed (15-20 tweets from
other people), bundle them into one digest source packet, and draft a standalone
`feed_observation` tweet from them. The model receives: the feed tweets + the existing
shared prompt (authenticity rules, voice references, banned phrases, AI-slop list) +
the account's style profile (tone, rules, example posts, systemPromptExtra) + standing
system feedback + the `feed_observation` style contract. All of that already happens
automatically because the digest flows through the standard source-packet → draft
pipeline (`draftFromSourcePacket` → `generateDraftCandidates`).

Output posts must be standalone observations: never quote/name/link a specific tweet
or author.

## File changes (in order)

### 1. packages/core/src/index.ts
- Move `"feed_observation"` from `LEGACY_TWEET_TYPES` (line 21-28) to `TWEET_TYPES`
  (line 13-19), appended after `narrative_history`.
- Add `"x-feed"` to `SOURCE_TYPES` (line 40-49), appended.

### 2. packages/browser/src/index.ts — new `fetchXHomeFeed`
Add exported types and function in this single-file package (it may use the private
helpers: `openPersistentContext` (L383), `pageForSessionCheck` (L256), `assertNotLoginPage` (L195)).

```ts
export interface XFeedTweet {
  id: string;               // numeric tweet id from status URL
  authorHandle: string;     // no leading @
  authorName: string;
  text: string;
  url: string;              // https://x.com/<handle>/status/<id>
  publishedAt: string | null; // ISO from <time datetime>
  isRetweet: boolean;
}

export interface FetchXHomeFeedInput {
  profileDir: string;
  maxTweets?: number;        // default 20
  minTweets?: number;        // default 15; throw if fewer
  scrolls?: number;          // default 8; maximum scroll attempts before one reload retry
  browserChannel?: string | null;
  cdpUrl?: string;
  headless?: boolean;
  xHomeUrl?: string;
  actionDelayMs?: number;    // default 1500 between scrolls
  artifactsDir?: string;     // default dataPath("data","artifacts")
}

export interface FetchXHomeFeedResult {
  tweets: XFeedTweet[];
  url: string;
}
```

Behavior:
- `openPersistentContext({ profileDir, cdpUrl, browserChannel, headless, autoLaunchCdp: false })`
  — refuse to auto-launch (same policy as `checkXLogin`; error message when CDP is
  configured but down should follow the existing wording "Refusing to launch...").
- Home-page guard: if the reused X tab is not on `/home`, navigate it to `xHomeUrl` before
  extracting the feed.
- Collection loop: extract the visible tweets, then scroll until at least `minTweets` are
  collected or `scrolls` attempts are used. Keep a URL-keyed collection across scrolls so
  virtualized feed rows do not discard tweets already seen. If the minimum is still not
  met, reload the page once and repeat the bounded collection loop.
- Each scroll uses `page.mouse.wheel(0, 2400)` plus `page.waitForTimeout(actionDelayMs)`.
- Parse: `page.locator('article[data-testid="tweet"]')` → single `evaluateAll` over
  elements, extracting per article:
  - status URL: first `a[href*="/status/"]` href; skip article if absent. Normalize via
    `extractStatusPermalink`.
  - id: trailing digits of the status URL.
  - authorHandle: first path segment of the status URL.
  - authorName: from `[data-testid="User-Name"]` textContent, strip trailing `@handle`,
    fall back to handle.
  - text: `[data-testid="tweetText"]` textContent, trimmed; skip if empty.
  - publishedAt: `time[datetime]` attribute value or null.
  - isRetweet: article contains `[data-testid="socialContext"]` or header text matching
    `/reposted/i`; keep retweets in the list but flagged.
- Skip promoted, sponsored, and advertisement-labelled articles. Dedupe by url (first
  occurrence wins), slice to maxTweets.
- If `tweets.length < minTweets` → throw `BrowserFeedError` (new class extending the
  exported `BrowserPrepareError`, message prefix "X home feed fetch failed") carrying a
  screenshot artifact written to `artifactsDir` named `feed-<ISO>.png` (reuse the
  preparePost screenshot pattern, L459-526).
- Close the context if `ownsContext` (same pattern as checkXLogin).
- No clicks, no engagement, read-only scroll only. Do not auto-launch Chrome.

### 3. packages/adapters/src/x-feed.ts (new) + index.ts export
```ts
export interface XFeedAdapterOptions {
  fetchHomeFeed: (input: { profileDir: string; maxTweets?: number }) => Promise<{ tweets: XFeedTweet[]; url: string }>;
  resolveProfileDir: (accountId: string) => Promise<string | null>;
}
export function createXFeedAdapter(options: XFeedAdapterOptions): SourceAdapter
```
- `name: "x-feed"`, `sourceType: "x-feed"`.
- `fetch(configMetadata)`:
  - `accountId = configMetadata?.accountId` — throw if not a string
    ("x-feed adapter requires accountId in config metadata").
  - `profileDir = await resolveProfileDir(accountId)`; throw if null
    ("No profile dir for account ...").
  - `{ tweets } = await fetchHomeFeed({ profileDir, maxTweets: 20 })`.
  - Return ONE digest `SourceItem`:
    - title: `X home feed observations <YYYY-MM-DD>` (local date of `new Date()`).
    - url: `https://x.com/home#zyquor-digest-<YYYY-MM-DD>` (unique per day for the
      duplicate-URL checks).
    - content: tweets joined by newline as `<@handle>: <text>` (skip empty text).
    - metadata: `{ source: "x-feed", published: <now ISO>, type: "feed_observation",
      tweets: tweets.map(t => ({ id, authorHandle, authorName, text, url, publishedAt, isRetweet })) }`.
- `@zyquor/browser` dep: type-only import of `XFeedTweet` (add to package.json
  dependencies — browser does NOT depend on adapters, no cycle).
- Export `createXFeedAdapter` from `packages/adapters/src/index.ts`.

### 4. packages/automation/src/selection.ts
- Remove the `feed_observation: "useful_info"` entry from `TWEET_TYPE_ALIASES` (line 13).

### 5. packages/automation/src/routing.ts
- Add branch in `routeTweetType` (after the `job` branch, before/after the `feed`
  branch): `if (sourceType === "x-feed") return "feed_observation";`

### 6. packages/automation/src/context.ts
- Add `packetFieldsFromFeedDigest(item: SourceItem)`:
  - facts: item.content split on "\n", trim, dedupe, truncate each to 500 via
    `truncateText`, take first 8.
  - summary: first 8 lines joined with " · ", truncated to 2000 via truncateText.
  - title: `truncateText(item.title, 240)`.
  - Export it.

### 7. packages/automation/src/ingest.ts
- Line 355: `adapter.fetch({ ...config.metadata, accountId: config.accountId })`.
- Line 356: skip the on-topic filter for x-feed:
  `const onTopic = config.sourceType === "x-feed" ? fresh : fresh.filter((item) => isOnTopicSourceItem(item));`
- Line 395: use digest fields for x-feed:
  `const fields = config.sourceType === "x-feed" ? packetFieldsFromFeedDigest(enriched) : packetFieldsFromItem(enriched);`
  (keep the `hasEnoughSourceContext` check as-is — the digest passes it).

### 8. packages/generation/src/prompts.ts
- Remove `feed_observation: "useful_info"` from `TYPE_ALIASES` (line 43).
- Add to `STYLE_CONTRACTS`:
```ts
feed_observation: {
  name: "Feed observation",
  instruction: "You have recent posts from the X home feed. Find one notable pattern, gap, or shift across them and write a standalone observation about it — your own take, not a reply and not a recap. Never quote, name, or link a specific post or author. The post must make sense on its own, with no reference at all.",
  qualityBar: "The reader sees something the feed shows but no single post says. A recap, a paraphrase of one post, a headline, or a generic hot take does not pass.",
  insightDirection: "Find the pattern, tension, or gap across the supplied posts that is worth noticing. Prefer an observation that survives without naming its source."
}
```
- In `packages/generation/src/harness.ts` `buildSourceTweetInput`: when
  `packet.sourceType === "x-feed"`, render the intro line as "Recent posts from the X
  home feed:" instead of the generic "Source:" line (read harness.ts first; only make
  this change if it is a small, local edit — skip otherwise).

### 9. apps/api/src/app.ts
- `createDefaultSourceAdapters()` (line 33) gains an options param
  `{ repository: Promise<ZyquorRepository>, browserChannel?: string | null, cdpUrl?: string }`
  and adds `createXFeedAdapter({...})` to the returned array:
  - `resolveProfileDir: async (accountId) => { const repo = await repository; const account = await repo.getAccount(accountId); return account?.profileDir ? resolveProfileDir(account.profileDir) : null; }`
    (import `resolveProfileDir` from `./lib/paths.js` — check its signature first).
  - `fetchHomeFeed: async (input) => { const browser = await import("@zyquor/browser"); return browser.fetchXHomeFeed({ ...input, browserChannel, cdpUrl }); }`
  - Call site line 45: `createDefaultSourceAdapters({ repository: repositoryPromise, browserChannel: options.browserChannel, cdpUrl: options.browserCdpUrl })`.

### 10. apps/web/src/components/AutomationPanel.tsx
- Remove `feed_observation: "useful_info"` from `legacyTweetTypeAliases` (line 9).
- Add `<option value="x-feed">X home feed observations</option>` to the Live source
  select (line 127-131).
- Check `tweetTypeOptions` in `apps/web/src/types.js` — if `feed_observation` is not
  already included, add it (it may derive from an API payload instead; read the file
  and handle accordingly).
- Metadata already only includes feedUrl for sourceType "feed" — x-feed sends `{}`,
  fine.

### 11. Tests (minimal, per repo rules)
- `packages/automation/src/routing.test.ts`: add case — sourceType "x-feed" routes to
  "feed_observation".
- `packages/adapters/src/x-feed.test.ts` (new): inject fake `fetchHomeFeed` and
  `resolveProfileDir`; assert digest item shape (title date, unique url, content lines,
  metadata.published, metadata.type, metadata.tweets length).
- `packages/browser/src/index.test.ts`: if the existing chromium-based test pattern
  works in this environment, add a parse test rendering a data: URL page with
  `article[data-testid="tweet"]` markup (tweetText, status link, User-Name, time);
  skip gracefully if bundled chromium is unavailable (same pattern as existing test).

## Constraints
- No comments in code (repo rule).
- No auto-launching Chrome from the feed fetch; failure → cooldown is handled by the
  existing source-health mechanism (adapter name "x-feed").
- Keep changes small and tied to this feature; do not refactor unrelated code.
- LLM never browses: the browser fetch is deterministic and read-only.

## Verification
- `pnpm check` (typecheck), `pnpm test` — must pass.
- Report exact blockers if any verification can't run.
