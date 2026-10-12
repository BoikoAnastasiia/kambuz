// Mirrors the pipeline's documents (src/db/mongo.ts and src/schemas/recipe.ts in the repo root).

export type MealType = "breakfast" | "lunch" | "dinner";

export interface Ingredient {
  ingredient: string | null;
  rawName: string;
  baseName?: string;
  quantity: number | null;
  unit: string | null;
  provenance: "stated" | "inferred" | "unknown";
  note: string | null;
}

export interface Recipe {
  id: string;
  nameRu: string;
  nameEn: string;
  dishKey: string;
  cuisine: string;
  mealTypes: MealType[];
  course: string;
  method: string | null;
  richness: "light" | "medium" | "hearty";
  servings: number | null;
  activeMinutes: number | null;
  totalMinutes: number | null;
  ingredients: Ingredient[];
  steps: { order: number; text: string; timestamp: number }[];
  completeness: number;
  source: { videoId: string; url: string; videoTitle: string; channel: string; segmentStart: number; segmentEnd: number };
}

export type RecipeDoc = Recipe & { _id: string; archived: boolean };

export interface VocabItem {
  id: string;
  nameRu: string;
  nameEn: string;
}

export interface VocabDoc {
  _id: "ingredients" | "cuisines" | "courses" | "methods";
  items: VocabItem[];
}

export type JobStatus = "queued" | "running" | "done" | "error";

export interface JobDoc {
  _id: import("mongodb").ObjectId;
  url: string;
  status: JobStatus;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  progress: string[];
  recipes: string[];
  error: string | null;
  costUsd: number | null;
}

export interface VideoDoc {
  _id: string;
  title: string;
  status: string;
  recipes: number;
  error: string | null;
  processedAt: string;
}

export interface WorkerDoc {
  _id: string;
  startedAt: string;
  lastSeen: string;
  currentJob: string | null;
  stoppedAt: string | null;
}

/** What GET /api/admin/status returns to the admin panel. */
export interface AdminStatus {
  worker: { online: boolean; host: string | null; lastSeen: string | null; currentJob: string | null };
  queued: number;
  jobs: {
    id: string;
    url: string;
    videoId: string | null;
    status: JobStatus;
    createdAt: string;
    finishedAt: string | null;
    lastProgress: string | null;
    error: string | null;
    costUsd: number | null;
    recipes: { id: string; nameRu: string }[];
  }[];
  totals: { recipes: number; videos: number; spentUsd: number };
}

/** What the suggestion card and the "also fits" list need from a recipe. */
export interface RecipeCard {
  id: string;
  nameRu: string;
  nameEn: string;
  cuisine: string;
  course: string;
  method: string | null;
  totalMinutes: number | null;
  ingredients: string[];
  videoId: string;
  segmentStart: number;
}

export interface Suggestion {
  pick: RecipeCard | null;
  others: RecipeCard[];
  total: number;
}
