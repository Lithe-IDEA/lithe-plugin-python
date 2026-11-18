import ast
import configparser
import json
import os
from pathlib import Path
import re
import sys

# Never write bytecode into the installed read-only plugin directory or the user workspace.
sys.dont_write_bytecode = True


def _load_tomllib():
    try:
        import tomllib  # type: ignore[import-not-found]
        return tomllib
    except ModuleNotFoundError:
        vendor_dir = str(Path(__file__).resolve().parent.parent / "vendor")
        inserted = False
        if vendor_dir not in sys.path:
            sys.path.insert(0, vendor_dir)
            inserted = True
        try:
            import tomli as tomllib  # type: ignore[import-not-found]
            return tomllib
        finally:
            if inserted and sys.path and sys.path[0] == vendor_dir:
                sys.path.pop(0)


_IGNORED_DIRS = frozenset({
    ".git",
    ".hg",
    ".svn",
    ".venv",
    "venv",
    "env",
    ".env",
    "__pycache__",
    ".mypy_cache",
    ".pytest_cache",
    ".ruff_cache",
    ".pytype",
    ".tox",
    ".nox",
    "node_modules",
    "build",
    "dist",
    "site-packages",
})

_IDENTIFIER_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
_MAX_SCANNED_FILES = 500
_MAX_SCAN_DEPTH = 4
_MAX_FILE_BYTES = 1024 * 1024


def _is_dotted_identifier(value: str) -> bool:
    parts = value.split(".")
    return bool(parts) and all(_IDENTIFIER_RE.match(part) is not None for part in parts)


def _resolve_instance_root(raw_root: str) -> Path:
    candidate = Path(raw_root)
    if candidate.is_absolute():
        return candidate
    cwd = Path.cwd()
    if raw_root in ("", "."):
        return cwd
    direct = cwd / candidate
    if direct.is_dir():
        return direct
    # Host modelPlan sets workingDirectory to the workspace-relative ${root} while also
    # expanding ${root} in argv, so nested instances arrive with cwd already at ${root}.
    norm_cwd = cwd.as_posix().rstrip("/")
    norm_arg = candidate.as_posix().strip("/")
    if norm_arg and (norm_cwd == norm_arg or norm_cwd.endswith("/" + norm_arg)):
        return cwd
    return direct


def _safe_within(root_real: Path, path: Path) -> bool:
    try:
        resolved = path.resolve()
    except OSError:
        return False
    return resolved == root_real or root_real in resolved.parents


def _should_skip_dir(name: str) -> bool:
    if name in _IGNORED_DIRS:
        return True
    if name.startswith(".") and name not in (".",):
        return True
    if name.endswith(".egg-info") or name.endswith(".dist-info"):
        return True
    return False


def _is_test_file(rel_posix: str, filename: str) -> bool:
    parts = rel_posix.split("/")
    if any(part in ("tests", "test") for part in parts[:-1]):
        return True
    if filename == "conftest.py":
        return True
    return filename.startswith("test_") or filename.endswith("_test.py")


def _read_ast(path: Path):
    try:
        if path.stat().st_size > _MAX_FILE_BYTES:
            return None
        source = path.read_bytes()
    except OSError:
        return None
    try:
        return ast.parse(source, filename=str(path))
    except (SyntaxError, ValueError):
        return None


def _parse_entry_point_spec(spec: str):
    """Parses 'pkg.mod:attr.sub' into (module, callable_chain) after strict identifier checks."""
    text = spec.strip()
    if "[" in text:
        text = text.split("[", 1)[0].strip()
    if ":" not in text:
        return None
    module, attr = (part.strip() for part in text.split(":", 1))
    if not _is_dotted_identifier(module) or not _is_dotted_identifier(attr):
        return None
    return module, attr


def _make_entrypoint_runner(module: str, attr: str, has_src_dir: bool) -> str:
    root_attr = attr.split(".", 1)[0]
    path_setup = "sys.path[:0] = ['src', '.']" if has_src_dir else "sys.path.insert(0, '.')"
    return f"import sys; {path_setup}; from {module} import {root_attr}; raise SystemExit({attr}())"


