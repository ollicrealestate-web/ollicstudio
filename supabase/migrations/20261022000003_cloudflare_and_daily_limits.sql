-- Ollic Design Studio, Phase 2 follow-up: Cloudflare Workers AI as a second image
-- provider (free daily allowance), and fast counting of each user's renders per day.

alter table public.usage_events drop constraint if exists usage_events_provider_check;
alter table public.usage_events add constraint usage_events_provider_check check (provider in ('openai', 'cloudflare'));

create index if not exists jobs_owner_created_idx on public.jobs (owner_id, created_at desc);
