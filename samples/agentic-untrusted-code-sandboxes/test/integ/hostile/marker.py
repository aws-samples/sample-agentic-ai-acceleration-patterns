# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
#
# Steps reuse and apart: CONFIG["mode"] is "write" (put CONFIG["value"] in
# /work/marker) or "read" (report what /work/marker holds, or that it is absent).
import os

if CONFIG["mode"] == "write":
    with open("/work/marker", "w") as f:
        f.write(CONFIG["value"])
    R["written"] = True
else:
    R["present"] = os.path.exists("/work/marker")
    R["value"] = open("/work/marker").read() if R["present"] else None
done()
