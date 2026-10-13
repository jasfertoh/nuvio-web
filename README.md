# Nuvio Web PWA — `main` branch (vanilla upstream)

> **Which branch is this?** `main` tracks [lucaboox/nuvio-web](https://github.com/lucaboox/nuvio-web) `main` and is served at https://nuvio-upstream.jasfertoh.com purely so it can be compared with the user's fork, `modified` (https://nuvio-web.jasfertoh.com). This README is written so a new session can pick the project up cold. **The original upstream README is preserved at the bottom.**

## What differs from upstream, and what does not

- Code is upstream's, except for **one deliberate commit**: the sign-in screen was synced from `modified` (`src/components/AuthScreen.tsx` and the `.auth-card`/`.auth-logo` rules in `src/styles.css`). Do not add other changes here.
- This build has **no media-proxy support**: `media-transcode` appears nowhere in its bundle, and it talks to whatever backend it was built with. Sources needing AC-3/TrueHD/HEVC handling, the decoder-refusal retry, the device subtitle size and the proxy sign flow exist only on `modified`. That absence is the point of the comparison, not a bug.
- It has no `Dockerfile`, `deploy/Caddyfile` or `.dockerignore`; upstream ships none. The image is built from a self-contained Dockerfile in the `self-host` repo (`deploy/nuvio-web-upstream.Dockerfile`) that copies only source and writes Caddy's config inline, so this checkout stays clean. It deliberately takes no media-proxy build arg.
- It is checked out as the git worktree `~/Github Repos/nuvio-web-main`, belonging to the repo at `~/Github Repos/nuvio-web`.

## How this project is deployed (read this first)

Everything runs on one Mac (the "Pro") in Docker, published through Cloudflare tunnels. Two repositories are involved and they are always used together:

| Path | What it is |
|---|---|
| `~/Github Repos/nuvio-web` | This repo: the browser PWA. Checked out on `modified`. |
| `~/Github Repos/nuvio-web-main` | A **git worktree** of this same repo, checked out on `main`, so both branches can be built at once without switching. |
| `~/Github Repos/self-host` | Docker Compose stack: Supabase-compatible backend, the media proxy, and the Dockerfiles/compose files that build and serve both web clients. Its `origin` is `NuvioMedia/self-host`; the local-only additions live on its `media-transcode-proxy` branch. |

### What is live

| Branch | URL | Container | Local port | Built by |
|---|---|---|---|---|
| `modified` (the fork) | https://nuvio-web.jasfertoh.com | `nuvio-nuvio-web-1` | 8092 | `self-host/scripts/deploy-web.sh` |
| `main` (vanilla upstream) | https://nuvio-upstream.jasfertoh.com | `nuvio-nuvio-web-upstream-1` | 8093 | `docker compose -f compose.yml -f compose.nuvio-web-upstream.yml up -d --build nuvio-web-upstream` (run in `self-host`) |
| Backend (Supabase API) | https://backend.jasfertoh.com | Kong | 8091 | the stack |
| Media proxy | `https://backend.jasfertoh.com/media-transcode/*` | `nuvio-media-proxy-1` | 8085 (internal) | `compose.media-proxy.yml` |

Both clients use the **same backend and publishable key**, so one account shows the same library on both. Each has its own hostname on purpose: two builds of one PWA on a single origin would share `localStorage` and fight over one service worker.

### Cloudflare tunnels

`cloudflared` runs exactly one tunnel per process, so there are two LaunchAgents on the Mac, each with its own **named** config. `~/.cloudflared/config.yml` is deliberately unused.

- Nuvio tunnel `537d0023-b0ce-40cc-957c-6351a8c46e1e`, config `~/.cloudflared/nuvio.yml`, agent `~/Library/LaunchAgents/com.nuvio.cloudflared.plist`. Ingress: `backend.jasfertoh.com`→8091, `nuvio-web.jasfertoh.com`→8092, `nuvio-upstream.jasfertoh.com`→8093, then `http_status:404`.
- Ollama tunnel, config `~/.cloudflared/ollama.yml`, serves `ai.jasfertoh.com`→8080. Unrelated to Nuvio; do not disturb it.
- Add a hostname: `cloudflared tunnel route dns <tunnel-id> <host>` (authenticates with `cert.pem`), add an ingress rule, then `launchctl bootout`, **wait a few seconds**, `launchctl bootstrap` (bootstrapping too soon fails with "Input/output error 5" and briefly takes the tunnel down).
- HTTP 530 means the origin is unreachable (container or tunnel down).

### Operating rules and gotchas

- **Deploy the fork with `self-host/scripts/deploy-web.sh`**, not a hand-run `docker build`: the script also purges the Cloudflare cache, otherwise the edge keeps serving the old shell.
- The Cloudflare API token in `self-host/.env` is scoped to **Cache Purge only**. It cannot edit DNS, Page Rules or Cache Rules. Never print it or paste secrets into chat; `.env` is gitignored.
- A legacy Page Rule `*jasfertoh.com/*` (Cache Everything, 1-month TTL) exists and all three free Page Rule slots are used. Cloudflare Cache Rules with an explicit Edge TTL override `no-store`. If a deploy looks like it did nothing, check `cf-cache-status` with a cache-busting query string; a `HIT` can even make a dead origin look healthy.
- Installed PWAs keep serving their service-worker precache until the update prompt is accepted. When testing, unregister the service worker and clear caches (or use a private window).
- Supabase **publishable/anon** keys are public by design and baked into the bundle at build time (so an image is specific to one backend). `service_role` keys and the media-proxy signing secret must never be committed or pasted.
- The user has explicitly refused routing video outside Cloudflare (to avoid exposing the origin IP). Do not propose it.
- The Mac must be logged in: Docker Desktop and `cloudflared` are LaunchAgents.

## Development

```bash
npm install
npm run dev        # vite on 0.0.0.0
npm run check      # tsc -b
npm test           # node --experimental-strip-types --test tests/*.test.mjs
npm run build      # tsc -b && vite build, also copies index.html to 404.html
```

Build-time environment (read by Vite, baked into the bundle; put in `.env.local` for dev):

| Variable | Meaning |
|---|---|
| `NUVIO_SUPABASE_URL` | Account backend URL |
| `NUVIO_SUPABASE_ANON_KEY` | That backend's publishable key |
| `NUVIO_MEDIA_PROXY_URL` | *(modified only)* media proxy origin; defaults to the backend URL, kept separate so pointing at another backend does not send playback at a host with no proxy |

JSX gotcha: a bare `/* */` inside JSX is rendered as **text**; comments there must be `{/* */}`. `tsc` does not catch this. User-facing strings live in `src/locales/*.json`, never in components (see `TRANSLATING.md`).

## Git layout

Remotes: `origin` = `jasfertoh/nuvio-web` (the user's fork), `upstream` = `lucaboox/nuvio-web`. Nothing local has been pushed to `origin`.

| Branch | Purpose |
|---|---|
| `main` | Tracks `upstream/main` exactly, plus **one** deliberate commit: the sign-in screen is synced from `modified` (see below). Everything else must stay upstream's. |
| `modified` | The user's working fork, served at nuvio-web.jasfertoh.com. Contains all of upstream up to the last sync plus the fork's own work. |
| `media-proxy-playback`, `upstream-cherry-pick` | Older names for the same tip as `modified`; safe to ignore. |
| `proxy-on-upstream` | Spike proving the media-proxy port onto upstream's player is about six lines in `Player.tsx` (the other player features are the real cost). |
| `feat/anime-subtitles-fast-continue`, `backup/anime-subtitles-v1` | Anime-subtitle work; may hold commits not on `modified`. Check before deleting. |

Syncing upstream into `modified`: `git fetch upstream`, dry-run with `git merge-tree --write-tree modified upstream/main`, resolve player conflicts in the fork's favour. About 91 upstream commits (as of 2026-10) remain unapplied to `modified`; earlier ones were cherry-picked as a dependent chain, so skipping one cascades.

To refresh `main`: `git -C ../nuvio-web-main fetch upstream && git -C ../nuvio-web-main merge upstream/main`. The sign-in commit means this is a merge, not a fast-forward; the README and `AuthScreen.tsx`/`styles.css` auth rules may conflict and should keep the fork's versions.

## The sign-in screen

`src/components/AuthScreen.tsx` has **no self-hosted-backend toggle**: this build ships pointed at one backend, taken from `NUVIO_SUPABASE_URL` / `NUVIO_SUPABASE_ANON_KEY`, and the form is just email, password and a show/hide eye. The card is left-aligned and the headline wraps ("Your Nuvio, / anywhere."). Both branches now render this identically; `main`'s copy of the component and its `.auth-card*` / `.auth-logo` rules in `src/styles.css` were copied from `modified` (upstream's own version is centred, one-line, with the self-hosted toggle).

## Original upstream README

### Nuvio Web PWA

Mobile-first browser proof of concept for Nuvio accounts and Stremio addons.

#### Run

```powershell
npm install
npm run dev
```

The official backend is read from `NUVIO_SUPABASE_URL` and
`NUVIO_SUPABASE_ANON_KEY` in `.env.local`. You can also select **Self-hosted**
on the sign-in screen and enter a URL and publishable key on the device.

#### Translations

Interface text lives in `src/locales/`, one JSON file per language — never in a
component. Correcting a word is a one-line change and a pull request, with no
TypeScript involved. See [TRANSLATING.md](TRANSLATING.md).

The translations were written by an AI rather than by native speakers, so
corrections from people who actually speak the language are welcome and
expected.

#### Current scope

- Persistent sign-in and session refresh. Account creation is delegated to
  nuvio.tv; this client only signs in.
- Synced profiles, installed addons, library, watch progress and collections
- Home ordering and per-catalog visibility read from Nuvio's synced home layout
- Direct addon manifest/catalog/meta/stream calls
- Responsive home, discover, library and settings views (addons live inside
  settings), with paginated catalogs and collection folders
- Series episodes, source selection, and marking episodes watched via a
  right-click menu or a touch hold
- Native video/HLS.js playback with external handoff, plus codec diagnostics
  for Matroska audio the browser cannot decode
- Installable PWA shell with a prompted update flow

Library, watched and progress writes mirror the desktop client's sync payloads
field for field. The home layout and collections are read-only here: this
client never pushes them, so it cannot overwrite what another device saved.
See [ARCHITECTURE.md](./ARCHITECTURE.md) for the full design and limitations.

