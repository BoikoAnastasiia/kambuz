import Link from "next/link";
import { currentRole } from "@/auth";

/**
 * The header's right side: "+ Добавить видео" for an admin, a quiet "Войти" for a visitor
 * (the add page offers Google sign-in), nothing for a signed-in non-admin.
 */
export async function AdminLink() {
  const { role, email } = await currentRole();
  if (role === "admin") {
    return (
      <Link href="/add" className="topbar-link">
        + Добавить видео
      </Link>
    );
  }
  if (email) return null;
  return (
    <Link href="/add" className="topbar-login">
      Войти
    </Link>
  );
}
