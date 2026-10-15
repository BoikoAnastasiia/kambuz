import type { MetadataRoute } from "next";
import { connection } from "next/server";
import { collections } from "@/lib/db";
import { localePath } from "@/lib/i18n";
import { SITE_URL } from "@/lib/site";

/** Every page in both languages, each pointing at its other-language twin. Read per request, so a new recipe appears at once. */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  await connection();
  const { recipes } = await collections();
  const docs = await recipes.find({ archived: false }, { projection: { id: 1, extractedAt: 1, en: 1 } }).toArray();
  const entry = (path: string, lastModified?: string): MetadataRoute.Sitemap[number] => ({
    url: `${SITE_URL}${path === "/" ? "" : path}`,
    lastModified,
    alternates: { languages: { ru: `${SITE_URL}${path === "/" ? "" : path}`, en: `${SITE_URL}${localePath("en", path)}` } },
  });
  return [entry("/"), ...docs.map((d) => entry(`/recipe/${d.id}`, d.en?.translatedAt ?? d.extractedAt))];
}
