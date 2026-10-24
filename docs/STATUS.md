# Status

Last updated: 24 October 2026 (models back; AI walkthroughs; Revit).

**Product direction (owner, 24 Oct 2026):** OLLIC Studio AI connects AI services through their APIs, with Claude coordinating. Architects upload Revit, IFC, drawings or images; the AI renders and films, but always guided by the architect's model so the geometry stays accurate. Everything in minutes, not hours of rendering. Customers see Ollic names only.

**How geometry is kept:** the browser draws exact guides from the model (clay view, line drawing, depth, camera paths). Renders start from the clay view and are checked against the line drawing (edge match: good ≥ 0.7, fair ≥ 0.5); a poor render is re-rendered once with a geometry-first prompt and the better one kept. Walkthrough shots send the exact clay guide video of the camera move to the video service, with the first frame rendered from the model; three frames of every shot are checked against the guide. With `ANTHROPIC_API_KEY`, Claude also looks at each result and lists any drift.

(The 23 Oct images-only change was reversed on 24 Oct: model import and the viewer were restored from `2cb3285`; construction schedules and the model construction animation stay removed.)

- **Live** at https://ollicstudio.onrender.com (Render, Frankfurt; Supabase project zusfpymdqfmwgfaejaer).

## Services

| Service | Status | Evidence |
| --- | --- | --- |
| **Render your model**: IFC read into 3D in the browser; outside, inside and walk views; "Capture view" saves the view and its line drawing; the render is checked against the lines and redone once if it drifts | Built and tested in a browser | `e2e/test_model_flow.py`, `test_bim.py`, `test_renders.py` |
| **Project look**: the model's materials (class and the model's colour) are listed from every captured view; the architect names each, sets its finish and approved colour, a setting for every view, and approves one render as the hero. Each model render is sent with the view's material map (one flat colour per material) and the hero, told what each colour stands for, and checked material by material (approved colour vs. the median colour of its region, light and shade allowed); below 80% it is made once more, materials first | Built and tested in a browser; live needs migration 12 | `test_look.py`, `e2e/test_model_flow.py` |
| **Ollic Exact**: model renders drawn on the model's own depth map (fal FLUX depth control LoRA, `preprocess_depth` off), so walls, floors, openings and camera come from the model; offered only where a model view is rendered; revisions of an Exact render use Ollic VS | Built and tested with a stand-in; live uses `FAL_KEY` (already set). Price about $0.04 an image is an estimate: no list price was published | `test_look.py` |
| **Geometry check**: finds the AI's zoom and shift against the model view, crops a reframed render back to the model's camera, then scores the shape (good ≥ 0.8); below that, one more render, geometry first. Counting floors and openings is Claude's part of the check (needs `ANTHROPIC_API_KEY`) | Built and tested; calibrated on a real 7-storey render (59% before, 82% after correction; wrong building 49%) | `test_film.py` |
| **AI walkthrough**: Claude plans the shots (a ready-made three-shot plan without a key); camera moves approach, orbit, aerial, rise, slow move in; the browser records each shot's exact clay guide (24 fps, 16:9, 9:16 or 1:1; VP9 converted to H.264); Ollic Path (Runway Aleph) or Path Plus (Kling O3 via Runway) films it photoreal, optional people and cars; checked against the model | Built and tested with a stand-in video service; live needs `RUNWAY_API_KEY` and migration 11 | `test_film.py`, `e2e/test_film_flow.py` |
| **Revit (.rvt)**: recognised from its contents; converted to IFC through Autodesk Platform Services (paid plans and owner accounts), then opened in 3D like any IFC | Built and tested with a stand-in that follows Autodesk's documented requests; live needs `APS_CLIENT_ID`, `APS_CLIENT_SECRET` | `test_revit.py`, `e2e/test_film_flow.py` |
| **Photoreal render**: pick the picture to render (or describe the building), up to 3 reference images for the scene, a plain-words description; "Read image and write prompt" has Claude (free Cloudflare vision as a fallback) study the pictures and write the prompt, which the architect can edit; the render uses it as written | Verified live | `test_renders.py`, `test_prompting.py`, `test_studio.py`, `e2e/test_render_flow.py` |
| **Floor plan to 3D**: a floor plan picture becomes photoreal 3D views that follow its layout; "Read my plan" describes the plan | Built and tested | `test_studio.py` |
| **Golden animation (Animation from a 3D image)**: up to 3 images; AI photoreal night view per image (or "already photoreal"); gold lines traced and drawn from the ground up; a light sweep reveals the photoreal building; exported as MP4 (16:9, 9:16, 1:1) in the browser, checked and made phone-friendly on the server | Built and tested in a browser, including a real export | `e2e/test_image_animation_flow.py`, `test_animation.py` |
| **Cinematic clip**: one AI video shot from the gold line drawing to the photoreal building; Ollic Motion (Kling) or Ollic VS (fal.ai), 5–15 s, 720p/1080p, sound optional, cost shown | Ollic VS verified live; Motion awaits `KLING_API_KEY` | `test_cinematic.py` |
| **Revisions in plain words** on any render | Verified live | `test_renders.py` |
| **Choosable AI options, Ollic names only**: Standard, Premium, Ollic Swift, Ultra, VS (Studio coming soon) for pictures; Ollic Motion, VS (Cinema, Reel coming soon) for clips; each shown only where it works | Built and tested; VS live | `test_cinematic.py` |
| **Uploads**: PNG, JPEG, PDF, IFC and Revit, checked from their contents; anything else is refused with a reason | Tested | `test_uploads.py`, `test_revit.py` |
| **One service at a time**: a project opens on "What do you want to make?" (Photoreal render, Floor plan to 3D, Animation from a 3D image); step 1 uploads images or picks them from the Library; step 2 shows only that service's screen; a tab bar switches service and opens the Library | Tested in a real browser, desktop and phone | `e2e/` |
| Sign-up, sign-in, password reset, projects, ownership (RLS and storage policies), deletion of files, renders, videos and projects | Verified live | `test_auth.py`, `test_projects.py` |
| Testers (`profiles.role = 'tester'`): free features unlimited, Ollic VS limited by `profiles.allowances` | Built and tested; migration 10 | `test_cinematic.py` |
| "Ollicstudio" watermark on every picture | Verified live | `test_renders.py` |

