import { describe, expect, test } from "vitest";
import { formatMediaTime, formatTimestamp } from "../src/lib/format";

describe("trim time display", () => {
  test.each([
    [0, "00:00"],
    [5, "00:05"],
    [65, "01:05"],
    [1122, "18:42"],
    [3904, "65:04"],
  ] as const)("%s seconds displays as %s", (seconds, expected) => {
    expect(formatMediaTime(seconds)).toBe(expected);
  });

  test("display rounding does not change precise transport timestamps", () => {
    expect(formatMediaTime(84.382)).toBe("01:24");
    expect(formatTimestamp(84.382)).toBe("01:24.382");
  });
});
