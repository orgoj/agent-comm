#!/usr/bin/env python3
"""Tests for ac watch JSONL output format."""
import json
import subprocess
import sys
import os
import unittest

AC = os.path.join(os.path.dirname(__file__), "..", "skills", "agent-comm", "scripts", "ac")


def _emit(obj):
    """Replicate the _emit function from ac watch."""
    return json.dumps(obj, ensure_ascii=False)


def _format_msg(m, name_map=None):
    """Replicate _print_msg logic from ac watch."""
    import time
    if name_map is None:
        name_map = {}
    mid = m.get("id", "?")
    from_id = m.get("from_agent", "")
    from_name = name_map.get(from_id, from_id[:8]) if from_id else "?"
    ts = time.strftime("%H:%M:%S")
    ch = m.get("channel_id") or m.get("channel_name") or None
    raw = m.get("content") or ""
    first_line = raw.split("\n")[0]
    content = first_line[:100] + ("…" if len(first_line) > 100 else "")
    return _emit({"type": "msg", "ts": ts, "id": mid, "from": from_name,
                   "channel": ch, "content": content})


class TestMsgJsonl(unittest.TestCase):
    """Test message JSONL format."""

    def test_valid_json(self):
        line = _format_msg({"id": 1, "from_agent": "a1", "content": "hello"})
        parsed = json.loads(line)
        self.assertIsInstance(parsed, dict)

    def test_required_fields(self):
        line = _format_msg({"id": 42, "from_agent": "a1", "content": "hi"})
        parsed = json.loads(line)
        for field in ("type", "ts", "id", "from", "channel", "content"):
            self.assertIn(field, parsed)

    def test_type_is_msg(self):
        line = _format_msg({"id": 1, "from_agent": "a1", "content": "x"})
        parsed = json.loads(line)
        self.assertEqual(parsed["type"], "msg")

    def test_id_preserved(self):
        line = _format_msg({"id": 137, "from_agent": "a1", "content": "x"})
        parsed = json.loads(line)
        self.assertEqual(parsed["id"], 137)

    def test_name_from_map(self):
        line = _format_msg({"id": 1, "from_agent": "uuid-123", "content": "x"},
                           name_map={"uuid-123": "human"})
        parsed = json.loads(line)
        self.assertEqual(parsed["from"], "human")

    def test_name_fallback_short_id(self):
        line = _format_msg({"id": 1, "from_agent": "abcdefgh-1234", "content": "x"})
        parsed = json.loads(line)
        self.assertEqual(parsed["from"], "abcdefgh")

    def test_channel_null_when_absent(self):
        line = _format_msg({"id": 1, "from_agent": "a1", "content": "x"})
        parsed = json.loads(line)
        self.assertIsNone(parsed["channel"])

    def test_channel_from_channel_id(self):
        line = _format_msg({"id": 1, "from_agent": "a1", "content": "x",
                            "channel_id": "builds"})
        parsed = json.loads(line)
        self.assertEqual(parsed["channel"], "builds")

    def test_channel_from_channel_name(self):
        line = _format_msg({"id": 1, "from_agent": "a1", "content": "x",
                            "channel_name": "deploy"})
        parsed = json.loads(line)
        self.assertEqual(parsed["channel"], "deploy")

    def test_timestamp_format(self):
        line = _format_msg({"id": 1, "from_agent": "a1", "content": "x"})
        parsed = json.loads(line)
        self.assertRegex(parsed["ts"], r"\d{2}:\d{2}:\d{2}")