def _parse_pyproject(pyproject_path: Path):
    meta = {
        "name": None,
        "version": None,
        "requires_python": None,
        "scripts": {},
    }
    if not pyproject_path.is_file():
        return meta
    tomllib = _load_tomllib()
    try:
        data = tomllib.loads(pyproject_path.read_text(encoding="utf-8"))
    except Exception:
        return meta
    if not isinstance(data, dict):
        return meta

    project = data.get("project")
    if isinstance(project, dict):
        if isinstance(project.get("name"), str) and project["name"].strip():
            meta["name"] = project["name"].strip()
        if isinstance(project.get("version"), str) and project["version"].strip():
            meta["version"] = project["version"].strip()
        if isinstance(project.get("requires-python"), str) and project["requires-python"].strip():
            meta["requires_python"] = project["requires-python"].strip()
        for key in ("scripts", "gui-scripts"):
            table = project.get(key)
            if isinstance(table, dict):
                for script_name, spec in table.items():
                    if isinstance(script_name, str) and isinstance(spec, str):
                        meta["scripts"][script_name.strip()] = spec.strip()

    tool = data.get("tool")
    if isinstance(tool, dict):
        poetry = tool.get("poetry")
        if isinstance(poetry, dict):
            if not meta["name"] and isinstance(poetry.get("name"), str) and poetry["name"].strip():
                meta["name"] = poetry["name"].strip()
            if not meta["version"] and isinstance(poetry.get("version"), str) and poetry["version"].strip():
                meta["version"] = poetry["version"].strip()
            scripts = poetry.get("scripts")
            if isinstance(scripts, dict):
                for script_name, value in scripts.items():
                    if not isinstance(script_name, str):
                        continue
                    if isinstance(value, str):
                        meta["scripts"].setdefault(script_name.strip(), value.strip())
                    elif isinstance(value, dict) and isinstance(value.get("callable"), str):
                        meta["scripts"].setdefault(script_name.strip(), value["callable"].strip())
    return meta


def _parse_setup_cfg(setup_cfg_path: Path):
    meta = {"name": None, "version": None, "scripts": {}}
    if not setup_cfg_path.is_file():
        return meta
    parser = configparser.ConfigParser(interpolation=None)
    try:
        parser.read_string(setup_cfg_path.read_text(encoding="utf-8"))
    except Exception:
        return meta
    if parser.has_section("metadata"):
        name = parser.get("metadata", "name", fallback="").strip()
        version = parser.get("metadata", "version", fallback="").strip()
        if name and not name.startswith(("attr:", "file:")):
            meta["name"] = name
        if version and not version.startswith(("attr:", "file:")):
            meta["version"] = version
    if parser.has_section("options.entry_points"):
        for group in ("console_scripts", "gui_scripts"):
            raw = parser.get("options.entry_points", group, fallback="")
            for line in raw.splitlines():
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                script_name, spec = (part.strip() for part in line.split("=", 1))
                if script_name and spec:
                    meta["scripts"][script_name] = spec
    return meta


def _literal_str(node):
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return node.value.strip()
    return None


def _parse_setup_py(setup_py_path: Path):
    """Extracts static string literals from setup(...) in setup.py without executing code."""
    meta = {"name": None, "version": None, "scripts": {}}
    if not setup_py_path.is_file():
        return meta
    tree = _read_ast(setup_py_path)
    if tree is None:
        return meta
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        func_name = None
        if isinstance(node.func, ast.Name):
            func_name = node.func.id
        elif isinstance(node.func, ast.Attribute):
            func_name = node.func.attr
        if func_name != "setup":
            continue
        for kw in node.keywords:
            if kw.arg == "name" and not meta["name"]:
                val = _literal_str(kw.value)
                if val:
                    meta["name"] = val
            elif kw.arg == "version" and not meta["version"]:
                val = _literal_str(kw.value)
                if val:
                    meta["version"] = val
            elif kw.arg == "entry_points" and isinstance(kw.value, ast.Dict):
                for key_node, val_node in zip(kw.value.keys, kw.value.values):
                    key_str = _literal_str(key_node) if key_node is not None else None
                    if key_str not in ("console_scripts", "gui_scripts"):
                        continue
                    if isinstance(val_node, (ast.List, ast.Tuple)):
                        for item in val_node.elts:
                            entry = _literal_str(item)
                            if entry and "=" in entry:
                                s_name, s_spec = (p.strip() for p in entry.split("=", 1))
                                if s_name and s_spec:
                                    meta["scripts"][s_name] = s_spec
    return meta


