# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
"""Job limits per backend (spec §3.5 memory cap, ADR-0019, ADR-0020, ADR-0022).

Pure functions over the text of /proc and cgroup files, so the unit tests
feed them samples.
"""

from __future__ import annotations

import math
from typing import Dict, Optional

MIB = 1024 * 1024
RUNNER_MARGIN = 256 * MIB  # L = M less this
NITRO_AS_MARGIN = 64 * MIB  # nitro A = L less this (ADR-0022)
MICROVM_A = 256 * MIB
MICROVM_SHARE = 0.6  # N x A at most 60 % of M (ADR-0020)
FSIZE = 100 * MIB
NOFILE = {"microvm": 64, "nitro": 256, "agentcore": 256}
NPROC = 64  # nitro and agentcore
MICROVM_FLOOR = 512 * MIB  # MemAvailable floor
MICROVM_FLOOR_POLL_S = 0.05
NITRO_WATCHDOG_POLL_S = 0.2
AGENTCORE_DIRTY = 32 * MIB  # design value, spec §3.5 step 3


class Sizing:
    """M, L, A and N for one sandbox, measured when it becomes one tenant's."""

    __slots__ = ("backend", "m", "l", "a", "n", "nofile")

    def __init__(self, backend: str, m: int):
        if m <= RUNNER_MARGIN + NITRO_AS_MARGIN:
            raise ValueError("sandbox memory too small")
        self.backend = backend
        self.m = m
        self.l = m - RUNNER_MARGIN
        if backend == "microvm":
            self.a = MICROVM_A
            self.n = math.floor(MICROVM_SHARE * m / MICROVM_A)
        elif backend == "nitro":
            self.a = self.l - NITRO_AS_MARGIN
            self.n = NPROC
        elif backend == "agentcore":
            self.a = self.l
            self.n = NPROC
        else:
            raise ValueError(backend)
        if self.n < 1:
            raise ValueError("sandbox memory too small")
        self.nofile = NOFILE[backend]


def meminfo(text: str) -> Dict[str, int]:
    """/proc/meminfo as bytes per key."""
    out = {}
    for line in text.splitlines():
        key, _, rest = line.partition(":")
        parts = rest.split()
        if parts and parts[0].isdigit():
            out[key.strip()] = int(parts[0]) * (1024 if len(parts) > 1 and parts[1] == "kB" else 1)
    return out


def memory_m(backend: str, meminfo_text: str, group_max: Optional[int]) -> int:
    """M per backend: microvm MemTotal, nitro min(MemTotal, task memory.max), agentcore MemAvailable."""
    info = meminfo(meminfo_text)
    if backend == "microvm":
        return info["MemTotal"]
    if backend == "nitro":
        total = info["MemTotal"]
        return min(total, group_max) if group_max else total
    if backend == "agentcore":
        return info["MemAvailable"]
    raise ValueError(backend)


def cgroup_path(proc_self_cgroup: str) -> str:
    """The cgroup v2 path of the process ('0::/path')."""
    for line in proc_self_cgroup.splitlines():
        if line.startswith("0::"):
            return line[3:].strip() or "/"
    raise ValueError("no cgroup v2 entry")


def memory_max(text: str) -> Optional[int]:
    text = text.strip()
    return None if text == "max" else int(text)


def flat_keyed(text: str) -> Dict[str, int]:
    """memory.stat or memory.events."""
    out = {}
    for line in text.splitlines():
        parts = line.split()
        if len(parts) == 2 and parts[1].isdigit():
            out[parts[0]] = int(parts[1])
    return out


def counted(current_text: str, stat_text: str) -> int:
    """memory.current less file plus shmem: page cache of /work files does not count, memfd and tmpfs do."""
    stat = flat_keyed(stat_text)
    return int(current_text.strip()) - stat.get("file", 0) + stat.get("shmem", 0)
