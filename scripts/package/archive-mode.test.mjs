import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readZipEntries, writeDeterministicZip } from "../lib/archive.mjs";

test("the archive declares executable files independently of staging permissions", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "python-archive-mode-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(join(directory, "package", "bin"), { recursive: true });
  writeFileSync(join(directory, "package", "bin", "backend.exe"), "backend", { mode: 0o644 });
  writeFileSync(join(directory, "package", "metadata.json"), "{}", { mode: 0o755 });

  const output = join(directory, "release.zip");
  writeDeterministicZip(directory, "package", output, ["bin/backend.exe"]);
  const modes = readZipEntries(readFileSync(output)).map(({ name, unixMode }) => [name, unixMode]);
  assert.deepEqual(modes, [
    ["package/bin/backend.exe", 0o100755],
    ["package/metadata.json", 0o100644],
  ]);
});
