# Status

Last updated: 22 October 2026. **Phase 1: Foundation is complete** and live at https://ollicstudio.onrender.com (Render, Frankfurt; Supabase project zusfpymdqfmwgfaejaer).

## Features

| Feature | Status | Evidence |
| --- | --- | --- |
| Sign-up, sign-in, sign-out, password reset (website, Supabase Auth) | Partial: built; tested against a stand-in for Supabase Auth | e2e journey test |
| Token verification on every request (HS256 legacy secret; RS256/ES256 via JWKS) | Operational in tests | `test_auth.py`, 10 tests |
| Projects: create, list, open, delete | Operational in tests; awaiting Supabase configuration | `test_projects.py` |
| Ownership checked in code on every request | Operational in tests | `test_projects.py::test_another_user_cannot_list_open_upload_to_or_delete_it` |
| Row-level security, storage policies, private bucket (`supabase/migrations`) | **Verified live**: migration applied on real Supabase; `scripts/verify_isolation.py` passed 14/14 against the deployed site on 22 Oct 2026 | — |
| Uploads: type from contents, size limit, checksum, private storage, originals never modified | Operational in tests; storage awaiting configuration | `test_uploads.py`, 22 tests |
| Clear errors for unsupported, renamed, corrupt, encrypted and oversize files | Operational in tests | `test_uploads.py` |
| Project deletion removes stored files | Operational in tests; awaiting real storage | `test_projects.py::test_deleting_a_project_removes_its_files_from_storage` |
| Website: landing page, dashboard, uploads with progress, in-page delete confirmation, mobile layout | Operational with stand-in auth | e2e journey test |
| Black-and-red design system (`docs/DESIGN.md`), made with UI/UX Pro Max: landing page and dashboard | Operational; checked at 390 px and 1440 px with no horizontal scroll, and all text contrast at least 5.2:1 | Screenshots; e2e journey test |
| Website settings served from the environment (`/assets/config.js`) | Operational in tests | `test_projects.py::test_website_config_is_served_from_settings_with_public_values_only` |
| Railway deployment (`Dockerfile`, `railway.json`, `docs/DEPLOY_RAILWAY.md`) | **Awaiting configuration**: the container's start command was tested here; the image itself has not been built, because Docker is not available in this environment | First Railway deploy, then the health check |

**Phase 1 deliverable** ("a signed-in user creates a project and uploads a drawing; another user cannot see it"): passes end to end in a browser against the real API and a stand-in for Supabase. Proven on real Supabase on 22 Oct 2026: `scripts/verify_isolation.py` passed 14/14 against the live deployment (API, row-level security and storage isolation, and file clean-up on delete). Hosting moved from Railway to Render because Railway deploys were paused by an outage; the Dockerfile runs unchanged on either.

## Test run (session 1)

`cd backend && python -m pytest`: **40 passed, 0 failed** (2.7 s), Python 3.13.

- `test_auth.py`: 10 passed (missing, malformed, wrong-signature, expired, wrong-audience and anon tokens refused; ES256 via JWKS; HS256 refused without a secret)
- `test_projects.py`: 6 passed (CRUD, validation, cross-user 404s on list, open, upload and delete, deletion clears storage, public website settings only)
- `test_uploads.py`: 20 passed (4 accepted types, details read from the file, 11 rejection cases, size limit, no orphan file when the database write fails, extension never trusted)
- `test_supabase_client.py`: 3 passed (requests carry the user's token and owner filters; uploads never overwrite; no service-role key in API code)
- `e2e/test_web_flow.py`: 1 passed (sign up, create, upload, rejection message, second user blocked by direct link, wrong-password message, delete with confirmation)

Brief acceptance tests covered so far: **1** (with stand-in auth), **2**, **5**, **14** (API layer; database layer awaits Supabase), **22** (stand-in storage).

## Known limits

- Uploads are held in memory while they are checked (50 MB cap). Streaming to storage comes with the large-file work in Phase 3.
- No rate limits or render quotas yet; these are Phase 8 per the brief.
- No privacy notice or retention policy yet (NDPA 2023); these are Phase 8.
- Dependency pins are the versions tested together here. The build environment could not reach PyPI, so FastAPI and pytest were installed from their GitHub source. Confirm the pins resolve with `pip install -r backend/requirements.txt` on first setup.
- Supabase's default email templates are in use.

## Next session should do first

1. **Owner:** create the Supabase project (`docs/SUPABASE_SETUP.md`), then deploy to Railway (`docs/DEPLOY_RAILWAY.md`). For local development, fill in `.env`.
2. Run `pip install -r backend/requirements-dev.txt`, run the test suite on that machine, then run `scripts/verify_isolation.py`. Fix anything that fails before moving on.
3. Mark Phase 1 complete in this file, then start **Phase 2: concept rendering**. That needs an **OpenAI API key** from the owner, and a check of the current image model name.
