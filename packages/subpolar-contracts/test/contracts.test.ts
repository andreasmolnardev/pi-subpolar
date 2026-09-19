import { describe, expect, test } from "bun:test";
import { UnsupportedCapabilityError } from "../src/index.ts";

describe("subpolar contracts", () => {
  test("exposes a typed unsupported capability error", () => {
    const error = new UnsupportedCapabilityError("session.persistence", "ephemeral-local");

    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe("UNSUPPORTED_CAPABILITY");
    expect(error.capability).toBe("session.persistence");
    expect(error.adapter).toBe("ephemeral-local");
  });
});
