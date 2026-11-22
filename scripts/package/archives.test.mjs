// Integration checks for built release archives in dist/.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { readZipEntries } from "../lib/archive.mjs";
import { backendPath } from "../lib/backend.mjs";
import { ASSET_PREFIX, manifestForPlatform, PACKAGE_ID } from "../package.mjs";

const baseManifest = JSON.parse(readFileSync(`${PACKAGE_ID}/plugin.json`, "utf8"));
const lock = JSON.parse(readFileSync("vendor-lock.json", "utf8"));
const version = baseManifest.version;

test("every platform shows the settings views on the Python language and build pages, with no interpreter override", () => {
  for (const platform of Object.keys(lock.pyrefly.platforms)) {
    const manifest = manifestForPlatform(baseManifest, platform, lock);
    assert.deepEqual(
      manifest.settingRegions.map(({ id, page, view }) => ({ id, page, view: view.function })),
      [
        { id: "language", page: { languageID: "python" }, view: "settings.view" },
        { id: "python", page: { buildSystemID: "python" }, view: "settings.view" },
      ],
      platform,
    );
    // The interpreter is the python tool's pin on the Toolchains page.
    assert.equal(manifest.settings.find(({ id }) => id === "pythonExecutable"), undefined, platform);
  }
});

function checkBackendArchitecture(bytes, platform) {
  const arm = platform.endsWith("-arm64");
  if (platform.startsWith("windows-")) {
    assert.equal(bytes.toString("ascii", 0, 2), "MZ");
    const peHeader = bytes.readUInt32LE(0x3c);
    assert.equal(bytes.readUInt32LE(peHeader), 0x4550);
    assert.equal(bytes.readUInt16LE(peHeader + 4), arm ? 0xaa64 : 0x8664);
  } else if (platform.startsWith("linux-")) {
    assert.equal(bytes.readUInt32BE(0), 0x7f454c46);
    assert.equal(bytes.readUInt16LE(18), arm ? 183 : 62);
  } else {
    assert.equal(bytes.readUInt32LE(0), 0xfeedfacf);
    assert.equal(bytes.readUInt32LE(4), arm ? 0x0100000c : 0x01000007);
  }
}

function builtArchives() {
  if (!existsSync("dist")) return [];
  return readdirSync("dist")
    .filter((name) => name.startsWith(`${ASSET_PREFIX}-${version}-`) && name.endsWith(".zip"))
    .sort()
    .map((name) => ({
      name,
      platform: name.slice(`${ASSET_PREFIX}-${version}-`.length, -".zip".length),
      path: resolve("dist", name),
    }));
}

test("at least one release archive exists in dist/ and matches vendor-lock platforms", () => {
  const archives = builtArchives();
  assert.ok(archives.length >= 1, "Expected at least one built archive in dist/");
  if (process.env.LITHE_EXPECT_ALL_ARCHIVES === "1") {
    assert.deepEqual(archives.map((archive) => archive.platform), Object.keys(lock.pyrefly.platforms).sort());
  }
  for (const archive of archives) {
    assert.ok(lock.pyrefly.platforms[archive.platform], `Unexpected platform ${archive.platform} for ${archive.name}`);
  }
});

