import path from "node:path";
import { fileURLToPath } from "node:url";

/** Repository root — this file lives in src/. */
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Loading .env is a side effect of importing this module, and config.ts imports ROOT
// from here, so the file is always read before buildConfig() looks at process.env —
// whatever order the entry point happens to import things in.
try {
  process.loadEnvFile(path.join(ROOT, ".env"));
} catch {
  // No .env file (or an unreadable one): the variables may already be in the
  // environment. A missing ANTHROPIC_API_KEY is reported by the CLI, not here.
}
