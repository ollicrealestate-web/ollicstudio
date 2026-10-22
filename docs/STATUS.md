# Status

Last updated: 22 October 2026, session 2.

- **Phase 1: Foundation: complete.** Live at https://ollicstudio.onrender.com (Render, Frankfurt; Supabase project zusfpymdqfmwgfaejaer).
- **Phase 2: Concept rendering: complete for Standard render** (verified live on 22 Oct 2026, see below). **Premium render** (OpenAI) is wired, locked to paid plans, and waits only for credit on the OpenAI account.
- **Phase 3: IFC import** and **Phase 3b: model from a floor plan: built and tested; awaiting configuration and a live check.** The owner has to run migration 5; then an IFC import and a plan-to-model build need checking on the live site.

### Live check, 22 Oct 2026 (Standard render, Cloudflare FLUX.2 [klein] 4B), test account B on the free plan
- Concept from a description: succeeded in 29 s, 1536 x 1024. From a line sketch: succeeded in 13 s, and kept the sketch's roof, two windows and centred door. Revision ("light terracotta walls, warm lights in the windows"): succeeded in 10 s, building unchanged otherwise.
- Every image carries the stamped label; downloads return `attachment; filename=ollic-concept-…-AI-concept-not-to-scale.jpg`.
- A 4th render that day was refused with the daily-limit message. Premium for a free-plan user was refused with `premium_only`.
- `/api/usage`: 3 calls, all with costs recorded (estimate at list price, $0.005275 total; actual charge $0 inside the free allowance).
- The first Premium (OpenAI) attempt was refused by OpenAI: "You have no credits remaining". The app reported that correctly and recorded no cost.

## Features

| Feature | Status | Evidence |
| --- | --- | --- |
| Sign-up, sign-in, sign-out, password reset (Supabase Auth) | Operational live; reset emails use Supabase's default template | Live sign-in with two test accounts |
| Token verification (HS256 legacy secret; RS256/ES256 via JWKS) | Operational live (the project issues ES256 tokens) | `test_auth.py`; live isolation check |
| Projects, uploads, ownership in code plus RLS and storage policies, deletion removes files | **Verified live**: `scripts/verify_isolation.py` 14/14 | `test_projects.py`, `test_uploads.py` |
| Website, mobile layout, Render hosting from GitHub | Operational live | e2e tests; `/health` |
| **Standard render** (Cloudflare `@cf/black-forest-labs/flux-2-klein-4b`, free daily allowance): from a description, from a sketch, revisions | **Verified live** | `test_cloudflare.py`, `test_renders.py`, e2e render test |
| **Premium render** (OpenAI `gpt-image-2.5-flare` / `-sunburst`), paid plans only (`profiles.plan = 'premium'`, set by the owner until Phase 7) | Built and tested; awaiting OpenAI credit | `test_cloudflare.py`, `test_openai_client.py` |
| Concept label stamped on every image and in the download name; database refuses an unlabelled concept | Verified live | live check; migration 2 |
| Jobs: real status, cancel, failure reasons, interrupted jobs reported after 10 min, idempotency, 3 active per project | Operational in tests; render jobs verified live | `test_renders.py` |
| Daily limits per customer: Standard 3, Premium 20; failed renders do not count | Verified live (Standard) | live check |
| Cost recorded for every model call; null, never a guess, when usage or a price is missing | Verified live | live check |
| **IFC import** (IfcOpenShell 0.9): IFC2X3, IFC4, IFC4X3; validation report (schema, units, storeys, GlobalIds, element counts, MEP note, geometry, size, georeferencing); GLB with one node per element named by its GlobalId; components table; private `models` bucket. An uploaded IFC is imported automatically | Built and tested with a generated house. **Awaiting configuration**: migration 5, live import of a real Revit export | `test_bim.py`, e2e model test |
| **3D viewer** (three.js r169 bundled with the site): outside view, inside with the roof off and room names, floor picker, tap an element to see its type, floor and GlobalId, GLB and IFC downloads. Draws only when something changes (battery) and fits the building to phone screens | Built and tested in a browser (WebGL) | e2e model test, screenshots at 1280 px and 390 px |
| **Floor plan to layout** (PNG, JPEG or PDF): OpenCV finds walls (solid or double-line), doors (empty gaps), windows (gaps with glazing lines) and rooms; a vision model (Cloudflare `@cf/meta/llama-4-scout-17b-16e-instruct`) reads room names and written areas; the scale comes from the areas. Every value carries its source; missing values are flagged, never invented | Built and tested on generated plans. **Awaiting** a live run: the vision model's image request format could not be tested from here (no Cloudflare access), and plan reading falls back to unnamed rooms and a manual scale if it fails | `test_bim.py`, e2e model test |
| **Plan review editor**: walls, doors, windows, rooms over the plan; select, add, delete, drag wall ends; set the scale from one wall of known length; storeys, storey height, roof type, pitch and overhang; nothing builds without a scale | Built and tested in a browser | e2e model test |
| **Model from confirmed dimensions**: IFC4 house with walls, real openings with doors and windows, slabs, flat/gable/hip roof, named spaces; GlobalIds derived from the draft, so a rebuild keeps them; saved as a "Made by Ollic" IFC file and imported through the same pipeline. Version 1: one or two storeys (the upper floor repeats the outline as one open space) | Built and tested | `test_bim.py` |

