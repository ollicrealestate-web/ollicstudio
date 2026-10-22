-- Cinematic clips (22 Oct 2026): AI video from a start frame to an end frame (Kling, direct),
-- Nano Banana images (Google Gemini API, direct), and Ollic VS (fal.ai) images and video.

alter table public.jobs drop constraint if exists jobs_type_check;
alter table public.jobs add constraint jobs_type_check
  check (type in ('concept_render', 'concept_edit', 'ifc_import', 'video_export', 'animation_export', 'cinematic_clip'));

alter table public.final_videos drop constraint if exists final_videos_kind_check;
alter table public.final_videos add constraint final_videos_kind_check check (kind in ('walkthrough', 'construction', 'cinematic'));

alter table public.usage_events drop constraint if exists usage_events_provider_check;
alter table public.usage_events add constraint usage_events_provider_check
  check (provider in ('openai', 'cloudflare', 'anthropic', 'kling', 'google', 'fal'));
alter table public.usage_events drop constraint if exists usage_events_operation_check;
alter table public.usage_events add constraint usage_events_operation_check
  check (operation in ('image_generate', 'image_edit', 'vision_read', 'prompt_write', 'animation_direct', 'video_generate'));
