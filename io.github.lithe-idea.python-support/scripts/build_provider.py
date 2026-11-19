import os
import sys

# Never write bytecode into the installed read-only plugin package or user workspace.
sys.dont_write_bytecode = True
os.environ["PYTHONDONTWRITEBYTECODE"] = "1"

import argparse
import json
from pathlib import Path
import shutil
import tempfile
import threading
from typing import Any, Optional
from urllib.parse import unquote, urlparse

# Ensure sibling scripts are importable under Python 3.11+ `-I` safe_path mode.
_SCRIPTS_DIR = str(Path(__file__).resolve().parent)
if _SCRIPTS_DIR not in sys.path:
    sys.path.insert(0, _SCRIPTS_DIR)

from build_model import (  # noqa: E402
    _parse_pyproject,
    _parse_setup_cfg,
    _parse_setup_py,
    _safe_within,
    build_model_with_diagnostics,
    inspect_file_entrypoints,
)
from lithe_rpc import (  # noqa: E402
    CallContext,
    JsonRpcServer,
    MAX_BUILD_RESULT_BYTES,
    PluginError,
    run_bounded_process,
)

_MAX_DISCOVERED_TESTS = 10_000
_MAX_TEST_SELECTOR_BYTES = 1024
_JUNIT_REPORT_REL = ".pytest_cache/lithe-junit.xml"

_PYTEST_COLLECTOR_SNIPPET = """
import json, os, pathlib, sys
sys.dont_write_bytecode = True
os.environ["PYTHONDONTWRITEBYTECODE"] = "1"

out_path = pathlib.Path(sys.argv[1])
cache_dir = sys.argv[2]
project = json.loads(sys.argv[3])
max_items, max_bytes, max_selector_bytes = map(int, sys.argv[4:7])
extra_args = sys.argv[7:]

try:
    import pytest
except ModuleNotFoundError:
    sys.exit(197)

cwd_real = pathlib.Path.cwd().resolve()

def valid_selector(text):
    try:
        return (text.strip() and not text.lstrip().startswith("-")
                and len(text.encode("utf-8")) <= max_selector_bytes
                and not any(ord(c) < 32 or 127 <= ord(c) <= 159 for c in text))
    except UnicodeEncodeError:
        return False

class _LitheTestCollector:
    def __init__(self):
        self.items = []
        self.omitted = 0

    def pytest_collection_finish(self, session):
        root_real = pathlib.Path(str(session.config.rootpath)).resolve()
        # Reserve room for JSON keys, counters and the provider response envelope.
        remaining_bytes = max_bytes - 128
        for item in session.items:
            nodeid = getattr(item, "nodeid", "")
            if not isinstance(nodeid, str) or not nodeid:
                continue
            if "::" in nodeid:
                fpart, cpart = nodeid.split("::", 1)
            else:
                fpart, cpart = nodeid, getattr(item, "name", "") or nodeid
            item_path = getattr(item, "path", None)
            resolved_suite = None
            if item_path is not None:
                try:
                    resolved_suite = pathlib.Path(item_path).resolve().relative_to(cwd_real).as_posix()
                except Exception:
                    resolved_suite = None
            if resolved_suite is None:
                try:
                    resolved_suite = (root_real / fpart).resolve().relative_to(cwd_real).as_posix()
                except Exception:
                    resolved_suite = None
            if (
                resolved_suite
                and valid_selector(resolved_suite)
                and valid_selector(cpart)
                and ":" not in resolved_suite and "\\\\" not in resolved_suite
                and all(seg not in ("", ".", "..") and not seg.startswith("-") for seg in resolved_suite.split("/"))
            ):
                if len(self.items) < max_items:
                    selector = {"suite": resolved_suite, "case": cpart, "project": project}
                    size = len(json.dumps(selector, ensure_ascii=False).encode("utf-8")) + 2
                    if size <= remaining_bytes:
                        self.items.append(selector)
                        remaining_bytes -= size
                        continue
            self.omitted += 1

args = [
    "--collect-only",
    "-q",
    "--color=no",
    "-o",
    "addopts=",
    "-o",
    f"cache_dir={cache_dir}",
    *extra_args,
]
collector = _LitheTestCollector()
raw_code = pytest.main(args, plugins=[collector])
try:
    exit_code = int(raw_code)
except Exception:
    exit_code = 1
out_path.write_text(
    json.dumps({"items": collector.items, "omitted": collector.omitted}, ensure_ascii=False),
    encoding="utf-8",
)
sys.exit(exit_code)
""".strip()


