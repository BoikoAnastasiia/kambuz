"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { LANG_COOKIE, switchPath, type Lang } from "@/lib/i18n";

const FLAGS: { lang: Lang; src: string; label: string }[] = [
  { lang: "ru", src: "/flag-ru.svg", label: "Русский" },
  { lang: "en", src: "/flag-us.svg", label: "English" },
];

/** Two flags; the current language's is lit. Choosing one is remembered in a cookie the proxy reads. */
export function LanguageSwitch({ lang }: { lang: Lang }) {
  return <Flags lang={lang} pathname={usePathname()} />;
}

/**
 * The flags pointing at the given page. The layout shows them for the home page while the
 * current path streams in (usePathname can't be read during prerendering).
 */
export function Flags({ lang, pathname }: { lang: Lang; pathname: string }) {
  return (
    <nav className="lang-switch" aria-label={lang === "ru" ? "Язык" : "Language"}>
      {FLAGS.map((f) => (
        <Link
          key={f.lang}
          href={switchPath(pathname, f.lang)}
          hrefLang={f.lang}
          // Not prefetched: a prefetch made before the click carries the old cookie, so the
          // proxy would answer it with a redirect back to the language being left.
          prefetch={false}
          lang={f.lang}
          aria-current={f.lang === lang ? "true" : undefined}
          aria-label={f.label}
          title={f.label}
          className="lang-flag"
          onClick={() => {
            document.cookie = `${LANG_COOKIE}=${f.lang}; path=/; max-age=31536000; samesite=lax`;
          }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={f.src} alt="" width={28} height={20} />
        </Link>
      ))}
    </nav>
  );
}
