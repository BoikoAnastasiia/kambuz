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

Adding videos is open to anyone who can reach the site, and each video costs API money,
so don't deploy it publicly before sign-in is added.
