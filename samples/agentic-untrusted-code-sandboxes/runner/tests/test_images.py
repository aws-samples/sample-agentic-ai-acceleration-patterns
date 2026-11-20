# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
"""The runner images are built from pinned bases with COPY only, and hold every module the runner imports.

M-46 and M-48 (threat model): the base is pinned by digest, the runner image has no RUN line,
the MicroVM image installs one package at an exact version, and nothing is fetched at build time.
A module that runner.py imports but a Dockerfile does not copy would only fail at the first start.
"""

import os
import re
import unittest

RUNNER = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
NITRO_AGENTCORE = os.path.join(RUNNER, "Dockerfile")
MICROVM = os.path.join(RUNNER, "microvm", "Dockerfile")
FETCHERS = re.compile(r"\b(pip3?|curl|wget|apt(-get)?|npm|git|ADD)\b")


def instructions(path):
    """The Dockerfile's instructions, comments dropped and continuation lines joined."""
    with open(path, encoding="utf-8") as f:
        text = f.read().replace("\\\n", " ")
    return [line.strip() for line in text.splitlines() if line.strip() and not line.lstrip().startswith("#")]


def copied(path):
    """File names copied into the image, without a leading runner/ directory."""
    names = set()
    for line in instructions(path):
        if line.startswith("COPY "):
            names.update(os.path.basename(part) for part in line.split()[1:-1])
    return names


def imported_modules(entry="runner.py"):
    """Every runner module reachable from the entry through `from runner import ...` and `from runner.x import ...`."""
    seen, queue = set(), [entry]
    while queue:
        name = queue.pop()
        if name in seen:
            continue
        seen.add(name)
        with open(os.path.join(RUNNER, name), encoding="utf-8") as f:
            source = f.read()
        for module in re.findall(r"^\s*from runner\.(\w+) import", source, re.M):
            queue.append(module + ".py")
        for names in re.findall(r"^\s*from runner import ([\w, ]+?)(?: as \w+)?\s*(?:#.*)?$", source, re.M):
            queue.extend(n.strip().split(" as ")[0] + ".py" for n in names.split(","))
    return seen


class ImageTest(unittest.TestCase):
    def test_every_base_is_pinned_by_digest(self):
        for path in (NITRO_AGENTCORE, MICROVM):
            froms = [line for line in instructions(path) if line.startswith("FROM ")]
            self.assertEqual(len(froms), 1, path)
            self.assertRegex(froms[0], r"@sha256:[0-9a-f]{64}$", path)

    def test_the_runner_image_is_copy_only(self):
        lines = instructions(NITRO_AGENTCORE)
        self.assertEqual([line for line in lines if line.startswith("RUN ")], [])
        self.assertEqual([line for line in lines if FETCHERS.search(line)], [])

    def test_the_microvm_image_installs_one_pinned_package_and_fetches_nothing_else(self):
        lines = instructions(MICROVM)
        runs = [line for line in lines if line.startswith("RUN ")]
        self.assertEqual(len(runs), 1)
        installs = re.findall(r"dnf install -y (\S+)", runs[0])
        self.assertEqual(len(installs), 1)
        self.assertRegex(installs[0], r"^python3-\d+\.\d+\.\d+-\d+\.amzn\d+\.\d+\.\d+$")
        self.assertEqual(runs[0].count("&&"), 1)  # install, then clean: nothing else runs
        self.assertTrue(runs[0].endswith("dnf clean all"))
        self.assertEqual([line for line in lines if FETCHERS.search(line)], [])

    def test_both_images_copy_every_module_the_runner_imports(self):
        needed = imported_modules() | {"__init__.py"}
        self.assertTrue({"runner.py", "wire.py", "server.py", "job.py", "sizing.py", "seccomp.py"} <= needed)
        for path in (NITRO_AGENTCORE, MICROVM):
            self.assertEqual(needed - copied(path), set(), path)


if __name__ == "__main__":
    unittest.main()
