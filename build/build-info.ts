import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface BuildMetadata {
  version: string;
  sha: string;
  dirty: boolean;
}

export function formatBuildLabel({ version, sha, dirty }: BuildMetadata): string {
  return `SHIFT v${version} · ${sha}${dirty ? "-dirty" : ""}`;
}

export function readBuildMetadata(rootDir: string): BuildMetadata {
  const config = JSON.parse(
    readFileSync(join(rootDir, "src-tauri", "tauri.conf.json"), "utf8"),
  ) as { version?: unknown };

  if (typeof config.version !== "string" || config.version.length === 0) {
    throw new Error("src-tauri/tauri.conf.json must contain an app version");
  }

  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: rootDir, encoding: "utf8" }).trim();

  return {
    version: config.version,
    sha: git("rev-parse", "HEAD").slice(0, 7),
    dirty: git("status", "--porcelain=v1", "--untracked-files=normal").length > 0,
  };
}
