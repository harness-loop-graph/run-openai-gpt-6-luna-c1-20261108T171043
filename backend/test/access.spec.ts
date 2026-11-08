import { describe, expect, it } from "vitest";

function mayReadHistory(
  role: string,
  self: boolean,
  assigned: boolean,
): boolean {
  return (role === "patient" && self) || (role === "professional" && assigned);
}

describe("authorization policy", () => {
  it("restricts clinical history to own patient or assigned professional", () => {
    expect(mayReadHistory("patient", true, false)).toBe(true);
    expect(mayReadHistory("patient", false, true)).toBe(false);
    expect(mayReadHistory("professional", false, true)).toBe(true);
    expect(mayReadHistory("staff", false, true)).toBe(false);
  });
});
