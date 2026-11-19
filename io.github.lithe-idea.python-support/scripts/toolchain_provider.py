import os
import sys

# Never write bytecode into the installed read-only plugin package or user workspace.
sys.dont_write_bytecode = True
os.environ["PYTHONDONTWRITEBYTECODE"] = "1"

import base64
import glob
import hashlib
import json
from pathlib import Path
import re
from typing import Any, Optional

# Ensure sibling scripts are importable under Python 3.11+ `-I` safe_path mode.
_SCRIPTS_DIR = str(Path(__file__).resolve().parent)
if _SCRIPTS_DIR not in sys.path:
    sys.path.insert(0, _SCRIPTS_DIR)

from build_model import _load_tomllib  # noqa: E402
from lithe_rpc import CallContext, ToolchainQueryError, run_bounded_process  # noqa: E402

PROVIDER_ID = "python"
SUPPORTED_TOOLS = frozenset({"python", "io.github.lithe-idea.python-support:python"})

TOOLCHAIN_PROVIDER_DECLARATION = {
    "id": PROVIDER_ID,
    "displayName": "Python Environments (conda / uv / pyenv / Poetry / Pipenv)",
    "tools": ["python"],
    "watchFiles": [
        {"pattern": ".python-version", "reader": "compatible"},
        {"pattern": "pyproject.toml", "reader": "native"},
        {"pattern": "Pipfile", "reader": "native"},
        {"pattern": "poetry.lock", "reader": "native"},
    ],
}

_IDENTIFIER_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
_VERSION_EXTRACT_RE = re.compile(r"(\d+(?:\.\d+)+)")
_SPEC_CLAUSE_RE = re.compile(r"^(~=|==|!=|<=|>=|<|>|\^)\s*v?(\d+(?:\.\d+)*(?:\.\*)?)$")

_MAX_INSTALLATIONS = 512
_MAX_STATEMENTS = 256
_MAX_WATCH_PATHS = 256
_MAX_PROBES = 24
_MAX_DIR_ENTRIES = 1024


def _is_valid_id(value: Any) -> bool:
    return isinstance(value, str) and _IDENTIFIER_RE.match(value) is not None and not any(ord(c) < 32 or ord(c) == 127 for c in value)


def _is_valid_rel_dir(value: Any) -> bool:
    if not isinstance(value, str) or not value or len(value.encode("utf-8")) > 2048:
        return False
    if any(ord(c) < 32 or ord(c) == 127 for c in value):
        return False
    if value == ".":
        return True
    if "\\" in value or ":" in value:
        return False
    return all(part not in ("", ".", "..") for part in value.split("/"))


def _parse_version_tuple(ver: str) -> Optional[tuple[int, ...]]:
    m = re.match(r"^(\d+(?:\.\d+)*)", ver.strip())
    if not m:
        return None
    parts = [int(p) for p in m.group(1).split(".")]
    if len(parts) > 8:
        return None
    return tuple(parts)


def _normalize_version_tuple(parts: tuple[int, ...]) -> tuple[int, ...]:
    trimmed = list(parts)
    while len(trimmed) > 1 and trimmed[-1] == 0:
        trimmed.pop()
    return tuple(trimmed)


def _compare_versions(left: tuple[int, ...], right: tuple[int, ...]) -> int:
    nl = _normalize_version_tuple(left)
    nr = _normalize_version_tuple(right)
    if nl < nr:
        return -1
    if nl > nr:
        return 1
    return 0


