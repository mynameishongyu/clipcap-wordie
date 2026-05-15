update storage.buckets
set
  allowed_mime_types = array[
    'application/pdf',
    'image/png',
    'image/jpeg',
    'image/webp',
    'text/plain'
  ]
where id = 'generation-pdfs';
