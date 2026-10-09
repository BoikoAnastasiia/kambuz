export type Role = "admin" | "user";

/**
 * ADMIN_EMAILS="me@gmail.com, friend@gmail.com", compared case-insensitively. Values get
 * pasted into hosting dashboards in every shape, so quotes and brackets are ignored and
 * commas, semicolons, spaces and line breaks all separate addresses.
 */
export function adminEmails(env: Record<string, string | undefined> = process.env): Set<string> {
  return new Set(
    (env.ADMIN_EMAILS ?? "")
      .replace(/["'`[\]<>]/g, " ")
      .split(/[\s,;]+/)
      .map((e) => e.trim().toLowerCase())
      .filter((e) => e.includes("@")),
  );
}

/** Only an allowlisted email is admin; no email (or an unverified one) never is. */
export function roleFor(email: string | null | undefined, env: Record<string, string | undefined> = process.env): Role {
  return email && adminEmails(env).has(email.trim().toLowerCase()) ? "admin" : "user";
}
