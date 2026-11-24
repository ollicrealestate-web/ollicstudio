-- Realistic materials (24 Nov 2026): which library material each part of a model shows (set by the user), the
-- user's own materials made from photos, and their favourite and recent materials. All private to their owner.
-- The shared Ollic library itself is part of the app (web/assets/materials), so customers can only read it.
-- Run once, after 20261124000014_sketch_ai.sql.

-- ---------------------------------------------------------------- what each part of a model shows
-- assignments: { "<GlobalId>#<part>": { "id": "mt-travertine", "tint": "#d6c39f", "scale": 1, "rotation": 0,
-- "rough": 0.5, "offset": [0, 0] }, ... } (only what the user changed; the IFC's own materials are not stored)
create table if not exists public.model_materials (
  model_id     uuid primary key references public.building_models (id) on delete cascade,
  owner_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  assignments  jsonb not null default '{}'::jsonb check (jsonb_typeof(assignments) = 'object'),
  updated_at   timestamptz not null default now(),
  constraint model_materials_size check (pg_column_size(assignments) <= 4 * 1024 * 1024)
);
drop trigger if exists model_materials_touch on public.model_materials;
create trigger model_materials_touch before update on public.model_materials for each row execute function public.touch_updated_at();

alter table public.model_materials enable row level security;
drop policy if exists "own model materials: read" on public.model_materials;
drop policy if exists "own model materials: create" on public.model_materials;
drop policy if exists "own model materials: update" on public.model_materials;
drop policy if exists "own model materials: delete" on public.model_materials;
create policy "own model materials: read" on public.model_materials for select to authenticated using (owner_id = (select auth.uid()));
-- only for a model the user owns
create policy "own model materials: create" on public.model_materials for insert to authenticated
  with check (owner_id = (select auth.uid()) and exists (select 1 from public.building_models m where m.id = model_id and m.owner_id = (select auth.uid())));
create policy "own model materials: update" on public.model_materials for update to authenticated
  using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
create policy "own model materials: delete" on public.model_materials for delete to authenticated using (owner_id = (select auth.uid()));
revoke all on public.model_materials from anon;
grant select, insert, update, delete on public.model_materials to authenticated;

-- ---------------------------------------------------------------- my materials (made from the user's photos)
create table if not exists public.user_materials (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name        text not null check (char_length(name) between 1 and 80),
  category    text not null default 'My materials' check (char_length(category) <= 40),
  cls         text not null default 'stone' check (cls in ('paint','plaster','concrete','stone','brick','tile','wood','metal','glass','roof','grass','paving','asphalt','furniture','ceramic')),
  -- size (metres one picture covers), tile ({w, h, grout, groutColor}), rough, metal, color (average, for the plain
  -- colour shown while it loads), based_on (a library id when it is an adjusted library material)
  settings    jsonb not null default '{}'::jsonb check (jsonb_typeof(settings) = 'object'),
  -- the pictures in the private user-materials bucket: { color, normal, rough, ao, original }
  maps        jsonb not null default '{}'::jsonb check (jsonb_typeof(maps) = 'object'),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists user_materials_owner on public.user_materials (owner_id, created_at desc);
drop trigger if exists user_materials_touch on public.user_materials;
create trigger user_materials_touch before update on public.user_materials for each row execute function public.touch_updated_at();

alter table public.user_materials enable row level security;
drop policy if exists "own materials: read" on public.user_materials;
drop policy if exists "own materials: create" on public.user_materials;
drop policy if exists "own materials: update" on public.user_materials;
drop policy if exists "own materials: delete" on public.user_materials;
create policy "own materials: read"   on public.user_materials for select to authenticated using (owner_id = (select auth.uid()));
create policy "own materials: create" on public.user_materials for insert to authenticated with check (owner_id = (select auth.uid()));
create policy "own materials: update" on public.user_materials for update to authenticated using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
create policy "own materials: delete" on public.user_materials for delete to authenticated using (owner_id = (select auth.uid()));
revoke all on public.user_materials from anon;
grant select, insert, update, delete on public.user_materials to authenticated;

-- ---------------------------------------------------------------- favourites and recently used
create table if not exists public.material_prefs (
  owner_id    uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  favourites  text[] not null default '{}' check (cardinality(favourites) <= 200),
  recent      text[] not null default '{}' check (cardinality(recent) <= 30),
  updated_at  timestamptz not null default now()
);
alter table public.material_prefs enable row level security;
drop policy if exists "own material prefs" on public.material_prefs;
create policy "own material prefs" on public.material_prefs for all to authenticated
  using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
revoke all on public.material_prefs from anon;
grant select, insert, update, delete on public.material_prefs to authenticated;

-- ---------------------------------------------------------------- private bucket for the user's material pictures
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('user-materials', 'user-materials', false, 15728640, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do nothing;

drop policy if exists "own user-materials: read" on storage.objects;
drop policy if exists "own user-materials: upload" on storage.objects;
drop policy if exists "own user-materials: update" on storage.objects;
drop policy if exists "own user-materials: delete" on storage.objects;
create policy "own user-materials: read" on storage.objects for select to authenticated
  using (bucket_id = 'user-materials' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "own user-materials: upload" on storage.objects for insert to authenticated
  with check (bucket_id = 'user-materials' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "own user-materials: update" on storage.objects for update to authenticated
  using (bucket_id = 'user-materials' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "own user-materials: delete" on storage.objects for delete to authenticated
  using (bucket_id = 'user-materials' and (storage.foldername(name))[1] = (select auth.uid())::text);