def _matches_clause(candidate: tuple[int, ...], op: str, raw_target: str) -> bool:
    wildcard = raw_target.endswith(".*")
    base_str = raw_target[:-2] if wildcard else raw_target
    if not re.match(r"^\d+(?:\.\d+)*$", base_str):
        return False
    target = tuple(int(x) for x in base_str.split("."))

    if wildcard:
        prefix = candidate[: len(target)]
        padded = prefix + (0,) * max(0, len(target) - len(prefix))
        if op == "==":
            return padded == target
        if op == "!=":
            return padded != target
        return False

    cmp_val = _compare_versions(candidate, target)
    if op == "==":
        return cmp_val == 0
    if op == "!=":
        return cmp_val != 0
    if op == ">=":
        return cmp_val >= 0
    if op == "<=":
        return cmp_val <= 0
    if op == ">":
        return cmp_val > 0
    if op == "<":
        return cmp_val < 0
    if op == "~=":
        if cmp_val < 0:
            return False
        upper = list(target[:-1]) if len(target) > 1 else [target[0]]
        upper[-1] += 1
        return _compare_versions(candidate, tuple(upper)) < 0
    if op == "^":
        if cmp_val < 0:
            return False
        upper_list = list(target)
        bumped = False
        for idx, val in enumerate(upper_list):
            if val != 0:
                upper_list = upper_list[: idx + 1]
                upper_list[idx] = val + 1
                bumped = True
                break
        if not bumped:
            upper_list[-1] += 1
        return _compare_versions(candidate, tuple(upper_list)) < 0
    return False


def matches_python_requirement(version_str: str, requirement: str) -> bool:
    """Evaluates PEP 440 / Poetry / .python-version requirement expressions."""
    ver_tuple = _parse_version_tuple(version_str)
    if ver_tuple is None:
        return False
    req = requirement.strip()
    if not req or req == "*":
        return True

    # Plain dotted version or prefix from .python-version (e.g. "3.12", "3.12.4", "cpython-3.12.4-macos").
    cleaned = req
    if cleaned.startswith("cpython-"):
        cleaned = cleaned[len("cpython-") :]
        cleaned = cleaned.split("-", 1)[0]
    if re.match(r"^\d+(?:\.\d+)*$", cleaned):
        target = tuple(int(x) for x in cleaned.split("."))
        if len(target) <= 2:
            padded = ver_tuple[: len(target)] + (0,) * max(0, len(target) - len(ver_tuple))
            return padded == target
        return _compare_versions(ver_tuple, target) == 0

    clauses = [c.strip() for c in req.split(",") if c.strip()]
    if not clauses:
        return False
    for clause in clauses:
        m = _SPEC_CLAUSE_RE.match(clause)
        if not m:
            return False
        if not _matches_clause(ver_tuple, m.group(1), m.group(2)):
            return False
    return True


def _within_dir(path: Path, root: Path, case_sensitive: bool) -> bool:
    p_str = str(path)
    r_str = str(root)
    if not case_sensitive:
        p_str = p_str.lower()
        r_str = r_str.lower()
    r_norm = r_str.rstrip("/\\")
    p_norm = p_str.rstrip("/\\")
    if p_norm == r_norm:
        return True
    sep = "\\" if "\\" in r_norm else "/"
    return p_norm.startswith(r_norm + sep)


def _executable_layouts_for_platform(platform_name: str) -> list[str]:
    if platform_name == "windows":
        return ["Scripts/python.exe", "python.exe"]
    return ["bin/python3", "bin/python"]


def _read_metadata_version(home_dir: Path) -> Optional[str]:
    """Reads Python version from pyvenv.cfg or conda-meta/python-*.json without spawning a process."""
    pyvenv_cfg = home_dir / "pyvenv.cfg"
    if pyvenv_cfg.is_file():
        try:
            for raw_line in pyvenv_cfg.read_text(encoding="utf-8", errors="ignore").splitlines():
                if "=" not in raw_line:
                    continue
                k, v = (part.strip() for part in raw_line.split("=", 1))
                if k in ("version_info", "version"):
                    m = _VERSION_EXTRACT_RE.search(v)
                    if m:
                        parts = m.group(1).split(".")[:3]
                        return ".".join(parts)
        except OSError:
            pass

    conda_meta = home_dir / "conda-meta"
    if conda_meta.is_dir():
        try:
            for entry in sorted(conda_meta.iterdir()):
                if entry.name.startswith("python-") and entry.name.endswith(".json") and entry.is_file():
                    data = json.loads(entry.read_text(encoding="utf-8", errors="ignore"))
                    if isinstance(data, dict) and data.get("name") == "python" and isinstance(data.get("version"), str):
                        m = _VERSION_EXTRACT_RE.match(data["version"].strip())
                        if m:
                            return m.group(1)
        except Exception:
            pass

    # uv python directory naming fallback: cpython-3.12.6-macos-aarch64-none
    m_uv = re.match(r"^(?:cpython|pypy)-(\d+\.\d+(?:\.\d+)?)\b", home_dir.name)
    if m_uv:
        return m_uv.group(1)

    # pyenv versions directory naming fallback: 3.12.4
    if re.match(r"^\d+\.\d+\.\d+$", home_dir.name):
        return home_dir.name

    return None


