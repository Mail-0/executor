import { describe, expect, it } from "@effect/vitest";

import { REDACTED_STATIC_VALUE, redactStaticValues } from "./redact-static-values";

describe("redactStaticValues", () => {
  it("preserves keys and replaces every value", () => {
    expect(
      redactStaticValues({
        Authorization: "Bearer secret-value",
        team: "secret-team",
      }),
    ).toEqual({
      Authorization: REDACTED_STATIC_VALUE,
      team: REDACTED_STATIC_VALUE,
    });
    expect(REDACTED_STATIC_VALUE).toBe("[redacted]");
  });

  it("passes undefined through", () => {
    expect(redactStaticValues(undefined)).toBeUndefined();
  });
});
