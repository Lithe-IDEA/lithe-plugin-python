#!/usr/bin/env node
// Packages io.github.lithe-idea.python-support into dist/python-support-<version>-<platform>.zip
// using pinned, SHA-256-verified upstream artifacts from vendor-lock.json.
//
// Usage:
//   node scripts/package.mjs [--platform <platform>]... [--expect-tag <tag>]
//
// Supported platforms:
//   darwin-arm64, darwin-x64, windows-x64, windows-arm64, linux-x64, linux-arm64

import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  extractFileFromTarGz,
  extractFileFromZip,
  extractWheelSubtree,
  writeDeterministicZip,
} from "./lib/archive.mjs";
import { backendPath, buildBackend, dependencyNotices } from "./lib/backend.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
export const PACKAGE_ID = "io.github.lithe-idea.python-support";
export const ASSET_PREFIX = "python-support";

export function sha256Buffer(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

export function sha256File(filePath) {
  return sha256Buffer(readFileSync(filePath));
}

/**
 * Produces the platform-specific plugin.json while keeping Store-checked identity,
 * version, API version, requires, and trust fields identical across all 6 archives.
 */
export function manifestForPlatform(baseManifest, platform, lock) {
  const platformSpec = lock.pyrefly?.platforms?.[platform];
  if (!platformSpec) {
    throw new Error(`Unsupported platform "${platform}" (expected one of: ${Object.keys(lock.pyrefly.platforms).join(", ")})`);
  }
  const clone = structuredClone(baseManifest);
  const isWindows = platform.startsWith("windows-");
  clone.backend.launch.path = backendPath(platform);

  for (const server of clone.languageServers ?? []) {
    if (server.languageID === "python" && server.launch?.kind === "packaged") {
      server.launch.path = platformSpec.packagePath;
    }
  }
  if (isWindows) {
    for (const generator of clone.projectGenerators ?? []) {
      for (const step of generator.steps ?? []) {
        if (step.kind === "command" && step.command === "python3") {
          step.command = "python";
        }
      }
    }
  }
  return clone;
}

async function ensureCachedArtifact({ cacheDir, filename, url, expectedSha256 }) {
  mkdirSync(cacheDir, { recursive: true });
  const target = join(cacheDir, filename);
  if (existsSync(target)) {
    const actual = sha256File(target);
    if (actual === expectedSha256) {
      return readFileSync(target);
    }
    rmSync(target, { force: true });
  }

  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) {
    throw new Error(`Failed to download ${url}: HTTP ${response.status} ${response.statusText}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  const actual = sha256Buffer(bytes);
  if (actual !== expectedSha256) {
    throw new Error(`SHA-256 mismatch for ${filename} from ${url}: expected ${expectedSha256}, got ${actual}`);
  }
  const tempPath = `${target}.tmp-${process.pid}`;
  writeFileSync(tempPath, bytes);
  renameSync(tempPath, target);
  return bytes;
}

function copyStaticTree(srcDir, dstDir) {
  mkdirSync(dstDir, { recursive: true });
  for (const name of readdirSync(srcDir).sort()) {
    if (name === ".DS_Store" || name === "__pycache__" || name.startsWith(".")) continue;
    if (/\.(pyc|pyo)$/i.test(name)) continue;
    const srcPath = join(srcDir, name);
    const dstPath = join(dstDir, name);
    const stat = lstatSync(srcPath);
    if (stat.isSymbolicLink()) {
      throw new Error(`Refusing symbolic link in plugin source directory: ${srcPath}`);
    }
    if (stat.isDirectory()) {
      copyStaticTree(srcPath, dstPath);
    } else if (stat.isFile()) {
      mkdirSync(dirname(dstPath), { recursive: true });
      copyFileSync(srcPath, dstPath);
      chmodSync(dstPath, 0o644);
    }
  }
}

export async function packagePlatforms({ platforms, expectTag, cleanDist = false } = {}) {
  const sourceDir = join(ROOT, PACKAGE_ID);
  const baseManifest = JSON.parse(readFileSync(join(sourceDir, "plugin.json"), "utf8"));
  const lock = JSON.parse(readFileSync(join(ROOT, "vendor-lock.json"), "utf8"));

  const problems = [];
  if (baseManifest.id !== PACKAGE_ID) {
    problems.push(`plugin.json id ${baseManifest.id} must equal directory ${PACKAGE_ID}`);
  }
  if (!/^[0-9]+\.[0-9]+\.[0-9]+$/.test(baseManifest.version)) {
    problems.push(`version ${baseManifest.version} is not MAJOR.MINOR.PATCH`);
  }
  if (baseManifest.vendor?.signatureRequirement !== "none") {
    problems.push('vendor.signatureRequirement must be "none"');
  }
  if (baseManifest.id === "dev.lithe" || baseManifest.id.startsWith("dev.lithe.")) {
    problems.push("dev.lithe.* is reserved for official first-party plugins");
  }
  if (expectTag && expectTag !== `v${baseManifest.version}`) {
    problems.push(`tag ${expectTag} does not match plugin.json version ${baseManifest.version} (expected v${baseManifest.version})`);
  }
  if (problems.length > 0) {
    throw new Error(problems.join("\n"));
  }

  const allPlatforms = Object.keys(lock.pyrefly.platforms);
  const selectedPlatforms = platforms && platforms.length > 0 ? platforms : allPlatforms;
  for (const p of selectedPlatforms) {
    if (!lock.pyrefly.platforms[p]) {
      throw new Error(`Unknown platform "${p}". Valid platforms: ${allPlatforms.join(", ")}`);
    }
  }

  const cacheDir = join(ROOT, ".cache");
  const distDir = join(ROOT, "dist");
  if (cleanDist) {
    rmSync(distDir, { recursive: true, force: true });
  }
  mkdirSync(distDir, { recursive: true });

  const wheels = new Map();
  for (const name of ["debugpy", "tomli", "packaging"]) {
    const spec = lock.wheels[name];
    wheels.set(name, await ensureCachedArtifact({
      cacheDir,
      filename: spec.filename,
      url: spec.url,
      expectedSha256: spec.sha256,
    }));
  }

  const notices = dependencyNotices(ROOT);
  const built = [];
  for (const platform of selectedPlatforms) {
    const pyreflySpec = lock.pyrefly.platforms[platform];
    const archiveFilename = new URL(pyreflySpec.url).pathname.split("/").pop();
    const pyreflyArchive = await ensureCachedArtifact({
      cacheDir,
      filename: archiveFilename,
      url: pyreflySpec.url,
      expectedSha256: pyreflySpec.sha256,
    });

    const stagePlatformRoot = join(ROOT, ".artifacts", "stage", platform);
    const stagePackageDir = join(stagePlatformRoot, PACKAGE_ID);
    rmSync(stagePlatformRoot, { recursive: true, force: true });
    copyStaticTree(sourceDir, stagePackageDir);
    copyFileSync(join(ROOT, "LICENSE"), join(stagePackageDir, "LICENSE"));
    chmodSync(join(stagePackageDir, "LICENSE"), 0o644);

    // Write platform-specific plugin.json.
    const platformManifest = manifestForPlatform(baseManifest, platform, lock);
    writeFileSync(
      join(stagePackageDir, "plugin.json"),
      `${JSON.stringify(platformManifest, null, 2)}\n`,
      "utf8",
    );
    chmodSync(join(stagePackageDir, "plugin.json"), 0o644);

    // Extract pyrefly binary.
    const pyreflyBytes =
      pyreflySpec.archive === "tar.gz"
        ? extractFileFromTarGz(pyreflyArchive, pyreflySpec.binaryInArchive)
        : extractFileFromZip(pyreflyArchive, pyreflySpec.binaryInArchive);
    const pyreflyDest = join(stagePackageDir, ...pyreflySpec.packagePath.split("/"));
    mkdirSync(dirname(pyreflyDest), { recursive: true });
    writeFileSync(pyreflyDest, pyreflyBytes);
    chmodSync(pyreflyDest, 0o755);

    const backendDest = join(stagePackageDir, backendPath(platform));
    copyFileSync(buildBackend(ROOT, platform), backendDest);
    chmodSync(backendDest, 0o755);
    const noticesDest = join(stagePackageDir, "RUST-THIRD-PARTY-NOTICES.txt");
    writeFileSync(noticesDest, notices, "utf8");
    chmodSync(noticesDest, 0o644);

    const vendorDir = join(stagePackageDir, "vendor");
    for (const [name, wheel] of wheels) {
      extractWheelSubtree(wheel, name, vendorDir);
    }
    extractWheelSubtree(wheels.get("packaging"), `packaging-${lock.wheels.packaging.version}.dist-info/licenses`, vendorDir);

    const relZipPath = `dist/${ASSET_PREFIX}-${baseManifest.version}-${platform}.zip`;
    const absZipPath = resolve(ROOT, relZipPath);
    rmSync(absZipPath, { force: true });
    writeDeterministicZip(stagePlatformRoot, PACKAGE_ID, absZipPath, [pyreflySpec.packagePath, backendPath(platform)]);

    const sha256 = sha256File(absZipPath);
    built.push({ platform, relZipPath, absZipPath, sha256 });
  }

  return built;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const { values } = parseArgs({
    options: {
      platform: { type: "string", multiple: true },
      "expect-tag": { type: "string" },
    },
  });
  const requestedPlatforms = (values.platform ?? [])
    .flatMap((entry) => entry.split(","))
    .map((entry) => entry.trim())
    .filter(Boolean);

  try {
    const built = await packagePlatforms({
      platforms: requestedPlatforms,
      expectTag: values["expect-tag"],
      cleanDist: requestedPlatforms.length === 0,
    });
    for (const item of built) {
      console.log(`${item.relZipPath} ${item.sha256}`);
    }
  } catch (error) {
    console.error(`✗ ${error.message ?? error}`);
    process.exit(1);
  }
}