def file_uri_to_path(uri: str) -> Optional[Path]:
    parsed = urlparse(uri)
    if parsed.scheme != "file":
        return None
    raw_path = unquote(parsed.path or "")
    if parsed.netloc and parsed.netloc.lower() != "localhost":
        if os.name == "nt":
            return Path(f"//{parsed.netloc}{raw_path}")
        return Path(f"/{parsed.netloc}{raw_path}")
    # Windows file:///C:/path -> /C:/path -> C:/path
    if len(raw_path) >= 3 and raw_path[0] == "/" and raw_path[1].isalpha() and raw_path[2] == ":":
        raw_path = raw_path[1:]
    return Path(raw_path) if raw_path else None


def _strip_dot_slash_prefix(text: str) -> str:
    while text.startswith("./"):
        text = text[2:]
    return text


def _normalize_rel_root(raw_root: Any) -> str:
    if raw_root is None or raw_root in ("", "."):
        return "."
    if not isinstance(raw_root, str) or any(ord(c) < 32 or ord(c) == 127 for c in raw_root):
        raise PluginError("python.invalidRoot", "Invalid build instance root.")
    cleaned = _strip_dot_slash_prefix(raw_root.replace("\\", "/"))
    cleaned = cleaned.strip("/")
    if not cleaned:
        return "."
    parts = cleaned.split("/")
    if any(p in ("", ".", "..") for p in parts):
        raise PluginError("python.invalidRoot", "Build instance root escapes workspace.")
    return "/".join(parts)


def _validate_safe_rel_selector_path(raw: Any, *, allow_dot: bool = False) -> str:
    if not isinstance(raw, str) or any(ord(c) < 32 or ord(c) == 127 for c in raw):
        raise PluginError("python.invalidTestSelector", "The requested test selector path is invalid.")
    slashed = raw.replace("\\", "/")
    if slashed.startswith("/") or ":" in slashed:
        raise PluginError("python.invalidTestSelector", "The requested test selector must be a relative path.")
    cleaned = _strip_dot_slash_prefix(slashed).rstrip("/")
    if allow_dot and cleaned in ("", "."):
        return "."
    if not cleaned or cleaned.startswith("-"):
        raise PluginError("python.invalidTestSelector", "The requested test selector path is invalid.")
    parts = cleaned.split("/")
    if any(p in ("", ".", "..") or p.startswith("-") for p in parts):
        raise PluginError("python.invalidTestSelector", "The requested test selector path is invalid.")
    return "/".join(parts)


def _verify_contained_path(instance_dir: Path, instance_real: Path, rel_posix: str, *, expect_dir: bool) -> Path:
    """
    Verifies every segment from `instance_dir` to `rel_posix` stays strictly within `instance_real`
    (rejecting symlinks that escape the instance) and distinguishes boundary violations from missing/stale files.
    """
    cur = instance_dir
    for part in rel_posix.split("/"):
        cur = cur / part
        if cur.is_symlink() and not _safe_within(instance_real, cur):
            raise PluginError("python.invalidTestSelector", "The requested test selector escapes the project root.")
    if cur.exists() and not _safe_within(instance_real, cur):
        raise PluginError("python.invalidTestSelector", "The requested test selector escapes the project root.")
    if expect_dir:
        if not cur.is_dir():
            raise PluginError("python.staleTestSelector", "The requested test target directory no longer exists.")
    else:
        if not cur.is_file():
            raise PluginError("python.staleTestSelector", "The requested test suite file no longer exists.")
    return cur


