import { NextResponse, type NextRequest } from "next/server";
import { LANG_COOKIE, preferredLang } from "@/lib/i18n";

/**
 * Russian is served at the bare paths (/, /recipe/…) and English under /en. Pages live in
 * app/[lang], so a bare path is rewritten to /ru/… behind the scenes, and links shared before
 * the English site existed keep working. A visitor who prefers English, by the switch or by
 * their browser, is sent to /en instead.
 */
export function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  if (pathname === "/en" || pathname.startsWith("/en/") || pathname === "/ru" || pathname.startsWith("/ru/")) return NextResponse.next();

  const lang = preferredLang(request.cookies.get(LANG_COOKIE)?.value, request.headers.get("accept-language"));
  // Only page loads are redirected: a form post (sign-in, sign-out) must reach its route as sent.
  if (lang === "en" && (request.method === "GET" || request.method === "HEAD")) {
    return NextResponse.redirect(new URL(`/en${pathname === "/" ? "" : pathname}${search}`, request.url));
  }
  return NextResponse.rewrite(new URL(`/ru${pathname === "/" ? "" : pathname}${search}`, request.url));
}

export const config = {
  // Not the API, Next's own files, or anything with a file extension (public/ assets).
  matcher: ["/((?!api|_next|.*\\..*).*)"],
};
