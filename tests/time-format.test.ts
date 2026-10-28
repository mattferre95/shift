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

  test.each([
    [0, "00:00.000"],
    [20.43, "00:20.430"],
    [3599.999, "59:59.999"],
    [3600.5, "01:00:00.500"],
    [60.0005, "01:00.001"],
  ] as const)("precise boundary %s displays as %s", (seconds, expected) => {
    expect(formatTimestamp(seconds)).toBe(expected);
  });
});
