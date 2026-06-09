# Gemini signed URL V3 tests

Standalone browser test for checking whether Gemini can read Supabase image
URLs through the AI SDK Google provider (`@ai-sdk/google`).

This folder does not change production business code.

## Install

The repository dependency is:

```powershell
pnpm add @ai-sdk/google
```

## Run

```powershell
node gemini_signed_urlV3/server.mjs
```

Open:

```text
http://localhost:8790
```

Paste one Supabase Storage path or URL per line, then click `Test with AI SDK
Google`.

Input examples:

```text
3ee82c19-eece-43f7-bd66-7354d327f089/fill-pdf-pages/.../page-1.jpg
https://xxx.supabase.co/storage/v1/object/sign/generation-pdfs/.../page-2.jpg
```

The server reads `.env.local` from the repository root and uses:

- `VISION_LLM_API_KEY`
- `VISION_LLM_MODEL`
- `VISION_LLM_BASE_URL`
- `SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `VERCEL_GEMINI_IMAGE_PROXY_TOKEN_EXPIRES_IN_SECONDS`

For this test, `VISION_LLM_MODEL` must be a Gemini model.
