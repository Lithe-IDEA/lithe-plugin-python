import os
import sys

# Never write bytecode into the installed read-only plugin package or user workspace.
sys.dont_write_bytecode = True
os.environ["PYTHONDONTWRITEBYTECODE"] = "1"

from pathlib import Path
import threading
from typing import Any, Optional
from urllib.parse import unquote, urlparse

# Ensure sibling scripts are importable under Python 3.11+ `-I` safe_path mode.
_SCRIPTS_DIR = str(Path(__file__).resolve().parent)
if _SCRIPTS_DIR not in sys.path:
    sys.path.insert(0, _SCRIPTS_DIR)

from build_model import (  # noqa: E402
    _safe_within,
    build_model_with_diagnostics,
    inspect_file_entrypoints,
    project_name_for_dir,
)
from lithe_rpc import (  # noqa: E402
    CallContext,
    JsonRpcServer,
    PluginError,
    run_bounded_process,
)

_JUNIT_REPORT_REL = ".pytest_cache/lithe-junit.xml"
_RUN_MODULE = (
    "import runpy, sys; sys.path.insert(0, sys.argv.pop(1)); "
    "runpy.run_module(sys.argv.pop(1), run_name='__main__', alter_sys=True)"
)

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


def create_build_provider_server() -> JsonRpcServer:
    server = JsonRpcServer(name="python-build-provider", version="0.2.0")
    workspace_root_holder: dict[str, Path] = {"root": Path.cwd().resolve()}
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
            "name": project_name_for_dir(instance_dir),
            "path": norm_root,
        }
        entrypoints = inspect_file_entrypoints(instance_dir, rel_file, project_selection)
        return {
            "format": "litheRunEntrypoints",
            "version": 0,
            "entrypoints": entrypoints,
        }

    def handle_prepare_run(params: dict[str, Any], ctx: CallContext) -> dict[str, Any]:
        ctx.raise_if_cancelled()
        norm_root, instance_dir = _resolve_instance(params)
        project = params.get("project")
        launch = params.get("launchOptions")
        if (params.get("run") != "main" or params.get("target") is not None
                or not isinstance(project, dict) or project.get("path") != norm_root
                or not isinstance(launch, dict)):
            raise PluginError("python.invalidRunEntrypoint", "Run this file from its Python project.")

        entrypoint = launch.get("entrypoint")
        if not isinstance(entrypoint, str):
            raise PluginError("python.invalidRunEntrypoint", "Select a Python file to run.")
        kind, _, relative_file = entrypoint.partition(":")
        if (kind not in ("script", "module") or relative_file.startswith("/")
                or any(char in relative_file for char in ("\\", ":", "\x00"))):
            raise PluginError("python.invalidRunEntrypoint", "Select a Python file inside the project.")

        # Saved configurations can outlive their source or its main guard.
        entries = inspect_file_entrypoints(instance_dir, relative_file, project)
        if not entries or entries[0]["entrypoint"] != entrypoint:
            raise PluginError("python.staleRunEntrypoint", "The saved Python entry point is unavailable. Open a runnable Python file and run it again.")

        working_directory = launch.get("workingDirectory") or norm_root
        if kind == "script":
            program = [str(instance_dir / relative_file)]
        elif relative_file.startswith("src/") or working_directory != norm_root:
            # Keep module imports rooted in the build instance even when using a custom cwd.
            module_root = instance_dir / "src" if relative_file.startswith("src/") else instance_dir
            program = ["-c", _RUN_MODULE, str(module_root), entries[0]["name"]]
        else:
            program = ["-m", entries[0]["name"]]

        environment = dict(params.get("environment") or {})
        environment.update(launch.get("environment") or {})
        return {
            "executable": {"kind": "toolchain", "value": "python"},
            "arguments": [
                *_string_args(launch.get("runtimeArguments")),
                *program,
                *_string_args(params.get("optionArguments")),
                *_string_args(launch.get("arguments", params.get("userArguments"))),
            ],
            "workingDirectory": working_directory,
            "environment": environment,
        }

    server.on_initialize(_on_init)
    server.build_handler("lithe/build/model", handle_model)
    server.build_handler("lithe/build/test", handle_test)
    server.build_handler("lithe/build/runEntrypoints", handle_run_entrypoints)
    server.build_handler("lithe/build/prepareRun", handle_prepare_run)
    server.suppress_success_diagnostics("lithe/build/runEntrypoints")
    return server


if __name__ == "__main__":
    raise SystemExit(create_build_provider_server().listen())
