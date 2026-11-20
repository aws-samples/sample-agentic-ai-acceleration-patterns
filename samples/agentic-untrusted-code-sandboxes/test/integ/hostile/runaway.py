# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
#
# Step runaway. CONFIG["mode"] picks one job:
#   loop          spin until the time cap
#   setsid_spawn  start a session-leader child that sleeps past the job, then exit
#   setsid_check  report any other process of this user and whether the child lives
#   kill_pid1     signal PID 1 and the runner (the parent), which must be refused
#   disk_fill     a file past the file-size limit, then files until the disk is full
#   disk_clean    remove what disk_fill left in /work
#   mem_children  the job plus every child it can fork each allocate up to their limit
#   over_as       one process allocates past its own address-space limit
#   files         write CONFIG["mib"] MiB of files to /work in 90 MiB pieces
#   threads       four threads that each allocate 32 MiB
#   memfd_fill    fill memfds (100 MiB each) towards 1.5 times the memory cap
#   sysv_create   create a SysV semaphore array and note its id
#   sysv_check    report whether that array still exists
#   fork_hold     fork children that sleep, then spin (killed by the time cap)
#   fork_count    fork children that exit, count them, report
import ctypes
import resource
import threading

MIB = 1 << 20
mode = CONFIG["mode"]


def touch(n):
    return bytearray(b"x") * n


def hog(chunk=16 * MIB):
    held = []
    try:
        while True:
            held.append(touch(chunk))
    except MemoryError:
        sys.stderr.write("MemoryError\n")
        return len(held) * chunk // MIB


def others():
    me = os.getpid()
    uid = os.getuid()
    out = []
    for p in os.listdir("/proc"):
        if p.isdigit() and int(p) != me:
            try:
                if os.stat("/proc/" + p).st_uid == uid:
                    out.append(int(p))
            except OSError:
                pass
    return out


if mode == "loop":
    while True:
        pass
elif mode == "setsid_spawn":
    pid = os.fork()
    if pid == 0:
        os.setsid()
        time.sleep(600)
        os._exit(0)
    open("/work/child.pid", "w").write(str(pid))
    R["child"] = pid
    done()
elif mode == "setsid_check":
    pid = int(open("/work/child.pid").read())
    try:
        os.kill(pid, 0)
        R["child_alive"] = True
    except ProcessLookupError:
        R["child_alive"] = False
    R["other_processes"] = others()
    done()
elif mode == "kill_pid1":
    for name, target in (("pid1", 1), ("runner", os.getppid())):
        attempt("kill_" + name, lambda t=target: os.kill(t, 9))
    done()
elif mode == "disk_fill":
    # One file past RLIMIT_FSIZE (100 MiB): Python ignores SIGXFSZ, so the write fails with EFBIG.
    try:
        with open("/work/fsize", "wb") as f:
            for _ in range(101):
                f.write(b"x" * MIB)
        R["fsize_errno"] = None
    except OSError as e:
        R["fsize_errno"] = errno_name(e.errno)
    done()
    # Then fill the disk with 100 MiB files until it is full, or the time cap kills the job.
    # The files stay in /work, as every file does; disk_clean removes them.
    try:
        n = 0
        while True:
            with open("/work/fill%d" % n, "wb") as f:
                for _ in range(100):
                    f.write(b"x" * MIB)
            n += 1
    except OSError as e:
        R["stopped_by"] = errno_name(e.errno)
    done()
elif mode == "disk_clean":
    removed = 0
    for name in os.listdir("/work"):
        if name.startswith("fill") or name == "fsize":
            os.remove(os.path.join("/work", name))
            removed += 1
    R["removed"] = removed
    R["left"] = len([n for n in os.listdir("/work") if n.startswith("fill") or n == "fsize"])
    done()
elif mode == "mem_children":
    limit = resource.getrlimit(resource.RLIMIT_NPROC)[0]
    kids = []
    err = None
    while True:
        try:
            pid = os.fork()
        except OSError as e:
            err = e.errno
            break
        if pid == 0:
            hog()
            time.sleep(0.5)
            os._exit(1)
        kids.append(pid)
    R["nproc_limit"] = limit
    R["children"] = len(kids)
    R["fork_failed_errno"] = errno_name(err) if err else None
    sys.stderr.write("forked %d of %d errno %s\n" % (len(kids), limit, R["fork_failed_errno"]))
    hog()
    for pid in kids:
        try:
            os.waitpid(pid, 0)
        except OSError:
            pass
    done()
    sys.exit(1)
elif mode == "over_as":
    R["allocated_mib"] = hog(8 * MIB)
    done()
elif mode == "files":
    total = 0
    n = 0
    while total < CONFIG["mib"]:
        with open("/work/big%d" % n, "wb") as f:
            for _ in range(90):
                f.write(b"y" * MIB)
        total += 90
        n += 1
    for i in range(n):
        os.remove("/work/big%d" % i)
    R["written_mib"] = total
    done()
elif mode == "threads":
    held = []

    def one():
        held.append(touch(32 * MIB))

    ts = [threading.Thread(target=one) for _ in range(4)]
    for t in ts:
        t.start()
    for t in ts:
        t.join()
    R["held_mib"] = sum(len(h) for h in held) // MIB
    done()
elif mode == "memfd_fill":
    def meminfo(key):
        for line in open("/proc/meminfo"):
            if line.startswith(key + ":"):
                return int(line.split()[1]) // 1024

    m = meminfo("MemAvailable") if CONFIG["backend"] == "agentcore" else meminfo("MemTotal")
    try:
        path = open("/proc/self/cgroup").read().strip().split("::")[-1]
        cap = open("/sys/fs/cgroup" + path + "/memory.max").read().strip()
        if cap.isdigit():
            m = min(m, int(cap) // MIB)
    except OSError:
        pass
    target = int(1.5 * (m - 256))
    R["target_mib"] = target
    held = 0
    fds = []
    while held < target:
        fd = os.memfd_create("fill")
        os.posix_fallocate(fd, 0, 100 * MIB)
        fds.append(fd)
        held += 100
    R["held_mib"] = held
    done()
elif mode == "sysv_create":
    libc = ctypes.CDLL(None, use_errno=True)
    semid = libc.semget(0, 8, 0o1000 | 0o600)
    R["semid"] = semid
    open("/work/semid", "w").write(str(semid))
    done()
elif mode == "sysv_check":
    semid = open("/work/semid").read().strip()
    R["semid"] = semid
    R["still_there"] = any(len(l.split()) > 1 and l.split()[1] == semid for l in open("/proc/sysvipc/sem"))
    done()
elif mode == "fork_hold":
    limit = resource.getrlimit(resource.RLIMIT_NPROC)[0]
    for _ in range(limit - 1):
        try:
            if os.fork() == 0:
                time.sleep(600)
                os._exit(0)
        except OSError:
            break
    while True:
        time.sleep(1)
elif mode == "fork_count":
    limit = resource.getrlimit(resource.RLIMIT_NPROC)[0]
    kids = 0
    err = None
    while True:
        try:
            if os.fork() == 0:
                os._exit(0)
        except OSError as e:
            err = e.errno
            break
        kids += 1
    R["nproc_limit"] = limit
    R["forked"] = kids
    R["fork_failed_errno"] = errno_name(err) if err else None
    for _ in range(kids):
        os.wait()
    done()
