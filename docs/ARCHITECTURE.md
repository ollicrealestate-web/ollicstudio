# Architecture

Ollic is an image-based platform: architects upload PNG or JPEG images and say in plain words what
they want; Ollic (with Claude understanding the request and writing the prompts) drives image and video
AI services through their APIs to make renders, animations and video clips. It does not read model files.

```
Browser (web/)                FastAPI (backend/app)                 Supabase
--------------                ----------------------                --------
app.html + assets/*.js  ──►   /api/*  verify JWT (auth.py)    ──►   Postgres + RLS (projects, source_files, jobs, rendered_images, final_videos, profiles)
  sign-in via Supabase         ownership check in code               Storage buckets "source-files", "renders", "videos" (private)
  Auth REST (session.js)       file inspection (filetypes.py)        Auth (accounts, emails)
                               AI services (server-side keys)  ──►   Cloudflare, OpenAI, Gemini, fal.ai, Kling, Claude
```

## Request flow

1. The website signs the customer in directly with Supabase Auth and keeps the session in the browser.
2. Every API call sends the customer's access token. `auth.py` verifies it: HS256 with the legacy secret, or RS256/ES256 against the project's JWKS. The audience must be `authenticated` and the token must not have expired.
3. Handlers call Supabase **as that customer**, with the anon key plus the customer's token, so row-level security applies. Queries also filter by `owner_id`, and every project is re-checked against the caller in `_owned_project` before anything else happens.
4. The privileged service-role key is not used anywhere in the API. A test fails if it appears in `backend/app`.

## Uploads

- Images only: PNG and JPEG, read from the file's contents (`filetypes.py`), never its name. A PDF, an IFC model, a Revit file or anything else is refused with a reason to export a PNG or JPEG instead.
- The API rejects renamed, truncated and unsupported files, with a reason and a code. A rejected file is never stored.
- Stored path: `<owner_id>/<project_id>/<file_id>.<ext>`. Storage policies only let a user touch their own folder, and the table has a check constraint that the path matches its owner and project.
- Uploads are created with `x-upsert: false` and there is no storage update policy, so originals cannot be overwritten.
- If the database write fails after the upload, the stored object is deleted, so no orphan files are left.
- Deleting a project removes its storage objects first, then the rows. Deleting a file or project also removes any 3D models or walkthrough shots made from it in older projects (tables `building_models`, `camera_shots` and the `models` bucket are kept only for that).

## Renders

1. The browser posts a render or revision request with an `Idempotency-Key`. The API checks ownership, validates the options, refuses tokens with under 5 minutes left, and writes a `jobs` row (`queued`).
2. A thread pool in the web service (`app/jobs.py`) runs `app/renders.py::run_render_job` as the same user, calling the chosen AI service from the server. Keys never leave the server.
3. Straight after the call, the cost is written to `usage_events` (`app/pricing.py`). The image is checked with Pillow and stored twice in the private `renders` bucket: an unlabelled base (used for revisions and animations) and a copy stamped "Ollicstudio". A `rendered_images` row links them, with `parent_image_id` for revisions.
4. The page reads `GET /api/projects/{id}/outputs` (signed one-hour links plus job states) and polls while anything is running. A job untouched for 10 minutes is marked failed with an explanation.

- A render takes up to four images, each with a role: `base` (keep a sketch's or 3D image's shape and camera), `model` (keep a plain 3D view's exact shape and camera; used by the golden animation), `plan` (follow a floor plan's layout), `style` (copy the scene, never the building).
- **Read my plan** (`app/vision.py`, `POST /api/projects/{id}/plan/read`): a vision model describes a floor plan picture for the brief.
- **Premium prompting** (`app/prompt_writer.py`): for Premium renders, Claude studies the images and brief and writes the image prompt, and turns plain-words revisions into precise edits; on any failure the standard prompt is used.

## Rendering prompt written by AI

`POST /api/projects/{id}/render-prompt` (`app/render_prompt.py`): the picture to render, up to 3 `style`
references and the description. Pictures are ordered by `renders.ROLE_ORDER`, the order the render sends
them, so "Image 1" means the same to the prompt writer and the image model. Claude
(`ClaudePromptWriter._call`) writes it; without Claude, or if it fails, the Cloudflare vision model writes
it from the main picture. 60 a day per customer (unlimited for testers and owners). A render with
`prompt_ready: true` uses the prompt as written plus the no-text tail.

## Golden animation (from 3D images)

