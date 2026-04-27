# Source Packets Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add deterministic source packets so automated posts start from structured source data, not LLM browsing.

**Architecture:** Store compact source packets with type/title/url/summary/facts/tweet type. API can ingest manual packets and generate drafts from one packet. UI exposes packet creation and draft generation.

**Tech Stack:** TypeScript, Zod, Fastify, SQLite/JSON fallback, React, Vitest.

---

### Task 1: Core + Storage

**Files:**
- Modify: `packages/core/src/index.ts`
- Modify: `packages/storage/src/index.ts`
- Test: `packages/storage/src/index.test.ts`

- [x] Add `sourcePacketSchema`, `createSourcePacketRequestSchema`, and repository types.
- [x] Add SQLite table and JSON/memory storage support.
- [x] Add storage test for create/list/get.

### Task 2: API + Generation

**Files:**
- Modify: `apps/api/src/app.ts`
- Modify: `apps/api/src/app.test.ts`

- [x] Add `GET /source-packets`, `POST /source-packets`, `POST /source-packets/:id/draft`.
- [x] Source-packet drafting builds deterministic idea text from packet fields and passes tweet type to generation.
- [x] Add API test covering packet ingestion and draft creation.

### Task 3: UI

**Files:**
- Modify: `apps/web/src/main.tsx`
- Modify: `apps/web/src/styles.css`

- [x] Add source packet panel with source type/title/url/summary/facts/tweet type.
- [x] Show packet list and “Draft” action.
- [x] Preserve existing single/batch/yolo flows.

### Task 4: Verify

**Commands:**
- `pnpm --filter @zyquor/storage test`
- `pnpm --filter @zyquor/api test`
- `pnpm --filter @zyquor/web check`
- `pnpm check`
- `pnpm test`

- [x] Run all commands and record status in `CLAUDE.md`.

---

**Status: All tasks completed (2026-04-26).**
