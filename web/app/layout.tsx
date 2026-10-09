import type { Metadata, Viewport } from "next";
import Link from "next/link";
import { Bitter, Manrope } from "next/font/google";
import { Suspense } from "react";
import { AdminLink } from "@/components/AdminLink";
import "./globals.css";

// Both carry Cyrillic: recipe names and ingredients are in Russian.
const display = Bitter({ variable: "--font-display", subsets: ["latin", "cyrillic"], weight: ["700", "800", "900"] });
const body = Manrope({ variable: "--font-body", subsets: ["latin", "cyrillic"], weight: ["400", "500", "600", "700", "800"] });

export const metadata: Metadata = {
  title: "Kambuz — what to cook?",
  description: "Не знаете, что приготовить? Выберите приём пищи и кухню — мы подберём блюдо.",
};

export const viewport: Viewport = { themeColor: "#D3122C" };

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="ru" className={`${display.variable} ${body.variable}`}>
      <body>
        <div className="frame">
          <header className="topbar">
            <Link href="/" className="brand">
              <span className="brand-mark" aria-hidden>⚓</span> kambuz
            </Link>
            {/* Holds the button's place while the session is read, so the header doesn't shift. */}
            <Suspense fallback={<span className="topbar-login topbar-placeholder" aria-hidden>Войти</span>}>
              <AdminLink />
            </Suspense>
          </header>
          <main className="sheet">{children}</main>
        </div>
      </body>
    </html>
  );
}
