-- Testers (23 Oct 2026): accounts with unlimited free features and a one-time allowance of
-- paid options, e.g. {"vs_image": 2, "vs_video": 1} (Ollic VS pictures and clips).
-- Customers cannot change their own allowances: profiles only grants updates on full_name and
-- organisation. Failed or cancelled attempts do not use up an allowance.
alter type public.user_role add value if not exists 'tester';
alter table public.profiles add column if not exists allowances jsonb not null default '{}'::jsonb;
