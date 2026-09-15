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

The `ingest` command is the next piece to land; see `docs/plans/` for the
implementation plan. The intended usage:

    npm run kambuz -- ingest "https://youtu.be/bskR7LVpF7I"
    npm run kambuz -- ingest "https://www.youtube.com/playlist?list=..."
    npm run kambuz -- ingest <url> --force --only-stage extract   # rerun extraction after editing vocab

Models: every agent uses `claude-sonnet-5`. Override with `KAMBUZ_MODEL=<id>`
or per agent, e.g. `KAMBUZ_MODEL_SCOUT=claude-opus-5`.

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
