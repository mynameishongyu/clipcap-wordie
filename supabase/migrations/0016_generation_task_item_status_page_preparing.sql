do $$
begin
  alter type public.generation_task_item_status add value if not exists 'page_preparing';
exception
  when duplicate_object then null;
end;
$$;
