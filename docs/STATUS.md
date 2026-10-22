# Status

Last updated: 22 October 2026, session 2.

**Product direction (owner, 22 Oct 2026):** architects model in Revit. Ollic is where they render, animate and present: upload a Revit IFC or a floor plan, add reference images and a description (glass, cantilevers, cladding), and get photoreal visuals. Ollic does not build models. The plan tracing, plan editor and house builder made earlier that day were removed; the builder survives only in `backend/tests/fixtures` to make a sample IFC for tests.

- **Phase 1: Foundation: complete.** Live at https://ollicstudio.onrender.com (Render, Frankfurt; Supabase project zusfpymdqfmwgfaejaer).
- **Phase 2: Concept rendering: complete for Standard render**, verified live. **Premium render** is built, locked to paid plans, and waits for OpenAI credit; **Premium prompting** waits for an Anthropic API key.
- **Phase 3: IFC import and 3D viewer: verified live** with a generated IFC; a real Revit export is still to be tried.
- **Render studio, rebuilt around architects:** built and tested; awaiting migration 6 and a live check.

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
| **3D viewer**: outside, inside with roof off and room names, floor picker, element details, GLB and IFC downloads; draws only on change; fits phones | Built and tested in a browser (WebGL) | e2e model test |

### Live checks, 22 Oct 2026
- Standard render (account B, free plan): description 29 s, sketch 13 s (kept the sketch's roof, windows and door), revision 10 s. Labels and download names correct; 4th render refused by the daily limit; Premium refused for a free plan; 3 costs recorded ($0.005 at list price, $0 actual).
- Premium: refused by OpenAI ("no credits remaining"); reported correctly, no cost recorded.
- IFC import of a generated bungalow: 6 s, report "pass", 26 elements.
- Vision model on a test plan: read all 5 room names, areas and the overall width.
- The owner's A103 sheet (6-storey block, two flats per floor) exposed bugs in the now-removed plan tracer; the lesson that stays: AI labels and readings are suggestions, never measurements.

## Test run (session 2)

`cd backend && python -m pytest`: **117 passed, 0 failed**, Python 3.13.

- Phase 1: `test_auth.py` 10, `test_projects.py` 6, `test_uploads.py` 20, `test_supabase_client.py` 5
- Renders: `test_renders.py` 25, `test_openai_client.py` 11, `test_cloudflare.py` 12, `test_studio.py` 12, `test_prompting.py` 5
- IFC: `test_bim.py` 8
- Browser: `test_web_flow.py`, `test_render_flow.py`, `test_model_flow.py` (WebGL: IFC to 3D, render this view, read my plan, plan plus look reference render, no sideways scrolling at 390 px)

## Known limits

- Jobs run inside the web service (512 MB on Render's free instance); IFC files are limited to 20,000 elements. A restart mid-job is reported as failed after 10 minutes.
- Jobs act with the user's token; users can write their own job and usage rows. Phase 7 moves those writes to a worker key.
- Standard render sends reference images below 512 px (the free model's limit), so fine plan detail is lost; Premium sends them at full size.
- The vision model and Standard render share Cloudflare's 10,000 free neurons a day.
- A few plan images from the removed plan tracer remain in the `models` bucket of the owner's test account.
- Render's free instance sleeps after 15 minutes idle; the first request then takes about 50 s.

## Next session should do first

1. **Owner:** run `supabase/migrations/20261022000006_remove_plan_modelling.sql`; add `ANTHROPIC_API_KEY` in Render; add credit to OpenAI.
2. Live check: Read my plan on the owner's A103 sheet; a Standard and a Premium render from it with a look reference; a render from a real Revit IFC view. Record results here.
3. Then **Phase 4: construction sequence** (from the IFC model) towards the build animation.
