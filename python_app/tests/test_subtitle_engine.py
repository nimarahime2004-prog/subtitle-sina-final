"""Unit tests verifying 100% immutable SRT/VTT timecodes, QA detection, Persian Find/Replace, and SQLite recovery."""

from __future__ import annotations

import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from core.database import DatabaseManager
from core.qa_validator import analyze_cue_quality, exact_find_replace
from core.subtitle_parser import (
    parse_subtitle_content,
    serialize_subtitle,
    verify_timecode_integrity,
)


class SubtitleEngineTests(unittest.TestCase):
    def test_srt_timecodes_and_crlf_100_percent_immutable(self) -> None:
        raw_srt = (
            "1\r\n"
            "00:00:01,250 --> 00:00:04,800\r\n"
            "Hello world!\r\n\r\n"
            "2\r\n"
            "00:00:05,100 --> 00:00:09,005\r\n"
            "<i>Second line here.</i>\r\n"
        )
        parsed = parse_subtitle_content(raw_srt, "movie.srt")
        self.assertEqual(parsed.fmt, "srt")
        self.assertEqual(parsed.line_ending, "\r\n")
        self.assertEqual(len(parsed.cues), 2)

        parsed.cues[0].translated_text = "سلام دنیا!"
        parsed.cues[1].translated_text = "<i>خط دوم اینجاست.</i>"

        rebuilt = serialize_subtitle(parsed)
        ok, errs = verify_timecode_integrity(parsed.cues, rebuilt, "movie.srt")
        self.assertTrue(ok, msg=f"Integrity errors: {errs}")
        self.assertIn("00:00:01,250 --> 00:00:04,800\r\nسلام دنیا!", rebuilt)
        self.assertIn("00:00:05,100 --> 00:00:09,005\r\n<i>خط دوم اینجاست.</i>", rebuilt)

    def test_vtt_headers_notes_and_cue_settings_preserved(self) -> None:
        raw_vtt = (
            "WEBVTT\n"
            "Kind: captions\n\n"
            "NOTE keep this header note intact\n\n"
            "cue-alpha\n"
            "00:01:10.500 --> 00:01:14.250 align:start position:10%\n"
            "Philosophy begins in wonder.\n"
        )
        parsed = parse_subtitle_content(raw_vtt, "lecture.vtt")
        self.assertEqual(parsed.fmt, "vtt")
        self.assertIn("NOTE keep this header note intact", parsed.file_header)
        parsed.cues[0].translated_text = "فلسفه با شگفتی آغاز می‌شود."

        rebuilt = serialize_subtitle(parsed)
        ok, errs = verify_timecode_integrity(parsed.cues, rebuilt, "lecture.vtt")
        self.assertTrue(ok, msg=f"VTT errors: {errs}")
        self.assertIn("cue-alpha\n00:01:10.500 --> 00:01:14.250 align:start position:10%", rebuilt)
        self.assertIn("WEBVTT", rebuilt)

    def test_persian_whole_word_exact_find_replace(self) -> None:
        text = "کار خوب است ولی کاربر و همکار و کارها نباید تغییر کنند؛ فقط خود کار!"
        updated, count = exact_find_replace(text, "کار", "فعالیت", whole_word=True)
        self.assertEqual(count, 2)
        self.assertEqual(
            updated,
            "فعالیت خوب است ولی کاربر و همکار و کارها نباید تغییر کنند؛ فقط خود فعالیت!",
        )

    def test_qa_validator_detects_incomplete_and_english(self) -> None:
        self.assertEqual(analyze_cue_quality("Hello", "")[0]["code"], "empty")
        self.assertEqual(
            analyze_cue_quality("This is a long sentence", "This is still English text")[0]["code"],
            "untranslated_english",
        )
        self.assertEqual(
            analyze_cue_quality("Good morning", "ترجمه: صبح بخیر")[0]["code"],
            "ai_artifact",
        )
        self.assertEqual(analyze_cue_quality("Good morning", "صبح بخیر"), [])

    def test_sqlite_persistence_and_crash_recovery(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            db_file = os.path.join(tmpdir, "test.db")
            db = DatabaseManager(db_file)
            pid = db.create_project("Test Project")
            parsed = parse_subtitle_content(
                "1\n00:00:01,000 --> 00:00:02,000\nTest line\n", "ep1.srt"
            )
            fid = db.import_subtitle_file(pid, "Season 1/ep1.srt", parsed)
            # Simulate crash mid-translation
            db.conn.execute("UPDATE subtitle_cues SET status = 'translating' WHERE file_id = ?", (fid,))
            db.conn.commit()
            db.close()

            # Reopen and assert automatic crash recovery
            db2 = DatabaseManager(db_file)
            reloaded = db2.load_parsed_file(fid)
            self.assertIsNotNone(reloaded)
            self.assertEqual(reloaded.cues[0].status, "pending")
            self.assertEqual(reloaded.cues[0].raw_timecode_line, "00:00:01,000 --> 00:00:02,000")
            db2.close()

    def test_delete_folder_file_and_bulk_providers(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            db = DatabaseManager(os.path.join(tmpdir, "ops.db"))
            pid = db.create_project("Doc Project")
            parsed = parse_subtitle_content(
                "1\n00:00:01,000 --> 00:00:02,000\nDirect line\n", "ep1.srt"
            )
            f1 = db.import_subtitle_file(pid, "Series/Season 1/ep1.srt", parsed)
            f2 = db.import_subtitle_file(pid, "Series/Season 1/ep2.srt", parsed)
            f3 = db.import_subtitle_file(pid, "Other/ep3.srt", parsed)

            deleted_folder_files = db.delete_folder(pid, "Series")
            self.assertEqual(deleted_folder_files, 2)
            self.assertIsNone(db.load_parsed_file(f1))
            self.assertIsNone(db.load_parsed_file(f2))
            self.assertIsNotNone(db.load_parsed_file(f3))

            db.delete_file(f3)
            self.assertIsNone(db.load_parsed_file(f3))

            added = db.bulk_add_providers(
                [
                    {"name": "Gemini Key 1", "provider_type": "gemini", "api_key": "AIza-1"},
                    {
                        "name": "Slow Proxy",
                        "provider_type": "custom_proxy",
                        "base_url": "https://proxy.example/v1",
                        "api_key": "sk-1",
                        "timeout_sec": 420,
                    },
                ]
            )
            self.assertEqual(added, 2)
            row = db.conn.execute(
                "SELECT model_name, rpm_limit, timeout_sec FROM api_providers WHERE name = 'Gemini Key 1'"
            ).fetchone()
            self.assertEqual(row["model_name"], "gemini-3.5-flash-lite")
            self.assertEqual(row["rpm_limit"], 10)
            self.assertEqual(row["timeout_sec"], 300)
            db.close()


if __name__ == "__main__":
    unittest.main()
