# Status

Last updated: 22 October 2026, session 2 (walkthrough added).

**Product direction (owner, 22 Oct 2026):** architects model in Revit. Ollic is where they render, animate and present: upload a Revit IFC or a floor plan, add reference images and a description (glass, cantilevers, cladding), and get photoreal visuals. Ollic does not build models. The plan tracing, plan editor and house builder made earlier that day were removed; the builder survives only in `backend/tests/fixtures` to make a sample IFC for tests.

- **Phase 1: Foundation: complete.** Live at https://ollicstudio.onrender.com (Render, Frankfurt; Supabase project zusfpymdqfmwgfaejaer).
- **Phase 2: Concept rendering: complete for Standard render**, verified live. **Premium render** is built, locked to paid plans, and waits for OpenAI credit; **Premium prompting** waits for an Anthropic API key.
- **Phase 3: IFC import and 3D viewer: verified live** with a generated IFC; a real Revit export is still to be tried.
- **Render studio, rebuilt around architects:** built and tested; awaiting migration 6 and a live check.
- **Construction animation:** built and tested in a browser (WebGL, WebCodecs, FFmpeg); awaiting migration 8 and a live export.
- **Walkthrough (rooms, render all shots, MP4 video):** built and tested in a browser with real FFmpeg; awaiting migration 7 and a live check.

## Features

