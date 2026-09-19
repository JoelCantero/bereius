// @vitest-environment node

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const allowedTextExtensions = new Set([
  ".css",
  ".js",
  ".json",
  ".md",
  ".mjs",
  ".prisma",
  ".sh",
  ".ts",
  ".tsx",
  ".yaml",
  ".yml",
]);
const legacyProjectNames = [
  ["vers", "medit"].join(""),
  ["next", "self"].join(""),
];

describe("project branding", () => {
  it("keeps legacy project names out of tracked files", async () => {
    const { stdout } = await execFileAsync(
      "git",
      ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
      { encoding: "utf8" },
    );
    const files = stdout
      .split("\0")
      .filter(Boolean)
      .filter((file) => ![".env", ".env.example"].includes(file))
      .filter((file) => allowedTextExtensions.has(path.extname(file)));

    const violations = (
      await Promise.all(
        files.map(async (file) => {
          let source: string;
          try {
            source = await readFile(file, "utf8");
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
            throw error;
          }
          return legacyProjectNames.some((name) =>
            source.toLocaleLowerCase("en-US").includes(name),
          )
            ? file
            : null;
        }),
      )
    ).filter((file): file is string => file !== null);

    expect(violations).toEqual([]);
  });
});