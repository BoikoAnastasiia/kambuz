import type { MetadataRoute } from "next";
import { SITE_URL } from "@/lib/site";

export default function robots(): MetadataRoute.Robots {
  // The admin page and the API are no use in search results.
  return { rules: { userAgent: "*", allow: "/", disallow: ["/add", "/en/add", "/api/"] }, sitemap: `${SITE_URL}/sitemap.xml` };
}
