# Gemini Signed URL Test

This folder is a small, isolated test harness for checking whether Gemini can
read a Supabase signed URL when it is passed as native `file_data.file_uri`.

The folder name intentionally follows the requested spelling:
`gemini_singed_url`.

## What It Tests

The script mirrors the production signed URL path:

1. Use an existing Supabase signed URL, or create one from a Supabase storage
   path.
2. Verify the URL is readable from this machine.
3. Call Gemini `generateContent` with:

```json
{
  "file_data": {
    "mime_type": "image/jpeg",
    "file_uri": "https://...supabase.co/storage/v1/object/sign/..."
  }
}
```

If step 2 succeeds but step 3 fails with `Cannot fetch content from the
provided URL`, the URL is valid but Gemini's server-side fetch cannot read it.

## Test With A Logged Signed URL

PowerShell:

```powershell
$env:GEMINI_SIGNED_URL_TEST_URL='PASTE_THE_FILE_URI_FROM_LOGS_HERE'
node .\gemini_singed_url\test-gemini-signed-url.mjs
```

Optional MIME override:

```powershell
$env:GEMINI_SIGNED_URL_TEST_MIME_TYPE='image/jpeg'
node .\gemini_singed_url\test-gemini-signed-url.mjs
```

## Test In A Browser Page

Start the local test server:

```powershell
node .\gemini_singed_url\server.mjs
```

Then open:

```text
http://localhost:8787
```

The page shows the currently loaded `VISION_LLM_MODEL` at the top. If you edit
`.env.local`, restart `server.mjs` and refresh the page.

## Test An ngrok Proxy Signed URL

Use this when you want to test whether Gemini can read an app-owned signed URL
instead of a Supabase signed URL.

Terminal 1:

```powershell
node .\gemini_singed_url\server.mjs
```

Terminal 2:

```powershell
ngrok http 8787
```

Copy the HTTPS forwarding URL shown by ngrok, for example:

```text
https://abc123.ngrok-free.app
```

Open the local browser page:

```text
http://localhost:8787
```

Then fill:

- `Test mode`: `ngrok proxy signed URL`
- `Supabase signed URL`: leave empty
- `Storage path`: paste the Supabase storage path from logs
- `ngrok public base URL`: paste the ngrok HTTPS forwarding URL
- `Bucket`: usually `generation-pdfs`
- `MIME type`: usually `image/jpeg`

The test server creates a short-lived signed proxy URL like:

```text
https://abc123.ngrok-free.app/proxy-image?token=...
```

Gemini receives that proxy URL as `file_data.file_uri`. The proxy endpoint then
streams the Supabase object back to Gemini.

Paste either:

- a logged Supabase signed URL into `Supabase signed URL`
- or a logged `storage_path` into `Storage path`

The browser page calls the local test server. This keeps `SUPABASE_SERVICE_ROLE_KEY`
and the Gemini API key on your machine instead of exposing them in browser code.

## Test By Generating A Fresh Supabase Signed URL

Use the `storage_path` from production logs:

```powershell
node .\gemini_singed_url\test-gemini-signed-url.mjs `
  --storage-path "58166df4-9d8a-40ef-9ea6-78ac45f52393/fill-pdf-pages/99f87a8f-e781-4a3d-882d-25d0ebf4c641/page-3.jpg"
```

By default, the script reads `.env.local` and uses:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `VERCEL_GEMINI_IMAGE_PROXY_TOKEN_EXPIRES_IN_SECONDS`
- `VISION_LLM_MODEL`
- `VISION_LLM_BASE_URL`
- `VISION_LLM_API_KEY`

You can override the Gemini model:

```powershell
$env:GEMINI_SIGNED_URL_TEST_MODEL='gemini-3-flash-preview'
node .\gemini_singed_url\test-gemini-signed-url.mjs --url "PASTE_URL"
```

## How To Interpret Results

- `Local fetch: OK` and `Gemini fetch: OK`
  - Gemini can read the signed URL.

- `Local fetch: OK` and `Gemini fetch: FAILED`
  - The signed URL is valid for normal HTTP clients, but Gemini cannot fetch it.
  - This matches production `Cannot fetch content from the provided URL`.

- `Local fetch: FAILED`
  - The signed URL itself, storage object, or permissions are invalid.

The script prints HTTP status, content type, byte size, Gemini status, and the
raw Gemini error text when available.
