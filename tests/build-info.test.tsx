import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { formatBuildLabel, readBuildMetadata } from "../build/build-info";
import { BuildInfo } from "../src/components/BuildInfo";

const rootDir = process.cwd();

afterEach(cleanup);

describe("build information", () => {
  test("reads the Tauri version and current short commit SHA", () => {
    const metadata = readBuildMetadata(rootDir);
    const config = JSON.parse(
      readFileSync(join(rootDir, "src-tauri", "tauri.conf.json"), "utf8"),
    ) as { version: string };
    const currentSha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: rootDir,
      encoding: "utf8",
    }).trim().slice(0, 7);
    const currentDirty = execFileSync(
      "git",
      ["status", "--porcelain=v1", "--untracked-files=normal"],
      { cwd: rootDir, encoding: "utf8" },
    ).trim().length > 0;

    expect(metadata.version).toBe(config.version);
    expect(metadata.sha).toBe(currentSha);
    expect(metadata.dirty).toBe(currentDirty);
  });

  test("marks dirty builds and leaves clean builds unmarked", () => {
    expect(formatBuildLabel({ version: "1.0.0", sha: "abcdef0", dirty: true }))
      .toBe("SHIFT v1.0.0 · abcdef0-dirty");
    expect(formatBuildLabel({ version: "1.0.0", sha: "abcdef0", dirty: false }))
      .toBe("SHIFT v1.0.0 · abcdef0");
  });

  test("renders the build label in the footer", () => {
    const label = formatBuildLabel(readBuildMetadata(rootDir));
    render(<BuildInfo label={label} />);
    expect(screen.getByLabelText("Build information").textContent).toBe(label);
  });
});
