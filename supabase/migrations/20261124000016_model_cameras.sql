-- Camera angles (24 Nov 2026): for each model, which side is its front (when the architect set it) and the views
-- saved from the Camera panel (name, the camera's numbers, a small picture). Private to their owner.
-- Run once, after 20261124000015_materials.sql.
create table if not exists public.model_cameras (
  model_id    uuid primary key references public.building_models (id) on delete cascade,
  owner_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  front       jsonb,                                      -- { "dir": [x, z], "from": "you" }
  views       jsonb not null default '[]'::jsonb check (jsonb_typeof(views) = 'array'),
  updated_at  timestamptz not null default now(),
  constraint model_cameras_size check (pg_column_size(views) <= 3 * 1024 * 1024)
);
drop trigger if exists model_cameras_touch on public.model_cameras;
create trigger model_cameras_touch before update on public.model_cameras for each row execute function public.touch_updated_at();

alter table public.model_cameras enable row level security;
drop policy if exists "own model cameras: read" on public.model_cameras;
drop policy if exists "own model cameras: create" on public.model_cameras;
drop policy if exists "own model cameras: update" on public.model_cameras;
drop policy if exists "own model cameras: delete" on public.model_cameras;
create policy "own model cameras: read" on public.model_cameras for select to authenticated using (owner_id = (select auth.uid()));
create policy "own model cameras: create" on public.model_cameras for insert to authenticated
  with check (owner_id = (select auth.uid()) and exists (select 1 from public.building_models m where m.id = model_id and m.owner_id = (select auth.uid())));
create policy "own model cameras: update" on public.model_cameras for update to authenticated
  using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
create policy "own model cameras: delete" on public.model_cameras for delete to authenticated using (owner_id = (select auth.uid()));
revoke all on public.model_cameras from anon;
grant select, insert, update, delete on public.model_cameras to authenticated;
