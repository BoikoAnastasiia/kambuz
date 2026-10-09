import NextAuth, { type DefaultSession } from "next-auth";
import Google from "next-auth/providers/google";
import { roleFor, type Role } from "@/lib/roles";

declare module "next-auth" {
  interface Session {
    user: { role: Role } & DefaultSession["user"];
  }
}

// Sessions are signed JWT cookies, so there is no user collection. The role is worked out
// from ADMIN_EMAILS on every request rather than stored in the token: taking an email off
// the list revokes admin on the next page load, not when the session expires.
// AUTH_SECRET, AUTH_GOOGLE_ID and AUTH_GOOGLE_SECRET come from the environment.
export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: [Google],
  callbacks: {
    // Google only vouches for an address it has verified; anything else could be anyone's.
    signIn({ account, profile }) {
      return account?.provider !== "google" || profile?.email_verified === true;
    },
    session({ session }) {
      session.user.role = roleFor(session.user.email);
      return session;
    },
  },
});

export const { GET, POST } = handlers;

/** The signed-in user's role; "user" for a visitor who isn't signed in. */
export async function currentRole(): Promise<{ role: Role; email: string | null }> {
  const session = await auth();
  return { role: session?.user.role ?? "user", email: session?.user.email ?? null };
}
