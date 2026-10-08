import type { Metadata, Viewport } from "next";
import Link from "next/link";
import { Bitter, Manrope } from "next/font/google";
import "./globals.css";

// Both carry Cyrillic: recipe names and ingredients are in Russian.
const display = Bitter({ variable: "--font-display", subsets: ["latin", "cyrillic"], weight: ["700", "800", "900"] });
const body = Manrope({ variable: "--font-body", subsets: ["latin", "cyrillic"], weight: ["400", "500", "600", "700", "800"] });

export const metadata: Metadata = {
  title: "Kambuz — what to cook?",
  description: "Can't decide what to cook? Pick a meal and a cuisine and get a recipe from the galley.",
};

export const viewport: Viewport = { themeColor: "#D3122C" };

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${display.variable} ${body.variable}`}>
      <body>
        <div className="frame">
          <header className="topbar">
            <Link href="/" className="brand">
              <span className="brand-mark" aria-hidden>⚓</span> kambuz
            </Link>
            <Link href="/add" className="topbar-link">+ Add a video</Link>
          </header>
          <main className="sheet">{children}</main>
        </div>
      </body>
    </html>
  );
}
