import Link from "next/link";
import { currentRole } from "@/auth";
import { DICTS, localePath, type Lang } from "@/lib/i18n";

/**
 * The header's right side: "+ Добавить видео" for an admin, a quiet "Войти" for a visitor
 * (the add page offers Google sign-in), nothing for a signed-in non-admin. The add page itself
 * is admin-only and stays in Russian; English pages link to its /en address so nothing redirects.
 */
export async function AdminLink({ lang }: { lang: Lang }) {
  const t = DICTS[lang];
  const { role, email } = await currentRole();
  if (role === "admin") {
    return (
      <Link href={localePath(lang, "/add")} className="topbar-link">
        {t.addVideo}
      </Link>
    );
  }
  if (email) return null;
  return (
    <Link href={localePath(lang, "/add")} className="topbar-login">
      {t.signIn}
    </Link>
  );
}
