import { describe, expect, test } from "vitest";
import {
  applyTrimPreset,
  defaultTrimRange,
  moveTrimRange,
  moveTrimStart,
  resizeTrimEnd,
  resizeTrimStart,
  type TrimRange,
} from "../src/state/trim";

const range = (start: number, end: number, preset: TrimRange["preset"] = 15): TrimRange => ({
  start,
  end,
  preset,
});

describe("trim range", () => {
  test("a new source starts with the 15 second preset", () => {
    expect(defaultTrimRange(120)).toEqual(range(0, 15));
    expect(defaultTrimRange(8)).toEqual(range(0, 8));
  });

  test("moving IN moves OUT with the active preset", () => {
    expect(moveTrimStart(range(20, 35), 42, 120)).toEqual(range(42, 57));
  });

  test.each([
    [10, 32],
    [15, 37],
    [30, 52],
    [60, 82],
  ] as const)("the %s second preset resizes from the current IN", (preset, end) => {
    expect(applyTrimPreset(range(22, 27, "custom"), preset, 120)).toEqual(range(22, end, preset));
  });

  test("dragging the selection preserves its duration and active preset", () => {
    expect(moveTrimRange(range(20, 35), 50, 120)).toEqual(range(50, 65));
    expect(moveTrimRange(range(110, 120), 118, 120)).toEqual(range(110, 120));
  });

  test("resizing OUT switches the range to Custom", () => {
    expect(resizeTrimEnd(range(20, 35), 40, 120)).toEqual(range(20, 40, "custom"));
  });

  test("resizing IN switches the range to Custom", () => {
    expect(resizeTrimStart(range(20, 35), 25)).toEqual(range(25, 35, "custom"));
  });

  test("a preset clamps at EOF without moving the requested IN", () => {
    expect(moveTrimStart(range(0, 15), 115, 120)).toEqual(range(115, 120));
  });

  test("IN and OUT handles cannot cross", () => {
    const movedIn = resizeTrimStart(range(2, 4), 7);
    const movedOut = resizeTrimEnd(range(2, 4), 1, 8);
    expect(movedIn.start).toBeLessThan(movedIn.end);
    expect(movedOut.end).toBeGreaterThan(movedOut.start);
  });

  test("Custom leaves the current authoritative range unchanged", () => {
    expect(applyTrimPreset(range(12, 19, 15), "custom", 120)).toEqual(range(12, 19, "custom"));
  });
});
