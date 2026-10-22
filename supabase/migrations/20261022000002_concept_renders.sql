-- Ollic Design Studio, Phase 2: concept renders (brief Module C), jobs and usage records.
-- Same two layers as Phase 1: the API checks ownership in code, and row-level
-- security limits every table and the storage bucket to the owner's own rows.
--
-- Phase 2 runs render jobs inside the web service, acting as the signed-in user, so
-- users can insert and update their own job rows. Phase 7 (billing) moves job and
-- usage writes to a background worker with its own key and removes those grants.

-- ---------------------------------------------------------------- jobs
create table public.jobs (
  id               uuid primary key default gen_random_uuid(),
  project_id       uuid not null references public.projects (id) on delete cascade,
  owner_id         uuid not null default auth.uid() references auth.users (id) on delete cascade,
  type             text not null check (type in ('concept_render', 'concept_edit')),
  status           text not null default 'queued' check (status in ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  stage            text check (char_length(stage) <= 200),
  input            jsonb not null default '{}'::jsonb,
  result           jsonb,
  error            text check (char_length(error) <= 1000),
  attempts         integer not null default 0 check (attempts >= 0),
  idempotency_key  text check (char_length(idempotency_key) between 8 and 200),
  worker           text check (char_length(worker) <= 200),
  created_at       timestamptz not null default now(),
  started_at       timestamptz,
  finished_at      timestamptz,
  updated_at       timestamptz not null default now(),
  constraint jobs_idempotency_unique unique (owner_id, idempotency_key)
);
create index jobs_project_created_idx on public.jobs (project_id, created_at desc);
create trigger jobs_touch before update on public.jobs for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------- rendered images
create table public.rendered_images (
  id               uuid primary key default gen_random_uuid(),
  project_id       uuid not null references public.projects (id) on delete cascade,
  owner_id         uuid not null default auth.uid() references auth.users (id) on delete cascade,
  job_id           uuid references public.jobs (id) on delete set null,
  kind             text not null check (kind in ('concept', 'model')),
  label            text not null,
  storage_path     text not null unique,
  base_path        text unique,          -- unlabelled copy, used as the base for revisions
  parent_image_id  uuid references public.rendered_images (id) on delete set null,
  source_file_id   uuid references public.source_files (id) on delete set null,
  prompt           text not null check (char_length(prompt) <= 4000),
  options          jsonb not null default '{}'::jsonb,
  model            text not null,
  width            integer check (width > 0),
  height           integer check (height > 0),
  created_at       timestamptz not null default now(),
  constraint rendered_images_path_in_owner_folder check (split_part(storage_path, '/', 1) = owner_id::text and split_part(storage_path, '/', 2) = project_id::text),
  constraint rendered_images_base_in_owner_folder check (base_path is null or (split_part(base_path, '/', 1) = owner_id::text and split_part(base_path, '/', 2) = project_id::text)),
  constraint rendered_images_concepts_labelled check (kind <> 'concept' or label ilike '%concept%')
);
create index rendered_images_project_idx on public.rendered_images (project_id, created_at desc);

-- ---------------------------------------------------------------- usage (cost of every provider call)
create table public.usage_events (
  id                  uuid primary key default gen_random_uuid(),
  owner_id            uuid not null default auth.uid() references auth.users (id) on delete cascade,
  project_id          uuid references public.projects (id) on delete set null,  -- kept after a project is deleted
  job_id              uuid references public.jobs (id) on delete set null,
  provider            text not null check (provider in ('openai')),
  model               text not null,
  operation           text not null check (operation in ('image_generate', 'image_edit')),
  input_text_tokens   integer not null default 0 check (input_text_tokens >= 0),
  input_image_tokens  integer not null default 0 check (input_image_tokens >= 0),
  output_tokens       integer not null default 0 check (output_tokens >= 0),
  cost_usd            numeric(12, 6) check (cost_usd >= 0),   -- null when the provider did not report usage
  price_source        text,
  raw_usage           jsonb,
  provider_request_id text,
  created_at          timestamptz not null default now()
);
create index usage_events_owner_created_idx on public.usage_events (owner_id, created_at desc);

-- rows that hang off a project must have the project's owner
create function public.row_owner_matches_project() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.project_id is not null and not exists (select 1 from public.projects p where p.id = new.project_id and p.owner_id = new.owner_id) then
    raise exception 'owner must match project owner';
  end if;
  return new;
end $$;
create trigger jobs_owner_check before insert or update on public.jobs for each row execute function public.row_owner_matches_project();
create trigger rendered_images_owner_check before insert or update on public.rendered_images for each row execute function public.row_owner_matches_project();
create trigger usage_events_owner_check before insert on public.usage_events for each row execute function public.row_owner_matches_project();

-- ---------------------------------------------------------------- row-level security
alter table public.jobs enable row level security;
alter table public.rendered_images enable row level security;
alter table public.usage_events enable row level security;

create policy "own jobs: read"   on public.jobs for select to authenticated using (owner_id = (select auth.uid()));
create policy "own jobs: create" on public.jobs for insert to authenticated
  with check (owner_id = (select auth.uid()) and exists (select 1 from public.projects p where p.id = project_id and p.owner_id = (select auth.uid())));
create policy "own jobs: update" on public.jobs for update to authenticated
  using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
-- the owner, project, type and input of a job never change after it is created
revoke update on public.jobs from anon, authenticated;
grant update (status, stage, result, error, attempts, worker, started_at, finished_at) on public.jobs to authenticated;

create policy "own renders: read"   on public.rendered_images for select to authenticated using (owner_id = (select auth.uid()));
create policy "own renders: create" on public.rendered_images for insert to authenticated
  with check (owner_id = (select auth.uid()) and exists (select 1 from public.projects p where p.id = project_id and p.owner_id = (select auth.uid())));
create policy "own renders: delete" on public.rendered_images for delete to authenticated using (owner_id = (select auth.uid()));
-- no update policy: a render is never changed; a revision is a new row

create policy "own usage: read"   on public.usage_events for select to authenticated using (owner_id = (select auth.uid()));
create policy "own usage: create" on public.usage_events for insert to authenticated with check (owner_id = (select auth.uid()));
-- no update or delete policy: usage records are append-only

-- ---------------------------------------------------------------- private bucket for renders
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('renders', 'renders', false, 26214400, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do nothing;

create policy "own renders folder: read" on storage.objects for select to authenticated
  using (bucket_id = 'renders' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "own renders folder: upload" on storage.objects for insert to authenticated
  with check (bucket_id = 'renders' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "own renders folder: delete" on storage.objects for delete to authenticated
  using (bucket_id = 'renders' and (storage.foldername(name))[1] = (select auth.uid())::text);
