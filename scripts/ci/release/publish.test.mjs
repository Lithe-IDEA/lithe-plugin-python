import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const workflow = readFileSync(new URL("../../../.github/workflows/release.yml", import.meta.url), "utf8");
const publishStep = workflow.match(/^ {6}- name: Publish GitHub Release\n(?: {8}[^\n]*\n)*? {8}run: \|\n((?:(?: {10}[^\n]*)?\n)+)/m);
assert.ok(publishStep, "Could not find the release workflow's publish step");
const publishScript = publishStep[1].replace(/^ {10}/gm, "");
const recordReleaseArgs = 'gh() { printf "%s\\n" "$@" > "$RELEASE_ARGS"; }\n';

const gitEnv = {
  PATH: process.env.PATH,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
  GIT_AUTHOR_NAME: "Release Test",
  GIT_AUTHOR_EMAIL: "release@example.invalid",
  GIT_COMMITTER_NAME: "Release Test",
  GIT_COMMITTER_EMAIL: "release@example.invalid",
};

function releaseFixture(t, tag = "v1.0.0", tagOptions = []) {
  const directory = mkdtempSync(join(tmpdir(), "python-release-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const checkout = join(directory, "checkout");
  const remote = join(directory, "remote.git");
  const ref = `refs/tags/${tag}`;
  const cliLog = join(directory, "release-args");

  function git(cwd, ...args) {
    return execFileSync("git", args, { cwd, env: gitEnv, encoding: "utf8", timeout: 5000 }).trim();
  }

  git(directory, "init", "-q", checkout);
  git(directory, "init", "-q", "--bare", remote);
  git(checkout, "remote", "add", "origin", remote);
  git(checkout, "commit", "-qm", "packaged commit", "--allow-empty");
  const packagedCommit = git(checkout, "rev-parse", "HEAD");
  git(checkout, "tag", ...tagOptions, tag);
  git(checkout, "push", "-q", "origin", ref);

  mkdirSync(join(checkout, "docs", "releases"), { recursive: true });
  mkdirSync(join(checkout, "dist"));
  writeFileSync(join(checkout, "docs", "releases", `${tag}.md`), "Release notes\n");
  writeFileSync(join(checkout, "dist", "python-support.zip"), "Test archive contents\n");

  return {
    cliLog,
    retag() {
      git(checkout, "commit", "-qm", "replacement commit", "--allow-empty");
      git(checkout, "push", "-q", "origin", `+HEAD:${ref}`);
      git(checkout, "checkout", "-q", "--detach", packagedCommit);
    },
    removeTag() {
      git(checkout, "push", "-q", "origin", `:${ref}`);
    },
    publish() {
      const result = spawnSync("bash", ["--noprofile", "--norc", "-e", "-c", recordReleaseArgs + publishScript], {
        cwd: checkout,
        encoding: "utf8",
        timeout: 5000,
        env: {
          ...gitEnv,
          GITHUB_REF: ref,
          GITHUB_REF_NAME: tag,
          RUNNER_TEMP: directory,
          PRERELEASE_TAGS: "v0.1.0 v0.1.1",
          RELEASE_ARGS: cliLog,
        },
      });
      assert.ifError(result.error);
      return result;
    },
  };
}

test("publish uses the unchanged lightweight release tag", (t) => {
  const fixture = releaseFixture(t);
  const result = fixture.publish();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const args = readFileSync(fixture.cliLog, "utf8").trimEnd().split("\n");
  assert.deepEqual(args.slice(0, 3), ["release", "create", "v1.0.0"]);
  assert.ok(args.includes("--verify-tag"));
  assert.ok(!args.includes("--prerelease"));
});

test("publish resolves an annotated prerelease tag to its commit", (t) => {
  const fixture = releaseFixture(t, "v0.1.1", ["-a", "-m", "Prerelease"]);
  const result = fixture.publish();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(readFileSync(fixture.cliLog, "utf8"), /^--prerelease$/m);
});

test("publish stops when the remote tag is moved after packaging", (t) => {
  const fixture = releaseFixture(t);
  fixture.retag();
  const result = fixture.publish();
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /no longer points to the packaged commit/);
  assert.ok(!existsSync(fixture.cliLog), "Should stop before invoking gh release create");
});

test("publish stops when the remote tag is deleted after packaging", (t) => {
  const fixture = releaseFixture(t);
  fixture.removeTag();
  const result = fixture.publish();
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /Could not resolve release tag/);
  assert.ok(!existsSync(fixture.cliLog), "Should stop before invoking gh release create");
});