**Phase 3 deliverable** ("a sample IFC house is processed and its report shown"): passes end to end in a browser. **Phase 3b deliverable** ("a simple sketch becomes a confirmed IFC model that passes Phase 3 validation"): passes end to end in a browser with a generated plan; awaits a real customer plan on the live site.

## Test run (session 2)

`cd backend && python -m pytest`: **114 passed, 0 failed**, Python 3.13. The 108 non-browser tests also pass in a clean environment built only from `requirements*.txt`.

- Phase 1: `test_auth.py` 10, `test_projects.py` 6, `test_uploads.py` 20, `test_supabase_client.py` 5
- Phase 2: `test_renders.py` 25, `test_openai_client.py` 11, `test_cloudflare.py` 12
- Phases 3 and 3b: `test_bim.py` 19: builder output and counts, stable GlobalIds, import report, GLB node names, broken files, plan reading (walls, doors, windows, rooms, widths, scale within 6%), double-line walls, missing scale flagged, unreadable images, vision answers parsed defensively, pixels to metres with the y-axis flipped, two storeys, API journeys (IFC import, plan to model), cross-user 404s, file links, deletion
- Browser: `e2e/test_web_flow.py`, `e2e/test_render_flow.py`, `e2e/test_model_flow.py` (WebGL: IFC upload to 3D with report and room labels; plan upload, review, scale from a wall, build; no sideways scrolling at 390 px)

Brief acceptance tests covered: **1, 2, 5, 14, 22** live; **3, 15** live for Standard render; **4, 8, 9 (honest MEP note), 12 (viewer at phone size, emulated), 13, 16, 17, 18, 37** in tests.

### Live check, 22 Oct 2026 (Phases 3 and 3b), test account B
- IFC import of the generated bungalow: succeeded in 6 s, report "pass", 26 elements, GLB served from the private bucket.
- Plan reading with the real vision model (`@cf/meta/llama-4-scout-17b-16e-instruct`): read all 5 room names and areas and the 12 m overall width; scale 0.01740 m/px against a true 0.01667 (4%).
- The owner's real sheet (A103, "Typical 1st - 6th Floor Plan", two flats around a core) failed with a generic error on its first try. Fixes: the AI step can no longer stop plan reading, results are converted to plain JSON before saving, and errors name the step that failed. The sheet frame and title block were being read as walls, and wide openings as doors: the reader now drops lines spanning the sheet, keeps only the building's wall groups, and limits doors and windows to realistic sizes. On that sheet it now finds the building's walls (128 pieces, 77 openings); rooms are under-counted (8) because terraces and open plans leave rooms unenclosed, so they need naming in the editor. A second live read then failed with a KeyError (a label landing on a wall line), fixed and tested; the third read succeeded in 13 s with 6 room names read by the AI. Its area-based scale was about 9x too large (a 14 m² label matched to a cupboard), so area evidence that implies a building under 4 m or over 150 m across, or that disagrees with the others by more than 25%, is now dropped; with nothing sensible left, the scale is flagged for the customer to set from one wall.

## Known limits

- Jobs run inside the web service (512 MB on Render's free instance). IFC files are limited to 20,000 elements here; bigger models wait for the Phase 5 worker. A restart mid-job is reported as failed after 10 minutes.
- Jobs act with the user's token; users can write their own job and usage rows. Phase 7 moves those writes to a worker key.
- Plan reading, version 1: walls must run horizontally or vertically on the page; curved and diagonal walls are not read yet. Rooms are not recomputed when walls are added in the editor. Two-storey buildings copy the ground outline upstairs until first-floor plans are supported.
- Pitched roofs cover the footprint's bounding rectangle (fine for rectangular plans; L-shapes get a simple roof).
- The vision model and Standard render share Cloudflare's 10,000 free neurons a day.
- Render's free instance sleeps after 15 minutes idle; the first request then takes about 50 s.

## Next session should do first

1. **Owner:** run `supabase/migrations/20261022000005_bim_models.sql` in the Supabase SQL editor. Until then, deleting a project fails (it looks for models to delete).
2. Live check: upload a real Revit IFC export and a real floor plan image; record the import report, whether the vision model read the room names, how the plan reading did, and the built model, here.
3. Then **Phase 4: construction sequence** (stages and dependencies from the model, cycle detection, CSV export).
