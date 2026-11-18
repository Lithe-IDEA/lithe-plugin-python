import os
import sys

# Never write bytecode into the installed read-only plugin package or user workspace.
sys.dont_write_bytecode = True
os.environ["PYTHONDONTWRITEBYTECODE"] = "1"

import argparse
from pathlib import Path
import threading
from typing import Any, Optional

# Ensure sibling scripts are importable under Python 3.11+ `-I` safe_path mode.
_SCRIPTS_DIR = str(Path(__file__).resolve().parent)
if _SCRIPTS_DIR not in sys.path:
    sys.path.insert(0, _SCRIPTS_DIR)

from lithe_rpc import CallContext, JsonRpcServer, PluginError  # noqa: E402
from toolchain_provider import query_python_toolchains  # noqa: E402

_VALID_TYPE_CHECKING_MODES = frozenset({"default", "auto", "basic", "strict", "all", "off"})
_VALID_DISPLAY_TYPE_ERRORS = frozenset({"force-on", "default", "error-missing-imports", "force-off"})
_VALID_DIAGNOSTIC_MODES = frozenset({"openFilesOnly", "workspace"})
_VALID_IMPORT_FORMATS = frozenset({"absolute", "relative"})


def _enum_setting(settings: dict[str, Any], key: str, allowed: frozenset[str], default: str) -> str:
    val = settings.get(key)
    return val if isinstance(val, str) and val in allowed else default


def _bool_setting(settings: dict[str, Any], key: str, default: bool) -> bool:
    val = settings.get(key)
    return val if isinstance(val, bool) else default


def create_backend_server(*, state_dir: Optional[str] = None) -> JsonRpcServer:
    server = JsonRpcServer(name="python-support-backend", version="0.1.2")
    degraded_workspaces: set[str] = set()
    degraded_lock = threading.Lock()

    def _workspace_key(params: dict[str, Any], ctx: CallContext) -> str:
        if isinstance(ctx.workspace_context, dict) and isinstance(ctx.workspace_context.get("contextID"), str):
            return ctx.workspace_context["contextID"]
        ws_state = params.get("workspaceStateDirectory")
        if isinstance(ws_state, str) and ws_state:
            return ws_state
        return state_dir or "default"

    def resolve_pyrefly_launch(params: dict[str, Any], ctx: CallContext) -> dict[str, Any]:
        server_id = params.get("serverID")
        if server_id != "python":
            raise PluginError("python.unknownServer", "Unsupported language server identifier.")

        platform_info = params.get("platform")
        if isinstance(platform_info, dict) and isinstance(platform_info.get("os"), str):
            os_name = platform_info["os"].strip().lower()
        else:
            os_name = "windows" if sys.platform == "win32" else ("macos" if sys.platform == "darwin" else "linux")

        packaged_path = "bin/pyrefly.exe" if os_name in ("windows", "win32") else "bin/pyrefly"

        raw_settings = params.get("settings")
        settings = raw_settings if isinstance(raw_settings, dict) else {}

        diagnostic_mode = _enum_setting(settings, "diagnosticMode", _VALID_DIAGNOSTIC_MODES, "openFilesOnly")
        python_cfg: dict[str, Any] = {
            "pyrefly": {
                "typeCheckingMode": _enum_setting(
                    settings,
                    "typeCheckingMode",
                    _VALID_TYPE_CHECKING_MODES,
                    "default",
                ),
                "displayTypeErrors": _enum_setting(
                    settings,
                    "displayTypeErrors",
                    _VALID_DISPLAY_TYPE_ERRORS,
                    "force-on",
                ),
                "diagnosticMode": diagnostic_mode,
            },
            "analysis": {
                "diagnosticMode": diagnostic_mode,
                "autoImportCompletions": _bool_setting(settings, "autoImportCompletions", True),
                "completeFunctionParens": _bool_setting(settings, "completeFunctionParens", False),
                "importFormat": _enum_setting(settings, "importFormat", _VALID_IMPORT_FORMATS, "absolute"),
            },
        }

        ws_key = _workspace_key(params, ctx)
        hint_degraded = False
        tools = params.get("tools")
        if tools is not None:
            if not isinstance(tools, dict):
                hint_degraded = True
            elif "python" in tools and tools["python"] is not None:
                py_tool = tools["python"]
                if not isinstance(py_tool, dict):
                    hint_degraded = True
                else:
                    raw_exec = py_tool.get("executable")
                    if raw_exec is None or raw_exec == "":
                        pass
                    elif (
                        isinstance(raw_exec, str)
                        and raw_exec.strip() == raw_exec
                        and not any(ord(ch) < 32 or ord(ch) == 127 for ch in raw_exec)
                        and len(raw_exec.encode("utf-8")) <= 4096
                    ):
                        python_cfg["pythonPath"] = raw_exec
                    else:
                        hint_degraded = True

        if hint_degraded:
            with degraded_lock:
                degraded_workspaces.add(ws_key)
            ctx.diagnostics.degraded("pyrefly.resolveLaunch", "invalid_tool_hint", 1)
        else:
            was_degraded = False
            with degraded_lock:
                if ws_key in degraded_workspaces:
                    degraded_workspaces.remove(ws_key)
                    was_degraded = True
            if was_degraded:
                ctx.diagnostics.recovered("pyrefly.resolveLaunch", "tool_hint_restored", 1)

        return {
            "executable": {
                "kind": "packaged",
                "path": packaged_path,
            },
            "arguments": ["lsp"],
            "workspaceConfiguration": {
                "python": python_cfg,
            },
        }

    def inspect_environment(params: dict[str, Any], ctx: CallContext) -> dict[str, Any]:
        ctx.raise_if_cancelled()
        raw_exec = params.get("executable")
        if raw_exec is not None:
            if (
                not isinstance(raw_exec, str)
                or not raw_exec.strip()
                or any(ord(ch) < 32 or ord(ch) == 127 for ch in raw_exec)
                or not Path(raw_exec).is_absolute()
            ):
                raise PluginError("python.invalidExecutable", "Executable must be an absolute path.")
            target = Path(raw_exec)
            home = target.parent.parent if target.parent.name.lower() in ("bin", "scripts") else target.parent
            return {
                "executable": str(target),
                "isVirtualEnv": (home / "pyvenv.cfg").is_file() or (home / "conda-meta").is_dir(),
            }
        return {
            "version": f"{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}",
            "isVirtualEnv": sys.prefix != getattr(sys, "base_prefix", sys.prefix),
        }

    server.function("pyrefly.resolveLaunch", resolve_pyrefly_launch)
    server.function("python.inspectEnvironment", inspect_environment)
    server.suppress_success_diagnostics("python.inspectEnvironment")
    server.toolchain_provider("python", query_python_toolchains)
    return server


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--state", dest="state_dir", default=None)
    known, _ = parser.parse_known_args(argv[1:])
    server = create_backend_server(state_dir=known.state_dir)
    return server.listen()


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
