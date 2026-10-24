-- The project look (24 Oct 2026): the materials the architect approved for the building, taken from
-- the model and named by the architect, and the approved "hero" render. Every render, shot and stage
-- of the project uses them, so all views show the same building in the same materials.
-- Run once, after 20261024000011_ai_walkthroughs.sql.

alter table public.projects add column if not exists look jsonb not null default '{}'::jsonb;
