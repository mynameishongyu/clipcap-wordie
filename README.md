# ClipCap Word Production

`clipcap-word-production` is a Next.js app scaffolded to mirror the structure of `clipcap-next-production`, but oriented around AI-assisted writing workflows instead of short-form video generation.

## Getting Started

```bash
pnpm install
pnpm dev
```

Open `http://localhost:3000` to view the app.

## Current Structure

- `src/app`: App Router pages, grouped into authenticated and unauthenticated flows
- `src/components`: shared UI
- `src/config`: app metadata and theme config
- `src/providers`: Mantine and React Query providers
- `supabase`: local Supabase config and migrations placeholder
- `trigger`: async workflow placeholder

## Initial Product Direction

This scaffold starts with:

- a landing page for AI writing workflows
- an authenticated home for creating document projects
- a documents page for browsing generated assets
- a per-project workspace route
