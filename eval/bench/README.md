# Bench ground truth

Labels for `kambuz bench`. Each file is a JSON array; the bench never writes here.

## categorizer.json

One row per cached segment you have labeled by hand:

```json
[
  {
    "videoId": "n6fmm5zLmhs",
    "segmentIndex": 1,
    "dish": "Яйца Бенедикт — free text, for humans only",
    "cuisine": "french",
    "category": "breakfast-dish",
    "mealTypes": ["breakfast"]
  }
]
```

- `videoId` + `segmentIndex` point at `.cache/<videoId>/scout.json` segment `segmentIndex`
  and its draft `.cache/<videoId>/extract-<segmentIndex>.json`. A label whose segment is not
  cached is skipped and listed in the plan.
- `cuisine` must be an id from `vocab/cuisines.json`, `category` an id from
  `vocab/categories.json`, `mealTypes` a non-empty list of `breakfast`, `lunch`, `dinner`.
- `dish` is not scored.
- Cuisine is scored on the model's raw answer. The pipeline turns a cuisine that is not in the
  vocabulary into `other`; the bench does not, so labelling a dish `other` only credits a model
  that actually answered `other`, not one that invented a cuisine.

Rows that break any of these are reported by row number and left out; the rest still run.
One row per segment: a later duplicate is reported and ignored.

The verifier bench needs no labels — it plants its own errors (see `src/bench/mutations.ts`).
