# Rudy development rules

## Scope

- Rudy is an independent TypeScript application. Consume pi through pinned npm dependencies.
- Do not restore the pi monorepo, copy its release workflows, or directly merge upstream.
- Do not add GitHub Actions workflows. Run checks and tests locally.
- `src/agent.ts` assembles pi; application features belong in Rudy's own modules.
- Keep the first version small. Background jobs, memory and notifications are future work.

## Communication

- Keep replies concise and technical. Answer questions before implementation.
- Say whether you agree or disagree when responding to feedback.
- Explain non-trivial changes through the problem, a concrete example, and the solution.
- No emojis in code, commits, issues or PR comments.

## Code

- Read files fully before editing. Keep changes focused.
- Use strict TypeScript with erasable syntax and top-level imports; no dynamic imports.
- Avoid `any` and unnecessary casts. Check installed dependency types before using APIs.
- Inline single-line helpers with one call site.
- Never remove functionality to resolve dependency type errors; update the dependency instead.
- Ask before removing intentional functionality unless its removal is already authorized.
- Never put credentials in source, logs, tests or committed configuration.
- Keep model-visible file access within the configured workspace. Test boundary changes.

## Dependencies and validation

- Pin direct dependencies to exact versions.
- Install with `npm install --ignore-scripts`; clean installs use `npm ci --ignore-scripts`.
- After dependency metadata changes, refresh with `npm install --package-lock-only --ignore-scripts`.
- Review lifecycle scripts before explicitly allowing any to run.
- Read target release notes before changing a direct `undici` dependency.
- Run `npm run check` after code changes and fix all reported issues.
- Run `npm run test:unit` for offline tests; run every test file you create or modify.
- Never run `npm test` without the user's request. Never use real model APIs in tests.
- Re-read changed files before reporting completion.
- Write ad-hoc scripts to temporary files, execute them, then remove them.

## Git

- Never commit or push unless requested.
- Other sessions may share this checkout. Preserve changes made by others.
- Stage only explicit paths changed in this session; never use `git add .` or `git add -A`.
- Never use destructive cleanup, `git stash`, force push, or bypass commit checks.
- Keep the original pi license notice. Preserve Git history when restructuring.
- Use concise commit messages beginning with `feat:`, `fix:` or `docs:`.
- Do not send messages or post issue/PR comments without explicit authorization.

## User override

If a user request conflicts with these rules, ask for explicit confirmation before overriding.