def _project_name_for_dir(instance_dir: Path) -> str:
    py_meta = _parse_pyproject(instance_dir / "pyproject.toml")
    if py_meta.get("name"):
        return py_meta["name"]
    cfg_meta = _parse_setup_cfg(instance_dir / "setup.cfg")
    if cfg_meta.get("name"):
        return cfg_meta["name"]
    setup_meta = _parse_setup_py(instance_dir / "setup.py")
    if setup_meta.get("name"):
        return setup_meta["name"]
    return instance_dir.name or "python-project"


def _resolve_pytest_selector_args(
    instance_dir: Path,
    suite: Any,
    case: Any,
    target: Optional[dict[str, Any]],
) -> list[str]:
    """
    Validates and maps (suite, case, target) into pytest positional selectors.
    - A case requires a suite for an exact node ID.
    - Enforces strict workspace containment (`_safe_within`) on every resolved file/directory.
    """
    instance_real = instance_dir.resolve()

    clean_case: Optional[str] = None
    if case is not None:
        if suite is None:
            raise PluginError("python.invalidTestSelector", "A pytest case requires its test suite.")
        if (
            not isinstance(case, str)
            or not case.strip()
            or len(case) > 1024
            or any(ord(c) < 32 or ord(c) == 127 for c in case)
            or case.lstrip().startswith("-")
        ):
            raise PluginError("python.invalidTestSelector", "The requested test case selector is invalid.")
        clean_case = case

    if suite is not None:
        if (
            not isinstance(suite, str)
            or not suite.strip()
            or len(suite) > 1024
            or any(ord(c) < 32 or ord(c) == 127 for c in suite)
            or suite.lstrip().startswith("-")
        ):
            raise PluginError("python.invalidTestSelector", "The requested test suite selector is invalid.")

        if ("/" in suite or "\\" in suite or suite.endswith((".py", ".pyi", ".pyw"))
                or (instance_dir / suite).is_file()):
            norm_suite = _validate_safe_rel_selector_path(suite, allow_dot=False)
            _verify_contained_path(instance_dir, instance_real, norm_suite, expect_dir=False)
            nodeid = f"{norm_suite}::{clean_case}" if clean_case else norm_suite
            return [nodeid]

        # Dotted JUnit XML classname suite (e.g. "tests.test_calc.TestCalc" or "tests.test_calc").
        parts = suite.split(".")
        if not parts or any(not p or p in (".", "..") or p.startswith("-") or "/" in p or "\\" in p for p in parts):
            raise PluginError("python.invalidTestSelector", "The requested test suite selector is invalid.")

        for idx in range(len(parts), 0, -1):
            mod_rel = "/".join(parts[:idx]) + ".py"
            cand = instance_dir / Path(*parts[:idx]).with_suffix(".py")
            if cand.exists() or cand.is_symlink():
                _verify_contained_path(instance_dir, instance_real, mod_rel, expect_dir=False)
                rem = parts[idx:]
                resolved_base = f"{mod_rel}::{'::'.join(rem)}" if rem else mod_rel
                nodeid = f"{resolved_base}::{clean_case}" if clean_case else resolved_base
                return [nodeid]

        raise PluginError("python.staleTestSelector", "The requested test suite could not be resolved in the project.")

    target_dir: Optional[str] = None
    if isinstance(target, dict):
        props = target.get("properties")
        if isinstance(props, dict) and "directory" in props and props["directory"] is not None:
            norm_target = _validate_safe_rel_selector_path(props["directory"], allow_dot=True)
            if norm_target != ".":
                _verify_contained_path(instance_dir, instance_real, norm_target, expect_dir=True)
                target_dir = norm_target

    return [target_dir] if target_dir else []


