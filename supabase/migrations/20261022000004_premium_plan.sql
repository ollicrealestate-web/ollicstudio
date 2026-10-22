-- Ollic Design Studio: plans. "Premium render" (OpenAI) is for paid customers only.
-- Customers cannot change their own plan: profiles only grants updates on full_name and
-- organisation (Phase 1). Until payments arrive in Phase 7, the owner sets a paying
-- customer's plan by hand in Table Editor > profiles > plan.

alter table public.profiles add column if not exists plan text not null default 'free' check (plan in ('free', 'premium'));
