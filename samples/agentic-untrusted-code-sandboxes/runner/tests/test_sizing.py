# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
"""M, L, A and N per backend (spec §3.5 memory cap table) and the cgroup file parsers."""

import unittest

from runner import sizing as sz

MIB = sz.MIB
MEMINFO = "MemTotal:        4093952 kB\nMemFree:  100 kB\nMemAvailable:    3500000 kB\nHugePages_Total:       0\n"


class SizingTest(unittest.TestCase):
    def test_microvm_default(self):
        s = sz.Sizing("microvm", 3998 * MIB)  # MemTotal at the default size (S-15)
        self.assertEqual((s.a, s.n, s.nofile), (256 * MIB, 9, 64))
        self.assertEqual(s.l, 3742 * MIB)
        self.assertLessEqual(s.n * s.a, 0.6 * s.m)

    def test_nitro(self):
        s = sz.Sizing("nitro", 1024 * MIB)
        self.assertEqual((s.l, s.a, s.n, s.nofile), (768 * MIB, 704 * MIB, 64, 256))

    def test_agentcore(self):
        s = sz.Sizing("agentcore", 7625 * MIB)
        self.assertEqual((s.l, s.a, s.n, s.nofile), (7369 * MIB, 7369 * MIB, 64, 256))

    def test_too_small_or_unknown(self):
        for m in (0, 320 * MIB):
            with self.assertRaises(ValueError):
                sz.Sizing("nitro", m)
        with self.assertRaises(ValueError):
            sz.Sizing("microvm", 400 * MIB)  # N would be 0
        with self.assertRaises(ValueError):
            sz.Sizing("lambda", 4096 * MIB)

    def test_m_per_backend(self):
        self.assertEqual(sz.memory_m("microvm", MEMINFO, None), 4093952 * 1024)
        self.assertEqual(sz.memory_m("agentcore", MEMINFO, None), 3500000 * 1024)
        self.assertEqual(sz.memory_m("nitro", MEMINFO, 1024 * MIB), 1024 * MIB)
        self.assertEqual(sz.memory_m("nitro", MEMINFO, None), 4093952 * 1024)
        self.assertEqual(sz.memory_m("nitro", MEMINFO, 10 ** 12), 4093952 * 1024)
        self.assertEqual(sz.meminfo(MEMINFO)["HugePages_Total"], 0)


class CgroupTest(unittest.TestCase):
    def test_path(self):
        self.assertEqual(sz.cgroup_path("0::/ecs/abc/def\n"), "/ecs/abc/def")
        self.assertEqual(sz.cgroup_path("0::/\n"), "/")
        self.assertEqual(sz.cgroup_path("12:memory:/x\n0::/y\n"), "/y")
        with self.assertRaises(ValueError):
            sz.cgroup_path("12:memory:/x\n")

    def test_memory_max(self):
        self.assertIsNone(sz.memory_max("max\n"))
        self.assertEqual(sz.memory_max("1073741824\n"), 1 << 30)

    def test_counted_drops_file_and_keeps_shmem(self):
        stat = "anon 100\nfile 870000000\nshmem 5000\nfile_dirty 10\n"
        self.assertEqual(sz.counted("900000000\n", stat), 900000000 - 870000000 + 5000)
        self.assertEqual(sz.flat_keyed("low 0\nhigh 0\nmax 3\noom 1\noom_kill 2\n")["oom_kill"], 2)

    def test_dirty_counted_drops_reclaimable_slab_only(self):
        stat = "anon 100\nfile 870000000\nshmem 5000\nslab_reclaimable 2000\nslab_unreclaimable 3000\n"
        self.assertEqual(sz.dirty_counted("900000000\n", stat), sz.counted("900000000\n", stat) - 2000)
        # without the key (an older kernel) it is the plain counted read
        self.assertEqual(sz.dirty_counted("900000000\n", "file 0\n"), 900000000)


if __name__ == "__main__":
    unittest.main()
