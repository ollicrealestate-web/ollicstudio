# Status

Last updated: 23 October 2026 (images-only platform).

**Product direction (owner, 23 Oct 2026):** Ollic is an image-based platform. Architects upload PNG or JPEG images (a sketch, a Revit, SketchUp or Lumion view, a render, a photo or a floor plan picture), say in plain words what they want, and Ollic, with Claude understanding the request and writing the prompts, drives the image and video AI services through their APIs to make renders, animations and video clips. Ollic does not read model files.

**Removed on 23 Oct 2026:** IFC upload and reading (server and browser), the 3D viewer, walkthrough shots and the walkthrough slideshow video, the model-based construction animation (technical and luxury 3D styles), the animation director, construction programme (schedule) files, and PDF uploads. Their code is in git history (last commit with them: `2cb3285`). Their database tables (`building_models`, `building_components`, `camera_shots`) and the `models` bucket are left in place, unused: deleting a file or project still removes any older 3D models and shots made from it. The golden animation from 3D images was not changed.

- **Live** at https://ollicstudio.onrender.com (Render, Frankfurt; Supabase project zusfpymdqfmwgfaejaer).

## Services

| Service | Status | Evidence |
| --- | --- | --- |
| **Photoreal render**: pick the picture to render (or describe the building), up to 3 reference images for the scene, a plain-words description; "Read image and write prompt" has Claude (free Cloudflare vision as a fallback) study the pictures and write the prompt, which the architect can edit; the render uses it as written | Verified live | `test_renders.py`, `test_prompting.py`, `test_studio.py`, `e2e/test_render_flow.py` |
| **Floor plan to 3D**: a floor plan picture becomes photoreal 3D views that follow its layout; "Read my plan" describes the plan | Built and tested | `test_studio.py` |
| **Golden animation (Animation from a 3D image)**: up to 3 images; AI photoreal night view per image (or "already photoreal"); gold lines traced and drawn from the ground up; a light sweep reveals the photoreal building; exported as MP4 (16:9, 9:16, 1:1) in the browser, checked and made phone-friendly on the server | Built and tested in a browser, including a real export | `e2e/test_image_animation_flow.py`, `test_animation.py` |
| **Cinematic clip**: one AI video shot from the gold line drawing to the photoreal building; Ollic Motion (Kling) or Ollic VS (fal.ai), 5–15 s, 720p/1080p, sound optional, cost shown | Ollic VS verified live; Motion awaits `KLING_API_KEY` | `test_cinematic.py` |
| **Revisions in plain words** on any render | Verified live | `test_renders.py` |
| **Choosable AI options, Ollic names only**: Standard, Premium, Ollic Swift, Ultra, VS (Studio coming soon) for pictures; Ollic Motion, VS (Cinema, Reel coming soon) for clips; each shown only where it works | Built and tested; VS live | `test_cinematic.py` |
| **Uploads**: PNG and JPEG only, checked from their contents; a PDF, IFC, Revit file or anything else is refused with a reason to export a PNG or JPEG instead | Tested | `test_uploads.py`, `e2e/test_web_flow.py` |
| **One service at a time**: a project opens on "What do you want to make?" (Photoreal render, Floor plan to 3D, Animation from a 3D image); step 1 uploads images or picks them from the Library; step 2 shows only that service's screen; a tab bar switches service and opens the Library | Tested in a real browser, desktop and phone | `e2e/` |
| Sign-up, sign-in, password reset, projects, ownership (RLS and storage policies), deletion of files, renders, videos and projects | Verified live | `test_auth.py`, `test_projects.py` |
| Testers (`profiles.role = 'tester'`): free features unlimited, Ollic VS limited by `profiles.allowances` | Built and tested; migration 10 | `test_cinematic.py` |
| "Ollicstudio" watermark on every picture | Verified live | `test_renders.py` |

## Test run (23 Oct 2026)

`cd backend && python -m pytest`: all unit tests pass; browser tests `test_web_flow.py`, `test_render_flow.py`, `test_image_animation_flow.py` pass.

## Known limits

- Jobs run inside the web service (512 MB on Render's free instance). A restart mid-job is reported as failed after 10 minutes.
- Jobs act with the user's token; users can write their own job and usage rows. A later phase moves those writes to a worker key.
- Standard render sends reference images below 512 px (the free model's limit); Premium sends them at full size.
- The animation export runs in the customer's browser: fast with Chrome, Edge or Safari 17+ (H.264); Firefox falls back to VP9, which the server converts. The tab must stay open while it draws.
- Render's free instance sleeps after 15 minutes idle; the first request then takes about 50 s.
- Video corner tags still read "not to scale".

## Next

1. **Owner:** add `ANTHROPIC_API_KEY` in Render (better prompts); `KLING_API_KEY` and `GEMINI_API_KEY` if wanted; run migration 10 for testers.
2. Payments (Paystack) so paid options can be sold.
