import { readFile } from "node:fs/promises";
import path from "node:path";

const cache = new Map<string, string>();

export async function loadPrompt(name: string, promptsDir: string): Promise<string> {
  const key = path.join(promptsDir, `${name}.md`);
  const hit = cache.get(key);
  if (hit) return hit;
  const text = (await readFile(key, "utf8")).trim();
  cache.set(key, text);
  return text;
}
