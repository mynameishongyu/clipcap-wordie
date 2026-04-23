---
name: staged-commit-message
description: Generate git cz / Conventional Commit messages from the current staged changes. Use when the user asks for a commit message, wants a git-cz style commit title, or invokes this skill directly. Always inspect only the current staged diff and ignore unstaged changes.
---

# Staged Commit Message

## Overview

Generate commit messages strictly from the current staged changes.

## Workflow

1. Inspect only staged changes:
   - `git diff --cached --name-only`
   - `git diff --cached --stat`
   - `git diff --cached --unified=0`
2. If nothing is staged, say that there are no staged changes and do not invent a message.
3. Infer the best Conventional Commit / git cz type from the staged diff:
   - `feat`, `fix`, `refactor`, `chore`, `docs`, `test`, `style`, `perf`, `build`, `ci`, `revert`
4. Add a scope only when the staged files clearly point to a narrow area.
5. Write a short subject in imperative mood, lowercase, with no trailing period.
6. Prefer one recommended message and at most two alternatives.

## Output Rules

- Base the answer only on staged changes.
- Do not mention unstaged files.
- Default to a single-line commit message.
- Keep the primary suggestion concise and production-ready.
- If helpful, provide one shorter variant and one more specific variant.

## Examples

- `feat(auth): add email otp sign-in flow`
- `fix(projects): handle empty list state`
- `refactor(api): unify response envelope`