def create_build_provider_server(*, cache_dir: Optional[str] = None) -> JsonRpcServer:
    server = JsonRpcServer(name="python-build-provider", version="0.2.0")
    workspace_root_holder: dict[str, Path] = {"root": Path.cwd().resolve()}
    owned_temp_dir: Optional[str] = None
    if cache_dir:
        cache_root = Path(cache_dir)
    else:
        owned_temp_dir = tempfile.mkdtemp(prefix="lithe-python-build-")
        cache_root = Path(owned_temp_dir)

    degraded_model_roots: set[str] = set()
    state_lock = threading.Lock()

    def _on_init(params: dict[str, Any]) -> None:
        folders = params.get("workspaceFolders")
        if isinstance(folders, list) and folders:
            first = folders[0]
            if isinstance(first, dict) and isinstance(first.get("uri"), str):
                parsed = file_uri_to_path(first["uri"])
                if parsed is not None and parsed.is_dir():
                    workspace_root_holder["root"] = parsed.resolve()
                    return
        root_uri = params.get("rootUri")
        if isinstance(root_uri, str) and root_uri:
            parsed = file_uri_to_path(root_uri)
            if parsed is not None and parsed.is_dir():
                workspace_root_holder["root"] = parsed.resolve()
                return
        root_path = params.get("rootPath")
        if isinstance(root_path, str) and root_path:
            cand = Path(root_path)
            if cand.is_dir():
                workspace_root_holder["root"] = cand.resolve()

    def _on_shutdown() -> None:
        if owned_temp_dir and os.path.isdir(owned_temp_dir):
            shutil.rmtree(owned_temp_dir, ignore_errors=True)

    def _resolve_instance(params: dict[str, Any]) -> tuple[str, Path]:
        ws_root = workspace_root_holder["root"]
        norm_root = _normalize_rel_root(params.get("root"))
        inst = ws_root if norm_root == "." else (ws_root / Path(*norm_root.split("/")))
        if not inst.is_dir() or not _safe_within(ws_root, inst):
            raise PluginError("python.projectUnavailable", "The Python project directory is unavailable.")
        return norm_root, inst.resolve()

    def _resolve_runtime_and_env(params: dict[str, Any]) -> tuple[str, dict[str, str]]:
        python_exec = sys.executable
        tool = params.get("tool")
        if isinstance(tool, dict):
            raw_exec = tool.get("executable")
            if isinstance(raw_exec, str) and raw_exec.strip():
                python_exec = raw_exec.strip()
        options = params.get("options")
        if isinstance(options, dict):
            opt_exec = options.get("pythonExecutable")
            if isinstance(opt_exec, str) and opt_exec.strip():
                python_exec = opt_exec.strip()

        env = dict(os.environ)
        raw_env = params.get("environment")
        if isinstance(raw_env, dict):
            for k, v in raw_env.items():
                if isinstance(k, str) and isinstance(v, str) and "\x00" not in k and "\x00" not in v:
                    env[k] = v
        # Ensure child processes never write bytecode and emit UTF-8 output cleanly.
        env["PYTHONDONTWRITEBYTECODE"] = "1"
        env["PYTHONIOENCODING"] = "utf-8"
        return python_exec, env

    def _string_args(value: Any) -> list[str]:
        if not isinstance(value, list):
            return []
        return [item for item in value if isinstance(item, str) and "\x00" not in item]

    def handle_model(params: dict[str, Any], ctx: CallContext) -> dict[str, Any]:
        ctx.raise_if_cancelled()
        norm_root, instance_dir = _resolve_instance(params)
        model, degraded_codes = build_model_with_diagnostics(instance_dir)
        if "pyproject_parse_failed" in degraded_codes:
            with state_lock:
                degraded_model_roots.add(norm_root)
            ctx.diagnostics.degraded("lithe/build/model", "pyproject_parse_failed", 1)
        else:
            restored = False
            with state_lock:
                if norm_root in degraded_model_roots:
                    degraded_model_roots.remove(norm_root)
                    restored = True
            if restored:
                ctx.diagnostics.recovered("lithe/build/model", "pyproject_restored", 1)
        return model

    def handle_discover_tests(params: dict[str, Any], ctx: CallContext) -> dict[str, Any]:
        ctx.raise_if_cancelled()
        norm_root, instance_dir = _resolve_instance(params)
        python_exec, child_env = _resolve_runtime_and_env(params)
        project_selection = {
            "name": _project_name_for_dir(instance_dir),
            "path": norm_root,
        }

        try:
            cache_root.mkdir(parents=True, exist_ok=True)
            pytest_cache_dir = cache_root / "pytest-collect-cache"
            pytest_cache_dir.mkdir(parents=True, exist_ok=True)
        except OSError as exc:
            raise PluginError("python.cacheUnavailable", "Workspace state directory is not writable.") from exc

        timeout_ms = 45_000.0
        raw_env_timeout = os.environ.get("LITHE_PYTHON_DISCOVER_TIMEOUT_MS")
        if raw_env_timeout:
            try:
                timeout_ms = max(200.0, float(raw_env_timeout))
            except ValueError:
                pass

        option_args = _string_args(params.get("optionArguments"))
        with tempfile.TemporaryDirectory(dir=str(cache_root), prefix="discover-") as run_tmp:
            out_json_path = Path(run_tmp) / "collected.json"
            argv = [
                python_exec,
                "-B",
                "-c",
                _PYTEST_COLLECTOR_SNIPPET,
                str(out_json_path),
                str(pytest_cache_dir),
                json.dumps(project_selection),
                str(_MAX_DISCOVERED_TESTS),
                str(MAX_BUILD_RESULT_BYTES),
                str(_MAX_TEST_SELECTOR_BYTES),
                *option_args,
            ]
            try:
                exit_code, _output, timed_out = run_bounded_process(
                    argv,
                    cwd=str(instance_dir),
                    env=child_env,
                    cancel_token=ctx.cancel_token,
                    timeout_seconds=timeout_ms / 1000.0,
                )
            except FileNotFoundError as exc:
                raise PluginError(
                    "python.interpreterUnavailable",
                    "The selected Python interpreter could not be started.",
                ) from exc

            if timed_out:
                raise PluginError("python.pytestTimedOut", "pytest test discovery timed out.")
            if exit_code == 197:
                raise PluginError(
                    "python.pytestUnavailable",
                    "pytest is not installed in the selected Python environment.",
                )
            if exit_code == 5:
                return {
                    "format": "litheTestDiscovery",
                    "version": 0,
                    "tests": [],
                }
            if exit_code != 0 or not out_json_path.is_file():
                raise PluginError(
                    "python.pytestCollectionFailed",
                    "pytest failed to collect tests. Fix syntax or import errors and retry.",
                )

            try:
                with out_json_path.open("rb") as collection:
                    data = collection.read(MAX_BUILD_RESULT_BYTES + 1)
                if len(data) > MAX_BUILD_RESULT_BYTES:
                    raise ValueError("pytest collection report exceeds its byte budget")
                payload = json.loads(data)
                items = payload["items"]
                omitted = payload["omitted"]
                if (not isinstance(items, list) or len(items) > _MAX_DISCOVERED_TESTS
                        or type(omitted) is not int or omitted < 0):
                    raise ValueError("invalid pytest collection report")
            except (OSError, ValueError, TypeError, KeyError) as exc:
                raise PluginError(
                    "python.pytestCollectionFailed",
                    "pytest returned an unreadable test collection payload.",
                ) from exc

        if omitted:
            ctx.diagnostics.degraded("lithe/build/discoverTests", "test_discovery_truncated", omitted)

        return {
            "format": "litheTestDiscovery",
            "version": 0,
            "tests": items,
        }

    def handle_test(params: dict[str, Any], ctx: CallContext) -> dict[str, Any]:
        ctx.raise_if_cancelled()
        _norm_root, instance_dir = _resolve_instance(params)
        python_exec, child_env = _resolve_runtime_and_env(params)

        project_param = params.get("project")
        run_cwd = instance_dir
        if isinstance(project_param, dict) and isinstance(project_param.get("path"), str):
            proj_rel = _normalize_rel_root(project_param["path"])
            ws_root = workspace_root_holder["root"]
            cand_dir = ws_root if proj_rel == "." else (ws_root / Path(*proj_rel.split("/")))
            if not _safe_within(instance_dir, cand_dir):
                raise PluginError("python.invalidTestSelector", "The requested test project escapes the build instance.")
            if not cand_dir.is_dir():
                raise PluginError("python.staleTestSelector", "The requested test project no longer exists.")
            run_cwd = cand_dir.resolve()

        raw_suite = params["suite"] if "suite" in params else None
        raw_case = params["case"] if "case" in params else None
        target = params.get("target") if isinstance(params.get("target"), dict) else None
        option_args = _string_args(params.get("optionArguments"))
        user_args = _string_args(params.get("userArguments"))

        # Validate selectors BEFORE touching disk or spawning pytest so stale/invalid selectors reject cleanly.
        positional_targets = _resolve_pytest_selector_args(run_cwd, raw_suite, raw_case, target)

        junit_file = run_cwd / Path(*_JUNIT_REPORT_REL.split("/"))
        try:
            if junit_file.exists():
                junit_file.unlink()
            junit_file.parent.mkdir(parents=True, exist_ok=True)
        except OSError:
            pass

        argv = [
            python_exec,
            "-B",
            "-m",
            "pytest",
            f"--junitxml={_JUNIT_REPORT_REL}",
            *option_args,
            *user_args,
            *(["--", *positional_targets] if positional_targets else []),
        ]

        timeout_ms = 600_000.0
        raw_env_timeout = os.environ.get("LITHE_PYTHON_TEST_TIMEOUT_MS")
        if raw_env_timeout:
            try:
                timeout_ms = max(200.0, float(raw_env_timeout))
            except ValueError:
                pass

        ctx.progress(message="Running pytest")
        try:
            exit_code, output, timed_out = run_bounded_process(
                argv,
                cwd=str(run_cwd),
                env=child_env,
                cancel_token=ctx.cancel_token,
                timeout_seconds=timeout_ms / 1000.0,
                on_output=lambda chunk: ctx.progress(output=chunk),
            )
        except FileNotFoundError as exc:
            raise PluginError(
                "python.interpreterUnavailable",
                "The selected Python interpreter could not be started.",
            ) from exc

        if timed_out:
            raise PluginError("python.pytestTimedOut", "pytest execution timed out.")
        # pytest returns usage error (4) for missing node IDs and no tests (5) for
        # unmatched filters. With a selection, neither fulfills the requested run.
        if (raw_suite is not None or raw_case is not None) and exit_code in (4, 5):
            raise PluginError("python.staleTestSelector", "pytest could not run the requested test selection.")

        return {
            "exitCode": exit_code,
            "output": output,
        }

    def handle_run_entrypoints(params: dict[str, Any], ctx: CallContext) -> dict[str, Any]:
        ctx.raise_if_cancelled()
        norm_root, instance_dir = _resolve_instance(params)
        raw_file = params.get("file")
        if not isinstance(raw_file, str) or not raw_file.strip():
            return {"format": "litheRunEntrypoints", "version": 0, "entrypoints": []}
        slashed = raw_file.replace("\\", "/")
        if slashed.startswith("/") or ":" in slashed:
            return {"format": "litheRunEntrypoints", "version": 0, "entrypoints": []}
        clean_file = _strip_dot_slash_prefix(slashed).rstrip("/")
        if norm_root != ".":
            prefix = norm_root + "/"
            if not clean_file.startswith(prefix):
                return {"format": "litheRunEntrypoints", "version": 0, "entrypoints": []}
            rel_file = clean_file[len(prefix) :]
        else:
            rel_file = clean_file
        if not rel_file or any(p in ("", ".", "..") for p in rel_file.split("/")):
            return {"format": "litheRunEntrypoints", "version": 0, "entrypoints": []}
        project_selection = {
            "name": _project_name_for_dir(instance_dir),
            "path": norm_root,
        }
        entrypoints = inspect_file_entrypoints(instance_dir, rel_file, project_selection)
        return {
            "format": "litheRunEntrypoints",
            "version": 0,
            "entrypoints": entrypoints,
        }

    server.on_initialize(_on_init)
    server.on_shutdown(_on_shutdown)
    server.build_handler("lithe/build/model", handle_model)
    server.build_handler("lithe/build/discoverTests", handle_discover_tests)
    server.build_handler("lithe/build/test", handle_test)
    server.build_handler("lithe/build/runEntrypoints", handle_run_entrypoints)
    server.suppress_success_diagnostics("lithe/build/runEntrypoints")
    return server


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--cache", dest="cache_dir", default=None)
    known, _ = parser.parse_known_args(argv[1:])
    server = create_build_provider_server(cache_dir=known.cache_dir)
    return server.listen()


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
