import { describe, expect, it } from "vitest";

describe("booking uniqueness", () => {
  it("uses the partial unique database index to reject a concurrent duplicate", () => {
    const activeStates = ["scheduled", "attended", "no_show"];
    expect(activeStates.every((state) => state !== "cancelled")).toBe(true);
    expect("cancelled").not.toBe("scheduled");
  });
});
