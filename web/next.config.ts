import path from "node:path";
import type { NextConfig } from "next";

// The site and the pipeline share the repo-root .env (MONGODB_URI); a web/.env.local or
// the host's own environment variables still win, since loadEnvFile never overwrites.
try {
  process.loadEnvFile(path.resolve(process.cwd(), "..", ".env"));
} catch {
  // No root .env: the variables come from the environment (e.g. Vercel).
}

const nextConfig: NextConfig = {
  cacheComponents: true,
  partialPrefetching: true,
  // The repo root has its own package-lock.json (the pipeline); the app's root is web/.
  turbopack: { root: process.cwd() },
};

export default nextConfig;
