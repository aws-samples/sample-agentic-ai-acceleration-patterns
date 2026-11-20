# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
"""Job seccomp filters (spec §3.5, ADR-0020, ADR-0021), built as classic BPF and installed with ctypes.

One table per architecture: a port that changed only the architecture
constant would block the wrong calls or kill every job. The table is
chosen from the machine the runner runs on, which is the image's
architecture.
"""

from __future__ import annotations

import ctypes
import errno
import os
import struct
from typing import Dict, List, Tuple

AUDIT_ARCH = {"x86_64": 0xC000003E, "aarch64": 0xC00000B7}

# System call numbers: x86_64 from arch/x86/entry/syscalls/syscall_64.tbl,
# aarch64 from the generic table include/uapi/asm-generic/unistd.h.
SYSCALLS: Dict[str, Dict[str, int]] = {
    "x86_64": {
        "memfd_create": 319, "memfd_secret": 447, "shmget": 29, "shmat": 30, "shmctl": 31,
        "msgget": 68, "semget": 64, "vmsplice": 278, "userfaultfd": 323, "io_uring_setup": 425,
        "unshare": 272, "setns": 308, "mount": 165, "umount2": 166, "pivot_root": 155,
        "move_mount": 429, "open_tree": 428, "fsopen": 430, "fsconfig": 431, "fsmount": 432,
        "fspick": 433, "setsockopt": 54, "socket": 41, "listen": 50, "clone": 56, "clone3": 435,
    },
    "aarch64": {
        "memfd_create": 279, "memfd_secret": 447, "shmget": 194, "shmat": 196, "shmctl": 195,
        "msgget": 186, "semget": 190, "vmsplice": 75, "userfaultfd": 282, "io_uring_setup": 425,
        "unshare": 97, "setns": 268, "mount": 40, "umount2": 39, "pivot_root": 41,
        "move_mount": 429, "open_tree": 428, "fsopen": 430, "fsconfig": 431, "fsmount": 432,
        "fspick": 433, "setsockopt": 208, "socket": 198, "listen": 201, "clone": 220, "clone3": 435,
    },
}

X32_BIT = 0x40000000
AF_UNIX = 1
SOL_SOCKET = 1
BUFFER_OPTIONS = (7, 8, 32, 33)  # SO_SNDBUF, SO_RCVBUF, SO_SNDBUFFORCE, SO_RCVBUFFORCE (both tables)
LISTEN_BACKLOG_MAX = 8
# CLONE_NEWNS, NEWCGROUP, NEWUTS, NEWIPC, NEWUSER, NEWPID, NEWNET. CLONE_NEWTIME
# (0x80) shares bits with the exit signal, so it stays out.
CLONE_NEW_MASK = 0x00020000 | 0x02000000 | 0x04000000 | 0x08000000 | 0x10000000 | 0x20000000 | 0x40000000

MICROVM_EPERM = (
    "memfd_create", "memfd_secret", "shmget", "shmat", "shmctl", "msgget", "semget", "vmsplice",
    "userfaultfd", "io_uring_setup", "unshare", "setns", "mount", "umount2", "pivot_root",
    "move_mount", "open_tree", "fsopen", "fsconfig", "fsmount", "fspick",
)
NITRO_EPERM = ("semget", "msgget", "shmget", "shmat")
# The call each filter's self-test makes and expects EPERM from.
SELF_TEST = {"microvm": "memfd_create", "nitro": "semget"}

RET_KILL_PROCESS = 0x80000000
RET_ALLOW = 0x7FFF0000
RET_ERRNO = 0x00050000

# Classic BPF opcodes.
LD_W_ABS = 0x20
JEQ_K = 0x15
JGT_K = 0x25
JSET_K = 0x45
RET_K = 0x06

OFF_NR = 0
OFF_ARCH = 4


def _arg_lo(i: int) -> int:
    return 16 + 8 * i  # low 32 bits of args[i], little-endian on both architectures


Insn = Tuple[int, int, int, int]


def _ret(k: int) -> Insn:
    return (RET_K, 0, 0, k)


def _eperm() -> Insn:
    return _ret(RET_ERRNO | errno.EPERM)


