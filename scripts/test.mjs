#!/usr/bin/env node
// Runs static contract checks, unit + protocol tests for the Rust backend and Python build scripts,
// and live end-to-end smoke tests against the unpacked plugin package (backend-resolved pyrefly launch with
// external tools.python.executable injection and .venv fallback, toolchains/query, pytest --collect-only discovery
// and JUnit XML execution, cancellation process-tree cleanup, project templates, and debugpy DAP launch),
// asserting 100% file-list and SHA-256 immutability of the installed plugin directory.
//
// PYTHON selects the base Python executable (default python3 on Unix, python on Windows).
// LITHE_TEST_PLUGIN_DIR tests an already-unpacked archive directory; when unset,
// scripts/test.mjs packages (if needed) and unpacks the current platform archive
// under a temporary path containing spaces, matching Lithe's plugin install layout.

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { readZipEntries } from "./lib/archive.mjs";
import { backendPath } from "./lib/backend.mjs";
import { ASSET_PREFIX, manifestForPlatform, PACKAGE_ID, packagePlatforms, sha256File } from "./package.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const COMMAND_TIMEOUT_MS = 60_000;
const pythonCmd = process.env.PYTHON ?? (process.platform === "win32" ? "python" : "python3");

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
  if (!osPart || !archPart) {
    throw new Error(`Unsupported host platform ${process.platform}/${process.arch}`);
  }
  return `${osPart}-${archPart}`;
}

function fileUri(absPath) {
  const norm = absPath.replace(/\\/g, "/");
  return new URL(`file://${norm.startsWith("/") ? "" : "/"}${norm}`).href;
}

function run(command, args, { cwd, env = process.env } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: "utf8",
    timeout: COMMAND_TIMEOUT_MS,
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.error) {
    throw new Error(`${command} ${args.join(" ")}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} exited with ${result.status ?? result.signal}\n${result.stdout}${result.stderr}`,
    );
  }
  return result.stdout;
}

function hasPytest(executable, extraEnv = {}) {
  if (!executable) return false;
  const res = spawnSync(executable, ["-I", "-B", "-c", "import pytest"], {
    env: { ...process.env, ...extraEnv },
    stdio: "ignore",
    timeout: 8_000,
    windowsHide: true,
  });
  if (res.status === 0) return true;
  // Re-check without -I in case pytest is installed in user site-packages or PYTHONPATH.
  const resUser = spawnSync(executable, ["-B", "-c", "import pytest"], {
    env: { ...process.env, ...extraEnv },
    stdio: "ignore",
    timeout: 8_000,
    windowsHide: true,
  });
  return resUser.status === 0;
}

function resolvePytestRuntime() {
  const executable = process.env.PYTEST_PYTHON ?? pythonCmd;
  assert.ok(hasPytest(executable), "Install pytest in PYTHON or set PYTEST_PYTHON to an interpreter with pytest");
  return run(executable, ["-B", "-c", "import sys; print(sys.executable)"]).trim();
}

/** Creates an isolated virtualenv that is guaranteed NOT to have `pytest` installed. */
function ensureNoPytestPython(scratchDir) {
  if (!hasPytest(pythonCmd)) {
    return run(pythonCmd, ["-B", "-c", "import sys; print(sys.executable)"]).trim();
  }
  const bareVenv = join(scratchDir, "bare-no-pytest-venv");
  run(pythonCmd, ["-m", "venv", "--without-pip", bareVenv]);
  return process.platform === "win32"
    ? join(bareVenv, "Scripts", "python.exe")
    : join(bareVenv, "bin", "python3");
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function unpackZipToDir(zipPath, destRoot) {
  for (const entry of readZipEntries(readFileSync(zipPath))) {
    if (entry.isDirectory) continue;
    const target = join(destRoot, ...entry.name.split("/"));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, entry.data);
    if (process.platform !== "win32") {
      chmodSync(target, (entry.unixMode & 0o111) !== 0 ? 0o755 : 0o644);
    }
  }
}

function snapshotDirectoryHashes(rootDir) {
  const map = new Map();
  function walk(currentDir, prefix) {
    for (const name of readdirSync(currentDir).sort()) {
      const abs = join(currentDir, name);
      const rel = prefix ? `${prefix}/${name}` : name;
      const stat = lstatSync(abs);
      if (stat.isSymbolicLink()) {
        map.set(rel, "SYMLINK");
      } else if (stat.isDirectory()) {
        walk(abs, rel);
      } else if (stat.isFile()) {
        map.set(rel, sha256File(abs));
      }
    }
  }
  walk(rootDir, "");
  return Object.fromEntries(map);
}

/** Sends framing-based JSON-RPC / DAP messages over stdio with bounded timeout. */
class FramedStdioPeer {
  constructor(child) {
    this.child = child;
    this.buffer = Buffer.alloc(0);
    this.messages = [];
    this.allReceived = [];
    this.waiters = [];
    this.stderr = "";

    child.stdout.on("data", (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.#drain();
    });
    child.stderr.on("data", (chunk) => {
      this.stderr += chunk.toString("utf8");
    });
    child.on("close", () => {
      for (const waiter of this.waiters.splice(0)) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error(`Process exited early. stderr:\n${this.stderr}`));
      }
    });
  }

  #drain() {
    while (true) {
      const sep = this.buffer.indexOf("\r\n\r\n");
      if (sep < 0) return;
      const header = this.buffer.subarray(0, sep).toString("ascii");
      const match = /Content-Length:\s*(\d+)/i.exec(header);
      if (!match) {
        throw new Error(`Non-protocol stdout output or missing Content-Length header: ${header}`);
      }
      const length = Number.parseInt(match[1], 10);
      const bodyStart = sep + 4;
      if (this.buffer.length < bodyStart + length) return;
      const payload = JSON.parse(this.buffer.subarray(bodyStart, bodyStart + length).toString("utf8"));
      this.buffer = this.buffer.subarray(bodyStart + length);
      this.allReceived.push(payload);
      let consumed = false;
      for (let i = 0; i < this.waiters.length; i += 1) {
        if (this.waiters[i].predicate(payload)) {
          const [matched] = this.waiters.splice(i, 1);
          clearTimeout(matched.timer);
          consumed = true;
          matched.resolve(payload);
          break;
        }
      }
      if (!consumed) {
        this.messages.push(payload);
      }
    }
  }

  send(payload) {
    const raw = Buffer.from(JSON.stringify(payload), "utf8");
    this.child.stdin.write(`Content-Length: ${raw.length}\r\n\r\n`);
    this.child.stdin.write(raw);
  }

  waitFor(predicate, description, timeoutMs = 20_000) {
    const existing = this.messages.find(predicate);
    if (existing) {
      this.messages.splice(this.messages.indexOf(existing), 1);
      return Promise.resolve(existing);
    }
    return new Promise((resolvePromise, rejectPromise) => {
      const waiter = {
        predicate,
        resolve: resolvePromise,
        reject: rejectPromise,
        timer: setTimeout(() => {
          const idx = this.waiters.indexOf(waiter);
          if (idx >= 0) this.waiters.splice(idx, 1);
          rejectPromise(new Error(`Timed out waiting for ${description}. stderr:\n${this.stderr}`));
        }, timeoutMs),
      };
      this.waiters.push(waiter);
    });
  }

  async waitExit(timeoutMs = 5_000) {
    if (this.child.exitCode !== null || this.child.signalCode !== null) {
      return this.child.exitCode;
    }
    return new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        rejectPromise(new Error(`Timed out waiting for process exit. stderr:\n${this.stderr}`));
      }, timeoutMs);
      this.child.once("close", (code) => {
        clearTimeout(timer);
        resolvePromise(code);
      });
    });
  }

  async closeAndKill(timeoutMs = 5_000) {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    await new Promise((resolvePromise) => {
      const timer = setTimeout(() => {
        try {
          this.child.kill("SIGKILL");
        } catch {}
        resolvePromise();
      }, timeoutMs);
      this.child.once("close", () => {
        clearTimeout(timer);
        resolvePromise();
      });
      try {
        this.child.stdin.end();
      } catch {}
    });
  }
}

let failed = false;
async function check(name, body) {
  const started = Date.now();
  try {
    await body();
    console.log(`✓ ${name} (${Date.now() - started} ms)`);
  } catch (error) {
    failed = true;
    console.error(`✗ ${name}\n${error.stack ?? error}`);
  }
}

const scratch = realpathSync.native(mkdtempSync(join(tmpdir(), "lithe-python-test-")));
let unpackedPluginDir = null;

