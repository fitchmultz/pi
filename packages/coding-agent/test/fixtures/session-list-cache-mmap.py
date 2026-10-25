"""Native Linux tmpfs reproduction of a metadata-preserving journal rewrite.

Dirtying MAP_SHARED before the cold reader means subsequent writes need not
update mtime/ctime. The test independently verifies every revision field.
"""

import hashlib
import json
import mmap
import os
import sys

with open(sys.argv[1], "r+b", buffering=0) as journal:
    with mmap.mmap(journal.fileno(), 0, access=mmap.ACCESS_WRITE) as mapping:
        mapping[0:1] = mapping[0:1]
        print("ready", flush=True)
        if not sys.stdin.readline():
            raise RuntimeError("reader exited before releasing mmap writer")
        old = bytes(mapping)
        new = old.replace(b"old name", b"new name").replace(b"old text", b"new text")
        assert len(old) == len(new) and old != new
        mapping[:] = new
        mapping.flush()
        os.fsync(journal.fileno())
        print(json.dumps({"before": hashlib.sha256(old).hexdigest(), "after": hashlib.sha256(new).hexdigest()}), flush=True)
