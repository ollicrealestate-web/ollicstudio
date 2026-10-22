-- Ollic Design Studio, Phases 3 and 3b: IFC import and models from confirmed dimensions.
-- Same two layers as before: ownership checked in the API, and row-level security.

-- ---------------------------------------------------------------- jobs: new types
alter table public.jobs drop constraint if exists jobs_type_check;
alter table public.jobs add constraint jobs_type_check
  check (type in ('concept_render', 'concept_edit', 'ifc_import', 'plan_trace', 'model_build'));

-- ---------------------------------------------------------------- usage: reading plans with a vision model
alter table public.usage_events drop constraint if exists usage_events_operation_check;
alter table public.usage_events add constraint usage_events_operation_check
  check (operation in ('image_generate', 'image_edit', 'vision_read'));

-- ---------------------------------------------------------------- source files made by Ollic
-- A model built from a confirmed layout is written as an IFC source file, so it goes
-- through exactly the same import pipeline as an uploaded one.
alter table public.source_files add column if not exists origin text not null default 'upload'
  check (origin in ('upload', 'generated'));

-- ---------------------------------------------------------------- building models
create table public.building_models (
  id              uuid primary key default gen_random_uuid(),
  project_id      uuid not null references public.projects (id) on delete cascade,
  owner_id        uuid not null default auth.uid() references auth.users (id) on delete cascade,
  source_file_id  uuid references public.source_files (id) on delete set null,
  job_id          uuid references public.jobs (id) on delete set null,
  layout_draft_id uuid,
  schema_version  text not null,
  glb_path        text not null unique,
  report          jsonb not null,
  stats           jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now(),
  constraint building_models_glb_in_owner_folder check (split_part(glb_path, '/', 1) = owner_id::text and split_part(glb_path, '/', 2) = project_id::text)
);
create index building_models_project_idx on public.building_models (project_id, created_at desc);

create table public.building_components (
  id           uuid primary key default gen_random_uuid(),
  model_id     uuid not null references public.building_models (id) on delete cascade,
  project_id   uuid not null references public.projects (id) on delete cascade,
  owner_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  global_id    text not null check (char_length(global_id) between 1 and 64),
  ifc_type     text not null,
  name         text,
  family       text not null,
  storey       text,
  has_geometry boolean not null default true,
  properties   jsonb not null default '{}'::jsonb,
  constraint building_components_unique_global_id unique (model_id, global_id)
);
create index building_components_model_idx on public.building_components (model_id);

-- ---------------------------------------------------------------- layout drafts (Module B2)
create table public.layout_drafts (
  id              uuid primary key default gen_random_uuid(),
  project_id      uuid not null references public.projects (id) on delete cascade,
  owner_id        uuid not null default auth.uid() references auth.users (id) on delete cascade,
  source_file_id  uuid references public.source_files (id) on delete set null,
  status          text not null default 'proposed' check (status in ('proposed', 'confirmed', 'built')),
  proposal        jsonb not null,           -- what Ollic read from the drawing, every value tagged with its source
  layout          jsonb,                    -- the customer's confirmed values
  trace           jsonb not null default '{}'::jsonb,  -- image size, detected lines, scale evidence
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index layout_drafts_project_idx on public.layout_drafts (project_id, created_at desc);
create trigger layout_drafts_touch before update on public.layout_drafts for each row execute function public.touch_updated_at();

alter table public.building_models add constraint building_models_layout_fk
  foreign key (layout_draft_id) references public.layout_drafts (id) on delete set null;

create trigger building_models_owner_check before insert on public.building_models for each row execute function public.row_owner_matches_project();
create trigger building_components_owner_check before insert on public.building_components for each row execute function public.row_owner_matches_project();
create trigger layout_drafts_owner_check before insert or update on public.layout_drafts for each row execute function public.row_owner_matches_project();

-- ---------------------------------------------------------------- row-level security
alter table public.building_models enable row level security;
alter table public.building_components enable row level security;
alter table public.layout_drafts enable row level security;

create policy "own models: read"   on public.building_models for select to authenticated using (owner_id = (select auth.uid()));
create policy "own models: create" on public.building_models for insert to authenticated
  with check (owner_id = (select auth.uid()) and exists (select 1 from public.projects p where p.id = project_id and p.owner_id = (select auth.uid())));
create policy "own models: delete" on public.building_models for delete to authenticated using (owner_id = (select auth.uid()));

create policy "own components: read"   on public.building_components for select to authenticated using (owner_id = (select auth.uid()));
create policy "own components: create" on public.building_components for insert to authenticated
  with check (owner_id = (select auth.uid()) and exists (select 1 from public.building_models m where m.id = model_id and m.owner_id = (select auth.uid())));

create policy "own drafts: read"   on public.layout_drafts for select to authenticated using (owner_id = (select auth.uid()));
create policy "own drafts: create" on public.layout_drafts for insert to authenticated
  with check (owner_id = (select auth.uid()) and exists (select 1 from public.projects p where p.id = project_id and p.owner_id = (select auth.uid())));
create policy "own drafts: update" on public.layout_drafts for update to authenticated
  using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
create policy "own drafts: delete" on public.layout_drafts for delete to authenticated using (owner_id = (select auth.uid()));

-- generated IFC files are written by the user's own session, like uploads (policy from migration 1 applies)

-- ---------------------------------------------------------------- private bucket for 3D models
insert into storage.buckets (id, name, public, file_size_limit)
values ('models', 'models', false, 104857600)
on conflict (id) do nothing;

create policy "own models folder: read" on storage.objects for select to authenticated
  using (bucket_id = 'models' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "own models folder: upload" on storage.objects for insert to authenticated
  with check (bucket_id = 'models' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "own models folder: delete" on storage.objects for delete to authenticated
  using (bucket_id = 'models' and (storage.foldername(name))[1] = (select auth.uid())::text);
