# Status

Last updated: 22 October 2026, session 2.

- **Phase 1: Foundation: complete.** Live at https://ollicstudio.onrender.com (Render, Frankfurt; Supabase project zusfpymdqfmwgfaejaer).
- **Phase 2: Concept rendering: built and tested; awaiting configuration and a live check.** The second migration has to be run in Supabase, then one real render and one revision need to be made with the live OpenAI key (see "Next session").

## Features

| Feature | Status | Evidence |
| --- | --- | --- |
| Sign-up, sign-in, sign-out, password reset (Supabase Auth) | Operational live; reset emails use Supabase's default template | Live sign-in with two test accounts on 22 Oct 2026 |
| Token verification on every request (HS256 legacy secret; RS256/ES256 via JWKS) | Operational live (the project issues ES256 tokens) | `test_auth.py`; live isolation check |
| Projects: create, list, open, delete | Operational live | `test_projects.py`; `scripts/verify_isolation.py` |
| Ownership checked in code, plus row-level security and storage policies | **Verified live**: `scripts/verify_isolation.py` passed 14/14 against the deployed site on 22 Oct 2026 | — |
| Uploads: type from contents, size limit, checksum, private storage, originals never modified | Operational live | `test_uploads.py`; live isolation check |
| Project deletion removes stored files | Verified live (the check reads the storage folder listing, because Supabase's CDN can serve a deleted object for up to a minute) | live isolation check |
| Website: landing page, dashboard, uploads, delete confirmation, mobile layout | Operational live | e2e journey test |
| Hosting on Render from GitHub (`Dockerfile`; Railway files kept) | Operational | `/health` live |
| **Concept renders from a description** (server-side OpenAI Image API, `gpt-image-2.5-flare`) | Built and tested with a stand-in model. **Awaiting configuration**: migration 2, then a live render | `test_renders.py`, `test_openai_client.py`, e2e render test |
| **Concept renders from a reference sketch or photo** (PNG/JPEG sent as the base image; PDF and IFC refused with a reason) | Same as above | same |
| **Revisions of a render** (`gpt-image-2.5-sunburst`, previous render kept as the base; the original is never changed) | Same as above | same |
| Concept label: "AI concept — not to scale" on every card, stamped into the image file and in the download name; the database refuses an unlabelled concept | Same as above | `test_renders.py`; migration check constraint |
| Jobs: real status from the database, cancel, failure reasons, interrupted jobs reported as failed after 10 minutes, one render per Idempotency-Key, 3 active per project | Same as above | `test_renders.py` |
| Cost recorded for every model call, from the tokens OpenAI reports (`/api/usage`); null, never a guess, when usage or a price is missing | Same as above | `test_renders.py::test_every_model_call_records_its_cost_from_the_reported_tokens` |
| **Free image provider: Cloudflare Workers AI** (`@cf/black-forest-labs/flux-2-klein-4b`, 10,000 free neurons a day, about 60 landscape concepts). This is **Standard render**, free for everyone. Reference images are shrunk below 512 px as the model requires. Cost recorded as an estimate from image tiles at list price | Built and tested with a mocked Cloudflare API. **Awaiting configuration**: token in Render, migration 3, live render | `test_cloudflare.py` |
| **Two tiers side by side**: Standard render (Cloudflare, free) and **Premium render** (OpenAI), Premium for paid plans only (`profiles.plan = 'premium'`, set by the owner until Phase 7; customers cannot change it). Revisions stay in the tier of the original | Operational in tests and in the browser test; awaiting migration 4 | `test_cloudflare.py`, e2e render test |
| Per-customer daily limits per tier: Standard 3 (`DAILY_RENDERS_PER_USER`), Premium 20 (`DAILY_PREMIUM_RENDERS_PER_USER`), reset at midnight UTC = 01:00 Lagos; failed renders do not count | Operational in tests | `test_cloudflare.py` |
| OpenAI key only on the server (not in `config.js`, `/health`, settings repr or logs) | Operational in tests | `test_renders.py::test_the_openai_key_never_reaches_the_browser` |

**Phase 2 deliverable** ("upload a reference image, generate a concept visual, request an edit"): passes end to end in a browser (real site, real API, real background threads; stand-in Supabase Auth and stand-in image model). Not yet run against the real OpenAI API.

## Test run (session 2)

`cd backend && python -m pytest`: **92 passed, 0 failed**, Python 3.13 (`test_cloudflare.py` covers the free provider, both tiers, plans and daily limits).

- `test_auth.py` 10, `test_projects.py` 6, `test_uploads.py` 20, `test_supabase_client.py` 5: Phase 1, plus requests for the new tables and buckets
- `test_renders.py` 25: prompt-only, reference and revision renders; labels; validation; token-expiry guard; cross-user 404s on render, outputs, jobs, cancel and revise; provider refusal; cancel mid-call; restart detection; idempotency; active-job limit; cost per call; usage kept after project deletion; renders deleted with the project
- `test_openai_client.py` 10: exact request bodies, data-URL images, the key only in the header, plain messages for moderation, bad key, no permission, no credit, rate limit, unknown model and server errors
- `e2e/test_web_flow.py` 1, `e2e/test_render_flow.py` 1: browser journeys; the render journey also checks for no sideways scrolling at 390 px

Brief acceptance tests covered: **1, 2, 5, 14, 22** live. **3, 13 (as far as one web process allows), 15, 18 (idempotency)** in tests, awaiting the live check.

## How Phase 2 works

- `POST /api/projects/{id}/architectural-render` and `POST /api/renders/{id}/edit` create a job row and return 202. A small thread pool in the web service runs it as the signed-in user, so row-level security still applies.
- The job calls `/v1/images/generations` or `/v1/images/edits` (JSON body, images as base64 data URLs, `safety_identifier` = a hash of the user id), records the usage event, then saves two private copies in the `renders` bucket: an unlabelled base for revisions and a labelled copy for viewing and download.
- `GET /api/projects/{id}/outputs` returns renders with one-hour signed links, plus recent jobs. The page polls it every 3 s while a job is active.
- Prices (`backend/app/pricing.py`): $5 text in, $8 image in, $30 image out per million tokens for both models, standard tier, from OpenAI's pricing page on 22 Oct 2026.

## Known limits

- Jobs run inside the web service. A restart mid-job loses that job; it is reported as failed after 10 minutes. A separate worker with retries comes with the GPU work in Phase 5.
- Jobs act with the user's token, which lasts an hour. Renders are refused when the token has under 5 minutes left (the page refreshes it). Users can therefore write their own job and usage rows directly. Harmless while nothing is billed; Phase 7 moves those writes to a worker key and removes the grants.
- Render's free instance sleeps after 15 minutes idle; the first request then takes about 50 s.
- The model may still move walls or windows when it works from a sketch, which is why every output is labelled a concept. Plan-accurate renders come from the 3D model (Phases 3–5).
- `Pillow==12.3.0` was added for labelling. It has not been installed from PyPI here (no access); the Render build confirms it.
- No customer credits, quotas or prices yet (Phase 7). No privacy notice or retention policy yet (Phase 8).

## Next session should do first

1. Migration 2 was run on 22 Oct 2026. **Owner:** run migrations 3 and 4 (`20261022000003_cloudflare_and_daily_limits.sql`, `20261022000004_premium_plan.sql`), and add `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` in Render; `/health` should then show `"standard": true`. The first live OpenAI attempt on 22 Oct 2026 was refused because the OpenAI account had no credit ("You have no credits remaining"), and the app reported it correctly.
2. Make one real render from a description, one from a reference sketch, and one revision on the live site. Check the label, the download and `/api/usage` against the OpenAI usage page. Record the results here and mark Phase 2 complete.
3. Then **Phase 3: IFC import** (IfcOpenShell processing, validation report, glTF output, GlobalIds kept).
