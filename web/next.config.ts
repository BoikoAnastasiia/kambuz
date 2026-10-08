import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  cacheComponents: true,
  partialPrefetching: true,
  // The repo root has its own package-lock.json (the pipeline); the app's root is web/.
  turbopack: { root: process.cwd() },
};

export default nextConfig;
