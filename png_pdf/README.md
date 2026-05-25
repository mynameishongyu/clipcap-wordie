# Supabase PDF -> PNG -> PDF

This folder contains a local conversion tool for checking how a PDF stored in
Supabase looks after being rasterized into PNG pages and rebuilt as a PDF.

## HTML page

Run from the project root:

```powershell
node png_pdf/server.mjs
```

Open:

```text
http://127.0.0.1:8042
```

Paste the Supabase Storage PNG folder prefix into the page and click the
generate button. The page calls the same converter script and shows links to the
rebuilt PDF and manifest.

## Usage

Run from the project root:

```powershell
node png_pdf/convert-supabase-pdf.mjs --path "user-id/path/to/file.pdf"
```

Or resolve the source PDF from a generation task item:

```powershell
node png_pdf/convert-supabase-pdf.mjs --task-item-id "00000000-0000-0000-0000-000000000000"
```

If you already have PNG pages in a Supabase Storage folder, pass the folder
prefix directly. The objects do not need a `.png` suffix; the script downloads
objects under the prefix and keeps the ones that can be decoded as images.

```powershell
node png_pdf/convert-supabase-pdf.mjs --png-prefix "58166df4-.../template-extraction-pages/task/865e18aa-1094-4d20-8bb6-..."
```

Optional flags:

```powershell
node png_pdf/convert-supabase-pdf.mjs `
  --path "user-id/path/to/file.pdf" `
  --bucket generation-pdfs `
  --scale 3 `
  --page-width 595 `
  --page-height 842 `
  --out png_pdf/output/my-run `
  --upload-path "user-id/png-pdf-tests/rebuilt.pdf"
```

## Output

Each run writes:

- `source.pdf`: the downloaded Supabase PDF.
- `pages/page-001.png`, `pages/page-002.png`, ...: rendered PNG pages.
- `rebuilt-from-png.pdf`: a PDF rebuilt from those PNG page images.
- `manifest.json`: source path, render settings, page sizes, and output paths.

For `--png-prefix` runs, `source.pdf` is not written because the input is already
PNG pages from Storage.

## Environment

The script reads `.env.local` automatically. It needs:

```env
NEXT_PUBLIC_SUPABASE_URL=...
SUPABASE_SERVICE_ROLE_KEY=...
```

If the object is publicly readable, an anon/publishable key may work, but the
service role key is the reliable option for private Storage objects and
`--task-item-id` database lookup.
