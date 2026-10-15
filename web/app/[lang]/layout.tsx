import type { Metadata, Viewport } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Bitter, Manrope } from "next/font/google";
import { Suspense } from "react";
import { AdminLink } from "@/components/AdminLink";
import { Flags, LanguageSwitch } from "@/components/LanguageSwitch";
import { DICTS, LANGS, isLang, localePath } from "@/lib/i18n";
import "../globals.css";

// Both carry Cyrillic: recipe names and ingredients are in Russian.
const display = Bitter({ variable: "--font-display", subsets: ["latin", "cyrillic"], weight: ["700", "800", "900"] });
const body = Manrope({ variable: "--font-body", subsets: ["latin", "cyrillic"], weight: ["400", "500", "600", "700", "800"] });

export async function generateStaticParams() {
  return LANGS.map((lang) => ({ lang }));
}

export async function generateMetadata({ params }: LayoutProps<"/[lang]">): Promise<Metadata> {
  const { lang } = await params;
  const t = DICTS[isLang(lang) ? lang : "ru"];
  return {
    title: t.htmlTitle,
    description: t.htmlDescription,
    alternates: { languages: { ru: "/", en: "/en" } },
  };
}

export const viewport: Viewport = { themeColor: "#D3122C" };

export default async function RootLayout({ children, params }: LayoutProps<"/[lang]">) {
  const { lang } = await params;
  if (!isLang(lang)) notFound();
  const t = DICTS[lang];
  return (
    <html lang={lang} className={`${display.variable} ${body.variable}`}>
      <body>
        <div className="frame">
          <header className="topbar">
            <Link href={localePath(lang, "/")} className="brand">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img className="brand-mark" src="/brand-mark.svg" alt="" width={36} height={36} /> kambuz
            </Link>
            <div className="topbar-end">
              <Suspense fallback={<Flags lang={lang} pathname={localePath(lang, "/")} />}>
                <LanguageSwitch lang={lang} />
              </Suspense>
              {/* Holds the button's place while the session is read, so the header doesn't shift. */}
              <Suspense fallback={<span className="topbar-login topbar-placeholder" aria-hidden>{t.signIn}</span>}>
                <AdminLink lang={lang} />
              </Suspense>
            </div>
          </header>
          <main className="sheet">{children}</main>
        </div>
      </body>
    </html>
  );
}