## Test run (24 Oct 2026)

`cd backend && python -m pytest`: all unit tests and all browser tests (`test_web_flow`, `test_render_flow`, `test_image_animation_flow`, `test_model_flow`, `test_film_flow`) pass.

## Known limits

- Jobs run inside the web service (512 MB on Render's free instance). A restart mid-job is reported as failed after 10 minutes.
- Jobs act with the user's token; users can write their own job and usage rows. A later phase moves those writes to a worker key.
- Standard render sends reference images below 512 px (the free model's limit); Premium sends them at full size.
- The animation export runs in the customer's browser: fast with Chrome, Edge or Safari 17+ (H.264); Firefox falls back to VP9, which the server converts. The tab must stay open while it draws.
- Render's free instance sleeps after 15 minutes idle; the first request then takes about 50 s.
- Video corner tags still read "not to scale".

## Next

1. **Owner:** run migrations `20261024000011_ai_walkthroughs.sql` (done 24 Oct) and `20261024000012_project_look.sql` in Supabase; add `RUNWAY_API_KEY` in Render (walkthroughs); `APS_CLIENT_ID` and `APS_CLIENT_SECRET` for Revit; `ANTHROPIC_API_KEY` for Claude's shot plans, prompts and checks. Supabase's free plan takes uploads up to 50 MB.
2. Next for consistency: material map and hero for walkthrough shots and construction stages; Claude counts floors and openings against the model; per-frame video checks; then construction sequences and MEP views from the model (guides per building stage, then the same AI pipeline).
3. Payments (Paystack) so paid options can be sold.
