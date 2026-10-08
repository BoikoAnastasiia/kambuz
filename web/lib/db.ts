import "server-only";
import { MongoClient, type Db } from "mongodb";
import type { JobDoc, RecipeDoc, VideoDoc, VocabDoc } from "./types";

// One client per server process. In development, hot reloads re-evaluate this module,
// so the promise lives on globalThis to avoid opening a new connection pool each time.
const globalForMongo = globalThis as unknown as { kambuzMongo?: Promise<MongoClient> };

/** Same rule as the pipeline: the database named in the URI path, or "kambuz". */
function dbNameFrom(uri: string): string {
  const name = uri.replace(/^mongodb(\+srv)?:\/\/[^/]*/, "").replace(/^\//, "").split("?")[0];
  return name || "kambuz";
}

export class MissingDatabaseError extends Error {
  constructor() {
    super("MONGODB_URI не задан. Добавьте строку подключения к MongoDB Atlas в файл .env в корне проекта.");
  }
}

async function db(): Promise<Db> {
  const uri = process.env.MONGODB_URI?.trim();
  if (!uri) throw new MissingDatabaseError();
  globalForMongo.kambuzMongo ??= MongoClient.connect(uri);
  return (await globalForMongo.kambuzMongo).db(dbNameFrom(uri));
}

export async function collections() {
  const d = await db();
  return {
    recipes: d.collection<RecipeDoc>("recipes"),
    vocab: d.collection<VocabDoc>("vocab"),
    jobs: d.collection<JobDoc>("jobs"),
    videos: d.collection<VideoDoc>("videos"),
  };
}
