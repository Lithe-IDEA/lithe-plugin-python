#!/usr/bin/env node
// Runs static contract checks, unit tests for scripts/build_model.py, and live
// end-to-end smoke tests against the unpacked plugin package (pyrefly --version,
// pyrefly lsp with .venv resolution, project template rendering, debugpy DAP launch),
// asserting 100% file-list and SHA-256 immutability of the installed plugin directory.
//
// PYTHON selects the Python executable (default python3 on Unix, python on Windows).
// LITHE_TEST_PLUGIN_DIR tests an already-unpacked archive directory; when unset,
// scripts/test.mjs packages (if needed) and unpacks the current platform archive
// under a temporary path containing spaces, matching Lithe's plugin install layout.

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
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
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readZipEntries } from "./lib/archive.mjs";
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

function setDirectoryTreeReadOnly(rootDir, readOnly) {
  if (process.platform === "win32") return;
  const dirs = [];
  function walk(currentDir) {
    dirs.push(currentDir);
    for (const name of readdirSync(currentDir)) {
      const abs = join(currentDir, name);
      const stat = lstatSync(abs);
      if (stat.isDirectory()) {
        if (!readOnly) chmodSync(abs, 0o755);
        walk(abs);
      } else if (stat.isFile()) {
        const execBit = (stat.mode & 0o111) !== 0;
        if (readOnly) {
          chmodSync(abs, execBit ? 0o555 : 0o444);
        } else {
          chmodSync(abs, execBit ? 0o755 : 0o644);
        }
      }
    }
  }
  if (!readOnly) chmodSync(rootDir, 0o755);
  walk(rootDir);
  if (readOnly) {
    for (const dir of dirs.reverse()) {
      chmodSync(dir, 0o555);
    }
  }
}

