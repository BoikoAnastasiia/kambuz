# Kambuz web

"What to cook?" in Russian and English — pick a meal (breakfast, lunch, dinner, dessert), a cuisine (or
random) and, optionally, ingredients the dish must contain; the site picks one recipe
and lists others that fit. Every recipe links to the moment in the video it came from.

The site only reads and writes MongoDB. It never runs the pipeline: **Add a video**
queues a job, and the worker (`npm run kambuz -- worker` in the repo root) picks it up,
runs the pipeline and writes the recipes back. See the repo root README.

## Run locally

    npm install
    npm run dev          # http://localhost:3000

`MONGODB_URI` is read from the repo-root `.env`, the same one the pipeline uses.
`npm run dev|build|start` go through `scripts/next-with-env.mjs`, which puts that
file's variables in the environment before Next starts; don't load it from
`next.config.ts`, which made the dev server rebuild and the page reload in a loop.

## Pages

Russian at the bare paths, English under `/en` (`/en`, `/en/recipe/[id]`):

- `/` — the picker. `GET /api/suggest?meal=&cuisine=&include=a,b&exclude=<recipe id>&lang=ru|en`
- `/recipe/[id]` — ingredients, steps with timestamps, the video embedded at the dish
- `/add` — paste a YouTube link. `POST /api/jobs {url}`, then `GET /api/jobs/[id]`
- `/sitemap.xml` — every recipe in both languages; `/robots.txt` points to it

Each recipe page has its own title ("Pepperoni Pizza — Kambuz") and links to its
other-language twin.

## Languages

Pages live in `app/[lang]` (`ru`, `en`). `proxy.ts` rewrites a bare path to the
Russian pages, so links shared before the English site existed still work, and
redirects to `/en` a visitor who chose the 🇺🇸 flag (the switch sets a `lang`
cookie) or whose browser's first language isn't Russian, Ukrainian, Belarusian or
Kazakh. The flags in the header link to the same page in the other language.

The interface text, durations, units and plurals are in `lib/i18n.ts`; cuisine,
course and ingredient names come from the vocab's `nameRu` / `nameEn`. A recipe's
English comes from its `en` field, written by the pipeline's translator (see the
root README); a recipe without one is shown in Russian with a note. The admin page
(`/add`) and the worker's progress messages stay in Russian.

## Test

    npm run test:e2e     # builds, starts on :3100, and checks both languages in Chromium

It reads the real database (nothing is written), so it needs `MONGODB_URI` in the
repo-root `.env`.

## Design

Light only. Tokens live in `app/globals.css`: red `#D3122C` frame, cream `#FFF4DE`
sheet, mustard / herb / tangerine accents; Bitter for headings and Manrope for text,
both with Cyrillic.

## Roles

Anyone can browse. Adding a video costs API money, so it needs the **admin** role:
sign in with Google (Auth.js, `auth.ts`), and an email listed in `ADMIN_EMAILS` is
admin. There is no user collection: the session is a signed cookie, and the role is
recomputed from `ADMIN_EMAILS` on every request, so removing an email revokes it at
once. The `/add` page, `POST /api/jobs` and `GET /api/jobs/[id]` all check it on the
server; the header shows "+ Добавить видео" only to admins.

Environment: `AUTH_SECRET`, `AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET`, `ADMIN_EMAILS`
(see `.env.example`). The Google OAuth client needs the redirect URI
`<site>/api/auth/callback/google` for every address the site runs on.

## Deploy (Vercel)

Import the GitHub repo with **Root Directory** `web`, and set `MONGODB_URI`,
`AUTH_SECRET`, `AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET` and `ADMIN_EMAILS` in the
project's environment variables. Atlas has to accept connections from Vercel, whose
addresses change: add `0.0.0.0/0` under Network Access (the database password still
guards it). The worker stays on your machine (`npm run kambuz -- worker`); a video
added on the deployed site waits in the queue until it runs.
