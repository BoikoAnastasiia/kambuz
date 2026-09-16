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

  /**
   * A cache file that is truncated (an interrupted run) or no longer matches its schema
   * (a shape change between runs) reads as a miss, so the stage simply runs again — a
   * corrupt file must never wedge a video permanently.
   */
  async get<T>(videoId: string, stage: string, schema: z.ZodType<T>): Promise<T | null> {
    if (!(await this.has(videoId, stage))) return null;
    try {
      return schema.parse(JSON.parse(await readFile(this.file(videoId, stage), "utf8")));
    } catch (e) {
      const reason = e instanceof Error ? e.message.split("\n")[0] : String(e);
      console.warn(`cache: ignoring unusable ${stage}.json for ${videoId} (${reason}); re-running the stage`);
      return null;
    }
  }

  async set(videoId: string, stage: string, value: unknown): Promise<void> {
    await mkdir(this.dir(videoId), { recursive: true });
    await writeFile(this.file(videoId, stage), JSON.stringify(value, null, 2));
  }
}