| Feature | Status | Evidence |
| --- | --- | --- |
| Sign-up, sign-in, password reset, token verification (ES256 via JWKS) | Operational live | `test_auth.py`; live use |
| Projects, uploads, ownership in code plus RLS and storage policies; deletion removes files; delete buttons (with a confirm step) for uploaded files (an IFC takes its 3D model, a shot picture its shot), renders and videos | **Verified live**: `scripts/verify_isolation.py` 14/14 | `test_projects.py`, `test_uploads.py` |
| **Standard render** (free daily allowance), 3 a day per customer; owner and test accounts (`profiles.role` admin or reviewer) have no daily limits (`supabase/owner_test_accounts.sql`) | **Verified live** | live check below |
| **Premium render**: the most precise image model, High or Maximum detail, paid plans only (`profiles.plan = 'premium'`, set by the owner until Phase 7), 20 a day | Built and tested; **awaiting OpenAI credit** | `test_cloudflare.py`, `test_openai_client.py` |
| **Premium prompting**: Claude (`claude-opus-5-5`, configurable) studies the plan, model view, sketches and look references with the brief and writes the image prompt; turns plain-words revisions into precise edits; falls back to the standard prompt on any failure; its cost is recorded | Built and tested with a mocked API; **awaiting `ANTHROPIC_API_KEY`** | `test_prompting.py` |
| **Render studio**: start from a floor plan (PNG, JPEG or PDF), a 3D model view or a sketch, plus up to 3 look references, each sent with its role; view (street, aerial, cutaway, interior), style, floors, ground floor, light, materials, landscaping | Built and tested in a browser | `test_studio.py`, e2e model test |
| **Read my plan**: a vision model describes the plan (building type, floors, layout, features) as an editable brief and fills in the floor count | Built and tested; the same vision model read a test plan correctly live | `test_studio.py` |
| **Render this view**: a picture of the 3D model's current view is saved and chosen as the shape to keep | Built and tested in a browser | e2e model test |
| No AI provider names shown to customers: tiers only, neutral errors, usage by service; provider details go to the server logs | Tested | `test_openai_client.py`, `test_cloudflare.py`, `test_renders.py`; grep of `web/` |
| Concept label stamped on every image and in the download name | Verified live | live check |
| Jobs: real status, cancel, failure reasons, interrupted jobs reported after 10 min, idempotency, 3 active per project | Verified live for renders and imports | `test_renders.py` |
| **IFC import**: IFC2X3, IFC4, IFC4X3; report (schema, units, storeys, GlobalIds, counts, honest MEP note, geometry, size, georeferencing); GLB with one node per element named by GlobalId; components table | **Verified live** (generated IFC, 6 s) | `test_bim.py` |
| **Walk through**: room list from the model's rooms, eye-height camera, drag to look, keys or on-screen arrows to move; **Save shot** keeps the view and camera | Built and tested in a browser (WebGL) | e2e walkthrough test |
| **Render all shots**: one brief, style and look references for every ticked shot; inside shots render as interiors; the whole batch is checked against the daily allowance first | Built and tested | `test_walkthrough.py`, e2e walkthrough test |
| **Walkthrough video**: chosen renders become an MP4 (16:9, 9:16 or 1:1) with slow camera moves, dips through black, room titles, title and end cards, made by FFmpeg on our server; private, downloadable, removed with the project | Built and tested with real FFmpeg (6 shots in 38 s on 2 CPUs, 250 MB peak); **verified live** (see below) | `test_walkthrough.py`, e2e walkthrough test |
| **Construction animation**: site, foundation, each floor's structure and walls, doors and windows, roof, fly-around, furniture, rooms, then the AI room renders; preview with play, scrub and stage chapters; settings for every stage's seconds, light, direction, format, hidden groups, rooms, captions, title | Built and tested in a browser | e2e construction test, `test_animation.py` |
| **Luxury style** (default): night, gold setting-out grid, glowing gold wireframe rising floor by floor, then a line of light sweeping each hero view into its photoreal AI render; **Make photoreal views** (one render per view) | Built and tested in a browser, including a real export; the look was approved by the owner from a test clip made with a live render | e2e construction test |
| **Construction animation from 3D images** (no IFC needed): up to 3 images, AI photoreal per image or "already photoreal", gold lines traced from the ground up, light sweep to photoreal, export | Built and tested in a browser, including a real export | `test_image_animation_flow.py` |
| **Cinematic clip** (Kling direct): one AI video shot from the gold wireframe to the photoreal building, 5 or 10 s, 720p/1080p, sound optional, cost shown | Built and tested with a stand-in that follows Kling's documented API; **awaiting `KLING_API_KEY` and migration 9** | `test_cinematic.py`, `test_image_animation_flow.py` |
| **Render box, prompt by AI**: "Capture view" puts the current 3D view in the render box (or the architect picks/uploads a sketch, 3D image or plan); up to 3 reference images give the scene to copy; a plain-words description; "Read image and write prompt" has Claude (free Cloudflare vision as a fallback) study the picture, the references and the model's facts (floors, element counts) and write the rendering prompt, which the architect can edit; the render then uses it as written (`prompt_ready`), with the pictures in the same order. The separate view/style/floors/light/materials fields are gone | Built and tested (unit + browser) | `test_prompting.py`, `e2e/test_model_flow.py` |
| **IFC read on the architect's computer** (web-ifc 0.0.77, MPL-2.0, in a background worker): the 3D file, parts list and model check are made in the browser and saved through `POST /api/projects/{id}/models/from-browser` (streamed into storage). A 49 MB Revit IFC2X3 model reads in about 12 s instead of 4–5 min on the server, with every part's floor, group and type identical to the server reading. The server reads files up to `IFC_MAX_MB` itself only if the browser cannot | Built and tested (browser tests read every test model in the browser) | `test_bim.py`, `e2e/test_model_flow.py` |
| **One service at a time**: a project opens on "What do you want to make?" (Photoreal render, Floor plan to 3D, Render your Revit model, Walkthrough video, Construction animation, Animation from a 3D image); step 1 uploads a new file or picks one from the project's Library; step 2 shows only that service's screen, with its settings and AI version choice; a tab bar switches service (back to step 1) and opens the Library (all files, renders and videos). The service and model are kept in the address, so a reload returns to the same screen | Built and tested in a real browser, desktop and phone | all `e2e/` tests |
| **Construction animation from the contractor's programme**: upload a Microsoft Project .xml, Primavera P6 .xer, .csv or Excel .xlsx schedule (SYNCHRO and Asta export these); each task is matched by keywords to a building part (foundation, columns, slabs, walls, windows, roof, MEP, finishes, furniture) and floor (from its name or WBS); the customer can correct any match; the build follows the programme's order and dates, with the date and current tasks on screen, in either style, and exports to MP4. No licence and no AI involved | Built and tested (unit tests for each format, and in a real browser) | `test_schedule.py`, `e2e/test_programme_flow.py` |
| **Choosable options, Ollic names only**: renders offer Standard and Premium (unchanged) plus Ollic Swift, Ultra (Gemini, direct), Studio (Flux 3, coming soon) and VS (fal.ai); clips offer Ollic Motion (Kling), Cinema and Reel (coming soon) and VS (fal.ai). Each option shows what it is good at and its cost; options not connected are listed greyed out. Image options appear only where pictures are made; video options only on clips | Built and tested with stand-ins that follow each vendor's documented API; **awaiting `GEMINI_API_KEY`, `FAL_KEY`** | `test_cinematic.py` |
| **Nano Banana line drawings** (Google direct) | Built and tested with a stand-in; **awaiting `GEMINI_API_KEY`** | `test_cinematic.py` |
| **Animation director**: plain words change the settings (Standard: free text model; paid plans: Claude); 40 a day | Built and tested with stand-ins; live once migration 8 is run | `test_animation.py` |
| **Construction video export**: made in the browser (H.264, or VP9 converted by the server), checked, made phone-friendly and saved; 16:9, 9:16, 1:1 | Built and tested (VP9 path end to end; H.264 path on the server) | e2e construction test, `test_animation.py` |
| **3D viewer**: outside, inside with roof off and room names, floor picker, element details, GLB and IFC downloads; draws only on change; fits phones | Built and tested in a browser (WebGL) | e2e model test |

