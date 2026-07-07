# llm
- Use OpenRouter as the LLM provider instead of Ollama. Confidence: 0.70
- Generated posts must be written in first-person as if the human wrote them — no AI observations, no meta-commentary like "I notice" or "I observe." Confidence: 0.70
- Prioritize output quality over speed for Zyquor content generation — when the user asks for "high quality" work, focus exclusively on that and do not split effort on tangential improvements. Confidence: 0.85

# pnpm
- Do not use the Hermes-installed pnpm; install pnpm globally via npm instead. Confidence: 0.75
- Install pnpm with the latest version (do not pin to a specific version). Confidence: 0.70

# playwright
- Playwright bundled Chromium is unsupported on Ubuntu 26.04; use system Chrome with ZYQUOR_BROWSER_CHANNEL=chrome instead. Confidence: 0.70

# browser-posting
- The automatic worker with autopost is the primary use case of Zyquor — focus all pipeline work on making it production-quality, not manual click flows. Confidence: 0.90
- ZYQUOR_ENABLE_BROWSER_POST must be enabled by default (set to 1 in .env) — the user reversed the earlier "puppeteer post is shit" stance and now wants the worker to auto-click Post out of the box. Confidence: 0.85
- Posts must not be posted sequentially; randomize timing with high variance (30-90 minutes, anti-cluster so no two consecutive gaps are within 40% of each other, ±15% jitter, anti-cluster boost when last 3 gaps have variance < 40%). Configurable via ZYQUOR_POST_GAP_MIN_MINUTES / ZYQUOR_POST_GAP_MAX_MINUTES. The spacing must actually apply at runtime — verified violation: worker posted two jobs 21 seconds apart instead of respecting the 30-90 min window. Confidence: 0.95
- Hard quality floor for autopost: only accept candidates with score.quality ≥ ZYQUOR_QUALITY_MIN (default 3) AND no AI_SLOP_PHRASES match. Yolo path picks the highest-scoring candidate, not candidates[0]. Below-threshold candidates are recorded as metadata.qualityGate with reason "all_below_quality_floor" or "ai_slop_phrase_detected" and the job is NOT approved. Confidence: 0.85
- Only high-quality, well-thought posts are accepted — no AI slop, no filler, no generic phrasing. AI_SLOP_PHRASES list (75+ phrases: "let's dive in", "delve", "tapestry", "unlock the power", etc.) is checked in validateSourcePostQuality and rejects any candidate with a substring match. Confidence: 0.90

# communication
- Explain the plan and reasoning before executing system commands or making changes — do not act without the user understanding what is happening. Confidence: 0.95
- When the user invokes `/caveman full` (or any level), maintain that terse output style for the entire session — no filler words, no articles, drop pleasantries, fragments OK, technical terms exact. Auto-drop to clear prose only for security warnings, destructive ops, multi-step sequences, or when compression creates ambiguity. Off only on "stop caveman" / "normal mode". Confidence: 0.90

# workflow
See [workflow/taste.md](workflow/taste.md)
# wsl
- For WSL2 on Windows 11, use mirrored networking mode (networkingMode=mirrored + localhostForwarding=true in .wslconfig) so Chrome CDP on 127.0.0.1 is reachable from within WSL. Confidence: 0.70
- Launch Windows Chrome from WSL by writing a PowerShell script to /tmp and invoking it via powershell.exe -ExecutionPolicy Bypass -File with a Windows-style path (convert /mnt/c/ to C:\). Do not use cmd.exe /C start — it fails from WSL UNC paths. Confidence: 0.70
- Preserve the existing Chrome user-data-dir (C:\Users\asus\zyquor-profiles\personal-main) with the logged-in session — never wipe or recreate it when relaunching Chrome CDP, the user needs the persistent login. Use `pnpm profile:x:cdp` which launches via scripts/open-x-profile-cdp.mjs; do not create ad-hoc PowerShell launch scripts. Confidence: 0.90
