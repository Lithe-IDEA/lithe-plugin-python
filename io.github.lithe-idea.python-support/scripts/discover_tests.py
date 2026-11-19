"""Collect exact pytest selectors for the host-owned discovery report."""

import json
import os
from pathlib import Path
import subprocess
import sys

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))

from build_model import project_name_for_dir  # noqa: E402


_DISCOVERY_TIMEOUT_SECONDS = 45
_PYTEST_COLLECTOR = r"""
import json
from pathlib import Path
import sys

try:
    import pytest
except ModuleNotFoundError:
    print("pytest --collect-only: pytest unavailable (ModuleNotFoundError)", file=sys.stderr)
    sys.exit(197)

MAX_TESTS = 10_000
MAX_REPORT_BYTES = 32 * 1024 * 1024
MAX_SELECTOR_BYTES = 1024
HEADER = b'{"format":"litheTestDiscovery","version":0,"tests":['
FOOTER = b"]}\n"

output_file = Path(sys.argv[1])
project = json.loads(sys.argv[2])
cwd = Path.cwd().resolve()


def valid_selector(text):
    if not isinstance(text, str):
        return False
    try:
        return (text.strip() and not text.lstrip().startswith("-")
                and len(text.encode("utf-8")) <= MAX_SELECTOR_BYTES
                and not any(ord(c) < 32 or 127 <= ord(c) <= 159 for c in text))
    except UnicodeEncodeError:
        return False


class Collector:
    def __init__(self):
        self.tests = None

    def pytest_collection_finish(self, session):
        if len(session.items) > MAX_TESTS:
            return
        root = Path(session.config.rootpath).resolve()
        tests = []
        remaining_bytes = MAX_REPORT_BYTES - len(HEADER) - len(FOOTER)
        for item in session.items:
            nodeid = getattr(item, "nodeid", "")
            if not isinstance(nodeid, str) or not nodeid:
                return
            filename, separator, case = nodeid.partition("::")
            if not separator:
                case = getattr(item, "name", "") or nodeid
            suite = None
            for path in (getattr(item, "path", None), root / filename):
                if path is not None:
                    try:
                        suite = Path(path).resolve().relative_to(cwd).as_posix()
                        break
                    except (OSError, RuntimeError, ValueError):
                        continue
            if (not suite or not valid_selector(suite) or not valid_selector(case)
                    or ":" in suite or "\\" in suite
                    or any(seg in ("", ".", "..") or seg.startswith("-") for seg in suite.split("/"))):
                return
            selector = {"suite": suite, "case": case, "project": project}
            encoded = json.dumps(selector, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
            remaining_bytes -= len(encoded) + bool(tests)
            if remaining_bytes < 0:
                return
            tests.append(encoded)
        self.tests = tests


collector = Collector()
exit_code = pytest.main([
    "--collect-only", "-q", "--color=no",
    "-o", "addopts=", "-o", f"cache_dir={output_file.with_name('pytest-cache')}",
    *sys.argv[3:],
], plugins=[collector])
if exit_code not in (pytest.ExitCode.OK, pytest.ExitCode.NO_TESTS_COLLECTED):
    sys.exit(exit_code)
if collector.tests is None:
    print("litheTestDiscovery: invalid or oversized test selectors", file=sys.stderr)
    sys.exit(1)

with output_file.open("xb") as report:
    report.write(HEADER)
    for index, item in enumerate(collector.tests):
        if index:
            report.write(b",")
        report.write(item)
    report.write(FOOTER)
"""


def main() -> int:
    output_file, root, *options = sys.argv[1:]
    project = {"name": project_name_for_dir(Path.cwd().resolve()), "path": root}
    # The isolated entry point only imports bundled helpers. The pytest child
    # inherits the selected Python's user site and project imports, like pytest
    # execution, and stays in the host-owned process group or Windows job.
    try:
        child = subprocess.run(
            [sys.executable, "-B", "-c", _PYTEST_COLLECTOR, output_file, json.dumps(project), *options],
            env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1", "PYTHONIOENCODING": "utf-8"},
            check=False,
            timeout=_DISCOVERY_TIMEOUT_SECONDS,
        )
    except subprocess.TimeoutExpired:
        print(f"pytest --collect-only: ETIMEDOUT ({_DISCOVERY_TIMEOUT_SECONDS}s)", file=sys.stderr)
        return 124
    return child.returncode


if __name__ == "__main__":
    raise SystemExit(main())
