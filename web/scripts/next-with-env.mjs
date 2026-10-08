// Runs `next <args>` with the repo-root .env (MONGODB_URI) already in the environment.
//
// The variables must be set before Next starts. Loading them from next.config.ts changed
// the environment under the dev server, which rebuilt the page and made the browser
// reload in a loop; node's --env-file flag can't be used either, because Next passes its
// own startup flags on to child processes through NODE_OPTIONS, where it isn't allowed.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const envFile = path.resolve(here, "..", "..", ".env");
// Like Next's own .env handling, a variable already set in the environment wins.
if (existsSync(envFile)) {
  const fromFile = {};
  const before = { ...process.env };
  process.loadEnvFile(envFile);
  for (const [k, v] of Object.entries(process.env)) if (!(k in before)) fromFile[k] = v;
  Object.assign(process.env, fromFile, before);
}

const next = path.resolve(here, "..", "node_modules", "next", "dist", "bin", "next");
const child = spawn(process.execPath, [next, ...process.argv.slice(2)], { stdio: "inherit", env: process.env });
child.on("exit", (code, signal) => (signal ? process.kill(process.pid, signal) : process.exit(code ?? 0)));
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => child.kill(sig));
