"""Run Conda against the environment file in the task's working directory."""

import os
import subprocess
import sys
from pathlib import Path


def main() -> int:
    conda = Path(os.environ["LITHE_CONDA_PATH"])
    if os.name == "nt" and conda.suffix.lower() in (".bat", ".cmd"):
        # Standard Conda installations expose condabin on PATH. Use its native
        # executable so arguments are passed directly without batch expansion.
        if conda.parent.name.lower() == "condabin":
            conda = conda.parent.parent / "Scripts" / "conda.exe"
        else:
            conda = conda.with_suffix(".exe")
    environment_file = "environment.yml"
    if not Path(environment_file).is_file() and Path("environment.yaml").is_file():
        environment_file = "environment.yaml"
    args = [str(conda), "env", "update", "--file", environment_file, "--prune", *sys.argv[1:]]
    if os.name == "nt":
        return subprocess.run(args, check=False, creationflags=subprocess.CREATE_NO_WINDOW).returncode
    os.execv(conda, args)


if __name__ == "__main__":
    raise SystemExit(main())