def _is_name_eq_main(test_node: ast.AST) -> bool:
    if not isinstance(test_node, ast.Compare) or len(test_node.ops) != 1 or len(test_node.comparators) != 1:
        return False
    if not isinstance(test_node.ops[0], ast.Eq):
        return False
    left, right = test_node.left, test_node.comparators[0]
    if (
        isinstance(left, ast.Name)
        and left.id == "__name__"
        and isinstance(right, ast.Constant)
        and right.value == "__main__"
    ):
        return True
    if (
        isinstance(right, ast.Name)
        and right.id == "__name__"
        and isinstance(left, ast.Constant)
        and left.value == "__main__"
    ):
        return True
    return False


def _analyze_python_file(tree: ast.Module):
    """Returns static facts about a Python module without importing or executing anything."""
    has_main_guard = False
    is_django_manage = False
    fastapi_names = set()
    fastapi_modules = set()
    flask_names = set()
    flask_modules = set()

    for node in tree.body:
        if isinstance(node, ast.If) and _is_name_eq_main(node.test):
            has_main_guard = True

    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                bound = alias.asname or alias.name.split(".", 1)[0]
                if alias.name == "django" or alias.name.startswith("django."):
                    is_django_manage = True
                if alias.name == "fastapi":
                    fastapi_modules.add(bound)
                elif alias.name == "flask":
                    flask_modules.add(bound)
        elif isinstance(node, ast.ImportFrom):
            mod = node.module or ""
            if mod == "django" or mod.startswith("django."):
                is_django_manage = True
            if mod == "fastapi" or mod.startswith("fastapi."):
                for alias in node.names:
                    if alias.name == "FastAPI":
                        fastapi_names.add(alias.asname or alias.name)
            elif mod == "flask" or mod.startswith("flask."):
                for alias in node.names:
                    if alias.name == "Flask":
                        flask_names.add(alias.asname or alias.name)
        elif isinstance(node, ast.Constant) and node.value == "DJANGO_SETTINGS_MODULE":
            is_django_manage = True

    def _call_framework(expr: ast.AST):
        if not isinstance(expr, ast.Call):
            return None
        func = expr.func
        if isinstance(func, ast.Name):
            if func.id in fastapi_names:
                return "fastapi"
            if func.id in flask_names:
                return "flask"
        elif isinstance(func, ast.Attribute) and isinstance(func.value, ast.Name):
            if func.attr == "FastAPI" and func.value.id in fastapi_modules:
                return "fastapi"
            if func.attr == "Flask" and func.value.id in flask_modules:
                return "flask"
        return None

    asgi_vars = []
    wsgi_vars = []

    for stmt in tree.body:
        targets = []
        value = None
        if isinstance(stmt, ast.Assign):
            targets = stmt.targets
            value = stmt.value
        elif isinstance(stmt, ast.AnnAssign) and stmt.value is not None:
            targets = [stmt.target]
            value = stmt.value
        if value is not None:
            kind = _call_framework(value)
            if kind is not None:
                for target in targets:
                    if isinstance(target, ast.Name) and _IDENTIFIER_RE.match(target.id):
                        if kind == "fastapi":
                            asgi_vars.append((target.id, False))
                        else:
                            wsgi_vars.append((target.id, False))
        elif isinstance(stmt, (ast.FunctionDef, ast.AsyncFunctionDef)) and stmt.name == "create_app":
            for child in ast.walk(stmt):
                if isinstance(child, ast.Return) and child.value is not None:
                    kind = _call_framework(child.value)
                    if kind == "fastapi":
                        asgi_vars.append(("create_app", True))
                        break
                    if kind == "flask":
                        wsgi_vars.append(("create_app", True))
                        break

    return {
        "has_main_guard": has_main_guard,
        "is_django_manage": is_django_manage,
        "asgi_vars": asgi_vars,
        "wsgi_vars": wsgi_vars,
    }


def _module_name_for_file(rel_posix: str, has_src_dir: bool):
    parts = rel_posix.split("/")
    app_dir = "."
    if has_src_dir and parts[0] == "src" and len(parts) > 1:
        parts = parts[1:]
        app_dir = "src"
    if parts[-1] == "__init__.py":
        parts = parts[:-1]
    elif parts[-1].endswith(".py"):
        parts[-1] = parts[-1][:-3]
    else:
        return None, app_dir
    if not parts or any(_IDENTIFIER_RE.match(p) is None for p in parts):
        return None, app_dir
    return ".".join(parts), app_dir


