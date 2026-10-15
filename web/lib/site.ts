/** The production address, for links that must be absolute (sitemap, metadata). Vercel sets the variable; locally it falls back. */
export const SITE_URL = process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : "https://kambuz-lilac.vercel.app";
