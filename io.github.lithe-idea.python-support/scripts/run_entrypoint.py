"""Launch Python entrypoints within the process tree owned by the host."""

import sys
from importlib import import_module
from importlib.util import find_spec, module_from_spec
from pathlib import Path


_MESSAGES = {
    "invalid": (
        "Select a runnable Python file inside the project.",
        "请选择项目内可运行的 Python 文件。",
    ),
    "stale": (
        "The saved Python entrypoint is no longer available. Open the file and run it again.",
        "保存的 Python 入口已失效。请打开文件并重新运行。",
    ),
    "shadowed": (
        "A module or package with the same name shadows the selected Python entrypoint.",
        "当前包入口被同名模块或包遮蔽。",
    ),
}


def run_message(key: str, locale: str) -> str:
    english, chinese = _MESSAGES[key]
    if not locale:
        # Desktop releases that omit the standard initialize locale get both translations.
        return f"{english} {chinese}"
    return chinese if locale.replace("_", "-").split("-", 1)[0].lower() == "zh" else english


def _run_package(import_root: str, package: str, selected_file: str, locale: str, args: list[str]) -> int:
    source = Path(selected_file).resolve()
    if sys.path and sys.path[0] == str(Path(__file__).parent):
        sys.path.pop(0)
    sys.path.insert(0, import_root)
    sys.argv = ["-m", *args]

    # Check each package before importing it. Resolving a dotted name with find_spec
    # alone would import a shadowing module before we could check its origin.
    expected_dir = Path(import_root)
    qualified_name = ""
    for part in package.split("."):
        expected_dir /= part
        qualified_name = f"{qualified_name}.{part}" if qualified_name else part
        parent_spec = find_spec(qualified_name)
        locations = parent_spec.submodule_search_locations if parent_spec else None
        if not locations or not any(Path(path).resolve() == expected_dir.resolve() for path in locations):
            raise SystemExit(run_message("shadowed", locale))
        import_module(qualified_name)

    name = f"{package}.__main__"
    spec = find_spec(name)
    if spec is None or not spec.origin or not spec.loader or Path(spec.origin).resolve() != source:
        raise SystemExit(run_message("shadowed", locale))
    # Keep Python's module metadata and relative imports, and execute the checked loader.
    module = module_from_spec(spec)
    module.__name__ = "__main__"
    sys.modules["__main__"] = module
    sys.argv[0] = str(source)
    exec(spec.loader.get_code(name), vars(module))
    return 0


if __name__ == "__main__":
    _package_action, import_root, package, selected_file, locale, *program_args = sys.argv[1:]
    raise SystemExit(_run_package(import_root, package, selected_file, locale, program_args))
