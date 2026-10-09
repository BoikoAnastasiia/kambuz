import Link from "next/link";
import { currentRole } from "@/auth";

/** The header's "+ Добавить видео", shown to admins only; visitors only browse. */
export async function AdminLink() {
  const { role } = await currentRole();
  if (role !== "admin") return null;
  return (
    <Link href="/add" className="topbar-link">
      + Добавить видео
    </Link>
  );
}
