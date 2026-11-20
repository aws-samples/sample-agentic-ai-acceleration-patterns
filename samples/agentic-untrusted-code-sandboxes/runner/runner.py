# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
"""The runner: one Python HTTP server in every sandbox (spec 3.5, ADR-0010).

Placeholder from the scaffold. The runner worker owns runner/ (except
runner/protocol/ and runner/PROTOCOL.md, which change only by a conductor
decision) and implements runner/PROTOCOL.md against runner/protocol/vectors.json.
Standard library only; the entry is this file, run as PID 1 or the
container entrypoint.
"""

import sys


def main() -> int:
    sys.stderr.write("runner: not built yet\n")
    return 1


if __name__ == "__main__":
    sys.exit(main())
