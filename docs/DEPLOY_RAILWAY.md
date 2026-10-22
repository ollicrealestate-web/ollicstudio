# Deploy to Railway

One Railway service runs the API and the website together. Supabase stays separate, for accounts, the database and files. Do `docs/SUPABASE_SETUP.md` first.

## 1. Put the code where Railway can build it

Choose one:

- **GitHub (recommended):** create a private repository, push this folder to it, then in Railway choose **New Project > Deploy from GitHub repo**. Every push to `main` then redeploys automatically.
- **No GitHub:** install the Railway CLI, then run `railway login`, `railway init` and `railway up` from this folder.

Railway finds the `Dockerfile` and `railway.json` and builds the container. The health check is `/health`.

## 2. Add the variables

In the service, open **Variables** and add:

| Variable | Value |
| --- | --- |
| `SUPABASE_URL` | your Supabase project URL |
| `SUPABASE_ANON_KEY` | the anon / publishable key |
| `SUPABASE_JWT_SECRET` | only for legacy-secret projects; otherwise leave it out |
| `MAX_UPLOAD_MB` | `50` |

Do not add the service-role key. Phase 1 does not use it.

The website reads its settings from the server (`/assets/config.js`), so there is nothing to edit in `web/` for production.

## 3. Give it an address

1. Open **Settings > Networking > Generate Domain**. You get an address like `https://ollic-design-studio-production.up.railway.app`.
2. **Your own domain** (for example `app.ollic.com`): add it under **Custom Domain**, then create the CNAME record Railway shows you at your DNS provider. Cloudflare DNS works; set the record to DNS-only (grey cloud) until Railway has issued the certificate.
3. Pick the region closest to your users under **Settings > Region**.

## 4. Point Supabase at the live site

In Supabase, open **Authentication > URL Configuration**:

- Set **Site URL** to the live address.
- Under **Redirect URLs**, add `https://<your address>/app.html`.

Without this step, confirmation and password-reset emails link to the wrong place.

## 5. Check it

1. Open `https://<your address>/health`. It should show `{"status":"ok"}`.
2. Open the site, create an account, confirm the email, create a project and upload a plan.
3. From your computer, run `API_URL=https://<your address> python scripts/verify_isolation.py`. Every line must say PASS.

## Later phases on the same project

- **Phase 5:** add a Redis service and a worker service, from the same repository with a different start command. Rendering runs on a rented GPU machine that takes jobs from that Redis.
- Railway bills by usage. Check current prices on Railway's pricing page before choosing a plan.
