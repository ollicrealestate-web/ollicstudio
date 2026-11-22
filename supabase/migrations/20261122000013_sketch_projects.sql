-- Sketch (22 Nov 2026): the plan and 3D modeller. Each sketch is one JSON document (levels, types,
-- walls, openings, floors, roofs, lines ...) owned by one user. Geometry is always rebuilt from it.
-- Run once, after 20261024000012_project_look.sql.

create table if not exists public.sketch_projects (
  id             uuid primary key default gen_random_uuid(),
  owner_id       uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name           text not null check (char_length(name) between 1 and 120),
  doc            jsonb not null check (jsonb_typeof(doc) = 'object' and doc ? 'levels'),
  schema_version int not null default 1,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint sketch_doc_size check (pg_column_size(doc) <= 8 * 1024 * 1024)
);

create index if not exists sketch_projects_owner_updated on public.sketch_projects (owner_id, updated_at desc);

drop trigger if exists sketch_projects_touch on public.sketch_projects;
create trigger sketch_projects_touch before update on public.sketch_projects for each row execute function public.touch_updated_at();

-- a sketch can never be handed to someone else
create or replace function public.sketch_owner_fixed() returns trigger language plpgsql set search_path = '' as $$
begin
  if new.owner_id is distinct from old.owner_id then raise exception 'The owner of a sketch cannot change.'; end if;
  return new;
end $$;
drop trigger if exists sketch_projects_owner_fixed on public.sketch_projects;
create trigger sketch_projects_owner_fixed before update on public.sketch_projects for each row execute function public.sketch_owner_fixed();

alter table public.sketch_projects enable row level security;

drop policy if exists "own sketches: read" on public.sketch_projects;
drop policy if exists "own sketches: create" on public.sketch_projects;
drop policy if exists "own sketches: update" on public.sketch_projects;
drop policy if exists "own sketches: delete" on public.sketch_projects;
create policy "own sketches: read"   on public.sketch_projects for select to authenticated using (owner_id = (select auth.uid()));
create policy "own sketches: create" on public.sketch_projects for insert to authenticated with check (owner_id = (select auth.uid()));
create policy "own sketches: update" on public.sketch_projects for update to authenticated using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
create policy "own sketches: delete" on public.sketch_projects for delete to authenticated using (owner_id = (select auth.uid()));

revoke all on public.sketch_projects from anon;
grant select, insert, update, delete on public.sketch_projects to authenticated;
