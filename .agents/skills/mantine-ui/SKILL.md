---
name: mantine-ui
description: Use when building or refactoring Mantine-based UI in this repository, including component selection, Mantine Styles API, theming, responsive layout, modal/notification patterns, and resolving Mantine-specific warnings or gotchas. Read the bundled Mantine LLM reference only for the relevant component or topic.
---

# Mantine UI

Use this skill for Mantine component work in this repository.

## Goals

- Keep UI aligned with the repo's Mantine-first approach.
- Prefer Mantine primitives before custom Tailwind-only replacements.
- Resolve Mantine-specific issues with official guidance instead of guesswork.

## Workflow

1. Read `AGENT.md` UI rules first, especially the Mantine-first guidance.
2. Inspect the existing component/theme usage in the target area before changing patterns.
3. Use Mantine components, hooks, modals, notifications, and Styles API in ways that match existing repo conventions.
4. Only load the bundled reference file when the task depends on Mantine-specific behavior, APIs, or caveats.

## Reference Usage

The official Mantine LLM reference lives at:

- `references/mantine-ui-llm.txt`

Do not load the whole file by default. Search it first for the specific topic you need, for example:

- component names like `Modal`, `Popover`, `Select`, `Image`, `SimpleGrid`
- topics like `Styles API`, `color scheme`, `next/font`, `server components`, `hydration`, `responsive`

## Repo-Specific Rules

- Prefer `@mantine/core` primitives for layout and interaction.
- Keep Tailwind usage limited to local layout or sizing adjustments.
- Route modals through the existing modal registry, not ad hoc providers.
- Use the existing notification helpers instead of inventing another toast layer.
- When styling Mantine components, prefer supported props, theme overrides, CSS variables, and Styles API over brittle DOM targeting.

## When To Read The Reference

- You are unsure which Mantine component fits the interaction.
- You need the correct styling/customization path for a Mantine component.
- You hit Mantine warnings, hydration issues, modal/popover quirks, or responsive/theme edge cases.
- You are changing Mantine theme configuration or color-scheme behavior.
