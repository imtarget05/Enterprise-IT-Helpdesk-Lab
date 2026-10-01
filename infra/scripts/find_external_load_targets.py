#!/usr/bin/env python3
"""Find every Bicep load*Content() call whose target leaves the repository root.

WHY THIS EXISTS AS A SEPARATE PROGRAM RATHER THAN A LINE OF validate.sh. The
construct is `loadTextContent('../../apim-policies/api-inbound.xml')`: a
single-quoted path argument nested inside a shell command substitution. On bash
3.2 (the /bin/bash that ships with macOS) that nesting is mis-parsed and the
whole command substitution dies with a syntax error -- measured on this machine,
not assumed. Extracting the argument is a one-line regex, so it is a Python
program.

Two behaviours matter for the caller:
  * default mode  prints one finding per escaping call, and nothing when there are
    none. Exit code is always 0; the caller decides what a finding means.
  * --count mode prints the total number of load*Content() calls seen, so
    validate.sh can report "N call(s) checked" instead of a bare PASS. A check
    that reports nothing about its own coverage reads as untested.

Usage:
    find_external_load_targets.py <repo-root>
    find_external_load_targets.py --count <repo-root>
"""
from __future__ import annotations

import os
import re
import sys

# The three Bicep file-reading functions, plus any future sibling. A call whose
# first argument is not a string literal is ignored here: it cannot be a path
# literal and the compiler will reject it anyway.
CALL_RE = re.compile(r"load(?:TextContent|JsonContent|YamlContent)\(\s*'([^']*)'")

TEXT_SUFFIXES = {".bicep", ".bicepparam", ".yml", ".yaml", ".sh", ".py", ".json"}


def iter_files(root: str):
    for dirpath, dirnames, filenames in os.walk(root):
        # Pruned by name: these are dependency trees and VCS metadata, not source.
        dirnames[:] = [d for d in dirnames
                       if d not in {".git", "node_modules", ".venv", "__pycache__"}]
        for name in filenames:
            if name.endswith(".bicep") or name.endswith(".bicepparam"):
                yield os.path.join(dirpath, name)


def main() -> int:
    # Exactly two arguments are expected: an optional --count flag and the repo
    # root. An earlier revision required three, so every call fell through to the
    # usage text and validate.sh printed a PASS with the docstring above it --
    # which is why this asserts the count rather than trusting the caller.
    args = [a for a in sys.argv[1:] if a != "--count"]
    counting = "--count" in sys.argv[1:]
    if len(args) != 1:
        print("usage: find_external_load_targets.py [--count] <repo-root>",
              file=sys.stderr)
        return 2
    root = os.path.abspath(args[0])
    total = 0
    findings: list[str] = []

    for path in iter_files(root):
        rel = os.path.relpath(path, root)
        try:
            with open(path, encoding="utf-8") as handle:
                lines = handle.read().splitlines()
        except (OSError, UnicodeDecodeError):
            continue
        for lineno, line in enumerate(lines, start=1):
            for match in CALL_RE.finditer(line):
                total += 1
                if counting:
                    continue
                target = match.group(1)
                if os.path.isabs(target):
                    # Not a relative escape, but an absolute path pins the build
                    # to one machine's layout, which is the same class of problem.
                    findings.append(
                        f"{rel}:{lineno}: {target!r} is an absolute path")
                    continue
                resolved = os.path.normpath(
                    os.path.join(os.path.dirname(path), target))
                if not (resolved == root or resolved.startswith(root + os.sep)):
                    findings.append(
                        f"{rel}:{lineno}: {target!r} resolves to {resolved}, "
                        f"outside the repository root")

    if counting:
        print(total)
    else:
        for line in findings:
            print(line)
    return 0


if __name__ == "__main__":
    sys.exit(main())
