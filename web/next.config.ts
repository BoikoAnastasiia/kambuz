import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  cacheComponents: true,
  partialPrefetching: true,
  // Lets a phone on the same Wi-Fi use `next dev` at the Mac's LAN address; dev only, no effect on a build.
  allowedDevOrigins: ["192.168.*.*", "10.*.*.*"],
  // The repo root has its own package-lock.json (the pipeline); the app's root is web/.
  turbopack: { root: process.cwd() },
};

export default nextConfig;
