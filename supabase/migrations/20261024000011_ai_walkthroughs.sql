-- AI walkthroughs from the architect's model (24 Oct 2026): the browser records an exact guide video
-- of the model along a camera path; Runway (Ollic Path) turns it into a photoreal shot; Claude plans the
-- shots and checks the geometry. Revit files are read through Autodesk Platform Services.
-- Run once, after 20261023000010_testers.sql.

alter table public.jobs drop constraint if exists jobs_type_check;
alter table public.jobs add constraint jobs_type_check
  check (type in ('concept_render', 'concept_edit', 'ifc_import', 'video_export', 'animation_export', 'cinematic_clip', 'film_shot', 'revit_translate'));

alter table public.final_videos drop constraint if exists final_videos_kind_check;
alter table public.final_videos add constraint final_videos_kind_check check (kind in ('walkthrough', 'construction', 'cinematic', 'film'));

alter table public.usage_events drop constraint if exists usage_events_provider_check;
alter table public.usage_events add constraint usage_events_provider_check
  check (provider in ('openai', 'cloudflare', 'anthropic', 'kling', 'google', 'fal', 'runway', 'autodesk'));
alter table public.usage_events drop constraint if exists usage_events_operation_check;
alter table public.usage_events add constraint usage_events_operation_check
  check (operation in ('image_generate', 'image_edit', 'vision_read', 'prompt_write', 'animation_direct', 'video_generate',
                       'video_to_video', 'geometry_check', 'film_plan', 'model_translate'));

-- Revit files (.rvt) are accepted as uploads; they are translated to IFC by Autodesk.
alter table public.source_files drop constraint if exists source_files_detected_type_check;
alter table public.source_files add constraint source_files_detected_type_check check (detected_type in ('png', 'jpeg', 'pdf', 'ifc', 'rvt'));
