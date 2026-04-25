# Architecture Notes

Zyquor starts as a single-account, review-first local app. The first proof point is:

```text
idea -> LLM draft candidates -> review/edit -> approved job -> Chrome profile -> X compose insertion
```

The implementation is split so browser automation cannot accidentally depend on generation logic, and account profile mapping stays explicit.

## Package Boundaries

- `@zyquor/core`: domain types, validation schemas, lifecycle rules.
- `@zyquor/accounts`: account config helpers and profile safety rules.
- `@zyquor/generation`: mock, Ollama, and Gemini provider-backed draft generation.
- `@zyquor/storage`: SQLite schema, migrations, repositories.
- `@zyquor/browser`: Playwright prepare/post flows.
- `@zyquor/voice`: future voice input surface.

## Current Safety Defaults

- Browser prepare is implemented as the first automation path; final post clicking remains out of scope until compose insertion is proven.
- Prepare flow is represented as an explicit stub.
- Dedicated profile directories are ignored by Git.
- Job state transitions are explicit and tested in core.

## Generation Boundary

Only `@zyquor/generation` knows provider wire formats. API selects provider from env, UI reads `/generation`, storage persists only generated candidates and provider metadata in `score`.

Supported providers:

- `mock`: deterministic offline candidates for tests and local UI work.
- `ollama`: local `POST /api/generate`, non-streaming JSON response.
- `gemini`: Google Gemini `models/{model}:generateContent`, JSON response config.
