# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
"""The seccomp programs, run through a small classic BPF interpreter, and the tables against kernel headers.

The interpreter covers the four instructions the programs use, so both
architectures' programs are checked here on any host. Whether the kernel
loads and enforces them is the Docker test's job (x86_64 only).
"""

import errno
import re
import struct
import unittest

from runner import seccomp as sc

ALLOW = sc.RET_ALLOW
KILL = sc.RET_KILL_PROCESS
EPERM = sc.RET_ERRNO | errno.EPERM
ENOSYS = sc.RET_ERRNO | errno.ENOSYS


def run_bpf(prog, arch, nr, args=(0, 0, 0, 0, 0, 0)):
    args = (list(args) + [0] * 6)[:6]
    data = struct.pack("<iIQ6Q", nr, arch, 0, *[a & 0xFFFFFFFFFFFFFFFF for a in args])
    pc, acc = 0, 0
    for _ in range(len(prog) + 1):
        code, jt, jf, k = prog[pc]
        if code == sc.LD_W_ABS:
            acc = struct.unpack_from("<I", data, k)[0]
            pc += 1
        elif code == sc.RET_K:
            return k
        else:
            hit = {sc.JEQ_K: acc == k, sc.JGT_K: acc > k, sc.JSET_K: bool(acc & k)}[code]
            pc += 1 + (jt if hit else jf)
        if pc >= len(prog):
            raise AssertionError("ran off the end")
    raise AssertionError("loop")


class ProgramTest(unittest.TestCase):
    def check_microvm(self, machine):
        prog = sc.program("microvm", machine)
        arch = sc.AUDIT_ARCH[machine]
        nr = sc.SYSCALLS[machine]
        r = lambda name, *args: run_bpf(prog, arch, nr[name], args or (0,) * 6)  # noqa: E731
        for name in sc.MICROVM_EPERM:
            self.assertEqual(r(name), EPERM, name)
        self.assertEqual(r("clone3"), ENOSYS)
        self.assertEqual(r("socket", sc.AF_UNIX, 1, 0), EPERM)
        self.assertEqual(r("socket", 2, 1, 0), ALLOW)  # AF_INET
        self.assertEqual(r("socket", 10, 1, 0), ALLOW)  # AF_INET6
        self.assertEqual(r("listen", 3, 8), ALLOW)
        self.assertEqual(r("listen", 3, 0), ALLOW)
        self.assertEqual(r("listen", 3, 9), EPERM)
        self.assertEqual(r("listen", 3, 4096), EPERM)
        self.assertEqual(r("listen", 3, -1), EPERM)  # the kernel reads it unsigned and clamps it to somaxconn
        for opt in sc.BUFFER_OPTIONS:
            self.assertEqual(r("setsockopt", 3, sc.SOL_SOCKET, opt), EPERM, opt)
        self.assertEqual(r("setsockopt", 3, sc.SOL_SOCKET, 2), ALLOW)  # SO_REUSEADDR
        self.assertEqual(r("setsockopt", 3, 6, 7), ALLOW)  # IPPROTO_TCP, same option number
        for flag in (0x00020000, 0x02000000, 0x04000000, 0x08000000, 0x10000000, 0x20000000, 0x40000000):
            self.assertEqual(r("clone", flag | 17), EPERM, hex(flag))
        self.assertEqual(r("clone", 0x003D0F00), ALLOW)  # the thread flags glibc passes
        self.assertEqual(r("clone", 0x01200011), ALLOW)  # fork: CLONE_CHILD_SETTID|CLEARTID|SIGCHLD
        self.assertEqual(r("clone", 0x80 | 17), ALLOW)  # CLONE_NEWTIME bits are exit-signal bits
        self.assertEqual(run_bpf(prog, arch, 0, (0,) * 6), ALLOW)  # read on x86_64, io_setup on aarch64
        other = sc.AUDIT_ARCH["aarch64" if machine == "x86_64" else "x86_64"]
        self.assertEqual(run_bpf(prog, other, nr["socket"]), KILL)

    def test_microvm_aarch64(self):
        self.check_microvm("aarch64")

    def test_microvm_x86_64(self):
        self.check_microvm("x86_64")

    def test_nitro(self):
        for machine in ("x86_64", "aarch64"):
            prog = sc.program("nitro", machine)
            nr = sc.SYSCALLS[machine]
            arch = sc.AUDIT_ARCH[machine]
            for name in sc.NITRO_EPERM:
                self.assertEqual(run_bpf(prog, arch, nr[name]), EPERM, name)
            for name in ("shmctl", "memfd_create", "clone3", "socket", "listen"):
                self.assertEqual(run_bpf(prog, arch, nr[name], (1, 4096, 0, 0, 0, 0)), ALLOW, name)

    def test_x32_killed_on_x86_64(self):
        for backend in ("microvm", "nitro"):
            prog = sc.program(backend, "x86_64")
            self.assertEqual(run_bpf(prog, sc.AUDIT_ARCH["x86_64"], sc.X32_BIT | 39), KILL)
            self.assertEqual(run_bpf(prog, sc.AUDIT_ARCH["x86_64"], sc.X32_BIT | sc.SYSCALLS["x86_64"]["semget"]), KILL)

    def test_refuses_unknown(self):
        with self.assertRaises(ValueError):
            sc.program("microvm", "riscv64")
        with self.assertRaises(ValueError):
            sc.program("agentcore", "x86_64")

    def test_jumps_fit(self):
        for backend in ("microvm", "nitro"):
            for machine in sc.SYSCALLS:
                prog = sc.program(backend, machine)
                self.assertLess(len(prog), 4096)
                for i, (code, jt, jf, _) in enumerate(prog):
                    if code != sc.RET_K:
                        self.assertLess(i + 1 + max(jt, jf), len(prog))
                self.assertEqual(prog[-1], (sc.RET_K, 0, 0, ALLOW))
                self.assertEqual(len(sc.pack(prog)), 8 * len(prog))


def header_numbers(path, pattern):
    try:
        with open(path, encoding="utf-8") as f:
            text = f.read()
    except OSError:
        return None
    return {m.group(1): int(m.group(2)) for m in re.finditer(pattern, text)}


class TableTest(unittest.TestCase):
    """Compare the tables with the kernel headers on this host, where present."""

    def compare(self, machine, numbers):
        if not numbers:
            self.skipTest("no kernel header for " + machine + " on this host")
        for name, value in sc.SYSCALLS[machine].items():
            self.assertEqual(numbers.get(name), value, name)

    def test_x86_64(self):
        self.compare("x86_64", header_numbers("/usr/include/asm/unistd_64.h", r"#define __NR_(\w+) (\d+)"))

    def test_aarch64_generic(self):
        # The generic table: aarch64 uses it unchanged (arch/arm64 includes asm-generic/unistd.h).
        path = "/usr/include/asm-generic/unistd.h"
        numbers = header_numbers(path, r"#define __NR(?:3264)?_(\w+) (\d+)")
        if numbers and "fcntl" in numbers:
            del numbers["fcntl"]
        self.compare("aarch64", numbers)


if __name__ == "__main__":
    unittest.main()
