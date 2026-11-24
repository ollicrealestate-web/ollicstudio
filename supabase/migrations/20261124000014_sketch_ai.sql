-- Sketch "Complete my design" (24 Nov 2026): Ollic AI sessions, the cost of every call to the assistant, and the
-- reference images people upload. Only the owner can see any of it. Run once, after 20261122000013_sketch_projects.sql.

create table if not exists public.sketch_ai_sessions (
  id            uuid primary key default gen_random_uuid(),
  owner_id      uuid not null default auth.uid() references auth.users (id) on delete cascade,
  sketch_id     uuid references public.sketch_projects (id) on delete set null,
  status        text not null default 'open' check (status in ('open', 'built', 'accepted', 'discarded', 'stopped')),
  stage         text not null default 'start' check (char_length(stage) <= 40),
  detail        text check (detail in ('light', 'medium', 'full')),
  scope         jsonb not null default '{}'::jsonb,
  chat          jsonb not null default '[]'::jsonb,   -- what was said, both ways (no images)
  refs          jsonb not null default '[]'::jsonb,   -- reference images: storage path and what Ollic AI saw in each
  plan          jsonb not null default '[]'::jsonb,
  log           jsonb not null default '[]'::jsonb,   -- commands run and their results
  report        jsonb,
  summary       jsonb,                                -- the model summary that was sent
  estimate_usd  numeric(10, 4),
  input_tokens  bigint not null default 0,
  output_tokens bigint not null default 0,
  cost_usd      numeric(12, 6) not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint sketch_ai_session_size check (pg_column_size(chat) + pg_column_size(log) <= 4 * 1024 * 1024)
);
create index if not exists sketch_ai_sessions_owner on public.sketch_ai_sessions (owner_id, created_at desc);
drop trigger if exists sketch_ai_sessions_touch on public.sketch_ai_sessions;
create trigger sketch_ai_sessions_touch before update on public.sketch_ai_sessions for each row execute function public.touch_updated_at();

create table if not exists public.sketch_ai_calls (
  id                uuid primary key default gen_random_uuid(),
  owner_id          uuid not null default auth.uid() references auth.users (id) on delete cascade,
  session_id        uuid not null references public.sketch_ai_sessions (id) on delete cascade,
  stage             text not null,
  model             text not null,
  input_tokens      int not null default 0,
  output_tokens     int not null default 0,
  cache_read_tokens int not null default 0,
  cost_usd          numeric(12, 6),
  created_at        timestamptz not null default now()
);
create index if not exists sketch_ai_calls_owner on public.sketch_ai_calls (owner_id, created_at desc);
create index if not exists sketch_ai_calls_session on public.sketch_ai_calls (session_id);

-- a call is always logged against the caller's own session
create or replace function public.sketch_ai_call_owner() returns trigger language plpgsql set search_path = '' as $$
begin
  if not exists (select 1 from public.sketch_ai_sessions s where s.id = new.session_id and s.owner_id = new.owner_id) then
    raise exception 'That session is not yours.';
  end if;
  return new;
end $$;
drop trigger if exists sketch_ai_calls_owner on public.sketch_ai_calls;
create trigger sketch_ai_calls_owner before insert on public.sketch_ai_calls for each row execute function public.sketch_ai_call_owner();

alter table public.sketch_ai_sessions enable row level security;
alter table public.sketch_ai_calls enable row level security;
drop policy if exists "own ai sessions: read" on public.sketch_ai_sessions;
drop policy if exists "own ai sessions: create" on public.sketch_ai_sessions;
drop policy if exists "own ai sessions: update" on public.sketch_ai_sessions;
drop policy if exists "own ai sessions: delete" on public.sketch_ai_sessions;
create policy "own ai sessions: read"   on public.sketch_ai_sessions for select to authenticated using (owner_id = (select auth.uid()));
create policy "own ai sessions: create" on public.sketch_ai_sessions for insert to authenticated with check (owner_id = (select auth.uid()));
create policy "own ai sessions: update" on public.sketch_ai_sessions for update to authenticated using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
create policy "own ai sessions: delete" on public.sketch_ai_sessions for delete to authenticated using (owner_id = (select auth.uid()));
drop policy if exists "own ai calls: read" on public.sketch_ai_calls;
drop policy if exists "own ai calls: create" on public.sketch_ai_calls;
create policy "own ai calls: read"   on public.sketch_ai_calls for select to authenticated using (owner_id = (select auth.uid()));
create policy "own ai calls: create" on public.sketch_ai_calls for insert to authenticated with check (owner_id = (select auth.uid()));
revoke all on public.sketch_ai_sessions, public.sketch_ai_calls from anon;
grant select, insert, update, delete on public.sketch_ai_sessions to authenticated;
grant select, insert on public.sketch_ai_calls to authenticated;

-- reference images: private, each user's own folder only
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('sketch-ai', 'sketch-ai', false, 10485760, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do nothing;
drop policy if exists "own sketch-ai folder: read" on storage.objects;
drop policy if exists "own sketch-ai folder: upload" on storage.objects;
drop policy if exists "own sketch-ai folder: delete" on storage.objects;
create policy "own sketch-ai folder: read" on storage.objects for select to authenticated
  using (bucket_id = 'sketch-ai' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "own sketch-ai folder: upload" on storage.objects for insert to authenticated
  with check (bucket_id = 'sketch-ai' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "own sketch-ai folder: delete" on storage.objects for delete to authenticated
  using (bucket_id = 'sketch-ai' and (storage.foldername(name))[1] = (select auth.uid())::text);
