"""Exact metadata and bounded native canonical-path transport."""
from __future__ import annotations

import struct
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "native/execution-host"))
from filesystem import _description
from protocol import HostError


class PathDescriptionTests(unittest.TestCase):
    def frame(self, path=b"/app/file", modified=10000000001, modified_ns=234567890,
              changed=-10000000002, changed_ns=765432110):
        return struct.pack("!QQIQQqIqII", 2**63 + 1, 2**63 + 3, 0o100600, 2, 17,
                           modified, modified_ns, changed, changed_ns, len(path)) + path

    def test_preserves_inode_link_and_timestamp_bits_beyond_signed_nanosecond_range(self):
        result = _description(self.frame())
        self.assertEqual(result, {"canonicalPath": "/app/file", "identity": {
            "dev": str(2**63 + 1), "ino": str(2**63 + 3), "mode": str(0o100600),
            "nlink": "2", "size": "17", "mtimeNs": "10000000001234567890", "ctimeNs": "-10000000001234567890"}})
        self.assertEqual(_description(self.frame(modified=-1, modified_ns=999999999))["identity"]["mtimeNs"], "-1")

    def test_rejects_bad_lengths_unreachable_paths_and_non_utf8_names(self):
        for frame in (self.frame()[:-1], self.frame() + b"x", self.frame(b"relative"),
                      self.frame(b"(unreachable)/app"), self.frame(b"/app/\0hidden"),
                      self.frame(b"/app/\xff"), self.frame(b"/" * 16384),
                      self.frame(modified_ns=1000000000)):
            with self.subTest(frame_length=len(frame)):
                with self.assertRaises(HostError):
                    _description(frame)


if __name__ == "__main__":
    unittest.main()