try {
  const sourceManifest = JSON.parse(readFileSync(join(ROOT, PACKAGE_ID, "plugin.json"), "utf8"));
  const lock = JSON.parse(readFileSync(join(ROOT, "vendor-lock.json"), "utf8"));
  const l10n = JSON.parse(readFileSync(join(ROOT, PACKAGE_ID, "l10n", "zh-Hans.json"), "utf8"));

  if (process.env.LITHE_TEST_PLUGIN_DIR) {
    unpackedPluginDir = resolve(process.env.LITHE_TEST_PLUGIN_DIR);
  } else {
    const hostPlatform = detectHostPlatform();
    const expectedArchive = join(ROOT, "dist", `${ASSET_PREFIX}-${sourceManifest.version}-${hostPlatform}.zip`);
    if (!existsSync(expectedArchive)) {
      await packagePlatforms({ platforms: [hostPlatform] });
    }
    const installRoot = join(scratch, "Lithe Plugins");
    unpackZipToDir(expectedArchive, installRoot);
    unpackedPluginDir = join(installRoot, PACKAGE_ID);
  }

  const pluginManifest = JSON.parse(readFileSync(join(unpackedPluginDir, "plugin.json"), "utf8"));
  const dependencyCommand = pluginManifest.buildSystems.find(({ id }) => id === "python").dependencies;
  const dependencyArguments = (outputFile) => dependencyCommand.arguments.map((arg) =>
    arg.replace("${pluginDir}", unpackedPluginDir).replace("${outputFile}", outputFile));

  await check("dependency command skips user-site startup hooks", () => {
    const environment = join(scratch, "dependency environment with shared site");
    run(pythonCmd, ["-I", "-B", "-m", "venv", "--without-pip", "--system-site-packages", environment]);
    const python = process.platform === "win32"
      ? join(environment, "Scripts", "python.exe")
      : join(environment, "bin", "python");
    const userBase = join(scratch, "dependency user base");
    const env = { ...process.env, PYTHONUSERBASE: userBase };
    const userSite = run(python, ["-E", "-B", "-c", "import site; assert site.ENABLE_USER_SITE; print(site.getusersitepackages())"], {
      cwd: scratch, env,
    }).trim();
    assert.ok(userSite.startsWith(userBase + sep), "expected a user site under the test's PYTHONUSERBASE");
    mkdirSync(userSite, { recursive: true });
    writeFileSync(join(userSite, "usercustomize.py"), [
      "from pathlib import Path",
      'Path(__file__).with_name("user-site-hook-ran").touch()',
      "",
    ].join("\n"));

    const treeFile = join(scratch, "isolated-dependencies.json");
    run(python, dependencyArguments(treeFile), { cwd: scratch, env });
    assert.equal(existsSync(join(userSite, "user-site-hook-ran")), false, "usercustomize.py was executed");
    assert.equal(JSON.parse(readFileSync(treeFile, "utf8")).format, "litheDependencies");
  });

  await check("dependency command reads installed packages from a pip-free Python environment", () => {
    const environment = join(scratch, "dependency environment");
    run(pythonCmd, ["-m", "venv", "--without-pip", environment]);
    const python = process.platform === "win32"
      ? join(environment, "Scripts", "python.exe")
      : join(environment, "bin", "python");
    const packages = run(python, ["-I", "-B", "-c", "import sysconfig; print(sysconfig.get_path('purelib'))"]).trim();
    const metadata = (name, version, requirements = []) => {
      const directory = join(packages, `${name}-${version}.dist-info`);
      mkdirSync(directory);
      writeFileSync(join(directory, "METADATA"), [
        "Metadata-Version: 2.1",
        `Name: ${name}`,
        `Version: ${version}`,
        ...requirements.map((requirement) => `Requires-Dist: ${requirement}`),
        "",
      ].join("\n"));
    };
    metadata("App", "1.0", ["Lib_core[Speed] >= 1", 'Inactive; python_version < "3.0"']);
    metadata("lib-core", "1.2", ['Fast; extra == "speed"', 'Inactive; extra == "test"']);
    metadata("Fast", "2.0");
    metadata("Inactive", "3.0");
    metadata("CycleA", "4.0", ["CycleB"]);
    metadata("CycleB", "5.0", ["CycleA"]);

    const treeFile = join(scratch, "dependencies.json");
    assert.equal(dependencyCommand.output, "outputFile");
    assert.equal(dependencyCommand.decoder, "litheDependencies");
    run(python, dependencyArguments(treeFile), { cwd: scratch });
    const leaf = (name, version, children = []) => ({ name, version, children });
    assert.deepEqual(JSON.parse(readFileSync(treeFile, "utf8")), {
      format: "litheDependencies", version: 0, dependencies: [
        leaf("App", "1.0", [leaf("lib-core", "1.2", [leaf("Fast", "2.0")])]),
        leaf("Inactive", "3.0"),
        leaf("CycleA", "4.0", [leaf("CycleB", "5.0", [leaf("CycleA", "4.0")])]),
      ],
    });
  });

  await check("Unix and Windows plugin.json + zh-Hans.json satisfy M3 contract invariants", () => {
    const metadata = JSON.parse(readFileSync(join(unpackedPluginDir, "grammars", "python.first-line.json"), "utf8"));
    assert.deepEqual(Object.keys(metadata), ["firstLineMatch"]);
    const firstLine = new RegExp(metadata.firstLineMatch);
    for (const line of [
      "#!/usr/bin/python",
      "#!/usr/bin/env python3",
      "#!/usr/bin/env -S python3.13 -I",
      "#!/usr/bin/env -S /usr/bin/python3 -I",
      "#!/opt/venv/bin/python3.13t",
      "#!/usr/bin/env pypy3",
    ]) {
      assert.match(line, firstLine);
    }
    for (const line of [
      "#!/usr/bin/env bash",
      "#!/usr/bin/env python-wrapper",
      "#!/usr/bin/python3.13.exe",
      "#!/usr/bin/env node python3",
      "# Mention #!/usr/bin/env python3",
    ]) {
      assert.doesNotMatch(line, firstLine);
    }
    for (const platform of Object.keys(lock.pyrefly.platforms)) {
      const variant = manifestForPlatform(sourceManifest, platform, lock);
      assert.equal(variant.schemaVersion, 0);
      assert.equal(variant.pluginAPIVersion, 0);
      assert.equal(variant.id, "io.github.lithe-idea.python-support");
      assert.equal(variant.version, sourceManifest.version);
      assert.equal(variant.vendor.id, "io.github.lithe-idea");
      assert.equal(variant.vendor.signatureRequirement, "none");
      assert.equal("commandInstallers" in variant, false, "must not declare commandInstallers");
      assert.deepEqual(variant.toolchainProviders, [{
        id: "python",
        displayName: "Python Environments",
        tools: ["python"],
        watchFiles: [
          { pattern: ".python-version", reader: "compatible" },
          { pattern: "pyproject.toml", reader: "native" },
          { pattern: "Pipfile", reader: "native" },
          { pattern: "poetry.lock", reader: "native" },
        ],
      }]);
      assert.equal("$schema" in variant, false, "plugin.json must not contain $schema");
      assert.deepEqual(Object.keys(variant.requires).sort(), [
        "backend",
        "buildProviders",
        "buildSystems",
        "debugAdapters",
        "languageServers",
        "languages",
        "outputLinkMatchers",
        "projectGenerators",
        "runConfigurationTypes",
        "settings",
        "toolDefinitions",
        "toolchainProviders",
        "ui",
      ]);
      for (const [capability, version] of Object.entries(variant.requires)) {
        assert.equal(version, ["buildSystems", "buildProviders"].includes(capability) ? 1 : 0);
      }
      assert.deepEqual([...variant.permissions].sort(), [
        "backend.launch",
        "debug.attach",
        "debug.launch",
        "languageServer.launch",
        "process.build",
        "project.generate",
        "toolchains.provide",
        "ui.contribute",
      ]);

      assert.deepEqual(variant.backend, {
        launch: { kind: "packaged", path: backendPath(platform) },
      });

      const pyLang = variant.languages[0];
      assert.equal(pyLang.grammar, undefined);
      assert.equal("firstLineMatch" in pyLang, false);
      assert.deepEqual(pyLang.fileExtensions, ["py", "pyi", "pyw"]);
      assert.deepEqual(pyLang.dependencies.projectDependencyPaths, [".venv", "venv", ".conda"]);

      const pyTool = variant.toolDefinitions[0];
      assert.equal("pathPrepend" in pyTool, false, "toolDefinitions[0] must omit unsafe pathPrepend");
      assert.equal(pyTool.discovery.length, 16, "discovery rules must fit Core limit of 16");
      const envVars = pyTool.discovery
        .filter((d) => d.root.kind === "environment")
        .map((d) => d.root.variable)
        .sort();
      assert.deepEqual(envVars, [
        "APPDATA",
        "CONDA_ENVS_PATH",
        "CONDA_PREFIX",
        "LOCALAPPDATA",
        "PYENV_ROOT",
        "UV_PYTHON_INSTALL_DIR",
        "WORKON_HOME",
        "XDG_DATA_HOME",
      ]);
      assert.deepEqual(pyTool.launch, ["${executable}", "${runtimeArguments}", "${entry}", "${arguments}"]);

      assert.deepEqual(
        variant.buildSystems.map((b) => b.id),
        ["python", "uv", "conda", "ruff"],
      );
      const pyBuild = variant.buildSystems[0];
      assert.equal(pyBuild.provider.launch.entry, "scripts/build_provider.py");
      assert.deepEqual(pyBuild.provider.launch.runtimeArguments, ["-I", "-B"]);
      assert.equal(pyBuild.provider.executesProjectCode, true);
      assert.equal(pyBuild.provider.mayUseNetwork, false);
      assert.deepEqual(pyBuild.model, { source: "provider" });
      assert.deepEqual(pyBuild.run.find(({ id }) => id === "main"), {
        id: "main", source: "provider", entrypoints: true,
      });
      assert.equal(pyBuild.test.source, "provider");
      assert.equal("discovery" in pyBuild.test, false);
      assert.deepEqual(pyBuild.test.discoveryCommand, {
        arguments: ["-I", "-B", "${pluginDir}/scripts/discover_tests.py", "${outputFile}", "${root}", "${optionArguments}"],
        executesProjectCode: true,
        mayUseNetwork: false,
      });
      assert.deepEqual(pyBuild.test.filters, ["suite", "case"]);
      assert.deepEqual(pyBuild.test.arguments, []);
      assert.deepEqual(pyBuild.test.results, {
        decoder: "junitXml",
        reports: [".pytest_cache/lithe-junit.xml"],
      });

      const pyServer = variant.languageServers[0];
      assert.deepEqual(pyServer.launch, {
        kind: "backend",
        function: "pyrefly.resolveLaunch",
        timeoutMilliseconds: 30000,
      });
      assert.equal("arguments" in pyServer, false);
      assert.equal("validationArguments" in pyServer, false);
      assert.equal("pythonPath" in (pyServer.workspaceConfiguration.python ?? {}), false);

      const debugAdapter = variant.debugAdapters[0];
      assert.equal(debugAdapter.configurations.launch.arguments.env.PYTHONDONTWRITEBYTECODE, "1");
    }

    // Verify 1-to-1 l10n coverage of settings and sections.
    const declaredSettingIDs = sourceManifest.settings.map((s) => s.id).sort();
    assert.deepEqual(Object.keys(l10n.settings).sort(), declaredSettingIDs);
    const declaredSections = [...new Set(sourceManifest.settings.map((s) => s.section))].sort();
    assert.deepEqual(Object.keys(l10n.sections).sort(), declaredSections);
    for (const setting of sourceManifest.settings) {
      assert.ok(setting.description && setting.description.length > 0, `${setting.id} needs description`);
      const translated = l10n.settings[setting.id];
      assert.ok(translated.title && translated.description, `${setting.id} needs translated title & description`);
      if (setting.options) {
        assert.deepEqual(
          Object.keys(translated.options ?? {}).sort(),
          setting.options.map((o) => o.value).sort(),
          `${setting.id} option translations must match declared option values`,
        );
      }
    }
  });

  // Snapshot unpacked plugin directory while keeping it writable (matching Windows and
  // user-writable plugin directories) so any stray __pycache__ or log file write is caught!
  const beforeSnapshot = snapshotDirectoryHashes(unpackedPluginDir);

  const buildModelScript = join(unpackedPluginDir, "scripts", "build_model.py");
  const backendExecutable = join(unpackedPluginDir, pluginManifest.backend.launch.path);
  const buildProviderScript = join(unpackedPluginDir, "scripts", "build_provider.py");

  await check("build_model.py discovers PEP 621 scripts, src/ packages, tests, and .venv/.conda exclusions", () => {
    const proj = join(scratch, "case-pep621");
    mkdirSync(join(proj, "src", "demo_pkg"), { recursive: true });
    mkdirSync(join(proj, "tests"), { recursive: true });
    mkdirSync(join(proj, ".venv", "bin"), { recursive: true });
    mkdirSync(join(proj, ".conda", "conda-meta"), { recursive: true });
    writeFileSync(
      join(proj, "pyproject.toml"),
      [
        "[project]",
        'name = "demo-pkg"',
        'version = "1.2.3"',
        'requires-python = ">=3.10"',
        "[project.scripts]",
        'demo-cli = "demo_pkg.cli:main"',
      ].join("\n"),
    );
    writeFileSync(join(proj, "src", "demo_pkg", "__init__.py"), "");
    writeFileSync(join(proj, "src", "demo_pkg", "__main__.py"), "print('pkg main')\n");
    writeFileSync(join(proj, "src", "demo_pkg", "cli.py"), "def main():\n    return 0\n");
    writeFileSync(join(proj, "tests", "test_cli.py"), "def test_ok():\n    assert True\n");

    const outFile = join(scratch, "case-pep621-out.json");
    run(pythonCmd, ["-I", "-B", buildModelScript, proj, outFile]);
    const model = JSON.parse(readFileSync(outFile, "utf8"));
    assert.equal(model.format, "litheBuildModel");
    assert.equal(model.version, 0);
    assert.equal(model.projects[0].name, "demo-pkg");
    assert.equal(model.projects[0].properties.version, "1.2.3");
    assert.equal(model.projects[0].properties.requiresPython, ">=3.10");

    const byName = Object.fromEntries(model.targets.map((t) => [t.name, t]));
    assert.ok(byName["demo-cli"], "expected [project.scripts] demo-cli target");
    assert.deepEqual(byName["demo-cli"].tags, ["application", "entrypoint"]);
    assert.ok(byName["demo_pkg"], "expected src/demo_pkg/__main__.py target");
    assert.ok(byName["tests"], "expected tests target");
    assert.deepEqual(model.contentRoots, [
      { path: ".conda", kind: "excluded" },
      { path: ".venv", kind: "excluded" },
      { path: "src", kind: "source" },
      { path: "tests", kind: "testSource" },
    ]);

    run(pythonCmd, ["-I", "-B", "-c", byName["demo-cli"].properties.runner], { cwd: proj });
  });

  await check("build_model.py discovers Django, FastAPI, Flask, root packages, and __main__ scripts without executing code", () => {
    const proj = join(scratch, "case-frameworks");
    const canary = join(scratch, "MUST_NOT_EXIST");
    mkdirSync(join(proj, "mypkg"), { recursive: true });

    writeFileSync(
      join(proj, "setup.py"),
      `raise RuntimeError("never execute setup.py")\nopen(${JSON.stringify(canary)}, "w").write("bad")\nfrom setuptools import setup\nsetup(name="fw-suite", version="0.4.0")\n`,
    );
    writeFileSync(
      join(proj, "manage.py"),
      'import os\nos.environ.setdefault("DJANGO_SETTINGS_MODULE", "mysite.settings")\nif __name__ == "__main__":\n    pass\n',
    );
    writeFileSync(
      join(proj, "api.py"),
      `open(${JSON.stringify(canary)}, "w").write("bad")\nfrom fastapi import FastAPI\napp = FastAPI()\ndef create_app():\n    return FastAPI()\n`,
    );
    writeFileSync(join(proj, "web.py"), "from flask import Flask\napp = Flask(__name__)\n");
    writeFileSync(join(proj, "worker.py"), 'def run():\n    pass\nif __name__ == "__main__":\n    run()\n');
    writeFileSync(join(proj, "mypkg", "__init__.py"), "");
    writeFileSync(join(proj, "mypkg", "__main__.py"), "print('hi')\n");

    const outFile = join(scratch, "case-frameworks-out.json");
    run(pythonCmd, ["-I", "-B", buildModelScript, proj, outFile]);
    assert.equal(existsSync(canary), false, "build_model.py must NEVER execute user Python code");

    const model = JSON.parse(readFileSync(outFile, "utf8"));
    assert.equal(model.projects[0].name, "fw-suite");
    assert.equal(model.projects[0].properties.version, "0.4.0");
    const byName = Object.fromEntries(model.targets.map((t) => [t.name, t]));
    assert.deepEqual(byName["manage.py runserver"].tags, ["application", "django"]);
    assert.deepEqual(byName["fastapi (api:app)"].tags, ["application", "asgi"]);
    assert.deepEqual(byName["fastapi (api:create_app)"].tags, ["application", "asgifactory"]);
    assert.deepEqual(byName["flask (web:app)"].tags, ["application", "wsgi"]);
    assert.deepEqual(byName["mypkg"].tags, ["application", "module"]);
    assert.deepEqual(byName["worker.py"].tags, ["application", "script"]);

    // Verify vendored tomli fallback when stdlib tomllib is unavailable (Python 3.9/3.10 simulation).
    const nested = join(scratch, "workspace-nested", "services", "sub");
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(nested, "pyproject.toml"), '[project]\nname = "nested-svc"\nversion = "0.1.0"\n');
    const tomliOut = join(scratch, "tomli-fallback-out.json");
    run(pythonCmd, [
      "-I",
      "-B",
      "-c",
      "import runpy, sys; sys.modules['tomllib'] = None; sys.argv = sys.argv[1:]; runpy.run_path(sys.argv[0], run_name='__main__')",
      buildModelScript,
      nested,
      tomliOut,
    ]);
    assert.equal(JSON.parse(readFileSync(tomliOut, "utf8")).projects[0].name, "nested-svc");

    const secretMissingPath = join(scratch, "secret-path-token-do-not-log");
    const missing = spawnSync(pythonCmd, ["-I", "-B", buildModelScript, secretMissingPath, tomliOut], {
      encoding: "utf8",
      timeout: 10_000,
    });
    assert.notEqual(missing.status, 0);
    assert.equal(missing.stderr.trim(), "build_model.py: project_root_unavailable");
    assert.ok(!missing.stderr.includes("secret-path-token-do-not-log"), "stderr must never echo raw paths");
  });

  await check("The packaged SDK backend negotiates litheLogging + litheFunctions, resolves Unix/Windows pyrefly launch, and injects external tools.python.executable into pyrefly LSP", async () => {
    const stateDir = join(scratch, "backend-state");
    const wsStateDir = join(scratch, "backend-ws-state");
    const logDir = join(scratch, "backend-log");
    const tempDir = join(scratch, "backend-temp");
    for (const d of [stateDir, wsStateDir, logDir, tempDir]) mkdirSync(d, { recursive: true });

    // Create an EXTERNAL virtual environment outside the workspace with a unique package `external_env_pkg`.
    const extVenvRoot = join(scratch, "external-conda-like-env");
    run(pythonCmd, ["-m", "venv", extVenvRoot]);
    const extPython =
      process.platform === "win32"
        ? join(extVenvRoot, "Scripts", "python.exe")
        : join(extVenvRoot, "bin", "python3");
    const extSite = run(extPython, ["-I", "-B", "-c", "import site; print(site.getsitepackages()[0])"]).trim();
    mkdirSync(join(extSite, "external_env_pkg"), { recursive: true });
    writeFileSync(join(extSite, "external_env_pkg", "__init__.py"), "def magic_number() -> int:\n    return 7\n");

    const child = spawn(backendExecutable, [], {
      cwd: scratch,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const peer = new FramedStdioPeer(child);
    let resolvedUnixAnswer = null;

    try {
      // 1. Initialize without litheLogging MUST be refused (-32600) while keeping session alive for valid retry.
      peer.send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { capabilities: { experimental: { litheFunctions: { versions: [0] } } } },
      });
      const refusedInit = await peer.waitFor((m) => m.id === 1, "initialize refusal without litheLogging");
      assert.equal(refusedInit.error?.code, -32600);

      // 2. Initialize with litheLogging 0, litheFunctions 0, and litheToolchains 0.
      peer.send({
        jsonrpc: "2.0",
        id: 2,
        method: "initialize",
        params: {
          capabilities: {
            experimental: {
              litheLogging: { versions: [0] },
              litheFunctions: { versions: [0] },
              litheToolchains: { versions: [0], providers: ["python"] },
            },
          },
        },
      });
      const initOk = await peer.waitFor((m) => m.id === 2 && "result" in m, "backend initialize response");
      assert.deepEqual(initOk.result.capabilities.experimental.litheLogging, { version: 0 });
      assert.deepEqual(initOk.result.capabilities.experimental.litheFunctions, {
        version: 0,
        functions: [{ id: "pyrefly.resolveLaunch" }, { id: "python.inspectEnvironment" }, { id: "settings.preview" }],
      });
      assert.deepEqual(initOk.result.capabilities.experimental.litheToolchains, {
        version: 0,
        providers: ["python"],
      });

      const region = pluginManifest.settingRegions.find(({ id }) => id === "language");
      assert.deepEqual(region.page, { languageID: "python" });
      const previewEvent = {
        instance: "python-settings-preview",
        surface: { settingRegionID: region.id },
        settings: { effective: { displayTypeErrors: "force-on", completeFunctionParens: false }, draft: {} },
      };
      peer.send({
        jsonrpc: "2.0", id: 21, method: "lithe/function/invoke",
        params: { operationID: "op-preview-open", functionID: region.view.function,
          params: { ...previewEvent, event: "open", language: "en", width: 640 } },
      });
      const opened = await peer.waitFor((m) => m.id === 21, "Python preview open");
      const [wide] = opened.result.view;
      assert.deepEqual(wide.on, ["resize"]);
      assert.equal(wide.viewBox[2], 640);
      assert.match(JSON.stringify(wide), /Type error: expected int, got str/);
      assert.doesNotMatch(JSON.stringify(wide), /greet\(\)|not applied/);

      peer.send({
        jsonrpc: "2.0", id: 22, method: "lithe/function/invoke",
        params: { operationID: "op-preview-draft", functionID: region.view.function,
          params: { ...previewEvent, event: "settings", language: "zh-Hans", width: 360,
            settings: { ...previewEvent.settings, draft: {
              displayTypeErrors: "force-off", completeFunctionParens: true, importFormat: "relative",
            } } } },
      });
      const drafted = await peer.waitFor((m) => m.id === 22, "Python preview draft");
      const [narrow] = drafted.result.view;
      assert.equal(narrow.viewBox[2], 360);
      assert.ok(narrow.height > wide.height);
      assert.match(JSON.stringify(narrow), /含未应用的修改/);
      assert.match(JSON.stringify(narrow), /隐藏类型错误/);
      assert.match(JSON.stringify(narrow), /from \.utils import greet/);
      assert.match(JSON.stringify(narrow), /greet\(\)/);
      assert.ok(!peer.allReceived.some((m) =>
        m.method === "lithe/log" && ["op-preview-open", "op-preview-draft"].includes(m.params?.operationId),
      ), "Successful preview events should not produce logs");

      // 3. Resolve launch with external tools.python.executable on Unix.
      peer.send({
        jsonrpc: "2.0",
        id: 3,
        method: "lithe/function/invoke",
        params: {
          operationID: "op-launch-unix",
          functionID: "pyrefly.resolveLaunch",
          context: { contextID: "ctx-1", generation: 1 },
          params: {
            serverID: "python",
            platform: { os: process.platform === "win32" ? "windows" : "macos", arch: process.arch },
            stateDirectory: stateDir,
            workspaceStateDirectory: wsStateDir,
            logDirectory: logDir,
            temporaryDirectory: tempDir,
            settings: {
              typeCheckingMode: "strict",
              displayTypeErrors: "force-on",
              diagnosticMode: "openFilesOnly",
              autoImportCompletions: true,
              completeFunctionParens: true,
              importFormat: "relative",
            },
            tools: {
              python: {
                executable: extPython,
                home: extVenvRoot,
                version: "3.12.0",
              },
            },
          },
        },
      });
      const launchResp = await peer.waitFor((m) => m.id === 3, "pyrefly.resolveLaunch response");
      resolvedUnixAnswer = launchResp.result;
      assert.deepEqual(resolvedUnixAnswer.executable, {
        kind: "packaged",
        path: process.platform === "win32" ? "bin/pyrefly.exe" : "bin/pyrefly",
      });
      assert.deepEqual(resolvedUnixAnswer.arguments, ["lsp"]);
      assert.equal(resolvedUnixAnswer.workspaceConfiguration.python.pythonPath, extPython);
      assert.equal(resolvedUnixAnswer.workspaceConfiguration.python.pyrefly.typeCheckingMode, "strict");
      assert.equal(resolvedUnixAnswer.workspaceConfiguration.python.analysis.completeFunctionParens, true);

      // Verify lithe/log operationFinished arrived strictly BEFORE response id=3!
      const idxLog3 = peer.allReceived.findIndex(
        (m) => m.method === "lithe/log" && m.params?.operationId === "op-launch-unix" && m.params?.kind === "operationFinished",
      );
      const idxResp3 = peer.allReceived.findIndex((m) => m.id === 3);
      assert.ok(idxLog3 >= 0 && idxLog3 < idxResp3, "lithe/log operationFinished must precede RPC response");

      // 4. Resolve launch on Windows platform without tools.python (graceful fallback without pythonPath).
      peer.send({
        jsonrpc: "2.0",
        id: 4,
        method: "lithe/function/invoke",
        params: {
          operationID: "op-launch-win-fallback",
          functionID: "pyrefly.resolveLaunch",
          context: { contextID: "ctx-2", generation: 1 },
          params: {
            serverID: "python",
            platform: { os: "windows", arch: "x86_64" },
            stateDirectory: stateDir,
            workspaceStateDirectory: wsStateDir,
            logDirectory: logDir,
            temporaryDirectory: tempDir,
            settings: {},
          },
        },
      });
      const winFallback = await peer.waitFor((m) => m.id === 4, "Windows fallback resolveLaunch");
      assert.deepEqual(winFallback.result.executable, { kind: "packaged", path: "bin/pyrefly.exe" });
      assert.equal("pythonPath" in winFallback.result.workspaceConfiguration.python, false);

      // 5. Malformed tools.python.executable emits degraded WARN and falls back; subsequent valid call emits recovered WARN.
      peer.send({
        jsonrpc: "2.0",
        id: 5,
        method: "lithe/function/invoke",
        params: {
          operationID: "op-launch-degraded",
          functionID: "pyrefly.resolveLaunch",
          context: { contextID: "ctx-deg", generation: 1 },
          params: {
            serverID: "python",
            platform: { os: "macos", arch: "aarch64" },
            stateDirectory: stateDir,
            workspaceStateDirectory: wsStateDir,
            logDirectory: logDir,
            temporaryDirectory: tempDir,
            settings: {},
            tools: { python: { executable: "  bad\npath  " } },
          },
        },
      });
      const degResp = await peer.waitFor((m) => m.id === 5, "degraded resolveLaunch");
      assert.equal("pythonPath" in degResp.result.workspaceConfiguration.python, false);
      assert.ok(
        peer.allReceived.some(
          (m) =>
            m.method === "lithe/log" &&
            m.params?.operationId === "op-launch-degraded" &&
            m.params?.kind === "degraded" &&
            m.params?.code === "invalid_tool_hint",
        ),
        "Expected degraded diagnostic for malformed tool hint",
      );

      peer.send({
        jsonrpc: "2.0",
        id: 6,
        method: "lithe/function/invoke",
        params: {
          operationID: "op-launch-recovered",
          functionID: "pyrefly.resolveLaunch",
          context: { contextID: "ctx-deg", generation: 2 },
          params: {
            serverID: "python",
            platform: { os: "macos", arch: "aarch64" },
            stateDirectory: stateDir,
            workspaceStateDirectory: wsStateDir,
            logDirectory: logDir,
            temporaryDirectory: tempDir,
            settings: {},
            tools: { python: { executable: extPython } },
          },
        },
      });
      await peer.waitFor((m) => m.id === 6, "recovered resolveLaunch");
      assert.ok(
        peer.allReceived.some(
          (m) =>
            m.method === "lithe/log" &&
            m.params?.operationId === "op-launch-recovered" &&
            m.params?.kind === "recovered" &&
            m.params?.code === "tool_hint_restored",
        ),
        "Expected recovered diagnostic after valid tool hint",
      );

      // 6. High-frequency python.inspectEnvironment suppresses INFO on success but still logs ERROR on failure.
      peer.send({
        jsonrpc: "2.0",
        id: 7,
        method: "lithe/function/invoke",
        params: {
          operationID: "op-inspect-quiet",
          functionID: "python.inspectEnvironment",
          params: { executable: extPython },
        },
      });
      const inspectOk = await peer.waitFor((m) => m.id === 7, "inspectEnvironment success");
      assert.equal(inspectOk.result.isVirtualEnv, true);
      assert.equal(
        peer.allReceived.some((m) => m.method === "lithe/log" && m.params?.operationId === "op-inspect-quiet"),
        false,
        "suppressSuccessDiagnostics must suppress operationFinished INFO",
      );

      peer.send({
        jsonrpc: "2.0",
        id: 8,
        method: "lithe/function/invoke",
        params: {
          operationID: "op-inspect-fail",
          functionID: "python.inspectEnvironment",
          params: { executable: "relative/secret-path-token/python" },
        },
      });
      const inspectErr = await peer.waitFor((m) => m.id === 8, "inspectEnvironment failure");
      assert.equal(inspectErr.error?.code, -32000);
      assert.equal(inspectErr.error?.data?.code, "python.invalidExecutable");
      assert.ok(!inspectErr.error.message.includes("secret-path-token"));
      assert.ok(
        peer.allReceived.some(
          (m) =>
            m.method === "lithe/log" &&
            m.params?.operationId === "op-inspect-fail" &&
            m.params?.kind === "operationFailed" &&
            m.params?.code === "python.invalidExecutable",
        ),
        "Suppressed functions MUST still emit operationFailed ERROR",
      );

      // 6b. Unknown method and unknown functionID return static messages without echoing raw input.
      peer.send({
        jsonrpc: "2.0",
        id: 81,
        method: "secret/path/unknown-method",
        params: {},
      });
      const unknownMethodErr = await peer.waitFor((m) => m.id === 81, "unknown method error");
      assert.equal(unknownMethodErr.error?.code, -32601);
      assert.ok(unknownMethodErr.error?.message, "unknown method must return a diagnostic");
      assert.ok(!unknownMethodErr.error.message.includes("secret"));

      peer.send({
        jsonrpc: "2.0",
        id: 82,
        method: "lithe/function/invoke",
        params: {
          operationID: "op-unknown-fn",
          functionID: "secret.unregistered.fn",
          params: {},
        },
      });
      const unknownFnErr = await peer.waitFor((m) => m.id === 82, "unknown function error");
      assert.equal(unknownFnErr.error?.code, -32602);
      assert.ok(unknownFnErr.error?.message, "unknown function must return a diagnostic");
      assert.ok(!unknownFnErr.error.message.includes("secret"));

      // 7. Clean shutdown + exit without creating any custom log files.
      peer.send({ jsonrpc: "2.0", id: 9, method: "shutdown", params: null });
      await peer.waitFor((m) => m.id === 9 && m.result === null, "backend shutdown");
      peer.send({ jsonrpc: "2.0", method: "exit", params: null });
      const exitCode = await peer.waitExit();
      assert.equal(exitCode, 0);
      assert.deepEqual(readdirSync(logDir), [], "The SDK backend must create zero custom log files");
    } finally {
      await peer.closeAndKill();
    }

    // 8. Verify live packaged pyrefly LSP uses the backend-injected python.pythonPath to resolve external_env_pkg
    // in a bare workspace that has NO .venv!
    const bareWs = join(scratch, "ws-external-env-lsp");
    mkdirSync(bareWs, { recursive: true });
    const srcFile = join(bareWs, "use_ext.py");
    const srcContent = "from external_env_pkg import magic_number\nbad: str = magic_number()\n";
    writeFileSync(srcFile, srcContent);

    const pyreflyBin = join(unpackedPluginDir, ...resolvedUnixAnswer.executable.path.split("/"));
    const versionOut = run(pyreflyBin, ["--version"], { cwd: bareWs }).trim();
    assert.match(versionOut, /pyrefly\s+1\.4\.1/i);

    const lspChild = spawn(pyreflyBin, resolvedUnixAnswer.arguments, {
      cwd: bareWs,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const lspPeer = new FramedStdioPeer(lspChild);
    try {
      const rootUri = fileUri(bareWs);
      const docUri = fileUri(srcFile);
      lspPeer.send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          processId: process.pid,
          rootUri,
          workspaceFolders: [{ uri: rootUri, name: "ext-ws" }],
          capabilities: {
            workspace: { configuration: true },
            textDocument: { publishDiagnostics: {} },
          },
        },
      });
      await lspPeer.waitFor((m) => m.id === 1 && "result" in m, "pyrefly initialize");
      lspPeer.send({ jsonrpc: "2.0", method: "initialized", params: {} });

      let opened = false;
      let diagMsg = null;
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline) {
        const msg = await lspPeer.waitFor(() => true, "pyrefly LSP message", 15_000);
        if (msg.method === "workspace/configuration" && msg.id !== undefined) {
          const items = msg.params?.items ?? [];
          lspPeer.send({
            jsonrpc: "2.0",
            id: msg.id,
            result: items.map((it) =>
              it.section === "python" ? resolvedUnixAnswer.workspaceConfiguration.python : {},
            ),
          });
          if (!opened) {
            opened = true;
            lspPeer.send({
              jsonrpc: "2.0",
              method: "textDocument/didOpen",
              params: {
                textDocument: { uri: docUri, languageId: "python", version: 1, text: srcContent },
              },
            });
          }
        } else if (msg.id !== undefined && msg.method) {
          lspPeer.send({ jsonrpc: "2.0", id: msg.id, result: null });
        } else if (msg.method === "textDocument/publishDiagnostics" && msg.params?.uri === docUri) {
          if ((msg.params.diagnostics ?? []).length > 0) {
            diagMsg = msg;
            break;
          }
        }
      }
      assert.ok(diagMsg, "Expected diagnostics from pyrefly with injected pythonPath");
      const codes = diagMsg.params.diagnostics.map((d) => d.code);
      assert.ok(
        !codes.includes("missing-import"),
        `Expected backend-injected pythonPath to resolve external_env_pkg, got: ${JSON.stringify(diagMsg.params.diagnostics)}`,
      );
      lspPeer.send({ jsonrpc: "2.0", id: 2, method: "shutdown", params: null });
      await lspPeer.waitFor((m) => m.id === 2, "pyrefly shutdown", 10_000);
      lspPeer.send({ jsonrpc: "2.0", method: "exit", params: null });
    } finally {
      await lspPeer.closeAndKill();
    }
  });

  await check("The packaged provider answers toolchains/query for conda, uv, pyenv, Poetry, Pipenv, .python-version, and pyproject.toml", async () => {
    const fakeHome = join(scratch, "fake-home");
    const condaEnvDir = join(scratch, "conda-envs", "ml-311");
    const uvPyDir = join(scratch, "uv-pythons", "cpython-3.12.6-macos-aarch64-none");
    const pyenvVerDir = join(scratch, "pyenv-root", "versions", "3.10.14");
    const workonRoot = join(scratch, "workon-envs");
    const wsRoot = join(scratch, "tc-workspace (venv)");
    mkdirSync(wsRoot, { recursive: true });
    // Workspace-local .venv MUST be excluded from provider installations per toolchains contract!
    const wsLocalVenv = join(wsRoot, ".venv");

    const makeFakePythonHome = (dir, ver, isConda = false) => {
      const binDir = process.platform === "win32" ? (isConda ? dir : join(dir, "Scripts")) : join(dir, "bin");
      mkdirSync(binDir, { recursive: true });
      const exeName = process.platform === "win32" ? "python.exe" : "python3";
      const exePath = join(binDir, exeName);
      writeFileSync(exePath, process.platform === "win32" ? "MZ" : "#!/bin/sh\necho Python " + ver + "\n");
      if (process.platform !== "win32") chmodSync(exePath, 0o755);
      if (isConda) {
        mkdirSync(join(dir, "conda-meta"), { recursive: true });
        writeFileSync(
          join(dir, "conda-meta", `python-${ver}-0.json`),
          JSON.stringify({ name: "python", version: ver }),
        );
      } else {
        writeFileSync(join(dir, "pyvenv.cfg"), `version_info = ${ver}\n`);
      }
    };

    makeFakePythonHome(condaEnvDir, "3.11.9", true);
    makeFakePythonHome(uvPyDir, "3.12.6", false);
    makeFakePythonHome(pyenvVerDir, "3.10.14", false);
    makeFakePythonHome(wsLocalVenv, "3.12.1", false);

    mkdirSync(join(fakeHome, ".conda"), { recursive: true });
    const condaRegistry = join(fakeHome, ".conda", "environments.txt");
    writeFileSync(condaRegistry, `# comment\n${condaEnvDir}\n`);
    writeFileSync(join(wsRoot, ".python-version"), "3.11\n");
    writeFileSync(
      join(wsRoot, "pyproject.toml"),
      '[project]\nname = "tc-demo"\nrequires-python = ">=3.12"\n',
    );
    writeFileSync(join(wsRoot, "Pipfile"), '[[source]]\nname = "pypi"\n');

    const workspaceDirectory = realpathSync.native(wsRoot);
    const workspaceHash = (path) => createHash("sha256").update(path).digest("base64url").slice(0, 8);
    // Pipenv derives the default environment name from the full Pipfile path.
    const pipenvName = `tc-workspace__venv_-${workspaceHash(join(workspaceDirectory, "Pipfile"))}`;
    const pipenvDir = join(workonRoot, pipenvName);
    makeFakePythonHome(pipenvDir, "3.12.3");
    writeFileSync(join(wsRoot, "poetry.lock"), "");
    const poetryRoot = join(scratch, "poetry");
    const poetryProjectPath = process.platform === "win32" ? workspaceDirectory.toLowerCase() : workspaceDirectory;
    const poetryDir = join(poetryRoot, `tc-demo-${workspaceHash(poetryProjectPath)}-py3.12`);
    makeFakePythonHome(poetryDir, "3.12.1");

    const discoveryEnv = {
      HOME: fakeHome,
      USERPROFILE: fakeHome,
      PATH: "",
      UV_PYTHON_INSTALL_DIR: dirname(uvPyDir),
      PYENV_ROOT: join(scratch, "pyenv-root"),
      WORKON_HOME: workonRoot,
      POETRY_VIRTUALENVS_PATH: poetryRoot,
      CONDA_ENVS_PATH: "",
      CONDA_PREFIX: "",
    };
    // Windows environment variable names are case-insensitive. Ensure inherited
    // entries with different capitalization cannot shadow the fixture values.
    const inherited = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !(key.toUpperCase() in discoveryEnv)),
    );
    const child = spawn(backendExecutable, [], {
      cwd: scratch,
      env: { ...inherited, ...discoveryEnv },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const peer = new FramedStdioPeer(child);
    try {
      peer.send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          capabilities: {
            experimental: {
              litheLogging: { versions: [0] },
              litheToolchains: { versions: [0], providers: ["python"] },
            },
          },
        },
      });
      await peer.waitFor((m) => m.id === 1 && "result" in m, "toolchain backend init");

      async function queryProject(id, operationID) {
        peer.send({
          jsonrpc: "2.0",
          id,
          method: "toolchains/query",
          params: {
            operationID,
            generation: id + 1,
            providerID: "python",
            authority: { kind: "local" },
            tools: ["python"],
            workspace: { rootID: "root-1", root: wsRoot, directory: "." },
            context: { contextID: "ctx-tc", generation: 1 },
          },
        });
        return peer.waitFor((m) => m.id === id, "toolchains/query reply");
      }
      const reply = await queryProject(2, "tc-op-1");
      assert.equal(reply.result.operationID, "tc-op-1");
      assert.equal(reply.result.generation, 3);
      assert.equal(reply.result.providerID, "python");

      // Rust and Node may preserve different drive letter and directory casing
      // on Windows. Resolve candidate homes and statement sources separately.
      const pathKey = (path) => {
        const nativePath = normalize(path);
        return process.platform === "win32" ? nativePath.toLowerCase() : nativePath;
      };
      const expectedPath = (path) => pathKey(realpathSync.native(path));
      const watch = reply.result.watch.map(pathKey);
      // The registry watch uses the configured home path so it still works
      // when conda has yet to create the registry file.
      assert.deepEqual(
        watch.filter((path) => basename(path) === "environments.txt"),
        [pathKey(condaRegistry)],
      );
      const homes = reply.result.installations.map((installation) => pathKey(installation.home));
      assert.ok(homes.includes(expectedPath(condaEnvDir)), "Expected ~/.conda/environments.txt installation");
      assert.ok(homes.includes(expectedPath(uvPyDir)), "Expected UV_PYTHON_INSTALL_DIR installation");
      assert.ok(homes.includes(expectedPath(pyenvVerDir)), "Expected PYENV_ROOT installation");
      assert.ok(homes.includes(expectedPath(pipenvDir)), "Expected WORKON_HOME Pipenv installation");
      assert.ok(homes.includes(expectedPath(poetryDir)), "Expected configured Poetry installation");
      assert.ok(watch.includes(expectedPath(join(wsRoot, "poetry.lock"))));
      assert.equal(homes.includes(expectedPath(wsLocalVenv)), false, "Must NEVER return workspace-local .venv");

      const bySource = new Map(reply.result.statements.map((statement) => [pathKey(statement.source), statement]));
      const versionPath = join(wsRoot, ".python-version");
      const projectPath = join(wsRoot, "pyproject.toml");
      const declarations = (response) => response.result.statements.filter((statement) => statement.kind === "declaration");
      assert.equal(
        declarations(reply).length,
        1,
        "The provider must return one version declaration per directory to avoid a Core providerConflict",
      );
      const [unmet] = declarations(reply);
      assert.equal(pathKey(unmet.source), expectedPath(versionPath));
      assert.equal(unmet.request, "3.11");
      assert.equal(unmet.installation, null, "3.11 does not satisfy the project requirement");
      for (const watched of [versionPath, projectPath]) {
        assert.ok(watch.includes(expectedPath(watched)));
      }

      writeFileSync(versionPath, "3.12\n");
      const [compatible] = declarations(await queryProject(6, "tc-op-compatible"));
      assert.equal(pathKey(compatible.source), expectedPath(versionPath));
      assert.equal(pathKey(compatible.installation), expectedPath(uvPyDir));

      rmSync(versionPath);
      const [projectOnly] = declarations(await queryProject(7, "tc-op-project-only"));
      assert.equal(pathKey(projectOnly.source), expectedPath(projectPath));
      assert.equal(pathKey(projectOnly.installation), expectedPath(uvPyDir));
      const pipfileStmt = bySource.get(expectedPath(join(wsRoot, "Pipfile")));
      assert.ok(pipfileStmt);
      assert.equal(pipfileStmt.kind, "environment");
      assert.equal(pathKey(pipfileStmt.installation), expectedPath(pipenvDir));

      writeFileSync(projectPath, '[project]\nname = "tc-demo"\nrequires-python = ">=3.12.5"\n');
      const stricter = await queryProject(8, "tc-op-incompatible-pipenv");
      assert.equal(
        stricter.result.statements.some((statement) => pathKey(statement.source) === expectedPath(join(wsRoot, "Pipfile"))),
        false,
        "A Pipenv environment outside requires-python must not override the compatible declaration",
      );
      assert.equal(pathKey(declarations(stricter)[0].installation), expectedPath(uvPyDir));

      const poetryStmt = bySource.get(expectedPath(join(wsRoot, "poetry.lock")));
      assert.ok(poetryStmt);
      assert.equal(poetryStmt.kind, "environment");
      assert.equal(pathKey(poetryStmt.installation), expectedPath(poetryDir));

      assert.equal(peer.allReceived.some((m) => m.method === "lithe/log" && m.params?.operationId === "tc-op-1"), false,
        "A successful discovery must not emit an INFO terminal event");

      peer.send({
        jsonrpc: "2.0",
        id: 5,
        method: "toolchains/query",
        params: {
          operationID: "tc-op-global",
          generation: 4,
          providerID: "python",
          authority: { kind: "local" },
          tools: ["python"],
          workspace: null,
          context: null,
        },
      });
      const global = await peer.waitFor((m) => m.id === 5, "global toolchain backend reply");
      assert.deepEqual(global.result.statements, []);
      assert.ok(global.result.installations.some((entry) => pathKey(entry.home) === expectedPath(condaEnvDir)));

      // Remote authority must return -32071 plugin.toolchain.authorityUnsupported.
      peer.send({
        jsonrpc: "2.0",
        id: 3,
        method: "toolchains/query",
        params: {
          operationID: "tc-op-remote",
          generation: 4,
          providerID: "python",
          authority: { kind: "remote", id: "ssh-box" },
          tools: ["python"],
          workspace: null,
          context: null,
        },
      });
      const remoteErr = await peer.waitFor((m) => m.id === 3, "remote authority error");
      assert.equal(remoteErr.error?.code, -32071);
      assert.equal(remoteErr.error?.data?.code, "plugin.toolchain.authorityUnsupported");

      peer.send({ jsonrpc: "2.0", id: 4, method: "shutdown", params: null });
      await peer.waitFor((m) => m.id === 4, "shutdown");
      peer.send({ jsonrpc: "2.0", method: "exit", params: null });
      await peer.waitExit();
    } finally {
      await peer.closeAndKill();
    }
  });

  await check("The packaged discovery command collects pytest selectors and the provider runs them exactly, reports JUnit, and handles cancellation", async () => {
    const pytestExecutable = resolvePytestRuntime();
    const noPytestExec = ensureNoPytestPython(scratch);

    const wsDir = join(scratch, "pytest-workspace");
    const cacheDir = join(scratch, "pytest-ws-state");
    mkdirSync(join(wsDir, "tests"), { recursive: true });
    mkdirSync(cacheDir, { recursive: true });

    // Start with an intentionally malformed pyproject.toml to verify degraded -> recovered!
    writeFileSync(join(wsDir, "pyproject.toml"), "[project\nname = 'broken'\n");
    writeFileSync(join(wsDir, "worker.py"), 'if __name__ == "__main__":\n    print("run worker")\n');
    writeFileSync(join(wsDir, "conftest.py"), [
      "def pytest_sessionstart(session):",
      "    if session.config.option.collectonly:",
      "        session.config.cache.set('lithe/discovery-test', True)",
      "",
    ].join("\n"));
    writeFileSync(
      join(wsDir, "tests", "test_calc.py"),
      [
        "import pytest",
        "import worker",
        "",
        "@pytest.mark.parametrize('x,expected', [(2, 6), (3, 9)])",
        "def test_scale(x, expected):",
        "    assert x * 3 == expected",
        "",
        "class TestCalc:",
        "    def test_add(self):",
        "        assert 1 + 2 == 3",
      ].join("\n") + "\n",
    );

    const discoveryCommand = pluginManifest.buildSystems.find(({ id }) => id === "python").test.discoveryCommand;
    assert.ok(discoveryCommand, "The installed plugin must declare a test discovery command");
    function discover(label, { cwd = wsDir, root = ".", executable = pytestExecutable, options = [] } = {}) {
      const attemptDir = join(cacheDir, label);
      mkdirSync(attemptDir);
      const report = join(attemptDir, "tests.json");
      const args = discoveryCommand.arguments.flatMap((value) => value === "${optionArguments}"
        ? options
        : value.replace("${pluginDir}", unpackedPluginDir).replace("${outputFile}", report).replace("${root}", root));
      const result = spawnSync(executable, args, {
        cwd,
        encoding: "utf8",
        timeout: COMMAND_TIMEOUT_MS,
        windowsHide: true,
      });
      if (result.error) throw result.error;
      return { ...result, report };
    }

    const child = spawn(pythonCmd, ["-I", "-B", buildProviderScript], {
      cwd: wsDir,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const peer = new FramedStdioPeer(child);

    try {
      const rootUri = fileUri(wsDir);
      peer.send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          rootUri,
          workspaceFolders: [{ uri: rootUri, name: "pytest-ws" }],
          capabilities: {
            experimental: {
              litheLogging: { versions: [0] },
              litheBuild: { versions: [1, 0] },
            },
          },
        },
      });
      const initResp = await peer.waitFor((m) => m.id === 1 && "result" in m, "build provider initialize");
      assert.deepEqual(initResp.result.capabilities.experimental.litheBuild, { version: 1 });

      // 1. Degraded lithe/build/model on malformed pyproject.toml.
      peer.send({
        jsonrpc: "2.0",
        id: 2,
        method: "lithe/build/model",
        params: {
          operationID: "op-model-broken",
          buildSystemID: "python",
          root: ".",
          options: {},
          optionArguments: [],
          environment: {},
        },
      });
      const brokenModel = await peer.waitFor((m) => m.id === 2, "broken pyproject model");
      assert.equal(brokenModel.result.format, "litheBuildModel");
      assert.ok(
        peer.allReceived.some(
          (m) =>
            m.method === "lithe/log" &&
            m.params?.operationId === "op-model-broken" &&
            m.params?.kind === "degraded" &&
            m.params?.code === "pyproject_parse_failed",
        ),
        "Expected degraded pyproject_parse_failed log",
      );

      // Fix pyproject.toml and keep UTF-8 parameter IDs to exercise the Core byte limit.
      writeFileSync(join(wsDir, "pyproject.toml"), [
        "[project]",
        'name = "calc-suite"',
        'version = "0.2.0"',
        "[tool.pytest.ini_options]",
        "disable_test_id_escaping_and_forfeit_all_rights_to_community_support = true",
        "",
      ].join("\n"));
      peer.send({
        jsonrpc: "2.0",
        id: 3,
        method: "lithe/build/model",
        params: {
          operationID: "op-model-fixed",
          buildSystemID: "python",
          root: ".",
          refresh: true,
          options: {},
          optionArguments: [],
          environment: {},
        },
      });
      const fixedModel = await peer.waitFor((m) => m.id === 3, "fixed pyproject model");
      assert.equal(fixedModel.result.projects[0].name, "calc-suite");
      assert.ok(
        peer.allReceived.some(
          (m) =>
            m.method === "lithe/log" &&
            m.params?.operationId === "op-model-fixed" &&
            m.params?.kind === "recovered" &&
            m.params?.code === "pyproject_restored",
        ),
        "Expected recovered pyproject_restored log",
      );

      // 2. Run the packaged command with the host's output path and project cwd.
      const discovered = discover("collected");
      assert.equal(discovered.status, 0, discovered.stdout + discovered.stderr);
      const discovery = JSON.parse(readFileSync(discovered.report, "utf8"));
      assert.equal(discovery.format, "litheTestDiscovery");
      assert.equal(discovery.version, 0);
      assert.equal(existsSync(join(wsDir, ".pytest_cache")), false);
      assert.equal(existsSync(join(dirname(discovered.report), "pytest-cache")), true);

      const discoveredCases = discovery.tests.map((t) => `${t.suite}::${t.case}`).sort();
      assert.deepEqual(discoveredCases, [
        "tests/test_calc.py::TestCalc::test_add",
        "tests/test_calc.py::test_scale[2-6]",
        "tests/test_calc.py::test_scale[3-9]",
      ]);
      for (const item of discovery.tests) {
        assert.deepEqual(item.project, { name: "calc-suite", path: "." });
      }

      // 3. Empty projects complete, while missing pytest and failed collection publish no report.
      const missingPytest = discover("missing-pytest", { executable: noPytestExec });
      assert.equal(missingPytest.status, 197);
      assert.match(missingPytest.stderr, /pytest unavailable/);
      assert.equal(existsSync(missingPytest.report), false);

      const nested = join(wsDir, "nested project");
      mkdirSync(nested);
      const empty = discover("empty", { cwd: nested, root: "nested project" });
      assert.equal(empty.status, 0, empty.stdout + empty.stderr);
      assert.deepEqual(JSON.parse(readFileSync(empty.report, "utf8")), {
        format: "litheTestDiscovery", version: 0, tests: [],
      });
      writeFileSync(join(nested, "test_nested.py"), "def test_nested():\n    assert True\n");
      const nestedDiscovery = discover("nested", { cwd: nested, root: "nested project" });
      assert.equal(nestedDiscovery.status, 0, nestedDiscovery.stdout + nestedDiscovery.stderr);
      assert.deepEqual(JSON.parse(readFileSync(nestedDiscovery.report, "utf8")).tests, [{
        suite: "test_nested.py", case: "test_nested", project: { name: "nested project", path: "nested project" },
      }]);
      rmSync(nested, { recursive: true });

      const brokenTest = join(wsDir, "tests", "test_collection_error.py");
      writeFileSync(brokenTest, "def test_broken():\n    assert (\n");
      const collectionError = discover("collection-error");
      assert.equal(collectionError.status, 2);
      assert.equal(existsSync(collectionError.report), false);
      rmSync(brokenTest);

      // 4. Execute a single discovered parameterized test via lithe/build/test and verify progress + JUnit XML.
      peer.send({
        jsonrpc: "2.0",
        id: 6,
        method: "lithe/build/test",
        params: {
          operationID: "op-test-single",
          buildSystemID: "python",
          root: ".",
          tool: { executable: pytestExecutable },
          project: { name: "calc-suite", path: "." },
          suite: "tests/test_calc.py",
          case: "test_scale[2-6]",
          options: {},
          optionArguments: [],
          userArguments: [],
          environment: {},
        },
      });
      const testRunResp = await peer.waitFor((m) => m.id === 6, "lithe/build/test response");
      assert.equal(testRunResp.result.exitCode, 0);
      assert.ok(
        peer.allReceived.some(
          (m) => m.method === "lithe/build/progress" && m.params?.operationID === "op-test-single",
        ),
        "Expected lithe/build/progress notifications during test execution",
      );
      const junitXmlPath = join(wsDir, ".pytest_cache", "lithe-junit.xml");
      assert.ok(existsSync(junitXmlPath), "Expected JUnit XML report at .pytest_cache/lithe-junit.xml");
      const junitXml = readFileSync(junitXmlPath, "utf8");
      assert.match(junitXml, /tests="1"/);
      assert.match(junitXml, /test_scale\[2-6\]/);

      writeFileSync(join(wsDir, "tests", "test_names.py"), [
        "def test_add():",
        "    assert True",
        "def test_additional():",
        "    assert True",
        "",
      ].join("\n"));
      const oversizedTest = join(wsDir, "tests", "test_long_id.py");
      writeFileSync(oversizedTest, [
        "import pytest",
        "@pytest.mark.parametrize('value', [pytest.param(1, id='é' * 600)])",
        "def test_long_id(value):",
        "    assert value == 1",
        "",
      ].join("\n"));
      writeFileSync(join(wsDir, "test_notes.txt"), ">>> 1 + 1\n2\n");
      peer.send({
        jsonrpc: "2.0", id: 67, method: "lithe/build/test",
        params: {
          operationID: "op-case-only",
          buildSystemID: "python", root: ".", tool: { executable: pytestExecutable },
          case: "test_add", options: {}, optionArguments: [], userArguments: [], environment: {},
        },
      });
      const caseOnly = await peer.waitFor((m) => m.id === 67, "case without a suite");
      assert.equal(caseOnly.error?.data?.code, "python.invalidTestSelector");
      assert.equal(readFileSync(junitXmlPath, "utf8"), junitXml);

      const withLongId = discover("oversized-id");
      assert.notEqual(withLongId.status, 0);
      assert.match(withLongId.stderr, /invalid or oversized test selectors/);
      assert.equal(existsSync(withLongId.report), false, "An oversized UTF-8 ID must fail the whole discovery");
      rmSync(oversizedTest);
      const withDoctest = discover("doctest", { options: ["--doctest-glob=test_notes.txt"] });
      assert.equal(withDoctest.status, 0, withDoctest.stdout + withDoctest.stderr);
      const tests = JSON.parse(readFileSync(withDoctest.report, "utf8")).tests;
      assert.deepEqual(
        tests.filter(({ suite }) => suite === "tests/test_names.py").map(({ case: name }) => name).sort(),
        ["test_add", "test_additional"],
      );
      const doctest = tests.find(({ suite }) => suite === "test_notes.txt");
      assert.ok(doctest, "pytest must discover a root-level doctest");
      peer.send({
        jsonrpc: "2.0", id: 70, method: "lithe/build/test",
        params: {
          operationID: "op-exact-doctest",
          buildSystemID: "python", root: ".", tool: { executable: pytestExecutable },
          options: {}, optionArguments: [], userArguments: [], environment: {}, ...doctest,
        },
      });
      const doctestRun = await peer.waitFor((m) => m.id === 70, "run discovered root-level doctest");
      assert.equal(doctestRun.result?.exitCode, 0);
      assert.match(readFileSync(junitXmlPath, "utf8"), /tests="1"/);

      // 4b. Security & contract selector regressions: traversal, symlink escape, flag injection, and stale/deleted suites
      // MUST reject with controlled PluginError (never bypassing _safe_within or widening to -k), while valid dot-directories work!
      const outsideDir = join(scratch, "outside-evil-tests");
      const outsideCanary = join(scratch, "OUTSIDE_CANARY_MUST_NOT_EXIST");
      mkdirSync(outsideDir, { recursive: true });
      const outsidePy = join(outsideDir, "test_evil.py");
      writeFileSync(
        outsidePy,
        `open(${JSON.stringify(outsideCanary)}, "w").write("pwned")\ndef test_evil():\n    assert True\n`,
      );
      if (process.platform !== "win32") {
        const { symlinkSync } = await import("node:fs");
        symlinkSync(outsidePy, join(wsDir, "tests", "test_escape_link.py"));
      }

      for (const [reqId, opId, badParams, expectedCode] of [
        [61, "op-sel-traversal", { suite: "tests/../../outside-evil-tests/test_evil.py", case: "test_evil" }, "python.invalidTestSelector"],
        [62, "op-sel-flag", { suite: "tests/test_calc.py", case: "--collect-only" }, "python.invalidTestSelector"],
        [63, "op-sel-stale-path", { suite: "tests/test_deleted.py", case: "test_add" }, "python.staleTestSelector"],
        [64, "op-sel-stale-dotted", { suite: "tests.test_deleted.TestCalc", case: "test_add" }, "python.staleTestSelector"],
        [67, "op-sel-stale-case", { suite: "tests/test_calc.py", case: "TestCalc::test_removed" }, "python.staleTestSelector"],
        [68, "op-sel-stale-project", { project: { name: "removed-project", path: "removed-project" } }, "python.staleTestSelector"],
        [69, "op-sel-stale-target", { target: { properties: { directory: "removed-tests" } } }, "python.staleTestSelector"],
      ]) {
        peer.send({
          jsonrpc: "2.0",
          id: reqId,
          method: "lithe/build/test",
          params: {
            operationID: opId,
            buildSystemID: "python",
            root: ".",
            tool: { executable: pytestExecutable },
            project: { name: "calc-suite", path: "." },
            ...badParams,
            options: {},
            optionArguments: [],
            userArguments: [],
            environment: {},
          },
        });
        const rej = await peer.waitFor((m) => m.id === reqId, `rejected selector ${opId}`);
        assert.equal(rej.error?.code, -32000);
        assert.equal(rej.error?.data?.code, expectedCode);
        assert.ok(
          peer.allReceived.some(
            (m) => m.method === "lithe/log" && m.params?.operationId === opId && m.params?.kind === "operationFailed" && m.params?.code === expectedCode,
          ),
        );
      }

      if (process.platform !== "win32") {
        peer.send({
          jsonrpc: "2.0",
          id: 65,
          method: "lithe/build/test",
          params: {
            operationID: "op-sel-symlink",
            buildSystemID: "python",
            root: ".",
            tool: { executable: pytestExecutable },
            project: { name: "calc-suite", path: "." },
            suite: "tests/test_escape_link.py",
            case: "test_evil",
            options: {},
            optionArguments: [],
            userArguments: [],
            environment: {},
          },
        });
        const symRej = await peer.waitFor((m) => m.id === 65, "rejected symlink escape selector");
        assert.equal(symRej.error?.code, -32000);
        assert.equal(symRej.error?.data?.code, "python.invalidTestSelector");
        rmSync(join(wsDir, "tests", "test_escape_link.py"), { force: true });
      }
      assert.equal(existsSync(outsideCanary), false, "Outside test file must NEVER be executed");

      // Valid dot-prefixed subdirectory (e.g. `.bench/test_dotdir.py`) must NOT be mangled by lstrip("./")!
      mkdirSync(join(wsDir, ".bench"), { recursive: true });
      writeFileSync(join(wsDir, ".bench", "test_dotdir.py"), "def test_dot_ok():\n    assert 2 * 2 == 4\n");
      peer.send({
        jsonrpc: "2.0",
        id: 66,
        method: "lithe/build/test",
        params: {
          operationID: "op-test-dotdir",
          buildSystemID: "python",
          root: ".",
          tool: { executable: pytestExecutable },
          project: { name: "calc-suite", path: "." },
          suite: ".bench/test_dotdir.py",
          case: "test_dot_ok",
          options: {},
          optionArguments: [],
          userArguments: [],
          environment: {},
        },
      });
      const dotDirResp = await peer.waitFor((m) => m.id === 66, "dot-directory test run");
      assert.equal(dotDirResp.result.exitCode, 0);

      // 5. lithe/build/runEntrypoints returns worker.py entrypoint and suppresses success INFO log.
      peer.send({
        jsonrpc: "2.0",
        id: 7,
        method: "lithe/build/runEntrypoints",
        params: {
          operationID: "op-entrypoints",
          buildSystemID: "python",
          root: ".",
          file: "worker.py",
          options: {},
          optionArguments: [],
          environment: {},
        },
      });
      const epResp = await peer.waitFor((m) => m.id === 7, "runEntrypoints response");
      assert.equal(epResp.result.format, "litheRunEntrypoints");
      assert.equal(epResp.result.entrypoints.length, 1);
      assert.equal(epResp.result.entrypoints[0].name, "worker.py");
      assert.equal(
        peer.allReceived.some((m) => m.method === "lithe/log" && m.params?.operationId === "op-entrypoints"),
        false,
        "runEntrypoints must suppress high-frequency success INFO logs",
      );

      const prepareRun = async (id, launchOptions) => {
        peer.send({
          jsonrpc: "2.0", id, method: "lithe/build/prepareRun",
          params: {
            operationID: `op-prepare-run-${id}`, buildSystemID: "python", root: ".", run: "main",
            project: epResp.result.entrypoints[0].project,
            options: {}, optionArguments: ["option"], userArguments: ["fallback"],
            environment: { LITHE_TEST_RUN_VALUE: "default" }, launchOptions,
          },
        });
        return peer.waitFor((m) => m.id === id, "prepare a Python entrypoint");
      };
      const scriptLaunch = await prepareRun(71, {
        entrypoint: epResp.result.entrypoints[0].entrypoint, runtimeArguments: ["-B"],
        arguments: ["argument with spaces"], environment: { LITHE_TEST_RUN_VALUE: "override" },
      });
      assert.deepEqual(scriptLaunch.result, {
        executable: { kind: "toolchain", value: "python" },
        arguments: ["-B", join(realpathSync(wsDir), "worker.py"), "option", "argument with spaces"],
        workingDirectory: ".", environment: { LITHE_TEST_RUN_VALUE: "override" },
      });

      const moduleDir = join(wsDir, "src", "run_demo");
      mkdirSync(moduleDir, { recursive: true });
      writeFileSync(join(moduleDir, "__init__.py"), "VALUE = 'from src'\n");
      writeFileSync(join(moduleDir, "__main__.py"), "from . import VALUE\nimport sys\nprint(VALUE, *sys.argv[1:])\n");
      const moduleLaunch = await prepareRun(72, {
        entrypoint: "module:src/run_demo/__main__.py", runtimeArguments: ["-B"], workingDirectory: "tests",
      });
      assert.equal(moduleLaunch.result.workingDirectory, "tests");
      assert.equal(run(pythonCmd, moduleLaunch.result.arguments, { cwd: join(wsDir, "tests") }).trim(), "from src option fallback");

      const shadowed = join(wsDir, "shadowed_package");
      mkdirSync(shadowed);
      writeFileSync(join(shadowed, "__main__.py"), "print('selected namespace entrypoint')\n");
      const shadowedLaunch = await prepareRun(75, {
        entrypoint: "module:shadowed_package/__main__.py", runtimeArguments: ["-B"],
      });
      assert.equal(run(pythonCmd, shadowedLaunch.result.arguments, { cwd: wsDir }).trim(), "selected namespace entrypoint");
      writeFileSync(join(wsDir, "shadowed_package.py"), "print('wrong source ran')\n");
      const collision = spawnSync(pythonCmd, shadowedLaunch.result.arguments, {
        cwd: wsDir, encoding: "utf8", timeout: 5000, windowsHide: true,
        env: { ...process.env, ...shadowedLaunch.result.environment },
      });
      assert.ifError(collision.error);
      assert.equal(collision.stdout, "", "a shadowed entrypoint must not start a different file");
      assert.equal(collision.status, 1);
      assert.match(collision.stderr, /当前包入口被同名模块或包遮蔽/);

      const launcher = join(unpackedPluginDir, "scripts", "run_entrypoint.py");
      const interpreter = run(pythonCmd, ["-c", "import sys; print(sys.executable)"]).trim();
      const forwarded = spawnSync(pythonCmd, ["-I", "-B", launcher, "interpreter", interpreter,
        "-c", "import sys; print(sys.argv[1]); sys.exit(17)", "argument with spaces"], {
        cwd: wsDir, encoding: "utf8", timeout: 5000, windowsHide: true,
      });
      assert.ifError(forwarded.error);
      assert.equal(forwarded.status, 17, forwarded.stderr);
      assert.equal(forwarded.stdout.trim(), "argument with spaces");

      for (const [id, entrypoint] of [[73, "script:../worker.py"], [74, "script:missing.py"]]) {
        const response = await prepareRun(id, { entrypoint });
        assert.equal(response.error?.code, -32000);
        assert.match(response.error.message, /保存的 Python 入口已失效/);
        assert.ok(peer.allReceived.some((m) => m.method === "lithe/log"
          && m.params?.operationId === `op-prepare-run-${id}` && m.params?.code === "python.staleRunEntrypoint"));
      }

      // 6. $/cancelRequest terminates active pytest subprocess tree cleanly with zero orphan processes!
      const pidFile = join(scratch, "slow-test.pid");
      writeFileSync(
        join(wsDir, "tests", "test_blocking.py"),
        [
          "import os, pathlib, time",
          `pathlib.Path(${JSON.stringify(pidFile)}).write_text(str(os.getpid()), encoding='utf-8')`,
          "time.sleep(30)",
          "def test_never_reached():",
          "    assert True",
        ].join("\n") + "\n",
      );

      peer.send({
        jsonrpc: "2.0",
        id: 8,
        method: "lithe/build/test",
        params: {
          operationID: "op-test-cancel",
          buildSystemID: "python",
          root: ".",
          tool: { executable: pytestExecutable },
          suite: "tests/test_blocking.py",
          options: {},
          optionArguments: [],
          environment: {},
        },
      });

      const waitPidDeadline = Date.now() + 10_000;
      while (!existsSync(pidFile) && Date.now() < waitPidDeadline) {
        await new Promise((r) => setTimeout(r, 40));
      }
      assert.ok(existsSync(pidFile), "Expected blocking pytest child process to start and record its PID");
      const childPid = Number.parseInt(readFileSync(pidFile, "utf8").trim(), 10);
      assert.ok(Number.isInteger(childPid) && childPid > 0);

      peer.send({ jsonrpc: "2.0", method: "$/cancelRequest", params: { id: 8 } });
      const cancelResp = await peer.waitFor((m) => m.id === 8, "cancelled test response", 10_000);
      assert.equal(cancelResp.error?.code, -32800);
      assert.equal(
        peer.allReceived.some((m) => m.method === "lithe/log" && m.params?.operationId === "op-test-cancel"),
        false,
        "Cancelled requests must NOT emit operationFinished or operationFailed logs",
      );

      // Bounded check that the spawned pytest process exited completely.
      const killCheckDeadline = Date.now() + 3_000;
      while (isProcessAlive(childPid) && Date.now() < killCheckDeadline) {
        await new Promise((r) => setTimeout(r, 50));
      }
      assert.equal(isProcessAlive(childPid), false, `Child pytest PID ${childPid} must be terminated on cancel`);

      peer.send({ jsonrpc: "2.0", id: 9, method: "shutdown", params: null });
      await peer.waitFor((m) => m.id === 9 && m.result === null, "build provider shutdown");
      peer.send({ jsonrpc: "2.0", method: "exit", params: null });
      const exitCode = await peer.waitExit();
      assert.equal(exitCode, 0);
    } finally {
      await peer.closeAndKill();
    }
  });

  await check("RPC cancellation covers queued requests and child process tree ownership", () => {
    run(pythonCmd, ["-I", "-B", join(ROOT, "scripts", "test-rpc.py"), join(unpackedPluginDir, "scripts")]);
  });

  await check("lineMatcher and outputLinkMatchers match mypy, Ruff, and Python Traceback output", () => {
    const pyBuild = pluginManifest.buildSystems.find((b) => b.id === "python");
    const mypyPattern = pyBuild.diagnostics.patterns[0];
    const mypyRe = new RegExp(mypyPattern.regex);
    const mypyMatch = mypyRe.exec("src/app.py:42:13: error: Incompatible types in assignment [assignment]");
    assert.ok(mypyMatch);
    assert.equal(mypyMatch[mypyPattern.file], "src/app.py");
    assert.equal(mypyMatch[mypyPattern.line], "42");
    assert.equal(mypyMatch[mypyPattern.column], "13");
    assert.equal(mypyMatch[mypyPattern.severity], "error");
    assert.match(mypyMatch[mypyPattern.message], /Incompatible types/);

    const ruffBuild = pluginManifest.buildSystems.find((b) => b.id === "ruff");
    const ruffPattern = ruffBuild.diagnostics.patterns[0];
    const ruffRe = new RegExp(ruffPattern.regex);
    const ruffMatch = ruffRe.exec("src/app.py:10:8: F401 `os` imported but unused");
    assert.ok(ruffMatch);
    assert.equal(ruffMatch[ruffPattern.file], "src/app.py");
    assert.equal(ruffMatch[ruffPattern.line], "10");
    assert.equal(ruffMatch[ruffPattern.column], "8");
    assert.equal(ruffMatch[ruffPattern.message], "F401 `os` imported but unused");

    const tbRe = new RegExp(pluginManifest.outputLinkMatchers[0].pattern.replaceAll("(?P<", "(?<"));
    const tbMatch = tbRe.exec('  File "/workspace/Lithe Python Demo/main.py", line 9, in <module>');
    assert.ok(tbMatch);
    assert.equal(tbMatch.groups.path, "/workspace/Lithe Python Demo/main.py");
    assert.equal(tbMatch.groups.line, "9");
  });

  const demoDir = join(scratch, "Lithe Python Demo");
  await check("project templates render cleanly, create .venv, and run sample script", () => {
    mkdirSync(demoDir, { recursive: true });
    const projectName = "Lithe Python Demo";
    const pyprojectTpl = readFileSync(join(unpackedPluginDir, "templates", "python", "project", "pyproject.toml"), "utf8");
    const gitignoreTpl = readFileSync(join(unpackedPluginDir, "templates", "python", "project", "dot-gitignore"), "utf8");
    const mainTpl = readFileSync(join(unpackedPluginDir, "templates", "python", "sample", "main.py"), "utf8");

    writeFileSync(
      join(demoDir, "pyproject.toml"),
      pyprojectTpl.replaceAll("{{ project.name | lower }}", projectName.toLowerCase()),
    );
    writeFileSync(join(demoDir, ".gitignore"), gitignoreTpl);
    writeFileSync(join(demoDir, "main.py"), mainTpl.replaceAll("{{ project.name }}", projectName));

    run(pythonCmd, ["-m", "venv", ".venv"], { cwd: demoDir });
    const venvPython =
      process.platform === "win32"
        ? join(demoDir, ".venv", "Scripts", "python.exe")
        : join(demoDir, ".venv", "bin", "python3");
    assert.ok(existsSync(venvPython), `Expected venv interpreter at ${venvPython}`);

    const versionOut = run(venvPython, ["--version"], { cwd: demoDir }).trim();
    const probeRe = new RegExp(pluginManifest.toolDefinitions[0].version.pattern);
    assert.match(versionOut, probeRe);

    const runOut = run(venvPython, ["main.py"], { cwd: demoDir }).trim();
    assert.equal(runOut, "Hello from Lithe Python Demo!");
  });

  await check("packaged pyrefly resolves .venv packages over LSP when tools.python is omitted (graceful fallback)", async () => {
    const pyreflyBin = join(
      unpackedPluginDir,
      ...(process.platform === "win32" ? ["bin", "pyrefly.exe"] : ["bin", "pyrefly"]),
    );

    const venvPython =
      process.platform === "win32"
        ? join(demoDir, ".venv", "Scripts", "python.exe")
        : join(demoDir, ".venv", "bin", "python3");
    const sitePackages = run(venvPython, ["-I", "-B", "-c", "import site; print(site.getsitepackages()[0])"], {
      cwd: demoDir,
    }).trim();
    const customPkgDir = join(sitePackages, "venv_only_pkg");
    mkdirSync(customPkgDir, { recursive: true });
    writeFileSync(join(customPkgDir, "__init__.py"), "def answer() -> int:\n    return 42\n");

    const checkFile = join(demoDir, "check_types.py");
    const checkContent = "from venv_only_pkg import answer\nx: str = answer()\n";
    writeFileSync(checkFile, checkContent);

    const fileUriStr = fileUri(checkFile);
    const rootUriStr = fileUri(demoDir);

    const child = spawn(pyreflyBin, ["lsp"], {
      cwd: demoDir,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const peer = new FramedStdioPeer(child);
    try {
      peer.send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          processId: process.pid,
          rootUri: rootUriStr,
          workspaceFolders: [{ uri: rootUriStr, name: "demo" }],
          capabilities: {
            workspace: { configuration: true },
            textDocument: { publishDiagnostics: {} },
          },
        },
      });

      await peer.waitFor((m) => m.id === 1 && "result" in m, "pyrefly initialize response");
      peer.send({ jsonrpc: "2.0", method: "initialized", params: {} });

      const expandedPythonConfig = {
        pyrefly: {
          typeCheckingMode: "default",
          displayTypeErrors: "force-on",
          diagnosticMode: "openFilesOnly",
          extraProjectExcludes: [".venv/**"],
        },
        analysis: {
          diagnosticMode: "openFilesOnly",
          autoImportCompletions: true,
          completeFunctionParens: false,
          importFormat: "absolute",
        },
      };

      const startTime = Date.now();
      let opened = false;
      let diagnosticsMsg = null;
      while (Date.now() - startTime < 20_000) {
        const msg = await peer.waitFor(() => true, "LSP message from pyrefly", 15_000);
        if (msg.method === "workspace/configuration" && msg.id !== undefined) {
          const items = msg.params?.items ?? [];
          peer.send({
            jsonrpc: "2.0",
            id: msg.id,
            result: items.map((item) => (item.section === "python" ? expandedPythonConfig : {})),
          });
          if (!opened) {
            opened = true;
            peer.send({
              jsonrpc: "2.0",
              method: "textDocument/didOpen",
              params: {
                textDocument: {
                  uri: fileUriStr,
                  languageId: "python",
                  version: 1,
                  text: checkContent,
                },
              },
            });
          }
        } else if (msg.id !== undefined && msg.method) {
          peer.send({ jsonrpc: "2.0", id: msg.id, result: null });
        } else if (msg.method === "textDocument/publishDiagnostics" && msg.params?.uri === fileUriStr) {
          if ((msg.params.diagnostics ?? []).length > 0) {
            diagnosticsMsg = msg;
            break;
          }
        }
      }

      assert.ok(diagnosticsMsg, "Expected publishDiagnostics from pyrefly");
      const codes = diagnosticsMsg.params.diagnostics.map((d) => d.code);
      assert.ok(
        !codes.includes("missing-import"),
        `Expected .venv import to resolve without pythonPath, got: ${JSON.stringify(diagnosticsMsg.params.diagnostics)}`,
      );
      assert.ok(diagnosticsMsg.params.diagnostics.length >= 1, "Expected type mismatch diagnostic on x: str = answer()");

      peer.send({ jsonrpc: "2.0", id: 2, method: "shutdown", params: null });
      await peer.waitFor((m) => m.id === 2 && "result" in m, "pyrefly shutdown response", 10_000);
      peer.send({ jsonrpc: "2.0", method: "exit", params: null });
    } finally {
      await peer.closeAndKill();
    }
  });

  await check("packaged debugpy adapter launches Python target over stdio DAP with PYTHONDONTWRITEBYTECODE=1", async () => {
    const adapter = pluginManifest.debugAdapters.find((a) => a.id === "debugpy");
    const entryScript = join(unpackedPluginDir, ...adapter.launch.process.launch.entry.split("/"));
    const logDir = join(scratch, "debugpy-logs");
    mkdirSync(logDir, { recursive: true });

    const venvPython =
      process.platform === "win32"
        ? join(demoDir, ".venv", "Scripts", "python.exe")
        : join(demoDir, ".venv", "bin", "python3");
    const args = [
      ...adapter.launch.process.launch.runtimeArguments,
      entryScript,
      ...adapter.launch.process.arguments.map((arg) => arg.replaceAll("${logDir}", logDir)),
    ];

    const child = spawn(venvPython, args, {
      cwd: demoDir,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const peer = new FramedStdioPeer(child);
    try {
      peer.send({
        seq: 1,
        type: "request",
        command: "initialize",
        arguments: {
          adapterID: adapter.adapterID,
          linesStartAt1: true,
          columnsStartAt1: true,
          pathFormat: "path",
        },
      });
      const initResp = await peer.waitFor(
        (m) => m.type === "response" && m.command === "initialize",
        "debugpy initialize response",
      );
      assert.equal(initResp.success, true);

      const launchArgs = {
        ...structuredClone(adapter.configurations.launch.arguments),
        program: join(demoDir, "main.py"),
        cwd: demoDir,
      };
      peer.send({
        seq: 2,
        type: "request",
        command: "launch",
        arguments: launchArgs,
      });

      await peer.waitFor((m) => m.type === "event" && m.event === "initialized", "debugpy initialized event");
      peer.send({
        seq: 3,
        type: "request",
        command: "configurationDone",
        arguments: {},
      });

      const launchResp = await peer.waitFor(
        (m) => m.type === "response" && m.command === "launch",
        "debugpy launch response",
      );
      assert.equal(launchResp.success, true, `debugpy launch failed: ${JSON.stringify(launchResp)}`);

      let combinedStdout = "";
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline) {
        const msg = await peer.waitFor(() => true, "debugpy session event", 15_000);
        if (msg.type === "event" && msg.event === "output" && msg.body?.category === "stdout") {
          combinedStdout += msg.body.output ?? "";
        }
        if (msg.type === "event" && msg.event === "terminated") {
          break;
        }
      }
      assert.match(combinedStdout, /Hello from Lithe Python Demo!/);

      peer.send({
        seq: 4,
        type: "request",
        command: "disconnect",
        arguments: { terminateDebuggee: true },
      });
      await peer.waitFor((m) => m.type === "response" && m.command === "disconnect", "debugpy disconnect response", 10_000);
    } finally {
      await peer.closeAndKill();
    }

    const logFiles = readdirSync(logDir);
    assert.ok(
      logFiles.some((name) => name.startsWith("debugpy") && name.endsWith(".log")),
      `Expected debugpy log files in ${logDir}, got: ${logFiles.join(", ")}`,
    );
  });

  await check("unpacked plugin package file manifest and SHA-256 hashes remain 100% unchanged after all workflows", () => {
    const afterSnapshot = snapshotDirectoryHashes(unpackedPluginDir);
    assert.deepEqual(afterSnapshot, beforeSnapshot);
  });
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

if (failed) {
  process.exit(1);
}
