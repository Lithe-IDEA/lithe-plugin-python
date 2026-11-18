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
    PluginError,
    run_bounded_process,
)

_MAX_DISCOVERED_TESTS = 10_000
_JUNIT_REPORT_REL = ".pytest_cache/lithe-junit.xml"

_PYTEST_COLLECTOR_SNIPPET = """
import json, os, pathlib, sys
sys.dont_write_bytecode = True
os.environ["PYTHONDONTWRITEBYTECODE"] = "1"

out_path = pathlib.Path(sys.argv[1])
cache_dir = sys.argv[2]
extra_args = sys.argv[3:]

try:
    import pytest
except ModuleNotFoundError:
    sys.exit(197)

collected = []
cwd_real = pathlib.Path.cwd().resolve()

class _LitheTestCollector:
    def pytest_collection_modifyitems(self, session, config, items):
        root_real = pathlib.Path(str(config.rootpath)).resolve()
        for item in items:
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
                    resolved_suite = fpart.replace("\\\\", "/").lstrip("./")
            if resolved_suite and cpart:
                collected.append({"suite": resolved_suite, "case": cpart})

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
raw_code = pytest.main(args, plugins=[_LitheTestCollector()])
try:
    exit_code = int(raw_code)
except Exception:
    exit_code = 1
out_path.write_text(
    json.dumps({"exitCode": exit_code, "items": collected}, ensure_ascii=False),
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


def _normalize_rel_root(raw_root: Any) -> str:
    if raw_root is None or raw_root in ("", "."):
        return "."
    if not isinstance(raw_root, str) or any(ord(c) < 32 or ord(c) == 127 for c in raw_root):
        raise PluginError("python.invalidRoot", "Invalid build instance root.")
    cleaned = raw_root.replace("\\", "/").strip("/")
    if not cleaned:
        return "."
    parts = cleaned.split("/")
    if any(p in ("", ".", "..") for p in parts):
        raise PluginError("python.invalidRoot", "Build instance root escapes workspace.")
    return "/".join(parts)


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
    suite: Optional[str],
    case: Optional[str],
    target: Optional[dict[str, Any]],
) -> list[str]:
    """
    Maps (suite, case, target) into exact pytest CLI selectors:
    - Native discovered nodeid parts (`suite="tests/test_a.py"`, `case="TestX::test_y[1]"`)
      become exact `tests/test_a.py::TestX::test_y[1]`.
    - JUnit XML classname suites (`suite="tests.test_a.TestX"`, `case="test_y"`) resolve to
      `tests/test_a.py::TestX::test_y` when the file exists on disk.
    """
    instance_real = instance_dir.resolve()

    def _resolve_dotted_suite(dotted: str) -> Optional[str]:
        if "/" in dotted or "\\" in dotted or dotted.endswith((".py", ".pyi", ".pyw")):
            norm = dotted.replace("\\", "/").lstrip("./")
            cand = instance_dir / Path(*norm.split("/"))
            if cand.exists() and _safe_within(instance_real, cand):
                return norm
            return norm if dotted.endswith((".py", ".pyi", ".pyw")) else None

        parts = [p for p in dotted.split(".") if p]
        for idx in range(len(parts), 0, -1):
            mod_rel = "/".join(parts[:idx]) + ".py"
            cand = instance_dir / Path(*parts[:idx]).with_suffix(".py")
            if cand.is_file() and _safe_within(instance_real, cand):
                rem = parts[idx:]
                return f"{mod_rel}::{'::'.join(rem)}" if rem else mod_rel
        return None

    if suite and case:
        resolved = _resolve_dotted_suite(suite)
        if resolved is not None:
            return [f"{resolved}::{case}"]
        return ["-k", f"{suite} and {case}"]

    if suite:
        resolved = _resolve_dotted_suite(suite)
        if resolved is not None:
            return [resolved]
        return ["-k", suite]

    target_dir: Optional[str] = None
    if isinstance(target, dict):
        props = target.get("properties")
        if isinstance(props, dict) and isinstance(props.get("directory"), str) and props["directory"].strip():
            target_dir = props["directory"].strip()

    if case:
        return [target_dir, "-k", case] if target_dir else ["-k", case]
    if target_dir:
        return [target_dir]
    return []


def create_build_provider_server(*, cache_dir: Optional[str] = None) -> JsonRpcServer:
    server = JsonRpcServer(name="python-build-provider", version="0.1.2")
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
                payload = json.loads(out_json_path.read_text(encoding="utf-8"))
            except Exception as exc:
                raise PluginError(
                    "python.pytestCollectionFailed",
                    "pytest returned an unreadable test collection payload.",
                ) from exc

        raw_items = payload.get("items") if isinstance(payload, dict) else None
        if not isinstance(raw_items, list):
            raw_items = []

        valid_selectors: list[dict[str, Any]] = []
        for item in raw_items:
            if not isinstance(item, dict):
                continue
            suite = item.get("suite")
            case = item.get("case")
            if (
                not isinstance(suite, str)
                or not isinstance(case, str)
                or not suite.strip()
                or not case.strip()
                or len(suite) > 1024
                or len(case) > 1024
                or any(ord(c) < 32 or ord(c) == 127 for c in suite)
                or any(ord(c) < 32 or ord(c) == 127 for c in case)
            ):
                continue
            valid_selectors.append({
                "suite": suite,
                "case": case,
                "project": project_selection,
            })

        if len(valid_selectors) > _MAX_DISCOVERED_TESTS:
            dropped = len(valid_selectors) - _MAX_DISCOVERED_TESTS
            valid_selectors = valid_selectors[:_MAX_DISCOVERED_TESTS]
            ctx.diagnostics.degraded("lithe/build/discoverTests", "test_discovery_truncated", dropped)

        return {
            "format": "litheTestDiscovery",
            "version": 0,
            "tests": valid_selectors,
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
            if cand_dir.is_dir() and _safe_within(ws_root, cand_dir):
                run_cwd = cand_dir.resolve()

        junit_file = run_cwd / Path(*_JUNIT_REPORT_REL.split("/"))
        try:
            if junit_file.exists():
                junit_file.unlink()
            junit_file.parent.mkdir(parents=True, exist_ok=True)
        except OSError:
            pass

        suite = params.get("suite") if isinstance(params.get("suite"), str) else None
        case = params.get("case") if isinstance(params.get("case"), str) else None
        target = params.get("target") if isinstance(params.get("target"), dict) else None
        option_args = _string_args(params.get("optionArguments"))
        user_args = _string_args(params.get("userArguments"))

        selector_args = _resolve_pytest_selector_args(run_cwd, suite, case, target)
        argv = [
            python_exec,
            "-B",
            "-m",
            "pytest",
            f"--junitxml={_JUNIT_REPORT_REL}",
            *selector_args,
            *option_args,
            *user_args,
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
        clean_file = raw_file.replace("\\", "/").strip("/")
        if norm_root != ".":
            prefix = norm_root + "/"
            if not clean_file.startswith(prefix):
                return {"format": "litheRunEntrypoints", "version": 0, "entrypoints": []}
            rel_file = clean_file[len(prefix) :]
        else:
            rel_file = clean_file
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