def build_model(root_dir: Path) -> dict:
    root_real = root_dir.resolve()
    py_meta = _parse_pyproject(root_dir / "pyproject.toml")
    cfg_meta = _parse_setup_cfg(root_dir / "setup.cfg")
    setup_meta = _parse_setup_py(root_dir / "setup.py")

    project_name = py_meta["name"] or cfg_meta["name"] or setup_meta["name"] or root_real.name or "python-project"
    project_version = py_meta["version"] or cfg_meta["version"] or setup_meta["version"]
    requires_python = py_meta["requires_python"]

    merged_scripts = {}
    for source_scripts in (setup_meta["scripts"], cfg_meta["scripts"], py_meta["scripts"]):
        merged_scripts.update(source_scripts)

    project_props = {}
    if project_version:
        project_props["version"] = project_version
    if requires_python:
        project_props["requiresPython"] = requires_python

    has_src_dir = (root_dir / "src").is_dir() and _safe_within(root_real, root_dir / "src")

    targets = []
    content_roots = []
    seen_targets = set()

    def add_target(name: str, path: str, tags: list[str], properties: dict[str, str]):
        key = (tags[0] if tags else "target", path, name)
        if key in seen_targets:
            return
        seen_targets.add(key)
        targets.append({
            "name": name,
            "path": path,
            "tags": tags,
            "properties": properties,
        })

    # 1. Console entry points from [project.scripts] / Poetry / setup.cfg / setup.py.
    for script_name in sorted(merged_scripts):
        parsed = _parse_entry_point_spec(merged_scripts[script_name])
        if parsed is None:
            continue
        module, attr = parsed
        add_target(
            name=script_name,
            path=".",
            tags=["application", "entrypoint"],
            properties={
                "entryPoint": f"{module}:{attr}",
                "runner": _make_entrypoint_runner(module, attr, has_src_dir),
            },
        )

    # 2. Bounded static walk of the workspace for packages, scripts, frameworks, and content roots.
    scanned_files = 0
    python_files: list[tuple[str, Path]] = []
    package_main_dirs: list[tuple[str, str]] = []
    top_source_dirs: set[str] = set()
    test_dirs: set[str] = set()

    for current_root, dirnames, filenames in os.walk(root_dir, topdown=True, followlinks=False):
        current_path = Path(current_root)
        if not _safe_within(root_real, current_path):
            dirnames[:] = []
            continue
        rel_dir = current_path.relative_to(root_dir)
        rel_dir_posix = "." if rel_dir == Path(".") else rel_dir.as_posix()
        depth = 0 if rel_dir_posix == "." else len(rel_dir.parts)

        kept_dirs = []
        for d in sorted(dirnames):
            child = current_path / d
            if d in (".venv", "venv") and depth == 0:
                content_roots.append({"path": d, "kind": "excluded"})
                continue
            if _should_skip_dir(d):
                continue
            if child.is_symlink() and not _safe_within(root_real, child):
                continue
            if d in ("tests", "test") and depth <= 1:
                rel_test = d if rel_dir_posix == "." else f"{rel_dir_posix}/{d}"
                test_dirs.add(rel_test)
            if depth < _MAX_SCAN_DEPTH:
                kept_dirs.append(d)
        dirnames[:] = kept_dirs

        if "__main__.py" in filenames and rel_dir_posix != ".":
            mod_name, app_dir = _module_name_for_file(f"{rel_dir_posix}/__init__.py", has_src_dir)
            if mod_name and app_dir == ".":
                package_main_dirs.append((mod_name, rel_dir_posix))
            elif mod_name and app_dir == "src":
                package_main_dirs.append((mod_name, rel_dir_posix))

        if depth == 1 and "__init__.py" in filenames and rel_dir_posix not in test_dirs:
            top_source_dirs.add(rel_dir_posix)

        for fname in sorted(filenames):
            if not fname.endswith(".py"):
                continue
            if scanned_files >= _MAX_SCANNED_FILES:
                break
            fpath = current_path / fname
            if fpath.is_symlink() and not _safe_within(root_real, fpath):
                continue
            rel_file = fname if rel_dir_posix == "." else f"{rel_dir_posix}/{fname}"
            python_files.append((rel_file, fpath))
            scanned_files += 1

    # Package __main__.py targets (`python -m <pkg>` or runner for src/ layout).
    for mod_name, pkg_rel_dir in sorted(package_main_dirs):
        if has_src_dir and pkg_rel_dir.startswith("src/"):
            add_target(
                name=mod_name,
                path=".",
                tags=["application", "entrypoint"],
                properties={
                    "entryPoint": f"{mod_name}:__main__",
                    "runner": f"import runpy, sys; sys.path[:0] = ['src', '.']; runpy.run_module('{mod_name}', run_name='__main__', alter_sys=True)",
                },
            )
        else:
            add_target(
                name=mod_name,
                path=".",
                tags=["application", "module"],
                properties={"module": mod_name},
            )

    # File-level AST inspection (Django manage.py, FastAPI ASGI, Flask WSGI, __main__ scripts).
    for rel_file, fpath in python_files:
        fname = fpath.name
        if _is_test_file(rel_file, fname):
            continue
        if fname in ("setup.py", "__main__.py"):
            continue
        tree = _read_ast(fpath)
        if tree is None:
            continue
        facts = _analyze_python_file(tree)

        if fname == "manage.py" and facts["is_django_manage"]:
            label = "manage.py runserver" if rel_file == "manage.py" else f"{rel_file} runserver"
            add_target(
                name=label,
                path=".",
                tags=["application", "django"],
                properties={"script": rel_file},
            )
            continue

        mod_name, app_dir = _module_name_for_file(rel_file, has_src_dir)
        if mod_name:
            for var_name, is_factory in facts["asgi_vars"]:
                app_ref = f"{mod_name}:{var_name}"
                tags = ["application", "asgifactory"] if is_factory else ["application", "asgi"]
                add_target(
                    name=f"fastapi ({app_ref})",
                    path=".",
                    tags=tags,
                    properties={"app": app_ref, "appDir": app_dir},
                )
            for var_name, is_factory in facts["wsgi_vars"]:
                flask_base = f"src/{mod_name.replace('.', '/')}" if app_dir == "src" else mod_name
                app_ref = f"{flask_base}:{var_name}()" if is_factory else f"{flask_base}:{var_name}"
                add_target(
                    name=f"flask ({mod_name}:{var_name})",
                    path=".",
                    tags=["application", "wsgi"],
                    properties={"app": app_ref},
                )

        if facts["has_main_guard"]:
            add_target(
                name=rel_file,
                path=".",
                tags=["application", "script"],
                properties={"script": rel_file},
            )

    # Content roots.
    if has_src_dir:
        content_roots.append({"path": "src", "kind": "source"})
    else:
        for src_dir in sorted(top_source_dirs):
            content_roots.append({"path": src_dir, "kind": "source"})
    for test_dir in sorted(test_dirs):
        content_roots.append({"path": test_dir, "kind": "testSource"})
        add_target(
            name=test_dir,
            path=test_dir,
            tags=["test"],
            properties={"directory": test_dir},
        )

    # Deduplicate content roots while preserving deterministic order.
    deduped_roots = []
    seen_roots = set()
    for root_entry in content_roots:
        key = (root_entry["path"], root_entry["kind"])
        if key not in seen_roots:
            seen_roots.add(key)
            deduped_roots.append(root_entry)

    return {
        "format": "litheBuildModel",
        "version": 0,
        "projects": [
            {
                "path": ".",
                "name": project_name,
                "properties": project_props,
            }
        ],
        "targets": targets,
        "tasks": [],
        "contentRoots": deduped_roots,
    }


def main(argv: list[str]) -> int:
    if len(argv) != 3:
        sys.stderr.write("build_model.py: invalid_arguments\n")
        return 2
    root_dir = _resolve_instance_root(argv[1])
    output_path = Path(argv[2])
    if not root_dir.exists() or not root_dir.is_dir():
        sys.stderr.write("build_model.py: project_root_unavailable\n")
        return 1
    try:
        model = build_model(root_dir)
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_text(json.dumps(model, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    except Exception as exc:
        sys.stderr.write(f"build_model.py: model_generation_failed ({type(exc).__name__})\n")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
