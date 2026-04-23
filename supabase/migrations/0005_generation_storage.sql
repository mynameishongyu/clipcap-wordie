insert into storage.buckets (
  id,
  name,
  public,
  file_size_limit,
  allowed_mime_types
)
values (
  'generation-pdfs',
  'generation-pdfs',
  false,
  52428800,
  array['application/pdf']
)
on conflict (id) do update
set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists generation_pdfs_bucket_select_authenticated on storage.buckets;
create policy generation_pdfs_bucket_select_authenticated
on storage.buckets for select
to authenticated
using (id = 'generation-pdfs');

drop policy if exists generation_pdfs_object_select_own_or_admin on storage.objects;
create policy generation_pdfs_object_select_own_or_admin
on storage.objects for select
to authenticated
using (
  bucket_id = 'generation-pdfs'
  and (
    auth.uid()::text = (storage.foldername(name))[1]
    or public.is_admin(auth.uid())
  )
);

drop policy if exists generation_pdfs_object_insert_own_or_admin on storage.objects;
create policy generation_pdfs_object_insert_own_or_admin
on storage.objects for insert
to authenticated
with check (
  bucket_id = 'generation-pdfs'
  and (
    auth.uid()::text = (storage.foldername(name))[1]
    or public.is_admin(auth.uid())
  )
);

drop policy if exists generation_pdfs_object_update_own_or_admin on storage.objects;
create policy generation_pdfs_object_update_own_or_admin
on storage.objects for update
to authenticated
using (
  bucket_id = 'generation-pdfs'
  and (
    auth.uid()::text = (storage.foldername(name))[1]
    or public.is_admin(auth.uid())
  )
)
with check (
  bucket_id = 'generation-pdfs'
  and (
    auth.uid()::text = (storage.foldername(name))[1]
    or public.is_admin(auth.uid())
  )
);

drop policy if exists generation_pdfs_object_delete_own_or_admin on storage.objects;
create policy generation_pdfs_object_delete_own_or_admin
on storage.objects for delete
to authenticated
using (
  bucket_id = 'generation-pdfs'
  and (
    auth.uid()::text = (storage.foldername(name))[1]
    or public.is_admin(auth.uid())
  )
);
