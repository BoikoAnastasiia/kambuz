# Kambuz web

"What to cook?" — pick a meal (breakfast, lunch, dinner, dessert), a cuisine (or
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

- `/` — the picker. `GET /api/suggest?meal=&cuisine=&include=a,b&exclude=<recipe id>`
- `/recipe/[id]` — ingredients, steps with timestamps, the video embedded at the dish
- `/add` — paste a YouTube link. `POST /api/jobs {url}`, then `GET /api/jobs/[id]`

## Language

The interface is in Russian, like the recipes; only the WHAT TO COOK? title is in
English. Labels come from the Russian names in the vocab (cuisines, courses) and from
`lib/format.ts` (meals, methods, units, Russian plurals). The worker's progress
messages on the add page are written in Russian in `src/db/worker.ts`.

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
