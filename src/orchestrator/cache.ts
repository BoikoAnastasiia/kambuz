import { mkdir, readFile, writeFile, access } from "node:fs/promises";
import path from "node:path";
import type { z } from "zod";

export class StageCache {
  constructor(private root: string) {}

  dir(videoId: string): string {
    return path.join(this.root, videoId);
  }

  private file(videoId: string, stage: string): string {
    return path.join(this.dir(videoId), `${stage}.json`);
  }

  async has(videoId: string, stage: string): Promise<boolean> {
    try { await access(this.file(videoId, stage)); return true; } catch { return false; }
  }

  async get<T>(videoId: string, stage: string, schema: z.ZodType<T>): Promise<T | null> {
    if (!(await this.has(videoId, stage))) return null;
    return schema.parse(JSON.parse(await readFile(this.file(videoId, stage), "utf8")));
  }

  async set(videoId: string, stage: string, value: unknown): Promise<void> {
    await mkdir(this.dir(videoId), { recursive: true });
    await writeFile(this.file(videoId, stage), JSON.stringify(value, null, 2));
  }
}
