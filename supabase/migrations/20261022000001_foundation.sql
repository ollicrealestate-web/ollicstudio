-- Ollic Design Studio, Phase 1: profiles, projects, source files, private storage.
-- Row-level security is the second layer of protection; the API also checks
-- ownership in code on every request (brief, Module L).

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------- profiles
create type public.user_role as enum ('customer', 'reviewer', 'admin');

create table public.profiles (
  id           uuid primary key references auth.users (id) on delete cascade,
  full_name    text check (char_length(full_name) <= 120),
  organisation text check (char_length(organisation) <= 120),
  role         public.user_role not null default 'customer',
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- a profile row for every new account, filled from the sign-up form's metadata
create function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, full_name, organisation)
  values (new.id, left(new.raw_user_meta_data ->> 'full_name', 120), left(new.raw_user_meta_data ->> 'organisation', 120));
  return new;
end $$;

create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------- projects
create table public.projects (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name        text not null check (char_length(name) between 1 and 120),
  status      text not null default 'draft' check (status in ('draft', 'processing', 'ready', 'archived')),
  input_type  text not null default 'unknown' check (input_type in ('unknown', 'sketch', 'ifc')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index projects_owner_created_idx on public.projects (owner_id, created_at desc);

-- ---------------------------------------------------------------- source files
create table public.source_files (
  id                uuid primary key default gen_random_uuid(),
  project_id        uuid not null references public.projects (id) on delete cascade,
  owner_id          uuid not null default auth.uid() references auth.users (id) on delete cascade,
  original_name     text not null check (char_length(original_name) between 1 and 255),
  storage_path      text not null unique,
  detected_type     text not null check (detected_type in ('png', 'jpeg', 'pdf', 'ifc')),
  size_bytes        bigint not null check (size_bytes > 0),
  checksum_sha256   text not null check (checksum_sha256 ~ '^[0-9a-f]{64}$'),
  validation        jsonb not null default '{}'::jsonb,
  processing_status text not null default 'uploaded' check (processing_status in ('uploaded', 'processing', 'processed', 'failed')),
  created_at        timestamptz not null default now(),
  -- the stored object must sit in the owner's own folder: <owner_id>/<project_id>/<file>
  constraint source_files_path_in_owner_folder check (split_part(storage_path, '/', 1) = owner_id::text and split_part(storage_path, '/', 2) = project_id::text)
);
create index source_files_project_idx on public.source_files (project_id, created_at desc);

-- a file can only belong to a project with the same owner
create function public.source_file_owner_matches() returns trigger
language plpgsql set search_path = '' as $$
begin
  if not exists (select 1 from public.projects p where p.id = new.project_id and p.owner_id = new.owner_id) then
    raise exception 'source file owner must match project owner';
  end if;
  return new;
end $$;
create trigger source_files_owner_check before insert or update on public.source_files
  for each row execute function public.source_file_owner_matches();

-- ---------------------------------------------------------------- updated_at
create function public.touch_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin new.updated_at = now(); return new; end $$;
create trigger profiles_touch before update on public.profiles for each row execute function public.touch_updated_at();
create trigger projects_touch before update on public.projects for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------- row-level security
alter table public.profiles enable row level security;
alter table public.projects enable row level security;
alter table public.source_files enable row level security;

create policy "own profile: read" on public.profiles for select to authenticated using (id = (select auth.uid()));
create policy "own profile: update" on public.profiles for update to authenticated
  using (id = (select auth.uid())) with check (id = (select auth.uid()));
-- users may edit their name and organisation, never their role
revoke insert, update, delete on public.profiles from anon, authenticated;
grant update (full_name, organisation) on public.profiles to authenticated;

create policy "own projects: read"   on public.projects for select to authenticated using (owner_id = (select auth.uid()));
create policy "own projects: create" on public.projects for insert to authenticated with check (owner_id = (select auth.uid()));
create policy "own projects: update" on public.projects for update to authenticated using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
create policy "own projects: delete" on public.projects for delete to authenticated using (owner_id = (select auth.uid()));

create policy "own files: read"   on public.source_files for select to authenticated using (owner_id = (select auth.uid()));
create policy "own files: create" on public.source_files for insert to authenticated
  with check (owner_id = (select auth.uid()) and exists (select 1 from public.projects p where p.id = project_id and p.owner_id = (select auth.uid())));
create policy "own files: delete" on public.source_files for delete to authenticated using (owner_id = (select auth.uid()));
-- no update policy: processing status is changed only by background workers (service role), from Phase 3 on

-- ---------------------------------------------------------------- private storage
insert into storage.buckets (id, name, public, file_size_limit)
values ('source-files', 'source-files', false, 52428800)
on conflict (id) do nothing;

create policy "own folder: read" on storage.objects for select to authenticated
  using (bucket_id = 'source-files' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "own folder: upload" on storage.objects for insert to authenticated
  with check (bucket_id = 'source-files' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "own folder: delete" on storage.objects for delete to authenticated
  using (bucket_id = 'source-files' and (storage.foldername(name))[1] = (select auth.uid())::text);
-- no update policy: originals are never modified
