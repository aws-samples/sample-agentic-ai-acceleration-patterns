# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
#
# Steps parse, standalone: parse the tenant's own invoice (a synthetic CSV the
# tool wrote to /work/input) and report the owner column and the total.
import csv

with open("/work/input", newline="") as f:
    rows = list(csv.DictReader(f))
R["rows"] = len(rows)
R["owner"] = rows[0]["tenant"] if rows else None
R["total"] = round(sum(float(r["amount"]) for r in rows), 2)
done()