`web/assets/imageanim.js`, `web/assets/export.js`, `app/animation.py`, `app/routes/animation.py`,
`app/animation_jobs.py`. Up to 3 uploaded images become shots. Each gets a photoreal night version from
the AI (one render, `role: model`, tagged `anim_hero.key = img-<file id>`), or is used as it is. The gold
lines come from a second AI render: an edit of the photoreal view into a clean white-on-black line drawing
(`anim_line` tag), which stays aligned with the photo; tracing the photo (smoothed Sobel edges, thinned,
thresholded) is the fallback. The lines are drawn in glowing gold on a night backdrop from the ground up,
then a line of light sweeps up and reveals the photo, with a slow push-in. Everything is a pure function
of time on a 2D canvas, so preview and export match.

**Export:** the browser draws every frame at full size (1920×1080, 1080×1920 or 1080×1080), encodes with
WebCodecs (H.264 where the browser has it, else VP9) and mp4-muxer (`web/vendor/mp4-muxer`, MIT), and posts
it to `POST /api/projects/{id}/animations` with its settings (`animation.Script`: format, title, subtitle,
look). The server checks the upload with ffprobe (codec, size for the format, length), keeps it in a
private temp folder, and an `animation_export` job re-packages H.264 or converts VP9 to H.264 on one
thread, adds a silent AAC track and saves it to `final_videos`. No GPU server and no per-video cost.

## Cinematic clips and provider connections

- **Cinematic clip** (`app/cinematic.py`, `POST /api/projects/{id}/cinematic`): paid plans, testers (by allowance) and owner accounts. Start frame: the AI line drawing turned gold on a night sky; end frame: the photoreal render; both cropped to the video's shape. The job polls with a heartbeat, saves the MP4 (silent track added if none, faststart) and records the cost.
- **Kling** (`app/kling.py`, `KLING_API_KEY`), **Google Gemini** (`app/gemini_images.py`, `GEMINI_API_KEY`), **fal.ai** (`app/fal.py`, `FAL_KEY`: Flux Kontext Pro pictures, Seedance 2.0 video), **OpenAI** (Premium), **Cloudflare** (Standard, vision), **Claude** (`ANTHROPIC_API_KEY`, prompts).
- Customers never see which AI provider does what: options carry Ollic names, errors are neutral, and `/api/usage` names services, not providers. Provider details go to the server logs.

## Choosable AI options (Ollic names only)

`backend/app/engines.py` lists every option customers can choose, under Ollic names; the service behind
each stays on the server. Image options (`IMAGE_ENGINES`) are render tiers beside Standard (Cloudflare)
and Premium (OpenAI): Swift and Ultra (Gemini), Studio (coming soon) and VS (fal.ai). Video options
(`VIDEO_ENGINES`) appear only on cinematic clips: Motion (Kling), Cinema and Reel (coming soon) and VS
(fal.ai). `app.state.video_clients` maps option to client. An option without a key is listed as "Not
connected yet" and refused with 503.

## Project page: services

`web/assets/app.js` (`SERVICES`) lists the services (Photoreal render, Floor plan to 3D, Animation from a
3D image), the image types each takes and which page sections it shows. `goTo(service, step)` switches
between the picker, step 1 (upload or choose from the Library: `drawStart`, `useFiles`) and step 2 (the
service's sections only); the address carries `service` and `step`. The AI version picker (`#tierPick`)
is moved into the screen of the active service, and the renders gallery into the Library when it is open.

## Decisions

| Decision | Why |
| --- | --- |
| Images only (owner, 23 Oct 2026) | Ollic's job is to connect AI tools through their APIs and let Claude drive them from plain words; model files were removed. |
| Website without a build step (plain HTML, CSS and ES modules) | Hosts anywhere and is easy to change. |
| Supabase Auth through its REST API, not supabase-js | Small, no bundler, and the exact requests can be tested. |
| Repository and storage behind interfaces | The API's own ownership checks are tested with in-memory stand-ins. The real database is checked by `scripts/verify_isolation.py`. |
| Sync handlers | FastAPI runs them in worker threads. Heavy work moves to background workers later. |

## Layout

```
backend/app/      config, auth, filetypes, supabase clients, AI clients, routes, main
backend/tests/    unit and API tests; tests/e2e drives the real site in Chromium
supabase/migrations/  schema, RLS, storage buckets and policies
web/              index.html (landing), app.html (dashboard), assets/
scripts/          verify_isolation.py (live check against Supabase)
docs/             STATUS.md, ARCHITECTURE.md, SUPABASE_SETUP.md
```
