import os
from pathlib import Path
import runpy
import sys

# Ensure neither this adapter process nor any child launcher/debuggee process
# spawned via os.environ writes __pycache__ / .pyc into the installed plugin package.
sys.dont_write_bytecode = True
os.environ["PYTHONDONTWRITEBYTECODE"] = "1"


def main() -> None:
    adapter_dir = Path(__file__).resolve().parent.parent / "vendor" / "debugpy" / "adapter"
    entry = adapter_dir / "__main__.py"
    # Python 3.11+ -I implies -P (safe_path), omitting sys.path[0]; upstream
    # debugpy/adapter/__main__.py expects sys.path[0] to be adapter_dir so it can
    # import debugpy from ../../ and then delete sys.path[0] itself.
    sys.path.insert(0, str(adapter_dir))
    sys.argv[0] = str(entry)
    runpy.run_path(str(entry), run_name="__main__")


if __name__ == "__main__":
    main()
