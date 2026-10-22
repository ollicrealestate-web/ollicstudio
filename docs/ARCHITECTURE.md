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

## 3D models and the render studio

Architects model in Revit; Ollic renders, animates and presents. (Plan tracing and a house builder were tried and removed on 22 Oct 2026.)

- **IFC import** (`app/bim/importer.py`): IfcOpenShell opens the architect's file; the report checks schema, units, storeys, GlobalIds, elements, MEP, geometry, size and georeferencing; trimesh writes a GLB with one node per element named by its GlobalId. Components go to `building_components`, the GLB to the private `models` bucket.
- **Viewer** (`web/assets/viewer.js`): three.js r169 bundled under `web/vendor/three`; renders only on change. "Render this view" uploads a picture of the current view as a project file and selects it as the shape to keep.
- **Render studio** (`app/renders.py`, `app/routes/renders.py`): a render takes up to four images, each with a role: `plan` (follow the layout), `model` (keep the 3D view's exact shape and camera), `base` (keep a sketch's shape and camera), `style` (take the look). PDFs can be the plan and are sent as their first page.
- **Read my plan** (`app/vision.py`, `POST /api/projects/{id}/plan/read`): a vision model describes the plan for the brief; the architect edits it.
- **Premium prompting** (`app/prompt_writer.py`): for Premium renders, Claude studies the images and brief and writes the image prompt, and turns plain-words revisions into precise edits; on any failure the standard prompt is used. Its cost is recorded like every other call.
- **Walkthrough** (`app/routes/walkthrough.py`, migration 7): in the viewer, **Walk through** lists the model's rooms (IfcSpace) and puts the camera at eye height (1.6 m) inside each one; the architect walks with drag, keys or on-screen arrows and presses **Save shot**. A shot is a picture of the view (a project file) plus the camera pose, in `camera_shots`. **Render all shots** starts one concept render per ticked shot with the same brief and look references, the shot as a `model` reference and its name in the prompt; shots taken inside a room always render as interiors. It checks the whole batch against the daily allowance before starting any.
- **Walkthrough video** (`app/video.py`, `app/video_jobs.py`): a `video_export` job joins the chosen renders into an MP4 with FFmpeg on our own server: title card, each render with a slow push-in, pan or pull-out (Ken Burns, from a 1.5x crop so it stays sharp), room titles, the concept label and the brand, a 0.8 s dip through black between clips, end card. Each clip is encoded with its own fades and FFmpeg uses one thread (`FFMPEG_THREADS`), then the clips are joined without re-encoding: about 250 MB peak and 38 s for 6 shots on 2 CPUs. (A cross-fade graph across all clips was tried first; it needed 580 MB and crashed Render's 512 MB instance.) H.264 High, yuv420p, 30 fps, silent AAC, faststart, so it plays on phones and WhatsApp. 16:9, 9:16 or 1:1. Saved in the private `videos` bucket and `final_videos`. No AI service is involved in the video; the realism comes from the renders. An AI video model (3b) or Blender GPU renders (3c) can come later.
- **Construction animation** (`web/assets/construction.js`, `web/assets/export.js`, `app/animation.py`, `app/routes/animation.py`, `app/animation_jobs.py`, migration 8): our own engine, no licences. In the browser, the IFC model's elements are grouped by type, predefined type and storey (the importer now writes `predefined` into each node's extras): site (setting-out lines and pegs), foundation (footings, piles, base slab rise from the ground, which turns see-through), then floor by floor structure (columns grow, beams and slabs drop in, stairs) and walls (rise), doors and windows (set in), roof (lowered), a fly-around, furniture (roof and upper floors lifted), then the camera stands in each room. Everything is a pure function of time, so the preview and the export match frame for frame. Settings ("script": seconds per stage, light, direction, format, hidden groups, rooms, captions, title) are checked by the same rules in Python and JavaScript (a test compares them).
  - **Plain-language director:** `POST /api/projects/{id}/animation/direct` sends the request, the current settings and model facts (rooms, floors, element groups) to a text model: Cloudflare Llama 3.3 for Standard, Claude for paid plans. It returns new settings only, which are validated and merged (an invalid value keeps the current one; rooms not in the model are dropped). 40 a day per customer; recorded as "Animation director".
  - **Export:** the browser draws every frame at full size (1920×1080, 1080×1920 or 1080×1080) on a 2D canvas: title card, the animation with stage captions and "Indicative sequence — not to scale", the newest AI render of each walkthrough shot with "AI concept — not to scale", end card. It encodes with WebCodecs (H.264 where the browser has it, else VP9) and mp4-muxer (`web/vendor/mp4-muxer`, MIT). The server checks the upload with ffprobe (codec, size for the format, length), keeps it in a private temp folder, and an `animation_export` job re-packages H.264 (seconds) or converts VP9 to H.264 on one thread, adds a silent AAC track and saves it to `final_videos` (`kind = 'construction'`, with the settings). No GPU server and no per-video cost.
- Customers never see which AI provider does what: tiers are "Standard render" and "Premium render", errors are neutral, and `/api/usage` names services, not providers. Provider details go to the server logs.

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
