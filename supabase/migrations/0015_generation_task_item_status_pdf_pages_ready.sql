do $$
begin
  alter type public.generation_task_item_status add value if not exists 'pdf_pages_ready';
exception
  when duplicate_object then null;
end;
$$;
