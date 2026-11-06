# FocusFlow

Personal AI Productivity & Focus Management Platform.

## Starter V1
- Dashboard
- Task management (create, edit, complete, delete)
- Pomodoro timer with editable durations
- Habit tracker
- Local persistence with IndexedDB (falls back to `localStorage` if IndexedDB is unavailable)
- PWA manifest and service worker shell cache

## Changelog
   ### v1.4
   - Bottom navigation for mobile (<= 650px)
   - Cloud sync of tasks, habits, habit check-ins and focus sessions with Supabase (assets/sync.js); needs migration 0004
   - Safety copy so the last change survives an instant reload
   - Neutral greeting when signed out
### v1.3.1
- Fix: service worker (v5) now revalidates with the server (`cache: "no-cache"`) and precaches with `cache: "reload"`. In v1.3 the browser HTTP cache could keep serving an old `assets/config.js` even after you edited it
- `assets/config.js` is validated: a missing/empty file, missing URL or key, malformed URL, or a **secret/service_role key** gives a specific hint in the account dialog instead of a generic failure
- `supabaseUrl` is reduced to its origin (a pasted `/rest/v1/`, trailing slash or spaces no longer break sign-in); the key is trimmed
- `FocusAuth.diagnose()` in the console prints a safe status summary (never the key)
- After upgrading from v1.3, reload twice (see `SETUP_GOOGLE_AUTH.md`)

### v1.3
- Google sign-in with Supabase Auth (PKCE flow): account button at the top right, optional and local-first. The app still works fully without signing in, and signing out never deletes local data
- `assets/config.js` holds the Supabase URL and publishable key (empty = local-only mode); `assets/auth.js` loads the pinned Supabase SDK on demand, so offline use is not affected
- `supabase/migrations/0003_rls_policies.sql`: row level security for every table (owner/admin/member/viewer roles, private habits and focus sessions, no access for signed-out visitors, protected columns such as `created_by`)
- `supabase/tests/rls_smoke_test.sql`: rollback-only test to run in the Supabase SQL editor
- Service worker v4: network first with cache fallback, never caches URLs with a query string (the OAuth `?code=`), and no longer serves stale files after you edit them
- Dashboard greeting uses your Google first name when signed in
- Setup guide: `SETUP_GOOGLE_AUTH.md`

### v1.2
- New storage layer `assets/db.js` (`FocusDB`): IndexedDB stores `tasks`, `habits`, `sessions`, `meta`
- Every record has `createdAt` / `updatedAt` / `deletedAt`; deleting leaves a tombstone, so records can be synced to Supabase later
- Only changed records are written on save; saves are queued so they never overlap
- One-time automatic import of the old `localStorage` data (key `focusflow-v1`); the old key is kept as a backup and is not modified afterwards
- Automatic fallback to `localStorage` when IndexedDB is unavailable (the status bar says "basic mode")
- Asks the browser for persistent storage to reduce the chance of data being evicted
- Service worker cache bumped to `v3` and now includes `db.js`

### v1.1
- Fix: habit/date logic now uses the local date (WIB), not UTC
- Fix: editing a completed task no longer resets it to open
- Fix: timer no longer logs duplicate sessions; it now uses timestamps so it stays accurate in background tabs
- Fix: saved timer durations are loaded back into the settings inputs
- Fix: corrupted `localStorage` no longer breaks the app
- Habit tracker now shows a real day streak
- Added PWA icons (192/512) so the app can be installed
- Service worker cache bumped to `v2`; only same-origin requests are cached
- Added `supabase/migrations/0002_foundation_helpers.sql` (updated_at triggers, sign-up trigger, indexes)

## Cloud login (optional)
See `SETUP_GOOGLE_AUTH.md`.

## Run locally
No XAMPP or backend is needed for this starter.
For PWA/service-worker testing, use a local static server (for example VS Code Live Server) or deploy to HTTPS hosting.

## Deploy
GitHub repository is the source of truth. If this folder is not the repo root, set the host's build output directory to this folder (e.g. `focusflow-starter-v1/focusflow-starter`). For a private repository, connect it to Cloudflare Pages (or another host that supports private repositories). GitHub Pages on GitHub Free has plan restrictions for private repositories.

## Important current limitations
- Data is currently stored only in this browser on this device (IndexedDB). Clearing site data deletes it.
- Sign-in exists, but cloud sync, teams, Google Calendar, push notifications, and AI integration do not yet. Signing in does not upload any data.
- Do not store secrets/API keys in frontend files or this repository.
- The service worker caches the app shell; task data uses browser local storage in this starter.

## Next milestone
Cloud sync between IndexedDB and Supabase using the `updatedAt` / `deletedAt` fields already stored locally, then the team workspace UI.
