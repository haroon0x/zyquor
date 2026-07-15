# workflow
- Research first, present options clearly, then wait for the user's decision before proceeding with execution. Confidence: 0.90
- Execute commands and changes directly — do not ask the user to manually run scripts or commands in their terminal. Confidence: 0.75
- Start Zyquor services using the `./zyquor` script rather than running individual pnpm processes for each service. Confidence: 0.65
- Do not start the automatic posting worker for Zyquor until the user explicitly says so; verify setup runs cleanly first and only begin auto-posting when the user requests it. Confidence: 0.85
- Before creating new scripts or solving problems from scratch, search the codebase (grep for keywords, check scripts/, package.json scripts, docs/ and **all .md files including docs/notes/**) for existing solutions — the user has already implemented working approaches and often documents them in markdown notes. Confidence: 0.95
- When the user says "do it the same way you did it earlier" or similar, stop debugging/inventing new approaches and reuse the previously working method — do not try portproxies, alternative IPs, or new PowerShell commands when an existing path is known to work. Confidence: 0.95
- Before declaring work complete, run an explicit self-verification loop: find loopholes/silent failure modes, fix them, retest until factually 100% confident — do not declare done after the first passing build or "looks right" assumption. Then run the actual end-to-end workflow (e.g. worker, smoke script) before reporting back. Confidence: 0.75
