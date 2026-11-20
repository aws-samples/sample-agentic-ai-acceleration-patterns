# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
#
# Step limits. CONFIG["mode"] picks one probe:
#   print      write 1 MiB to stdout (the tool must report truncated)
#   shm_write  multiprocessing.Lock(), then leave a file in /dev/shm
#   shm_check  report whether that file survived (nitro and agentcore: gone)
#   microvm    the job filter's blocked and allowed calls, and Seccomp mode
#   nitro      semget, which the nitro filter blocks
import ctypes
import multiprocessing
import socket

if CONFIG["mode"] == "print":
    sys.stdout.write("x" * (1 << 20))
    sys.stdout.flush()
elif CONFIG["mode"] == "shm_write":
    attempt("mp_lock", lambda: bool(multiprocessing.Lock()))
    attempt("shm_file", lambda: open("/dev/shm/rc-integ-leftover", "w").write("x"))
    done()
elif CONFIG["mode"] == "shm_check":
    R["shm_file_present"] = os.path.exists("/dev/shm/rc-integ-leftover")
    done()
else:
    libc = ctypes.CDLL(None, use_errno=True)

    def blocked(fn):
        # A blocked call fails with EPERM, as a PermissionError or as -1 and errno.
        ctypes.set_errno(0)
        r = fn()
        if r == -1:
            raise OSError(ctypes.get_errno(), "call failed")
        return r

    def sem():
        return blocked(lambda: libc.semget(0, 1, 0o1000 | 0o600))

    if CONFIG["mode"] == "nitro":
        attempt("semget", sem)
    else:
        attempt("memfd_create", lambda: os.memfd_create("x"))
        attempt("semget", sem)

        def sndbuf():
            s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            s.setsockopt(socket.SOL_SOCKET, socket.SO_SNDBUF, 1 << 20)

        attempt("setsockopt_sndbuf", sndbuf)
        attempt("af_unix_socket", lambda: socket.socket(socket.AF_UNIX, socket.SOCK_STREAM))
        attempt("socketpair", lambda: len(socket.socketpair()))

        def listen(n):
            s = socket.socket()
            s.bind(("127.0.0.1", 0))
            s.listen(n)
            return True

        attempt("listen_128", lambda: listen(128))
        attempt("listen_5", lambda: listen(5))
        R["seccomp"] = next((int(l.split()[1]) for l in open("/proc/self/status") if l.startswith("Seccomp:")), None)
    done()
