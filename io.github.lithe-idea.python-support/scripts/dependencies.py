"""Adapt the selected interpreter's installed distribution metadata to Lithe's build tree."""

import json
import sys
import warnings
from collections import deque
from importlib import metadata
from pathlib import Path

# The manifest uses -I -B to skip user-site startup hooks and bytecode writes.
# Use the bundled PEP 508 parser even in pip-free environments, and remove its
# path before discovering distributions so bundled packages stay out of the tree.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "vendor"))
try:
    from packaging.requirements import InvalidRequirement, Requirement
    from packaging.utils import InvalidName, canonicalize_name
finally:
    sys.path.pop(0)


# Leave room for the host's JSON nesting and dependency count limits.
MAX_DEPTH = 48
MAX_NODES = 10_000


def installed_graph():
    packages = {}
    for distribution in metadata.distributions():
        info = distribution.metadata
        name = info.get("Name")
        if not name:
            continue
        try:
            key = canonicalize_name(name, validate=True)
        except InvalidName:
            warnings.warn("ignoring invalid installed distribution name", stacklevel=2)
            continue
        # importlib.metadata yields distributions in import path order.
        packages.setdefault(key, (name, info))
        if len(packages) > MAX_NODES:
            raise ValueError("litheDependencies: maximum dependency count exceeded")

    dependencies = {key: set() for key in packages}
    requirements = {}
    for key, (name, info) in packages.items():
        requirements[key] = []
        for raw in info.get_all("Requires-Dist") or []:
            try:
                requirement = Requirement(raw)
            except InvalidRequirement:
                warnings.warn(f"{name}: invalid Requires-Dist metadata", stacklevel=2)
                continue
            child = canonicalize_name(requirement.name)
            if child in packages:
                requirements[key].append((child, requirement))

    # Evaluate PEP 508 markers in this interpreter. Follow explicitly requested
    # extras transitively. An installed package alone does not imply an extra.
    pending = deque((key, "") for key in packages)
    visited = set(pending)
    while pending:
        key, extra = pending.popleft()
        for child, requirement in requirements[key]:
            if requirement.marker and not requirement.marker.evaluate({"extra": extra}):
                continue
            dependencies[key].add(child)
            for child_extra in requirement.extras:
                state = (child, canonicalize_name(child_extra))
                if state not in visited:
                    visited.add(state)
                    pending.append(state)

    return packages, dependencies


def dependency_tree(packages, dependencies):
    expanded = set()
    nodes = 0

    def tree_node(key, depth=0):
        nonlocal nodes
        nodes += 1
        if nodes > MAX_NODES:
            raise ValueError("litheDependencies: maximum dependency count exceeded")
        name, info = packages[key]
        node = {"name": name, "children": []}
        if version := info.get("Version"):
            node["version"] = version
        if key not in expanded and depth < MAX_DEPTH:
            # Expand each package once. Shared dependencies and cycles remain
            # visible as leaf references, with no exponential tree growth.
            expanded.add(key)
            node["children"] = [
                tree_node(child, depth + 1) for child in sorted(dependencies[key])
            ]
        return node

    required = set().union(*dependencies.values())
    roots = [tree_node(key) for key in sorted(packages.keys() - required)]
    # A disconnected cycle has no root. This also preserves branches beyond the
    # host depth limit by starting their unexpanded nodes at the top level.
    roots.extend(tree_node(key) for key in sorted(packages) if key not in expanded)
    return {"format": "litheDependencies", "version": 0, "dependencies": roots}


if __name__ == "__main__":
    result = dependency_tree(*installed_graph())
    Path(sys.argv[1]).write_text(json.dumps(result), encoding="utf-8")
