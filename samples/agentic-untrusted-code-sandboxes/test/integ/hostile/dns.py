# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
#
# Step dns: raw DNS queries to the resolver in /etc/resolv.conf (so a TXT name
# can be asked too). CONFIG["names"] is a list of {"label", "name", "type"}; the
# result holds each answer's response code (3 = NXDOMAIN) and its first A
# address, if any. Nothing but the standard library is used.
import struct


def resolver():
    for line in open("/etc/resolv.conf"):
        parts = line.split()
        if len(parts) > 1 and parts[0] == "nameserver":
            return parts[1]
    raise OSError("no nameserver")


def skip_name(data, pos):
    # A name is labels ending in a zero byte, or ending in a two-byte compression pointer.
    while True:
        n = data[pos]
        if n == 0:
            return pos + 1
        if n & 0xC0 == 0xC0:
            return pos + 2
        pos += n + 1


def query(name, qtype):
    qid = os.urandom(2)
    q = b"".join(bytes([len(p)]) + p.encode() for p in name.split(".")) + b"\x00"
    msg = qid + b"\x01\x00\x00\x01\x00\x00\x00\x00\x00\x00" + q + struct.pack(">HH", qtype, 1)
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
        s.settimeout(3)
        s.sendto(msg, (resolver(), 53))
        data = s.recv(4096)
    if data[0:2] != qid:
        raise OSError("answer for another query")
    rcode = data[3] & 0x0F
    ancount = struct.unpack(">H", data[6:8])[0]
    pos = skip_name(data, 12) + 4
    address = None
    for _ in range(ancount):
        pos = skip_name(data, pos)
        rtype, _cls, _ttl, rdlen = struct.unpack(">HHIH", data[pos:pos + 10])
        pos += 10
        if rtype == 1 and rdlen == 4 and address is None:
            address = ".".join(str(b) for b in data[pos:pos + 4])
        pos += rdlen
    return {"rcode": rcode, "answers": ancount, "address": address}


for item in CONFIG["names"]:
    attempt(item["label"], lambda i=item: query(i["name"], i["type"]))
done()