/** Sends framing-based JSON-RPC / DAP messages over stdio with bounded timeout. */
class FramedStdioPeer {
  constructor(child) {
    this.child = child;
    this.buffer = Buffer.alloc(0);
    this.messages = [];
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
        throw new Error(`Missing Content-Length header: ${header}`);
      }
      const length = Number.parseInt(match[1], 10);
      const bodyStart = sep + 4;
      if (this.buffer.length < bodyStart + length) return;
      const payload = JSON.parse(this.buffer.subarray(bodyStart, bodyStart + length).toString("utf8"));
      this.buffer = this.buffer.subarray(bodyStart + length);
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

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "lithe-python-test-")));
let unpackedPluginDir = null;
let madeReadOnly = false;

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

  await check("Unix and Windows plugin.json + zh-Hans.json satisfy contract invariants", () => {
    for (const platform of Object.keys(lock.pyrefly.platforms)) {
      const variant = manifestForPlatform(sourceManifest, platform, lock);
      assert.equal(variant.schemaVersion, 0);
      assert.equal(variant.pluginAPIVersion, 0);
      assert.equal(variant.id, "io.github.lithe-idea.python-support");
      assert.equal(variant.vendor.id, "io.github.lithe-idea");
      assert.equal(variant.vendor.signatureRequirement, "none");
      assert.equal("commandInstallers" in variant, false, "must not declare commandInstallers");
      assert.equal("$schema" in variant, false, "plugin.json must not contain $schema");
      assert.equal("description" in variant, false, "plugin.json must not contain unknown top-level description");
      assert.equal("license" in variant, false, "plugin.json must not contain unknown top-level license");
      assert.deepEqual(Object.keys(variant.requires).sort(), [
        "buildSystems",
        "debugAdapters",
        "languageServers",
        "languages",
        "outputLinkMatchers",
        "projectGenerators",
        "settings",
        "toolDefinitions",
      ]);

      const pyLang = variant.languages[0];
      assert.equal("shebang" in pyLang, false, "languages[0] must not declare shebang");
      assert.deepEqual(pyLang.fileExtensions, ["py", "pyi", "pyw"]);

      const pyTool = variant.toolDefinitions[0];
      assert.equal("pathPrepend" in pyTool, false, "toolDefinitions[0] must omit unsafe pathPrepend");
      assert.ok(pyTool.discovery.length <= 16, "discovery rules must fit Core limit of 16");
      assert.deepEqual(pyTool.launch, ["${executable}", "${runtimeArguments}", "${entry}", "${arguments}"]);

      assert.deepEqual(
        variant.buildSystems.map((b) => b.id),
        ["python", "uv", "conda", "ruff"],
      );

      const pyServer = variant.languageServers[0];
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
  // user-writable plugin directories) so any stray __pycache__ write by a child process
  // such as debugpy/launcher is caught immediately instead of masked by POSIX 0555!
  const beforeSnapshot = snapshotDirectoryHashes(unpackedPluginDir);

  const buildModelScript = join(unpackedPluginDir, "scripts", "build_model.py");

  await check("build_model.py discovers PEP 621 scripts, src/ packages, tests, and .venv exclusions", () => {
    const proj = join(scratch, "case-pep621");
    mkdirSync(join(proj, "src", "demo_pkg"), { recursive: true });
    mkdirSync(join(proj, "tests"), { recursive: true });
    mkdirSync(join(proj, ".venv", "bin"), { recursive: true });
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
      { path: ".venv", kind: "excluded" },
      { path: "src", kind: "source" },
      { path: "tests", kind: "testSource" },
    ]);

    // Execute the generated entrypoint runner to verify it invokes demo_pkg.cli:main without editable install.
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
    writeFileSync(
      join(proj, "web.py"),
      "from flask import Flask\napp = Flask(__name__)\n",
    );
    writeFileSync(
      join(proj, "worker.py"),
      'def run():\n    pass\nif __name__ == "__main__":\n    run()\n',
    );
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

    // Verify nested-instance invocation where host sets cwd = <workspace>/services/sub and passes ${root} = "services/sub".
    const nested = join(scratch, "workspace-nested", "services", "sub");
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(nested, "pyproject.toml"), '[project]\nname = "nested-svc"\nversion = "0.1.0"\n');
    const nestedOut = join(scratch, "nested-out.json");
    run(pythonCmd, ["-I", "-B", buildModelScript, "services/sub", nestedOut], { cwd: nested });
    const nestedModel = JSON.parse(readFileSync(nestedOut, "utf8"));
    assert.equal(nestedModel.projects[0].name, "nested-svc");

    // Verify vendored tomli fallback when stdlib tomllib is unavailable (Python 3.9/3.10 simulation).
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

    // Verify non-zero exit on missing directory so host logs host.commandFailed,
    // and assert stderr contains only controlled diagnostic code without leaking paths.
    const secretMissingPath = join(scratch, "secret-path-token-do-not-log");
    const missing = spawnSync(pythonCmd, ["-I", "-B", buildModelScript, secretMissingPath, tomliOut], {
      encoding: "utf8",
      timeout: 10_000,
    });
    assert.notEqual(missing.status, 0);
    assert.equal(missing.stderr.trim(), "build_model.py: project_root_unavailable");
    assert.ok(!missing.stderr.includes("secret-path-token-do-not-log"), "stderr must never echo raw paths");
  });

  await check("lineMatcher and outputLinkMatchers match mypy, Ruff, and Python Traceback output", () => {
    const pyBuild = pluginManifest.buildSystems.find((b) => b.id === "python");
    const mypyPattern = pyBuild.diagnostics.patterns[0];
    const mypyRe = new RegExp(mypyPattern.regex);
    const mypyMatch = mypyRe.exec('src/app.py:42:13: error: Incompatible types in assignment [assignment]');
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

    // JS equivalent of Rust named capture group (?P<path>...) -> (?<path>...)
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

  await check("packaged pyrefly answers --version and resolves .venv packages over LSP without pythonPath: ''", async () => {
    const pyreflyServer = pluginManifest.languageServers.find((s) => s.languageID === "python");
    const pyreflyBin = join(unpackedPluginDir, ...pyreflyServer.launch.path.split("/"));
    const versionOut = run(pyreflyBin, pyreflyServer.validationArguments, { cwd: demoDir }).trim();
    assert.match(versionOut, /pyrefly\s+1\.4\.1/i);

    // Add a synthetic package inside demoDir/.venv site-packages so only .venv resolution can find it.
    const venvPython =
      process.platform === "win32"
        ? join(demoDir, ".venv", "Scripts", "python.exe")
        : join(demoDir, ".venv", "bin", "python3");
    const sitePackages = run(venvPython, ["-I", "-B", "-c", "import site; print(site.getsitepackages()[0])"], {
      cwd: demoDir,
    }).trim();
    const customPkgDir = join(sitePackages, "venv_only_pkg");
    mkdirSync(customPkgDir, { recursive: true });
    writeFileSync(join(customPkgDir, "__init__.py"), " def answer() -> int:\n    return 42\n".trimStart());

    const checkFile = join(demoDir, "check_types.py");
    const checkContent = "from venv_only_pkg import answer\nx: str = answer()\n";
    writeFileSync(checkFile, checkContent);

    const fileUri = new URL(`file://${checkFile.startsWith("/") ? "" : "/"}${checkFile.replace(/\\/g, "/")}`).href;
    const rootUri = new URL(`file://${demoDir.startsWith("/") ? "" : "/"}${demoDir.replace(/\\/g, "/")}`).href;

    const child = spawn(pyreflyBin, pyreflyServer.arguments, {
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
          rootUri,
          workspaceFolders: [{ uri: rootUri, name: "demo" }],
          capabilities: {
            workspace: { configuration: true },
            textDocument: { publishDiagnostics: {} },
          },
        },
      });

      await peer.waitFor((m) => m.id === 1 && "result" in m, "pyrefly initialize response");
      peer.send({ jsonrpc: "2.0", method: "initialized", params: {} });

      // Respond to workspace/configuration with our exact manifest defaults (no pythonPath!).
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
                  uri: fileUri,
                  languageId: "python",
                  version: 1,
                  text: checkContent,
                },
              },
            });
          }
        } else if (msg.id !== undefined && msg.method) {
          peer.send({ jsonrpc: "2.0", id: msg.id, result: null });
        } else if (msg.method === "textDocument/publishDiagnostics" && msg.params?.uri === fileUri) {
          if ((msg.params.diagnostics ?? []).length > 0) {
            diagnosticsMsg = msg;
            break;
          }
        }
      }

      assert.ok(diagnosticsMsg, "Expected publishDiagnostics from pyrefly");
      const codes = diagnosticsMsg.params.diagnostics.map((d) => d.code);
      assert.ok(!codes.includes("missing-import"), `Expected .venv import to resolve, got: ${JSON.stringify(diagnosticsMsg.params.diagnostics)}`);
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
  if (madeReadOnly && unpackedPluginDir && !process.env.LITHE_TEST_PLUGIN_DIR) {
    try {
      setDirectoryTreeReadOnly(unpackedPluginDir, false);
    } catch {}
  } else if (madeReadOnly && unpackedPluginDir && process.env.LITHE_TEST_PLUGIN_DIR) {
    try {
      setDirectoryTreeReadOnly(unpackedPluginDir, false);
    } catch {}
  }
  rmSync(scratch, { recursive: true, force: true });
}

if (failed) {
  process.exit(1);
}