def _list_subdirs_bounded(parent: Path, pattern: str = "*") -> list[Path]:
    if not parent.is_dir():
        return []
    found: list[Path] = []
    try:
        count = 0
        for entry in sorted(parent.iterdir(), key=lambda p: p.name):
            if count >= _MAX_DIR_ENTRIES:
                break
            count += 1
            if entry.name.startswith(".") and not pattern.startswith("."):
                continue
            if glob.fnmatch.fnmatch(entry.name, pattern) and entry.is_dir():
                found.append(entry)
    except OSError:
        pass
    return found


def _pipenv_virtualenv_prefix(project_dir: Path) -> str:
    clean_name = re.sub(r'[ $`!*@"\\\r\n\t]', "_", project_dir.name)[:42]
    digest = hashlib.sha256(str(project_dir).encode("utf-8")).digest()[:6]
    encoded = base64.urlsafe_b64encode(digest).decode("ascii").rstrip("=")[:8]
    return f"{clean_name}-{encoded}"


def _poetry_virtualenv_prefix(project_dir: Path, project_name: Optional[str]) -> str:
    raw_name = project_name or project_dir.name
    sanitized = re.sub(r'[ $`!*@"\\\r\n\t]', "_", raw_name).lower()
    norm_path = os.path.normcase(str(project_dir.resolve()))
    digest = hashlib.sha256(norm_path.encode("utf-8")).hexdigest()[:8]
    return f"{sanitized}-{digest}-py"


