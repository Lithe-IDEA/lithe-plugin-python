// Compiles the package-local Rust backend and collects its dependency licenses.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";

const targets = Object.freeze({
  "darwin-arm64": "aarch64-apple-darwin",
  "darwin-x64": "x86_64-apple-darwin",
  "linux-arm64": "aarch64-unknown-linux-musl",
  "linux-x64": "x86_64-unknown-linux-musl",
  "windows-arm64": "aarch64-pc-windows-msvc",
  "windows-x64": "x86_64-pc-windows-msvc",
});

export function backendPath(platform) {
  return `bin/lithe-python-backend${platform.startsWith("windows-") ? ".exe" : ""}`;
}

export function rustTarget(platform) {
  const target = targets[platform];
  if (!target) throw new Error(`No backend target configured for ${platform}`);
  return target;
}

function cargo(root, args) {
  return execFileSync(process.env.CARGO || "cargo", args, {
    cwd: root,
    encoding: "utf8",
    timeout: 10 * 60 * 1000,
    maxBuffer: 16 * 1024 * 1024,
    stdio: ["ignore", "pipe", "inherit"],
    windowsHide: true,
  });
}

export function buildBackend(root, platform) {
  const target = rustTarget(platform);
  const messages = cargo(root, [
    "build", "--locked", "--release", "--target", target, "--message-format=json-render-diagnostics",
    "--manifest-path", "backend/Cargo.toml",
  ]);
  const artifact = messages.trim().split("\n").map((line) => JSON.parse(line))
    .find((event) => event.reason === "compiler-artifact"
      && event.target.name === "lithe-python-backend" && event.executable);
  if (!artifact) throw new Error(`Cargo did not produce an executable for ${target}`);
  return artifact.executable;
}

export function dependencyNotices(root) {
  const metadata = JSON.parse(cargo(root, [
    "metadata", "--format-version", "1", "--locked", "--manifest-path", "backend/Cargo.toml",
  ]));
  const dependencies = metadata.packages.filter((pkg) => pkg.source)
    .sort((left, right) => left.name.localeCompare(right.name, "en") || left.version.localeCompare(right.version, "en"));
  const sections = dependencies.map((pkg) => {
    const directory = dirname(pkg.manifest_path);
    const licenses = readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /^(?:licen[cs]e|notice|copying|copyright)(?:\b|_)/i.test(entry.name))
      .map((entry) => join(directory, entry.name));
    if (pkg.license_file) {
      licenses.push(join(directory, pkg.license_file));
    }
    if (pkg.name === "lithe-plugin-sdk" && licenses.length === 0) {
      // The Git SDK shares its license with the sibling SDK packages.
      licenses.push(join(directory, "..", "..", "..", "LICENSE"));
    }
    if (licenses.length === 0 || licenses.some((path) => !existsSync(path))) {
      throw new Error(`Missing dependency license for ${pkg.name} ${pkg.version}`);
    }
    const texts = [...new Set(licenses.sort().map((path) => readFileSync(path, "utf8").trim()))];
    return [`${pkg.name} ${pkg.version} (${pkg.license})`, ...texts].join("\n\n");
  });
  return `Licenses for the packaged Rust backend's locked dependencies.\n\n${sections.join("\n\n------------------------------------------------------------------------\n\n")}\n`;
}