### Live checks, 22 Oct 2026
- Standard render (account B, free plan): description 29 s, sketch 13 s (kept the sketch's roof, windows and door), revision 10 s. Labels and download names correct; 4th render refused by the daily limit; Premium refused for a free plan; 3 costs recorded ($0.005 at list price, $0 actual).
- Premium: refused by OpenAI ("no credits remaining"); reported correctly, no cost recorded.
- IFC import of a generated bungalow: 6 s, report "pass", 26 elements.
- Construction animation (migration 8 run by the owner): a VP9 upload was checked, converted to H.264 and saved on the free instance in about 15 s; the animation director (free text model) turned "make it portrait for Instagram and slower on the roof" into format 9:16 and roof 6 s.
- Walkthrough (migrations 6 and 7 run by the owner): a walk-mode shot of the Living room rendered by Standard render in about 15 s, as a furnished interior that kept the model's doors and window. First video crashed the free server (out of memory); after the fix, a 1-shot 16:9 video took 110 s on the free instance (about 30 s per clip, 10 s long, H.264 1920x1080 with AAC).
- Vision model on a test plan: read all 5 room names, areas and the overall width.
- The owner's A103 sheet (6-storey block, two flats per floor) exposed bugs in the now-removed plan tracer; the lesson that stays: AI labels and readings are suggestions, never measurements.

## Test run (session 2)

`cd backend && python -m pytest`: **141 passed, 0 failed**, Python 3.13. (`test_web_flow.py` failed once in one of four full runs and passed in every other run, alone and in the suite; not yet explained.)

- Phase 1: `test_auth.py` 10, `test_projects.py` 6, `test_uploads.py` 20, `test_supabase_client.py` 5
- Renders: `test_renders.py` 25, `test_openai_client.py` 11, `test_cloudflare.py` 12, `test_studio.py` 12, `test_prompting.py` 5
- IFC: `test_bim.py` 8
- Construction animation: `test_animation.py` 10 (settings, Python and JavaScript rules agree, director replies, endpoint, limits, export of VP9 and H.264 uploads, refusals)
- Walkthrough: `test_walkthrough.py` 10 (shots, isolation, render all, allowance, real MP4 probe, video job, FFmpeg heartbeat and cancel, deletion)
- Browser: `test_web_flow.py`, `test_render_flow.py`, `test_model_flow.py` (WebGL: IFC to 3D, render this view, read my plan, plan plus look reference render, no sideways scrolling at 390 px), `test_construction_flow.py` (two-storey villa: chapters, scrubbing, plain-language change, square format, real export and conversion), `test_walkthrough_flow.py` (WebGL and FFmpeg: walk into rooms, save, reorder and delete shots, render all, make a 9:16 video)

## Known limits

- Jobs run inside the web service (512 MB on Render's free instance); IFC files are limited to 20,000 elements. A restart mid-job is reported as failed after 10 minutes.
- Jobs act with the user's token; users can write their own job and usage rows. Phase 7 moves those writes to a worker key.
- Standard render sends reference images below 512 px (the free model's limit), so fine plan detail is lost; Premium sends them at full size.
- The vision model and Standard render share Cloudflare's 10,000 free neurons a day.
- A few plan images from the removed plan tracer remain in the `models` bucket of the owner's test account.
- Render's free instance sleeps after 15 minutes idle; the first request then takes about 50 s.
- Videos are made inside the web service. On Render's free instance (0.1 CPU) a 6-shot video can take 10 minutes or more; the Starter plan (0.5 CPU) is about five times faster. A later phase moves videos to a worker.
- Construction export runs in the customer's browser: fast with a graphics card and Chrome, Edge or Safari 17+ (H.264); Firefox falls back to VP9, which the server converts (minutes on the free instance). A machine without a graphics card is slow (the test machine: about 0.7 s a frame at 1080p). The tab must stay open while it draws.
- The sequence follows element types and storeys, not a construction schedule. A schedule file (SYNCHRO, MS Project) driving the order is a later step.
- Walk through needs rooms in the IFC (IfcSpace). Revit exports them only when rooms are included in the IFC export settings; without rooms the app says so. Furniture shows when it is in the export.

## Next session should do first

1. **Owner:** run migration 9 (`20261022000009_cinematic_clips.sql`); add `KLING_API_KEY` and `GEMINI_API_KEY` in Render; add `ANTHROPIC_API_KEY` in Render; add credit to OpenAI.
2. Live check of the construction animation with a real Revit IFC: preview, a plain-language change, a 16:9 export in Chrome.
3. Live check of the walkthrough with a real Revit IFC with rooms and furniture: several shots, render all, a 9:16 video.
4. Live check: Read my plan on the owner's A103 sheet; a Standard and a Premium render from it with a look reference; a render from a real Revit IFC view. Record results here.
5. Then: payments (Paystack) so Premium can be sold; schedule files driving the construction order.
