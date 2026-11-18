#!/usr/bin/env node
// Runs this plugin's host end-to-end tests against a pinned Lithe desktop host.
//
//   node scripts/e2e-host.mjs [--source <Lithe git URL or path>] [--ref <commit or branch>] [--run <regex>]
//
// Mirrors Lithe-IDEA/lithe-plugin-go: checks out the host revision into the disposable
// .artifacts/lithe-host (desktop/ and scripts/ only), copies e2e/host/desktop/<path> into
// that checkout, and runs scripts/desktop/desktop-go.sh test against real Rust Core.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readdir, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const root = fileURLToPath(new URL("..", import.meta.url));
const tests = join(root, "e2e", "host");
const work = join(root, ".artifacts", "lithe-host");

function detectHostPlatform() {
  const osPart =
    process.platform === "darwin"
      ? "darwin"
      : process.platform === "win32"
        ? "windows"
        : process.platform === "linux"
          ? "linux"
          : null;
  const archPart = process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "x64" : null;
  return osPart && archPart ? `${osPart}-${archPart}` : null;
}

function run(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: "inherit", ...options });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`${command} ${args.join(" ")} failed (${signal ?? `exit ${code}`})`));
    });
  });
}

async function hostTestFiles(directory = join(tests, "desktop")) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await hostTestFiles(path)));
    else if (entry.isFile()) files.push(relative(tests, path));
  }
  return files;
}

async function checkoutHost(source, ref) {
  await mkdir(work, { recursive: true });
  await run("git", ["init", "-q", work]);
  await run("git", ["-C", work, "sparse-checkout", "set", "--cone", "desktop", "scripts"]);
  await run("git", ["-C", work, "config", "remote.origin.url", source]);
  await run("git", ["-C", work, "fetch", "-q", "--depth", "1", "--filter=blob:none", "origin", ref]);
  await run("git", ["-C", work, "checkout", "-q", "--force", "--detach", "FETCH_HEAD"]);
  await run("git", ["-C", work, "clean", "-q", "-f", "-d", "--", "desktop"]);
}

async function maybeSeedDesktopArtifacts(localSourceDir) {
  if (!localSourceDir) return;
  const srcArtifacts = join(localSourceDir, ".artifacts", "desktop");
  const dstArtifacts = join(work, ".artifacts", "desktop");
  if (!existsSync(srcArtifacts) || existsSync(dstArtifacts)) return;
  await mkdir(join(work, ".artifacts"), { recursive: true });
  const cpArgs = process.platform === "darwin" ? ["-cR", srcArtifacts, dstArtifacts] : ["-R", srcArtifacts, dstArtifacts];
  await run("cp", cpArgs);
}

const { values } = parseArgs({
  options: {
    source: { type: "string" },
    ref: { type: "string" },
    run: { type: "string" },
  },
});

const pin = JSON.parse(await readFile(join(tests, "lithe-host.json"), "utf8"));
const pluginManifest = JSON.parse(await readFile(join(root, "io.github.lithe-idea.python-support", "plugin.json"), "utf8"));

for (const [name, relPath] of Object.entries(pin.repositoryEnvironment ?? {})) {
  process.env[name] ||= join(root, relPath);
}
if (!process.env.LITHE_TEST_PYTHON_PLUGIN_ARCHIVE) {
  const hostPlatform = detectHostPlatform();
  if (hostPlatform) {
    const candidate = join(root, "dist", `python-support-${pluginManifest.version}-${hostPlatform}.zip`);
    if (existsSync(candidate)) {
      process.env.LITHE_TEST_PYTHON_PLUGIN_ARCHIVE = candidate;
    }
  }
}

const missing = Object.entries(pin.requiredEnvironment ?? {}).filter(([name]) => !process.env[name]);
if (missing.length > 0) {
  throw new Error(
    `Set the plugin inputs first:\n${missing.map(([name, what]) => `  ${name}: ${what}`).join("\n")}`,
  );
}

const given = values.source ?? pin.repository;
const isRemoteUrl = /^[a-z]+:\/\//.test(given);
const source = isRemoteUrl ? given : resolve(given);
await checkoutHost(source, values.ref ?? pin.revision);
if (!isRemoteUrl) {
  await maybeSeedDesktopArtifacts(source);
}

for (const file of await hostTestFiles()) {
  const target = join(work, file);
  await mkdir(dirname(target), { recursive: true });
  await copyFile(join(tests, file), target);
}

for (const [pkg, selection] of Object.entries(pin.packages)) {
  await run(
    "bash",
    [
      "scripts/desktop/desktop-go.sh",
      "test",
      pkg,
      "-count=1",
      "-v",
      "-timeout",
      pin.timeout ?? "15m",
      "-run",
      values.run ?? selection,
    ],
    { cwd: work },
  );
}
