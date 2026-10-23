# Ollic Design Studio

An image-based platform: architects upload PNG or JPEG images, say in plain words what they want, and Ollic drives image and video AI services through their APIs (with Claude writing the prompts) to make photoreal renders, a golden construction animation and cinematic video clips. Built phase by phase from the *Master Development Brief, Rev. 2*.

**Current phase: 1, Foundation.** Accounts, projects and validated, private uploads. See [`docs/STATUS.md`](docs/STATUS.md).

## Run it locally

1. **Supabase:** follow [`docs/SUPABASE_SETUP.md`](docs/SUPABASE_SETUP.md). It takes about 15 minutes, and the free plan is fine.
2. **Settings:** `cp .env.example .env` and fill in the Supabase values. The website gets them from the backend automatically.
3. **Backend** (Python 3.12 or newer):

   ```bash
   cd backend
   python -m venv .venv && source .venv/bin/activate      # Windows: .venv\Scripts\activate
   pip install -r requirements-dev.txt
   python -m playwright install chromium                   # only for the browser test
   python -m pytest                                        # 40 tests
   ./run_dev.sh                                            # API and website on http://localhost:8000
   ```

4. Open <http://localhost:8000>, create an account, confirm the email, and upload a plan.
5. **Isolation check against your real Supabase:** `python scripts/verify_isolation.py`. Every line must say PASS.

## Deploy

One Railway service hosts the API and the website; see [`docs/DEPLOY_RAILWAY.md`](docs/DEPLOY_RAILWAY.md). In production the site reads its Supabase settings from the server, so keys are entered once, in Railway's variables.

## What's where

- `backend/`: FastAPI API (`app/`) and tests (`tests/`)
- `web/`: the website: landing page and dashboard, no build step
- `supabase/migrations/`: database tables, row-level security, storage bucket and policies
- `scripts/verify_isolation.py`: live check that customers cannot see each other's data
- `Dockerfile`, `railway.json`: the container and Railway settings
- `docs/`: status, architecture, design system, Supabase setup, Railway deployment

## Rules this codebase keeps (brief, section 8)

- Secrets stay on the server and out of the repository. Every variable is listed in `.env.example`.
- Every request verifies the user's token and checks project ownership in code. Row-level security is a second layer.
- No faked results, progress or integrations. Anything that needs the owner (keys, accounts, machines) is listed in `docs/STATUS.md`.

All outputs are visualisations, not construction documents.
