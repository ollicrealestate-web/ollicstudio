# Status

Last updated: 22 October 2026, session 2 (walkthrough added).

**Product direction (owner, 22 Oct 2026):** architects model in Revit. Ollic is where they render, animate and present: upload a Revit IFC or a floor plan, add reference images and a description (glass, cantilevers, cladding), and get photoreal visuals. Ollic does not build models. The plan tracing, plan editor and house builder made earlier that day were removed; the builder survives only in `backend/tests/fixtures` to make a sample IFC for tests.

- **Phase 1: Foundation: complete.** Live at https://ollicstudio.onrender.com (Render, Frankfurt; Supabase project zusfpymdqfmwgfaejaer).
- **Phase 2: Concept rendering: complete for Standard render**, verified live. **Premium render** is built, locked to paid plans, and waits for OpenAI credit; **Premium prompting** waits for an Anthropic API key.
- **Phase 3: IFC import and 3D viewer: verified live** with a generated IFC; a real Revit export is still to be tried.
- **Render studio, rebuilt around architects:** built and tested; awaiting migration 6 and a live check.
- **Walkthrough (rooms, render all shots, MP4 video):** built and tested in a browser with real FFmpeg; awaiting migration 7 and a live check.

## Features

| Feature | Status | Evidence |
| --- | --- | --- |
| Sign-up, sign-in, password reset, token verification (ES256 via JWKS) | Operational live | `test_auth.py`; live use |
| Projects, uploads, ownership in code plus RLS and storage policies; deletion removes files | **Verified live**: `scripts/verify_isolation.py` 14/14 | `test_projects.py`, `test_uploads.py` |
| **Standard render** (free daily allowance), 3 a day per customer | **Verified live** | live check below |
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
| **Walkthrough video**: chosen renders become an MP4 (16:9, 9:16 or 1:1) with slow camera moves, cross-fades, room titles, title and end cards, made by FFmpeg on our server; private, downloadable, removed with the project | Built and tested with real FFmpeg (3 shots in 43 s on 2 CPUs) | `test_walkthrough.py`, e2e walkthrough test |
| **3D viewer**: outside, inside with roof off and room names, floor picker, element details, GLB and IFC downloads; draws only on change; fits phones | Built and tested in a browser (WebGL) | e2e model test |

### Live checks, 22 Oct 2026
- Standard render (account B, free plan): description 29 s, sketch 13 s (kept the sketch's roof, windows and door), revision 10 s. Labels and download names correct; 4th render refused by the daily limit; Premium refused for a free plan; 3 costs recorded ($0.005 at list price, $0 actual).
- Premium: refused by OpenAI ("no credits remaining"); reported correctly, no cost recorded.
- IFC import of a generated bungalow: 6 s, report "pass", 26 elements.
- Vision model on a test plan: read all 5 room names, areas and the overall width.
- The owner's A103 sheet (6-storey block, two flats per floor) exposed bugs in the now-removed plan tracer; the lesson that stays: AI labels and readings are suggestions, never measurements.

## Test run (session 2)

`cd backend && python -m pytest`: **128 passed, 0 failed**, Python 3.13. (`test_web_flow.py` failed once in one of four full runs and passed in every other run, alone and in the suite; not yet explained.)

- Phase 1: `test_auth.py` 10, `test_projects.py` 6, `test_uploads.py` 20, `test_supabase_client.py` 5
- Renders: `test_renders.py` 25, `test_openai_client.py` 11, `test_cloudflare.py` 12, `test_studio.py` 12, `test_prompting.py` 5
- IFC: `test_bim.py` 8
- Walkthrough: `test_walkthrough.py` 10 (shots, isolation, render all, allowance, real MP4 probe, video job, FFmpeg heartbeat and cancel, deletion)
- Browser: `test_web_flow.py`, `test_render_flow.py`, `test_model_flow.py` (WebGL: IFC to 3D, render this view, read my plan, plan plus look reference render, no sideways scrolling at 390 px), `test_walkthrough_flow.py` (WebGL and FFmpeg: walk into rooms, save, reorder and delete shots, render all, make a 9:16 video)

## Known limits

- Jobs run inside the web service (512 MB on Render's free instance); IFC files are limited to 20,000 elements. A restart mid-job is reported as failed after 10 minutes.
- Jobs act with the user's token; users can write their own job and usage rows. Phase 7 moves those writes to a worker key.
- Standard render sends reference images below 512 px (the free model's limit), so fine plan detail is lost; Premium sends them at full size.
- The vision model and Standard render share Cloudflare's 10,000 free neurons a day.
- A few plan images from the removed plan tracer remain in the `models` bucket of the owner's test account.
- Render's free instance sleeps after 15 minutes idle; the first request then takes about 50 s.
- Videos are made inside the web service. On Render's free instance (0.1 CPU) a 6-shot video can take 10 minutes or more; the Starter plan (0.5 CPU) is about five times faster. A later phase moves videos to a worker.
- Walk through needs rooms in the IFC (IfcSpace). Revit exports them only when rooms are included in the IFC export settings; without rooms the app says so. Furniture shows when it is in the export.

## Next session should do first

1. **Owner:** run `supabase/migrations/20261022000006_remove_plan_modelling.sql`, then `20261022000007_shots_and_videos.sql`; add `ANTHROPIC_API_KEY` in Render; add credit to OpenAI.
2. Live check of the walkthrough: a real Revit IFC with rooms and furniture, 3 shots, render all, a 16:9 and a 9:16 video; time it on the free instance.
3. Live check: Read my plan on the owner's A103 sheet; a Standard and a Premium render from it with a look reference; a render from a real Revit IFC view. Record results here.
4. Then **Phase 4: construction sequence** (from the IFC model) towards the build animation.