test("every built archive has safe paths, no bytecode or symlinks, and valid platform manifest", () => {
  for (const archive of builtArchives()) {
    const entries = readZipEntries(readFileSync(archive.path));
    assert.ok(entries.length > 50, `${archive.name} should bundle pyrefly, debugpy, tomli, and templates`);

    const names = new Set();
    const folded = new Set();
    let manifestEntry = null;
    let pyreflyEntry = null;
    let backendEntry = null;

    for (const entry of entries) {
      assert.equal(entry.isSymlink, false, `${archive.name}: symbolic link forbidden (${entry.name})`);
      assert.ok(entry.name.startsWith(`${PACKAGE_ID}/`), `${archive.name}: entry ${entry.name} outside ${PACKAGE_ID}/`);
      assert.doesNotMatch(entry.name, /\.(pyc|pyo)$/i, `${archive.name}: bytecode forbidden (${entry.name})`);
      assert.ok(!entry.name.includes("__pycache__/"), `${archive.name}: __pycache__ forbidden (${entry.name})`);

      for (const part of entry.name.replace(/\/$/, "").split("/")) {
        assert.doesNotMatch(part, /[<>:"\\|?*\x00-\x1f]|[. ]$/, `${archive.name}: ${entry.name} has a name Windows refuses`);
        assert.doesNotMatch(part, /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i, `${archive.name}: ${entry.name} uses a reserved Windows name`);
        assert.ok(!part.startsWith("."), `${archive.name}: hidden file ${entry.name} forbidden in archive`);
      }

      const lower = entry.name.toLowerCase();
      assert.ok(!folded.has(lower), `${archive.name}: ${entry.name} collides in case with another entry`);
      folded.add(lower);
      names.add(entry.name);

      if (entry.name === `${PACKAGE_ID}/plugin.json`) manifestEntry = entry;
      const expectedPyrefly = `${PACKAGE_ID}/${lock.pyrefly.platforms[archive.platform].packagePath}`;
      if (entry.name === expectedPyrefly) pyreflyEntry = entry;
      if (entry.name === `${PACKAGE_ID}/${backendPath(archive.platform)}`) backendEntry = entry;
    }

    assert.ok(manifestEntry, `${archive.name}: missing plugin.json`);
    assert.ok(pyreflyEntry, `${archive.name}: missing pyrefly binary`);
    assert.equal(pyreflyEntry.unixMode & 0o111, 0o111, `${archive.name}: pyrefly binary must have executable mode`);

    assert.ok(backendEntry, `${archive.name}: missing the Rust backend`);
    assert.equal(backendEntry.unixMode & 0o111, 0o111, `${archive.name}: backend must have executable mode`);
    checkBackendArchitecture(backendEntry.data, archive.platform);

    for (const required of [
      `${PACKAGE_ID}/LICENSE`,
      `${PACKAGE_ID}/THIRD-PARTY-NOTICES.txt`,
      `${PACKAGE_ID}/RUST-THIRD-PARTY-NOTICES.txt`,
      `${PACKAGE_ID}/l10n/zh-Hans.json`,
      `${PACKAGE_ID}/scripts/lithe_rpc.py`,
      `${PACKAGE_ID}/scripts/windows_job.py`,
      `${PACKAGE_ID}/scripts/build_model.py`,
      `${PACKAGE_ID}/scripts/build_provider.py`,
      `${PACKAGE_ID}/scripts/run_entrypoint.py`,
      `${PACKAGE_ID}/scripts/discover_tests.py`,
      `${PACKAGE_ID}/scripts/dependencies.py`,
      `${PACKAGE_ID}/scripts/debugpy_adapter.py`,
      `${PACKAGE_ID}/vendor/debugpy/adapter/__main__.py`,
      `${PACKAGE_ID}/vendor/debugpy/ThirdPartyNotices.txt`,
      `${PACKAGE_ID}/vendor/tomli/__init__.py`,
      `${PACKAGE_ID}/vendor/packaging/requirements.py`,
      `${PACKAGE_ID}/vendor/packaging-${lock.wheels.packaging.version}.dist-info/licenses/LICENSE`,
      `${PACKAGE_ID}/templates/python/project/pyproject.toml`,
      `${PACKAGE_ID}/templates/python/project/dot-gitignore`,
      `${PACKAGE_ID}/templates/python/sample/main.py`,
    ]) {
      assert.ok(names.has(required), `${archive.name}: missing required file ${required}`);
    }

    const manifest = JSON.parse(manifestEntry.data.toString("utf8"));
    assert.equal(manifest.id, baseManifest.id);
    assert.equal(manifest.version, baseManifest.version);
    assert.equal(manifest.schemaVersion, baseManifest.schemaVersion);
    assert.equal(manifest.pluginAPIVersion, baseManifest.pluginAPIVersion);
    assert.deepEqual(manifest.requires, baseManifest.requires);
    assert.deepEqual(manifest.vendor, baseManifest.vendor);

    assert.equal(manifest.requires.languages, 0);
    const pythonLanguage = manifest.languages.find(({ id }) => id === "python");
    assert.equal(pythonLanguage.grammar, undefined);
    assert.equal("firstLineMatch" in pythonLanguage, false);
    const metadataPath = `${PACKAGE_ID}/grammars/python.first-line.json`;
    const metadataEntry = entries.find(({ name }) => name === metadataPath);
    assert.ok(metadataEntry, `${archive.name}: missing ${metadataPath}`);
    // Packaged JSON can have CRLF when a Windows runner assembles the ZIP.
    assert.deepEqual(
      JSON.parse(metadataEntry.data.toString("utf8")),
      JSON.parse(readFileSync(metadataPath, "utf8")),
      `${archive.name}: packaged metadata differs from ${metadataPath}`,
    );

    assert.deepEqual(manifest.backend, { launch: { kind: "packaged", path: backendPath(archive.platform) } });
    assert.deepEqual(manifest.toolchainProviders, baseManifest.toolchainProviders);
    assert.equal(manifest.requires.toolchainProviders, 0);
    assert.deepEqual(
      manifest.buildSystems.find(({ id }) => id === "python").test,
      baseManifest.buildSystems.find(({ id }) => id === "python").test,
    );
    const isWindows = archive.platform.startsWith("windows-");
    const pyreflyServer = manifest.languageServers.find((s) => s.languageID === "python");
    assert.deepEqual(pyreflyServer.launch, {
      kind: "backend",
      function: "pyrefly.resolveLaunch",
      timeoutMilliseconds: 30000,
    });
    assert.equal("arguments" in pyreflyServer, false);
    assert.equal("validationArguments" in pyreflyServer, false);

    const generator = manifest.projectGenerators.find((g) => g.id === "python-project");
    const venvCommands = generator.steps.filter((s) => s.kind === "command" && s.command !== "uv").map((s) => s.command);
    assert.deepEqual(venvCommands, isWindows ? ["python", "python"] : ["python3", "python3"]);
  }
});
