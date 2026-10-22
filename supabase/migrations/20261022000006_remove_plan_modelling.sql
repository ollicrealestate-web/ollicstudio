-- Ollic Design Studio: plan tracing and the house builder were removed (architects model in
-- Revit; Ollic renders, animates and presents). Their table and job types go too.
-- Also: Premium prompting is recorded in usage like every other paid call.

alter table public.building_models drop constraint if exists building_models_layout_fk;
alter table public.building_models drop column if exists layout_draft_id;
drop table if exists public.layout_drafts;

delete from public.jobs where type in ('plan_trace', 'model_build');
alter table public.jobs drop constraint if exists jobs_type_check;
alter table public.jobs add constraint jobs_type_check
  check (type in ('concept_render', 'concept_edit', 'ifc_import'));

alter table public.usage_events drop constraint if exists usage_events_provider_check;
alter table public.usage_events add constraint usage_events_provider_check check (provider in ('openai', 'cloudflare', 'anthropic'));
alter table public.usage_events drop constraint if exists usage_events_operation_check;
alter table public.usage_events add constraint usage_events_operation_check
  check (operation in ('image_generate', 'image_edit', 'vision_read', 'prompt_write'));
