# Eval case format

A case is one JSON file in this directory. `npm run eval` reads every `*.json`
file here (alphabetically), makes sure the video's recipes are in the catalog
(ingesting it first unless `--no-ingest` is passed), and checks the catalog
against the case's `expect` block. It's ground truth written by a human who
watched the video — not a snapshot of whatever the model produced first.

## Shape

```json
{
  "videoId": "string",
  "note": "string",
  "expect": {
    "dishCount": 0,
    "names": ["string"],
    "cuisines": ["string"],
    "mealTypes": [["string"]],
    "ingredients": {
      "dishIndex": 0,
      "must": [
        { "ingredient": "string", "provenance": "stated", "quantity": 0 }
      ]
    }
  }
}
```

## Fields

- `videoId` — the YouTube video id (not the full URL).
- `note` — free text for the next human: what the video is, why this case exists.
- `expect.dishCount` — how many recipes this video should produce in the
  catalog. `0` for a video with no dishes (a vlog, a haul, a Q&A).
- `expect.names` — `nameRu` of every recipe from this video, in the order the
  dishes are cooked in the video (recipes are compared sorted by
  `source.segmentStart`). Must have exactly `dishCount` entries.
- `expect.cuisines` — `cuisine` of every recipe, same order as `names`.
- `expect.mealTypes` — `mealTypes` of every recipe, same order as `names`.
  Each entry is itself an array, since one recipe can carry more than one
  meal type.
- `expect.ingredients` (optional) — a spot check on one dish's ingredient
  list, for cases where getting quantities and provenance right matters most.
  - `dishIndex` — which recipe in `names`/`cuisines`/`mealTypes` order to check.
  - `must` — ingredients that must appear on that dish, each with:
    - `ingredient` — the canonical vocabulary id (see `vocab/ingredients.json`),
      not the raw word the chef used.
    - `provenance` — `"stated"` (an exact quantity was said), `"inferred"`
      (implied, e.g. "take an onion" = one onion), or `"unknown"` (present but
      no usable quantity).
    - `quantity` (optional) — only checked when present here; omit it for an
      ingredient whose exact amount doesn't matter for the case.

Only ingredients listed in `must` are checked — the case does not need to
enumerate the whole ingredient list, and extra ingredients in the actual
recipe are not a failure.

## Writing a case

1. Run `npm run kambuz -- ingest "https://youtu.be/<videoId>"` for real.
2. Watch the video (or at least the segments in question) and write down what
   the chef actually said — dish names, cuisines, meal types, and any
   ingredient quantities you want pinned down.
3. Write the case file from that ground truth, not from the recipe JSON the
   pipeline produced — the point of the eval is to catch the pipeline being
   wrong, so the case must not just echo its output back at it.
4. Run `npm run eval` (add `--force` if you changed a prompt and want the eval
   to re-run the agents instead of reading the cache) and confirm the new
   case passes for the right reason.

Required coverage for the suite as a whole (see the task brief): at least one
video with four or more dishes, one non-recipe vlog (`dishCount: 0`), and one
video with heavy caption noise.

## Example (illustration only — not a verified case)

The block below shows the shape filled in; it is **not** verified against the
actual video and must not be dropped into this directory as a real case
without watching the video first.

```json
{
  "videoId": "bskR7LVpF7I",
  "note": "single recipe, clean audio, lasagna with bolognese and bechamel",
  "expect": {
    "dishCount": 1,
    "names": ["Лазанья с соусом болоньезе"],
    "cuisines": ["italian"],
    "mealTypes": [["dinner"]],
    "ingredients": {
      "dishIndex": 0,
      "must": [
        { "ingredient": "milk", "provenance": "stated", "quantity": 1.5 },
        { "ingredient": "onion", "provenance": "inferred" },
        { "ingredient": "nutmeg", "provenance": "unknown" }
      ]
    }
  }
}
```
