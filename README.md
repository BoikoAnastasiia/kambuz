# Kambuz

Multi-agent pipeline that turns YouTube cooking videos into grounded, structured recipes.
Give it a video or playlist URL; it writes one JSON per dish into `catalog/recipes/`.

Kambuz (камбуз) is the galley on a ship. The first source channel is a ship's cook
who films his recipes in Russian, without descriptions or chapters, so the only
input is the auto-generated captions. One video often holds five to eight dishes.

## How it works

Six stages run per video. Every LLM stage is a pure function with a typed
(Zod) structured output, and the orchestrator in plain TypeScript does all the I/O.

| Stage | What it does | LLM |
|---|---|---|
| fetcher | `yt-dlp` pulls metadata and Russian auto-captions, parsed into timestamped cues | no |
| scout | splits the transcript into one segment per dish actually cooked; says when a video is not a recipe at all | yes |
| extractor | one call per segment: name, ingredients with quantities, ordered steps | yes |
| verifier | checks every ingredient and step against the raw transcript and quotes the evidence | yes |
| categorizer | cuisine, meal type, category, timing, and a `dishKey` slug used for duplicate detection | yes |
| judge | finds candidate duplicates in the catalog, scores completeness, decides same dish or variant | yes |

Nothing is invented. Every ingredient and step must be supported by what the
chef said. Quantities carry a provenance tag: `stated` (he said "1.5 litres"),
`inferred` (he said "take an onion", so one onion), or `unknown`. Ingredients
that are not in the controlled vocabulary in `vocab/` are reported as unmapped,
never made up; the vocabulary files are edited by hand only.

Per-video stage results are cached in `.cache/<videoId>/`, so a run resumes
where it stopped and a single stage can be re-run after a prompt or vocabulary
change. Every LLM call logs token usage, and the run report prints the total.

## Setup

    brew install yt-dlp        # or: pipx install yt-dlp
    npm install
    cp .env.example .env       # add ANTHROPIC_API_KEY

Node 22 or newer.

## Run

    npm run kambuz -- ingest "https://youtu.be/bskR7LVpF7I"
    npm run kambuz -- ingest "https://www.youtube.com/playlist?list=..."
    npm run kambuz -- ingest <url> --only-stage extract   # rerun extraction after editing vocab
    npm run eval                                         # score the catalog against eval/cases

`--only-stage <stage>` re-runs that stage and every stage downstream of it
(`scout` < `extract` < `verify` < `categorize`); `--force` alone re-runs
every agent stage. Neither flag re-fetches captions — the `yt-dlp` source
stage is only re-run when its cache entry is missing.

While it runs, `ingest` draws a live tree of every video and its current
stage (spinner while an agent call is in flight, then elapsed time and
tokens, or "cached" for a stage served from `.cache/`); pass `--quiet` to
skip it and just print the final report.

Each run writes a report to `reports/<timestamp>.md` and prints its path
and the token-usage table to stdout. The report lists what was written,
what the verifier flagged, which segments failed, and every ingredient the
extractor could not map to `vocab/ingredients.json`.

The cache is keyed by video and stage, so nothing short of deleting a file
re-fetches captions. To start a video over completely — a corrupt download,
a changed caption track — remove its directory:

    rm -rf .cache/<videoId>

A cache file that is corrupt or no longer matches its schema is ignored with
a warning and the stage re-runs, so a half-written file cannot wedge a video.

## Eval

    npm run eval              # scores the existing catalog against eval/cases/*.json
    npm run eval -- --ingest  # ingests each case's video first (real API calls if uncached)

Each case names a video and what the pipeline should find in it (dish count,
names, cuisines, meal types, and optionally specific ingredients with their
provenance). The command prints a table and exits non-zero if any check fails,
so a prompt or vocabulary change can be regression-tested. Without `--ingest`
it never calls the API — it only reads what is already in `catalog/`.

## Configuration

`.env` (copied from `.env.example`) holds `ANTHROPIC_API_KEY` and, optionally:

- `KAMBUZ_MODEL=<id>` — model for every agent (default `claude-sonnet-5`).
- `KAMBUZ_MODEL_SCOUT`, `..._EXTRACTOR`, `..._VERIFIER`, `..._CATEGORIZER`,
  `..._JUDGE` — override one agent, e.g. `KAMBUZ_MODEL_SCOUT=claude-opus-5`.
- `KAMBUZ_CONCURRENCY=<n>` — simultaneous LLM calls across the whole run
  (default 4).

## Test

    npm test
    npm run typecheck

The tests never call the API. Agents are tested with a fake LLM client,
the fetcher with fixture caption files, and the cache and catalog on a
temporary directory.

## Layout

    src/
      fetcher/       yt-dlp wrapper and VTT caption parser
      agents/        scout, extractor, verifier, categorizer, judge
      prompts/       one markdown prompt per agent
      llm/           structured-output client and usage ledger
      orchestrator/  stage cache, catalog, pipeline
      schemas/       Zod schemas for every stage
      vocab/         loader and validator for vocab/*.json
    vocab/           cuisines, categories, ingredients (human-edited)
    docs/specs/      design document
    docs/plans/      implementation plan

## Design

See `docs/specs/2026-09-15-kambuz-ingestion-pipeline-design.md`.
