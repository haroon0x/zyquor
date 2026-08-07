import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { assertDedicatedProfileDir } from "@zyquor/accounts";
import { parseReplyTargetUrl, type ReplyTarget } from "@zyquor/core";
import { accountGenerationContext, normalizeTweetType } from "@zyquor/automation";
import type { DraftGenerationProvider } from "@zyquor/generation";
import type { AppDeps } from "../deps.js";
import type { ZyquorRepository } from "@zyquor/storage";
import { HttpError } from "../lib/errors.js";
import { browserOptions } from "../lib/browser.js";
import { resolveProfileDir } from "../lib/paths.js";

const fromUrlSchema = z.object({
  accountId: z.string().optional().default("account_personal"),
  url: z.string().url()
});

function isAdPost(tweet: { isPromoted?: boolean; hasLink?: boolean }): boolean {
  return Boolean(tweet.isPromoted) || Boolean(tweet.hasLink);
}

function targetFromTweet(tweet: {
  id: string;
  authorHandle: string;
  authorName: string;
  text: string;
  url: string;
  isPromoted?: boolean;
  hasLink?: boolean;
}): ReplyTarget {
  return {
    tweetId: tweet.id,
    authorHandle: tweet.authorHandle,
    url: tweet.url,
    authorName: tweet.authorName,
    text: tweet.text
  };
}

async function accountProfile(
  repository: Promise<ZyquorRepository>,
  accountId: string
): Promise<{ accountId: string; profileDir: string }> {
  const repo = await repository;
  const account = await repo.getAccount(accountId);
  if (!account) {
    throw new HttpError(404, "Account not found");
  }
  assertDedicatedProfileDir(account.profileDir);
  return { accountId: account.id, profileDir: resolveProfileDir(account.profileDir) };
}

export function registerRepliesRoutes(app: FastifyInstance, deps: AppDeps): void {
  const accountIdFrom = (value: unknown) => (typeof value === "string" && value.length ? value : "account_personal");

  app.get("/replies/feed", async (request, reply) => {
    const accountId = accountIdFrom((request.query as { accountId?: unknown }).accountId);
    const { profileDir } = await accountProfile(deps.repository, accountId);
    const browser = await import("@zyquor/browser");
    try {
      const result = await browser.fetchXHomeFeed({
        profileDir,
        maxTweets: 30,
        minTweets: 5,
        scrolls: 4,
        ...browserOptions(deps)
      });
      const seen = new Set<string>();
      const accounts = new Map<string, { authorHandle: string; authorName: string }>();
      let adsSkipped = 0;
      const tweets = result.tweets.filter((tweet) => {
        if (isAdPost(tweet)) {
          adsSkipped += 1;
          return false;
        }
        if (seen.has(tweet.url)) return false;
        seen.add(tweet.url);
        const key = `@${tweet.authorHandle}`;
        if (!accounts.has(key)) {
          accounts.set(key, { authorHandle: tweet.authorHandle, authorName: tweet.authorName });
        }
        return true;
      });
      return { url: result.url, tweets, accounts: Array.from(accounts.values()), adsSkipped };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown feed scan error";
      return reply.code(502).send({ error: message });
    }
  });

  app.post("/replies/from-url", async (request, reply) => {
    const input = fromUrlSchema.parse(request.body);
    if (!parseReplyTargetUrl(input.url)) {
      return reply.code(400).send({ error: "url must be a valid x.com or twitter.com post URL" });
    }
    const { accountId, profileDir } = await accountProfile(deps.repository, input.accountId);
    const browser = await import("@zyquor/browser");
    let fetched;
    try {
      fetched = await browser.fetchTweet({
        profileDir,
        url: input.url,
        ...browserOptions(deps)
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown tweet fetch error";
      return reply.code(502).send({ error: message });
    }
    const replyTo = targetFromTweet(fetched.tweet);
    if (isAdPost(fetched.tweet)) {
      return reply
        .code(400)
        .send({ error: "That post looks like an advertisement (it is tagged as promoted or contains a link). Nothing to reply to." });
    }
    const MAX_REPLY_SOURCE = 2_500;
    if (replyTo.text && replyTo.text.length > MAX_REPLY_SOURCE) {
      replyTo.text = `${replyTo.text.slice(0, MAX_REPLY_SOURCE).trimEnd()}…`;
    }

    const repository = await deps.repository;
    const history = await repository.listPostHistory();
    if (history.some((post) => post.accountId === accountId && post.sourceUrl === replyTo.url)) {
      return reply.code(409).send({ error: "This tweet was already posted to in the past" });
    }

    const created = await repository.createDraft({
      accountId,
      sourceInput: replyTo.text ?? replyTo.url,
      replyTo,
      metadata: { yolo: false, autopost: false, count: 1, tweetType: "reply" }
    });

    const context = await accountGenerationContext(repository, accountId);
    const generationInput = {
      idea: created.draft.sourceInput,
      count: 1,
      preserveCase: true,
      ...context,
      tweetType: normalizeTweetType("reply"),
      replyContext: {
        authorHandle: replyTo.authorHandle,
        url: replyTo.url,
        ...(replyTo.authorName ? { authorName: replyTo.authorName } : {}),
        ...(replyTo.text ? { text: replyTo.text } : {})
      }
    };
    const candidates = await deps.generationProvider.generateDraftCandidates(generationInput);
    const updated = await repository.saveDraftCandidates(
      created.draft.id,
      candidates.map((candidate) => ({ ...candidate, text: candidate.text }))
    );

    return reply.code(201).send({ draft: updated.draft, candidates: updated.candidates, replyTo });
  });

  app.get("/replies/drafts", async (request, reply) => {
    const accountId = accountIdFrom((request.query as { accountId?: unknown }).accountId);
    const repository = await deps.repository;
    const drafts = (await repository.listDrafts(accountId)).filter((draft) => Boolean(draft.replyTo));
    return { drafts };
  });
}