class TestContentTruncation(unittest.TestCase):
    """Test content truncation: first line, max 100 chars."""

    def test_short_content_unchanged(self):
        line = _format_msg({"id": 1, "from_agent": "a1", "content": "short"})
        parsed = json.loads(line)
        self.assertEqual(parsed["content"], "short")

    def test_exactly_100_chars_no_suffix(self):
        content = "x" * 100
        line = _format_msg({"id": 1, "from_agent": "a1", "content": content})
        parsed = json.loads(line)
        self.assertEqual(len(parsed["content"]), 100)
        self.assertFalse(parsed["content"].endswith("…"))

    def test_101_chars_truncated_with_suffix(self):
        content = "x" * 101
        line = _format_msg({"id": 1, "from_agent": "a1", "content": content})
        parsed = json.loads(line)
        self.assertTrue(parsed["content"].endswith("…"))
        self.assertEqual(len(parsed["content"]), 101)  # 100 chars + ellipsis

    def test_multiline_shows_first_line_only(self):
        content = "line one\nline two\nline three"
        line = _format_msg({"id": 1, "from_agent": "a1", "content": content})
        parsed = json.loads(line)
        self.assertEqual(parsed["content"], "line one")

    def test_multiline_long_first_line(self):
        content = "x" * 150 + "\nsecond line"
        line = _format_msg({"id": 1, "from_agent": "a1", "content": content})
        parsed = json.loads(line)
        self.assertTrue(parsed["content"].endswith("…"))
        self.assertNotIn("\n", parsed["content"])

    def test_empty_content(self):
        line = _format_msg({"id": 1, "from_agent": "a1", "content": ""})
        parsed = json.loads(line)
        self.assertEqual(parsed["content"], "")

    def test_none_content(self):
        line = _format_msg({"id": 1, "from_agent": "a1"})
        parsed = json.loads(line)
        self.assertEqual(parsed["content"], "")


class TestSpecialChars(unittest.TestCase):
    """Test special characters are properly JSON-escaped."""

    def test_quotes_in_content(self):
        line = _format_msg({"id": 1, "from_agent": "a1",
                            'content': 'He said "hello"'})
        parsed = json.loads(line)
        self.assertEqual(parsed["content"], 'He said "hello"')

    def test_tab_in_content(self):
        line = _format_msg({"id": 1, "from_agent": "a1", "content": "a\tb"})
        parsed = json.loads(line)
        self.assertEqual(parsed["content"], "a\tb")

    def test_unicode_content(self):
        line = _format_msg({"id": 1, "from_agent": "a1", "content": "Příliš žluťoučký kůň"})
        parsed = json.loads(line)
        self.assertEqual(parsed["content"], "Příliš žluťoučký kůň")

    def test_backslash_in_content(self):
        line = _format_msg({"id": 1, "from_agent": "a1", "content": "path\\to\\file"})
        parsed = json.loads(line)
        self.assertEqual(parsed["content"], "path\\to\\file")

    def test_jsonl_is_single_line(self):
        line = _format_msg({"id": 1, "from_agent": "a1",
                            "content": "line1\nline2\nline3"})
        self.assertNotIn("\n", line.rstrip("\n"))


class TestStatusJsonl(unittest.TestCase):
    """Test status lifecycle JSONL format."""

    def test_started(self):
        line = _emit({"type": "status", "status": "started", "agent": "my-agent",
                       "interval": 60})
        parsed = json.loads(line)
        self.assertEqual(parsed["type"], "status")
        self.assertEqual(parsed["status"], "started")
        self.assertEqual(parsed["agent"], "my-agent")
        self.assertEqual(parsed["interval"], 60)

    def test_batch(self):
        line = _emit({"type": "status", "status": "batch", "count": 15})
        parsed = json.loads(line)
        self.assertEqual(parsed["status"], "batch")
        self.assertEqual(parsed["count"], 15)

    def test_listening(self):
        line = _emit({"type": "status", "status": "listening"})
        parsed = json.loads(line)
        self.assertEqual(parsed["status"], "listening")

    def test_all_status_valid_json(self):
        for obj in [
            {"type": "status", "status": "started", "agent": "x", "interval": 30},
            {"type": "status", "status": "batch", "count": 5},
            {"type": "status", "status": "listening"},
        ]:
            parsed = json.loads(_emit(obj))
            self.assertEqual(parsed["type"], "status")


class TestErrorJsonl(unittest.TestCase):
    """Test error JSONL format."""

    def test_too_many_unread(self):
        line = _emit({"type": "error", "error": "too_many_unread",
                       "count": 6, "max": 5})
        parsed = json.loads(line)
        self.assertEqual(parsed["type"], "error")
        self.assertEqual(parsed["error"], "too_many_unread")
        self.assertEqual(parsed["count"], 6)
        self.assertEqual(parsed["max"], 5)


if __name__ == "__main__":
    unittest.main()
