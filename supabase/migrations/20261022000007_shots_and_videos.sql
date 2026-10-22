-- Ollic Design Studio: walkthrough shots and rendered walkthrough videos (brief Modules C, N and O).
-- Same two layers as before: ownership checked in the API, and row-level security.

-- ---------------------------------------------------------------- jobs: video export
alter table public.jobs drop constraint if exists jobs_type_check;
alter table public.jobs add constraint jobs_type_check
  check (type in ('concept_render', 'concept_edit', 'ifc_import', 'video_export'));

-- ---------------------------------------------------------------- camera shots
-- A saved view of the 3D model (a room in the walkthrough or an outside view): its camera
-- pose, and a picture of it that renders keep the shape of.
create table public.camera_shots (
  id              uuid primary key default gen_random_uuid(),
  project_id      uuid not null references public.projects (id) on delete cascade,
  owner_id        uuid not null default auth.uid() references auth.users (id) on delete cascade,
  model_id        uuid references public.building_models (id) on delete set null,
  source_file_id  uuid references public.source_files (id) on delete set null,
  name            text not null check (char_length(name) between 1 and 80),
  room            text check (char_length(room) <= 120),
  position        integer not null default 0,
  pose            jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now()
);
create index camera_shots_project_idx on public.camera_shots (project_id, position);
create trigger camera_shots_owner_check before insert or update on public.camera_shots for each row execute function public.row_owner_matches_project();

-- ---------------------------------------------------------------- final videos
create table public.final_videos (
  id            uuid primary key default gen_random_uuid(),
  project_id    uuid not null references public.projects (id) on delete cascade,
  owner_id      uuid not null default auth.uid() references auth.users (id) on delete cascade,
  job_id        uuid references public.jobs (id) on delete set null,
  storage_path  text not null unique,
  title         text check (char_length(title) <= 120),
  format        text not null check (format in ('16:9', '9:16', '1:1')),
  width         integer not null check (width > 0),
  height        integer not null check (height > 0),
  fps           integer not null check (fps > 0),
  duration_s    numeric(8, 2) not null check (duration_s > 0),
  items         jsonb not null default '[]'::jsonb,
  label         text not null default 'AI concept — not to scale',
  created_at    timestamptz not null default now(),
  constraint final_videos_path_in_owner_folder check (split_part(storage_path, '/', 1) = owner_id::text and split_part(storage_path, '/', 2) = project_id::text)
);
create index final_videos_project_idx on public.final_videos (project_id, created_at desc);
create trigger final_videos_owner_check before insert on public.final_videos for each row execute function public.row_owner_matches_project();

-- ---------------------------------------------------------------- row-level security
alter table public.camera_shots enable row level security;
alter table public.final_videos enable row level security;

create policy "own shots: read"   on public.camera_shots for select to authenticated using (owner_id = (select auth.uid()));
create policy "own shots: create" on public.camera_shots for insert to authenticated
  with check (owner_id = (select auth.uid()) and exists (select 1 from public.projects p where p.id = project_id and p.owner_id = (select auth.uid())));
create policy "own shots: update" on public.camera_shots for update to authenticated
  using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
create policy "own shots: delete" on public.camera_shots for delete to authenticated using (owner_id = (select auth.uid()));
revoke update on public.camera_shots from anon, authenticated;
grant update (name, position) on public.camera_shots to authenticated;

create policy "own videos: read"   on public.final_videos for select to authenticated using (owner_id = (select auth.uid()));
create policy "own videos: create" on public.final_videos for insert to authenticated
  with check (owner_id = (select auth.uid()) and exists (select 1 from public.projects p where p.id = project_id and p.owner_id = (select auth.uid())));
create policy "own videos: delete" on public.final_videos for delete to authenticated using (owner_id = (select auth.uid()));

-- ---------------------------------------------------------------- private bucket for videos
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('videos', 'videos', false, 524288000, array['video/mp4'])
on conflict (id) do nothing;

create policy "own videos folder: read" on storage.objects for select to authenticated
  using (bucket_id = 'videos' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "own videos folder: upload" on storage.objects for insert to authenticated
  with check (bucket_id = 'videos' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "own videos folder: delete" on storage.objects for delete to authenticated
  using (bucket_id = 'videos' and (storage.foldername(name))[1] = (select auth.uid())::text);
