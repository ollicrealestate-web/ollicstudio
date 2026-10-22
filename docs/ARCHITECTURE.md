# Architecture (Phase 1)

```
Browser (web/)                FastAPI (backend/app)                 Supabase
--------------                ----------------------                --------
app.html + assets/*.js  ──►   /api/*  verify JWT (auth.py)    ──►   Postgres + RLS (projects, source_files, profiles)
  sign-in via Supabase         ownership check in code               Storage bucket "source-files" (private)
  Auth REST (session.js)       file inspection (filetypes.py)        Auth (accounts, emails)
                    └────────────────────────────────────────────►  Auth REST only (sign-in, sign-up, reset)
```

## Request flow

1. The website signs the customer in directly with Supabase Auth and keeps the session in the browser.
2. Every API call sends the customer's access token. `auth.py` verifies it: HS256 with the legacy secret, or RS256/ES256 against the project's JWKS. The audience must be `authenticated` and the token must not have expired.
3. Handlers call Supabase **as that customer**, with the anon key plus the customer's token, so row-level security applies. Queries also filter by `owner_id`, and every project is re-checked against the caller in `_owned_project` before anything else happens.
4. The privileged service-role key is not used anywhere in the API. A test fails if it appears in `backend/app`.

## Uploads

- The type is read from the file's contents (`filetypes.py`), never its name. Accepted: PNG, JPEG, PDF, and IFC (IFC2X3, IFC4, IFC4X3).
- The API rejects renamed, truncated, password-protected and unsupported files, with a reason and a code. A rejected file is never stored.
- Stored path: `<owner_id>/<project_id>/<file_id>.<ext>`. Storage policies only let a user touch their own folder, and the table has a check constraint that the path matches its owner and project.
- Uploads are created with `x-upsert: false` and there is no storage update policy, so originals cannot be overwritten.
- If the database write fails after the upload, the stored object is deleted, so no orphan files are left.
- Deleting a project removes its storage objects first, then the rows. The database cascades from project to source files.

## Concept renders (Phase 2)

1. The browser posts a render or revision request with an `Idempotency-Key`. The API checks ownership, validates the options, refuses tokens with under 5 minutes left, and writes a `jobs` row (`queued`).
2. A thread pool in the web service (`app/jobs.py`) runs `app/renders.py::run_render_job` as the same user. It calls OpenAI's Image API from the server (`app/openai_images.py`). The key never leaves the server.
3. Straight after the call, the cost is written to `usage_events` from the reported tokens (`app/pricing.py`). Then the image is checked with Pillow and stored twice in the private `renders` bucket: an unlabelled base (used for revisions) and a copy stamped "AI concept - not to scale". A `rendered_images` row links them, with `parent_image_id` for revisions.
4. The page reads `GET /api/projects/{id}/outputs` (signed one-hour links plus job states) and polls while anything is running. A job untouched for 10 minutes is marked failed with an explanation.

## Decisions

| Decision | Why |
| --- | --- |
| Website without a build step (plain HTML, CSS and ES modules) | Hosts anywhere (Netlify, Vercel, Cloudflare Pages, or the API itself) and is easy to change. A framework can come later if the app grows. |
| Supabase Auth through its REST API, not supabase-js | Small, no bundler, and the exact requests can be tested. |
| Repository and storage behind interfaces | The API's own ownership checks are tested with in-memory stand-ins. The real database is checked by `scripts/verify_isolation.py`. |
| Sync handlers | FastAPI runs them in worker threads. Heavy work (IFC processing, renders) moves to background workers in Phase 5, as the brief requires. |

## Layout

```
backend/app/      config, auth, filetypes, supabase clients, routes, main
backend/tests/    unit and API tests; tests/e2e drives the real site in Chromium
supabase/migrations/  schema, RLS, storage bucket and policies
web/              index.html (landing), app.html (dashboard), assets/
scripts/          verify_isolation.py (live check against Supabase)
docs/             STATUS.md, ARCHITECTURE.md, SUPABASE_SETUP.md
```