def query_python_toolchains(
    params: dict[str, Any],
    ctx: CallContext,
    *,
    home_dir: Optional[Path] = None,
    environ: Optional[dict[str, str]] = None,
    platform_name: Optional[str] = None,
    extra_workspace_roots: Optional[list[Path]] = None,
) -> dict[str, Any]:
    """
    Executes `toolchains/query` for Python installations and project requirements,
    returning `{operationID, generation, providerID, installations, statements, watch}`
    strictly conforming to shared/plugins/contract/v1/toolchains/README.md.
    """
    op_id = params.get("operationID") if isinstance(params.get("operationID"), str) else ""
    provider_id = params.get("providerID") if isinstance(params.get("providerID"), str) else PROVIDER_ID
    generation = params.get("generation")

    if (
        not _is_valid_id(op_id)
        or isinstance(generation, bool)
        or not isinstance(generation, int)
        or generation <= 0
        or provider_id != PROVIDER_ID
        or "workspace" not in params
        or "context" not in params
    ):
        raise ToolchainQueryError(
            "plugin.toolchain.invalidParams",
            "Invalid query identities or missing workspace/context envelope.",
            op_id,
            provider_id,
        )

    authority = params.get("authority")
    if not isinstance(authority, dict) or not isinstance(authority.get("kind"), str):
        raise ToolchainQueryError(
            "plugin.toolchain.invalidParams",
            "Malformed query authority.",
            op_id,
            provider_id,
        )
    if authority["kind"] == "remote":
        raise ToolchainQueryError(
            "plugin.toolchain.authorityUnsupported",
            "Remote toolchain authority is not supported.",
            op_id,
            provider_id,
        )
    if authority["kind"] != "local" or set(authority.keys()) != {"kind"}:
        raise ToolchainQueryError(
            "plugin.toolchain.invalidParams",
            "Unsupported local authority shape.",
            op_id,
            provider_id,
        )

    tools = params.get("tools")
    if (
        not isinstance(tools, list)
        or not (1 <= len(tools) <= 64)
        or any(not isinstance(t, str) or t not in SUPPORTED_TOOLS for t in tools)
        or len(set(tools)) != len(tools)
        or tools != sorted(tools)
    ):
        raise ToolchainQueryError(
            "plugin.toolchain.invalidParams",
            "Invalid or undeclared tools in toolchain query.",
            op_id,
            provider_id,
        )
    target_tool = tools[0]

    ws_param = params.get("workspace")
    ctx_param = params.get("context")
    workspace_root: Optional[Path] = None
    queried_dir: Optional[Path] = None

    if ws_param is not None:
        if (
            not isinstance(ctx_param, dict)
            or not _is_valid_id(ctx_param.get("contextID"))
            or isinstance(ctx_param.get("generation"), bool)
            or not isinstance(ctx_param.get("generation"), int)
            or ctx_param["generation"] <= 0
        ):
            raise ToolchainQueryError(
                "plugin.toolchain.invalidParams",
                "Workspace toolchain queries require a valid context reference.",
                op_id,
                provider_id,
            )
        if (
            not isinstance(ws_param, dict)
            or not _is_valid_id(ws_param.get("rootID"))
            or not isinstance(ws_param.get("root"), str)
            or not _is_valid_rel_dir(ws_param.get("directory"))
        ):
            raise ToolchainQueryError(
                "plugin.toolchain.invalidParams",
                "Invalid workspace query parameters.",
                op_id,
                provider_id,
            )
        raw_ws_root = Path(ws_param["root"])
        if not raw_ws_root.is_absolute() or not raw_ws_root.is_dir():
            raise ToolchainQueryError(
                "plugin.toolchain.unsafePath",
                "Workspace root must be an existing absolute directory.",
                op_id,
                provider_id,
            )
        workspace_root = raw_ws_root.resolve()
        rel_dir = ws_param["directory"]
        target_dir = workspace_root if rel_dir == "." else (workspace_root / Path(*rel_dir.split("/")))
        if not target_dir.is_dir():
            raise ToolchainQueryError(
                "plugin.toolchain.unsafePath",
                "Queried workspace directory does not exist.",
                op_id,
                provider_id,
            )
        queried_dir = target_dir.resolve()

    eff_platform = platform_name or (
        "windows" if sys.platform == "win32" else ("macos" if sys.platform == "darwin" else "linux")
    )
    case_sensitive = eff_platform != "windows"
    if workspace_root is not None and queried_dir is not None:
        if not _within_dir(queried_dir, workspace_root, case_sensitive):
            raise ToolchainQueryError(
                "plugin.toolchain.unsafePath",
                "Queried directory escapes workspace root.",
                op_id,
                provider_id,
            )

    eff_env = environ if environ is not None else dict(os.environ)
    eff_home = (home_dir if home_dir is not None else Path.home()).resolve()
    forbidden_roots: list[Path] = []
    if workspace_root is not None:
        forbidden_roots.append(workspace_root)
    for extra in extra_workspace_roots or []:
        try:
            forbidden_roots.append(extra.resolve())
        except OSError:
            pass

    watch_paths: set[str] = set()
    candidate_homes: list[Path] = []

    # 1. ~/.conda/environments.txt
    conda_envs_txt = eff_home / ".conda" / "environments.txt"
    watch_paths.add(str(conda_envs_txt))
    if conda_envs_txt.is_file():
        try:
            for line in conda_envs_txt.read_text(encoding="utf-8", errors="ignore").splitlines():
                stripped = line.strip()
                if not stripped or stripped.startswith("#"):
                    continue
                p = Path(stripped)
                if p.is_absolute() and p.is_dir():
                    candidate_homes.append(p)
        except OSError:
            pass

    # 2. CONDA_ENVS_PATH (supports os.pathsep-separated directories) & CONDA_PREFIX & standard conda dirs
    raw_conda_envs = eff_env.get("CONDA_ENVS_PATH", "").strip()
    if raw_conda_envs:
        for chunk in raw_conda_envs.split(os.pathsep):
            chunk = chunk.strip()
            if chunk and Path(chunk).is_absolute():
                candidate_homes.extend(_list_subdirs_bounded(Path(chunk)))
    raw_conda_prefix = eff_env.get("CONDA_PREFIX", "").strip()
    if raw_conda_prefix and Path(raw_conda_prefix).is_absolute():
        cp = Path(raw_conda_prefix)
        if cp.is_dir():
            candidate_homes.append(cp)
            candidate_homes.extend(_list_subdirs_bounded(cp / "envs"))
    for pattern in ("*conda*", "miniforge*"):
        for base in _list_subdirs_bounded(eff_home, pattern):
            candidate_homes.append(base)
            candidate_homes.extend(_list_subdirs_bounded(base / "envs"))

    # 3. UV_PYTHON_INSTALL_DIR / XDG_DATA_HOME / default uv python dirs
    uv_dir_env = eff_env.get("UV_PYTHON_INSTALL_DIR", "").strip()
    if uv_dir_env and Path(uv_dir_env).is_absolute():
        uv_root = Path(uv_dir_env)
        watch_paths.add(str(uv_root))
        candidate_homes.extend(_list_subdirs_bounded(uv_root))
    xdg_data = eff_env.get("XDG_DATA_HOME", "").strip()
    if xdg_data and Path(xdg_data).is_absolute():
        candidate_homes.extend(_list_subdirs_bounded(Path(xdg_data) / "uv" / "python"))
    candidate_homes.extend(_list_subdirs_bounded(eff_home / ".local" / "share" / "uv" / "python"))
    appdata = eff_env.get("APPDATA", "").strip()
    if appdata and Path(appdata).is_absolute():
        candidate_homes.extend(_list_subdirs_bounded(Path(appdata) / "uv" / "data" / "python"))

    # 4. PYENV_ROOT / ~/.pyenv
    pyenv_root = eff_env.get("PYENV_ROOT", "").strip()
    if pyenv_root and Path(pyenv_root).is_absolute():
        pr = Path(pyenv_root) / "versions"
        watch_paths.add(str(pr))
        candidate_homes.extend(_list_subdirs_bounded(pr))
    candidate_homes.extend(_list_subdirs_bounded(eff_home / ".pyenv" / "versions"))
    candidate_homes.extend(_list_subdirs_bounded(eff_home / ".pyenv" / "pyenv-win" / "versions"))

    # 5. Poetry & Pipenv / WORKON_HOME external virtualenvs
    poetry_roots: list[Path] = []
    poetry_cache = eff_env.get("POETRY_CACHE_DIR", "").strip()
    if poetry_cache and Path(poetry_cache).is_absolute():
        poetry_roots.append(Path(poetry_cache) / "virtualenvs")
    if eff_platform == "macos":
        poetry_roots.append(eff_home / "Library" / "Caches" / "pypoetry" / "virtualenvs")
    elif eff_platform == "windows":
        local_app = eff_env.get("LOCALAPPDATA", "").strip()
        if local_app and Path(local_app).is_absolute():
            poetry_roots.append(Path(local_app) / "pypoetry" / "Cache" / "virtualenvs")
    else:
        xdg_cache = eff_env.get("XDG_CACHE_HOME", "").strip()
        if xdg_cache and Path(xdg_cache).is_absolute():
            poetry_roots.append(Path(xdg_cache) / "pypoetry" / "virtualenvs")
        poetry_roots.append(eff_home / ".cache" / "pypoetry" / "virtualenvs")
    for p_root in poetry_roots:
        candidate_homes.extend(_list_subdirs_bounded(p_root))

    workon = eff_env.get("WORKON_HOME", "").strip()
    if workon and Path(workon).is_absolute():
        candidate_homes.extend(_list_subdirs_bounded(Path(workon)))
    candidate_homes.extend(_list_subdirs_bounded(eff_home / ".local" / "share" / "virtualenvs"))
    candidate_homes.extend(_list_subdirs_bounded(eff_home / ".virtualenvs"))

    layouts = _executable_layouts_for_platform(eff_platform)
    installations_by_key: dict[str, dict[str, str]] = {}
    probes_used = 0

    for raw_home in candidate_homes:
        ctx.raise_if_cancelled()
        if len(installations_by_key) >= _MAX_INSTALLATIONS:
            break
        try:
            canon_home = raw_home.resolve()
        except OSError:
            continue
        if not canon_home.is_dir():
            continue
        if any(_within_dir(canon_home, root, case_sensitive) for root in forbidden_roots):
            continue

        home_key = str(canon_home) if case_sensitive else str(canon_home).lower()
        if home_key in installations_by_key:
            continue

        matched_exec: Optional[Path] = None
        for rel_layout in layouts:
            candidate_exec = canon_home / Path(*rel_layout.split("/"))
            if not candidate_exec.exists():
                continue
            try:
                canon_exec = candidate_exec.resolve()
            except OSError:
                continue
            if not canon_exec.is_file():
                continue
            if eff_platform != "windows" and not os.access(canon_exec, os.X_OK):
                continue
            # Core query.rs requires a provider installation's resolved executable to stay inside
            # canonical_home and outside workspace roots.
            if not _within_dir(canon_exec, canon_home, case_sensitive):
                continue
            if any(_within_dir(canon_exec, root, case_sensitive) for root in forbidden_roots):
                continue
            matched_exec = canon_exec
            break

        if matched_exec is None:
            continue

        version_str = _read_metadata_version(canon_home)
        if version_str is None and probes_used < _MAX_PROBES:
            probes_used += 1
            probe_env = dict(eff_env)
            probe_env["PYTHONDONTWRITEBYTECODE"] = "1"
            try:
                code, out, timed_out = run_bounded_process(
                    [str(matched_exec), "--version"],
                    cwd=str(canon_home),
                    env=probe_env,
                    cancel_token=ctx.cancel_token,
                    timeout_seconds=3.0,
                    max_output_bytes=4096,
                )
                if not timed_out and code == 0:
                    m = re.search(r"Python\s+(\d+(?:\.\d+)*)", out)
                    if m:
                        version_str = m.group(1)
            except OSError:
                version_str = None

        if not version_str or _parse_version_tuple(version_str) is None:
            continue

        installations_by_key[home_key] = {
            "tool": target_tool,
            "version": version_str,
            "home": str(canon_home),
        }

    # Sort installations deterministically: highest version first, then home path.
    sorted_installations = sorted(
        installations_by_key.values(),
        key=lambda item: (
            tuple(-part for part in (_parse_version_tuple(item["version"]) or (0,))),
            item["home"],
        ),
    )

    def _pick_best_installation(req_spec: str, allow_env_name: bool = False) -> Optional[str]:
        cleaned = req_spec.strip()
        if not cleaned:
            return None
        if allow_env_name:
            for inst in sorted_installations:
                if Path(inst["home"]).name == cleaned:
                    return inst["home"]
        best_home: Optional[str] = None
        best_ver: Optional[tuple[int, ...]] = None
        for inst in sorted_installations:
            if matches_python_requirement(inst["version"], cleaned):
                vt = _parse_version_tuple(inst["version"])
                if vt is not None and (best_ver is None or _compare_versions(vt, best_ver) > 0):
                    best_ver = vt
                    best_home = inst["home"]
        return best_home

    statements: list[dict[str, Any]] = []
    if workspace_root is not None and queried_dir is not None:
        ancestors: list[Path] = []
        cur = queried_dir
        for _ in range(64):
            ancestors.append(cur)
            if cur == workspace_root or cur.parent == cur:
                break
            cur = cur.parent

        tomllib = _load_tomllib()
        for anc in ancestors:
            if len(statements) >= _MAX_STATEMENTS:
                break

            py_ver_file = anc / ".python-version"
            watch_paths.add(str(py_ver_file))
            if py_ver_file.is_file():
                try:
                    lines = [
                        ln.strip()
                        for ln in py_ver_file.read_text(encoding="utf-8", errors="ignore").splitlines()
                        if ln.strip() and not ln.strip().startswith("#")
                    ]
                    if lines:
                        req_line = lines[0][:512]
                        statements.append({
                            "tool": target_tool,
                            "scope": "project",
                            "source": str(py_ver_file.resolve()),
                            "request": req_line,
                            "installation": _pick_best_installation(req_line, allow_env_name=True),
                            "kind": "declaration",
                            "reader": "compatible",
                        })
                except OSError:
                    pass

            pyproject_file = anc / "pyproject.toml"
            watch_paths.add(str(pyproject_file))
            project_name_hint: Optional[str] = None
            if pyproject_file.is_file():
                try:
                    data = tomllib.loads(pyproject_file.read_text(encoding="utf-8"))
                    if isinstance(data, dict):
                        proj_tbl = data.get("project")
                        req_py: Optional[str] = None
                        if isinstance(proj_tbl, dict):
                            if isinstance(proj_tbl.get("name"), str) and proj_tbl["name"].strip():
                                project_name_hint = proj_tbl["name"].strip()
                            if isinstance(proj_tbl.get("requires-python"), str) and proj_tbl["requires-python"].strip():
                                req_py = proj_tbl["requires-python"].strip()
                        poetry_tbl = (data.get("tool") or {}).get("poetry") if isinstance(data.get("tool"), dict) else None
                        if isinstance(poetry_tbl, dict):
                            if not project_name_hint and isinstance(poetry_tbl.get("name"), str):
                                project_name_hint = poetry_tbl["name"].strip() or None
                            deps = poetry_tbl.get("dependencies")
                            if not req_py and isinstance(deps, dict) and isinstance(deps.get("python"), str):
                                req_py = deps["python"].strip() or None
                        if req_py:
                            statements.append({
                                "tool": target_tool,
                                "scope": "project",
                                "source": str(pyproject_file.resolve()),
                                "request": req_py[:512],
                                "installation": _pick_best_installation(req_py, allow_env_name=False),
                                "kind": "declaration",
                                "reader": "native",
                            })
                except Exception:
                    pass

            poetry_lock = anc / "poetry.lock"
            if poetry_lock.is_file():
                watch_paths.add(str(poetry_lock))
                prefix = _poetry_virtualenv_prefix(anc, project_name_hint)
                matched_poetry = next(
                    (inst["home"] for inst in sorted_installations if Path(inst["home"]).name.lower().startswith(prefix)),
                    None,
                )
                if matched_poetry is not None:
                    statements.append({
                        "tool": target_tool,
                        "scope": "project",
                        "source": str(poetry_lock.resolve()),
                        "request": Path(matched_poetry).name[:512],
                        "installation": matched_poetry,
                        "kind": "environment",
                        "reader": "native",
                    })

            pipfile = anc / "Pipfile"
            if pipfile.is_file():
                watch_paths.add(str(pipfile))
                pipenv_prefix = _pipenv_virtualenv_prefix(anc)
                matched_pipenv = next(
                    (inst["home"] for inst in sorted_installations if Path(inst["home"]).name == pipenv_prefix),
                    None,
                )
                if matched_pipenv is not None:
                    statements.append({
                        "tool": target_tool,
                        "scope": "project",
                        "source": str(pipfile.resolve()),
                        "request": pipenv_prefix[:512],
                        "installation": matched_pipenv,
                        "kind": "environment",
                        "reader": "native",
                    })

    bounded_watch = sorted(watch_paths)[:_MAX_WATCH_PATHS]
    return {
        "operationID": op_id,
        "generation": generation,
        "providerID": provider_id,
        "installations": sorted_installations[:_MAX_INSTALLATIONS],
        "statements": statements[:_MAX_STATEMENTS],
        "watch": bounded_watch,
    }
