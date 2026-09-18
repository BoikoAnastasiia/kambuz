import { z } from "zod";

export const ProvenanceSchema = z.enum(["stated", "inferred", "unknown"]);
export type Provenance = z.infer<typeof ProvenanceSchema>;

export const DraftIngredientSchema = z.object({
  ingredient: z.string().nullable().describe("Canonical id from the vocabulary, or null if it cannot be mapped"),
  rawName: z.string().describe("What the chef called it"),
  quantity: z.number().nullable(),
  unit: z.string().nullable().describe("g, ml, pc, tbsp, tsp, clove, or null"),
  provenance: ProvenanceSchema,
  note: z.string().nullable(),
});
export type DraftIngredient = z.infer<typeof DraftIngredientSchema>;

export const DraftStepSchema = z.object({
  order: z.number().int(),
  text: z.string(),
  timestamp: z.number().describe("Seconds into the video when the chef starts this step"),
});
export type DraftStep = z.infer<typeof DraftStepSchema>;

export const DraftRecipeSchema = z.object({
  nameRu: z.string(),
  nameEn: z.string(),
  servings: z.number().nullable(),
  ingredients: z.array(DraftIngredientSchema),
  steps: z.array(DraftStepSchema),
  unmappedIngredients: z.array(z.string()),
});
export type DraftRecipe = z.infer<typeof DraftRecipeSchema>;

export const VerificationSchema = z.object({
  ingredients: z.array(z.object({ rawName: z.string(), quote: z.string().nullable(), supported: z.boolean() })),
  steps: z.array(z.object({ order: z.number().int(), quote: z.string().nullable(), supported: z.boolean() })),
  confidence: z.number().min(0).max(1),
});
export type Verification = z.infer<typeof VerificationSchema>;

// Wire schema: what the model is asked for. Structured outputs cannot enforce a
// numeric range — the SDK moves min/max into the field description, and
// messages.parse() throws outright when the answer falls outside it. runVerifier
// clamps into the strict range instead.
export const VerificationWireSchema = VerificationSchema.extend({
  confidence: z.number().describe("0 = nothing supported, 1 = everything supported"),
});

export const MealTypeSchema = z.enum(["breakfast", "lunch", "dinner"]);
export const RichnessSchema = z.enum(["light", "medium", "hearty"]);
export const DishKeySchema = z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/);

export const CategorizationSchema = z.object({
  cuisine: z.string(),
  mealTypes: z.array(MealTypeSchema).min(1),
  course: z.string(),
  method: z.string().nullable(),
  activeMinutes: z.number().nullable(),
  totalMinutes: z.number().nullable(),
  richness: RichnessSchema,
  dishKey: DishKeySchema,
});
export type Categorization = z.infer<typeof CategorizationSchema>;

// Wire schema: the dishKey pattern is unenforceable in a structured output (the SDK
// drops the regex into the description), and a model answer that breaks it would make
// messages.parse() throw. runCategorizer slugifies the answer; the strict schema above
// and RecipeSchema below guard what reaches the catalog.
export const CategorizationWireSchema = CategorizationSchema.extend({
  dishKey: z.string().describe("English slug of the dish: lowercase letters, digits and single dashes"),
});

export const RecipeFlagSchema = z.object({ kind: z.enum(["ingredient", "step"]), ref: z.string(), reason: z.string() });
export type RecipeFlag = z.infer<typeof RecipeFlagSchema>;

export const RecipeSchema = z.object({
  id: z.string(),
  nameRu: z.string(),
  nameEn: z.string(),
  dishKey: DishKeySchema,
  cuisine: z.string(),
  mealTypes: z.array(MealTypeSchema),
  course: z.string(),
  method: z.string().nullable(),
  richness: RichnessSchema,
  servings: z.number().nullable(),
  activeMinutes: z.number().nullable(),
  totalMinutes: z.number().nullable(),
  ingredients: z.array(DraftIngredientSchema),
  steps: z.array(DraftStepSchema),
  flags: z.array(RecipeFlagSchema),
  completeness: z.number(),
  source: z.object({
    videoId: z.string(), url: z.string(), videoTitle: z.string(),
    channel: z.string(), channelId: z.string(),
    segmentStart: z.number(), segmentEnd: z.number(), language: z.literal("ru"),
  }),
  extractedAt: z.string(),
  models: z.record(z.string(), z.string()),
});
export type Recipe = z.infer<typeof RecipeSchema>;
