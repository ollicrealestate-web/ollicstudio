# Supabase setup (about 15 minutes)

Phase 1 needs one Supabase project. The free plan is enough to build and test.

## 1. Create the project

1. Sign in at <https://supabase.com> and choose **New project**.
2. Name it `ollic-design-studio`, set a strong database password and store it in a password manager.
3. Pick the region closest to your customers.

## 2. Create the tables, security rules and storage bucket

1. Open **SQL Editor** > **New query**.
2. Paste the whole of `supabase/migrations/20261022000001_foundation.sql` and choose **Run**.
3. Check **Table Editor**: `profiles`, `projects` and `source_files` should each show "RLS enabled".
4. Check **Storage**: a bucket named `source-files` exists and is **not** public.

If you use the Supabase CLI, `supabase link` then `supabase db push` runs the same file.

## 3. Sign-in settings

**Authentication > URL Configuration**

- **Site URL**: where the website lives. In development: `http://localhost:8000`.
- **Redirect URLs**: add `http://localhost:8000/app.html`, plus the live address once the site is deployed.

**Authentication > Providers > Email**: leave **Confirm email** on. New customers get a confirmation link before they can sign in.

## 4. Copy the keys

**Project Settings > API** (or **API Keys**):

| Value | Where it goes |
| --- | --- |
| Project URL | `SUPABASE_URL` in `.env` (and in Railway's variables) |
| anon / publishable key | `SUPABASE_ANON_KEY` in `.env` (and in Railway's variables) |
| JWT secret (legacy projects only) | `SUPABASE_JWT_SECRET` in `.env`. Leave it empty if the project uses JWT signing keys; the API then reads the public keys itself. |
| service_role / secret key | **Not used in Phase 1.** Never put it in the website or in `config.js`. |

## 5. Storage size limit

The migration sets a 50 MB limit per file on the bucket. On the free plan, Supabase also caps uploads at 50 MB project-wide (**Storage > Settings**). Large IFC files will need a paid plan, or Cloudflare R2/S3, in a later phase.

## 6. Prove that customers are isolated

1. **Authentication > Users > Add user**: create two test users with **Auto confirm user** ticked.
2. Put their emails and passwords in `.env` (`TEST_USER_A_*`, `TEST_USER_B_*`).
3. Start the API (`backend/run_dev.sh`), then run `python scripts/verify_isolation.py`.

Every line must say PASS. This is acceptance test 14 against the real database, and test 22 against real storage.