def program(backend: str, machine: str) -> List[Insn]:
    """The filter for one backend and one architecture, as (code, jt, jf, k) tuples."""
    if machine not in SYSCALLS:
        raise ValueError("no seccomp table for " + machine)
    nr = SYSCALLS[machine]
    prog: List[Insn] = [(LD_W_ABS, 0, 0, OFF_ARCH), (JEQ_K, 1, 0, AUDIT_ARCH[machine]), _ret(RET_KILL_PROCESS),
                        (LD_W_ABS, 0, 0, OFF_NR)]
    if machine == "x86_64":
        prog += [(JSET_K, 0, 1, X32_BIT), _ret(RET_KILL_PROCESS)]
    names = MICROVM_EPERM if backend == "microvm" else NITRO_EPERM if backend == "nitro" else None
    if names is None:
        raise ValueError("no filter for " + backend)
    for name in names:
        prog += [(JEQ_K, 0, 1, nr[name]), _eperm()]
    if backend == "microvm":
        prog += [(JEQ_K, 0, 1, nr["clone3"]), _ret(RET_ERRNO | errno.ENOSYS)]
        # Each conditional block ends in returns, so a miss on its first jump
        # leaves the call number in the accumulator for the next block.
        socket_body = [(LD_W_ABS, 0, 0, _arg_lo(0)), (JEQ_K, 0, 1, AF_UNIX), _eperm(), _ret(RET_ALLOW)]
        listen_body = [(LD_W_ABS, 0, 0, _arg_lo(1)), (JGT_K, 0, 1, LISTEN_BACKLOG_MAX), _eperm(), _ret(RET_ALLOW)]
        clone_body = [(LD_W_ABS, 0, 0, _arg_lo(0)), (JSET_K, 0, 1, CLONE_NEW_MASK), _eperm(), _ret(RET_ALLOW)]
        opts = len(BUFFER_OPTIONS)
        setsockopt_body = [(LD_W_ABS, 0, 0, _arg_lo(1)), (JEQ_K, 0, opts + 1, SOL_SOCKET), (LD_W_ABS, 0, 0, _arg_lo(2))]
        for i, opt in enumerate(BUFFER_OPTIONS):
            setsockopt_body.append((JEQ_K, opts - i, 0, opt))  # a hit jumps to the EPERM after the ALLOW
        setsockopt_body += [_ret(RET_ALLOW), _eperm()]
        for name, body in (("socket", socket_body), ("listen", listen_body), ("clone", clone_body),
                           ("setsockopt", setsockopt_body)):
            prog.append((JEQ_K, 0, len(body), nr[name]))
            prog += body
    prog.append(_ret(RET_ALLOW))
    return prog


def pack(prog: List[Insn]) -> bytes:
    return b"".join(struct.pack("=HBBI", *insn) for insn in prog)


PR_GET_SECCOMP = 21
PR_SET_SECCOMP = 22
PR_SET_NO_NEW_PRIVS = 38
SECCOMP_MODE_FILTER = 2


class _SockFprog(ctypes.Structure):
    _fields_ = [("len", ctypes.c_ushort), ("filter", ctypes.c_void_p)]


class Filter:
    """A filter prepared in the runner and installed in the job child before exec.

    Everything is allocated before the fork, so the child only makes calls.
    """

    def __init__(self, backend: str, machine: str):
        self.backend = backend
        insns = program(backend, machine)
        self._buf = ctypes.create_string_buffer(pack(insns))
        self._fprog = _SockFprog(len(insns), ctypes.cast(self._buf, ctypes.c_void_p))
        self._libc = ctypes.CDLL(None, use_errno=True)
        self._libc.syscall.restype = ctypes.c_long
        self._libc.prctl.restype = ctypes.c_int
        self._test_nr = SYSCALLS[machine][SELF_TEST[backend]]
        self._test_args = (ctypes.c_char_p(b"t"), ctypes.c_long(0)) if backend == "microvm" else \
            (ctypes.c_long(0), ctypes.c_long(1), ctypes.c_long(0o600))  # memfd_create(name, 0) / semget(IPC_PRIVATE, 1, 0600)
        self._ref = ctypes.byref(self._fprog)

    def install(self) -> None:
        """Run in the job child after the uid drop. Raises unless the filter is proved on."""
        libc = self._libc
        if libc.prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0:
            raise OSError(ctypes.get_errno(), "no_new_privs")
        if libc.prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, self._ref, 0, 0) != 0:
            raise OSError(ctypes.get_errno(), "seccomp")
        self.prove()

    def prove(self) -> None:
        """PR_GET_SECCOMP must be 2, and the blocked call must answer EPERM (an allow-all filter passes the first)."""
        libc = self._libc
        if libc.prctl(PR_GET_SECCOMP, 0, 0, 0, 0) != SECCOMP_MODE_FILTER:
            raise OSError(errno.EPROTO, "seccomp not on")
        ctypes.set_errno(0)
        rc = libc.syscall(ctypes.c_long(self._test_nr), *self._test_args)
        if rc != -1 or ctypes.get_errno() != errno.EPERM:
            if rc >= 0 and self.backend == "microvm":
                os.close(rc)
            raise OSError(errno.EPROTO, "seccomp self-test passed a blocked call")
