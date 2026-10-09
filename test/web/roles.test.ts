import { describe, it, expect } from "vitest";
import { adminEmails, roleFor } from "../../web/lib/roles.js";

describe("roles", () => {
  const env = { ADMIN_EMAILS: " Me@Gmail.com, friend@example.com ,," };

  it("reads the admin allowlist case-insensitively and ignores blanks", () => {
    expect([...adminEmails(env)]).toEqual(["me@gmail.com", "friend@example.com"]);
  });

  it("makes only allowlisted emails admin", () => {
    expect(roleFor("me@gmail.com", env)).toBe("admin");
    expect(roleFor("ME@GMAIL.COM ", env)).toBe("admin");
    expect(roleFor("stranger@gmail.com", env)).toBe("user");
    expect(roleFor(null, env)).toBe("user");
  });

  it("has no admins when ADMIN_EMAILS is unset, so a missing setting never opens the door", () => {
    expect(roleFor("me@gmail.com", {})).toBe("user");
  });
});
