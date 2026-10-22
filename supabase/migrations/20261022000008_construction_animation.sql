-- Construction animation (22 Oct 2026).
-- The animation is drawn and encoded in the customer's browser from their IFC model; the server
-- checks the upload and a job makes it phone-friendly. Videos of both kinds live in final_videos.

alter table public.jobs drop constraint if exists jobs_type_check;
alter table public.jobs add constraint jobs_type_check
  check (type in ('concept_render', 'concept_edit', 'ifc_import', 'video_export', 'animation_export'));

alter table public.final_videos add column if not exists kind text not null default 'walkthrough';
alter table public.final_videos drop constraint if exists final_videos_kind_check;
alter table public.final_videos add constraint final_videos_kind_check check (kind in ('walkthrough', 'construction'));
alter table public.final_videos add column if not exists script jsonb;
alter table public.final_videos drop constraint if exists final_videos_script_size;
alter table public.final_videos add constraint final_videos_script_size check (script is null or pg_column_size(script) < 20000);

-- plain-language animation edits are recorded like every other AI call
alter table public.usage_events drop constraint if exists usage_events_operation_check;
alter table public.usage_events add constraint usage_events_operation_check
  check (operation in ('image_generate', 'image_edit', 'vision_read', 'prompt_write', 'animation_direct'));
