"""SQLite database persistence, crash recovery, and JSON backup/restore."""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path
from typing import Any, Dict, List, Optional

from .subtitle_parser import ParsedSubtitle, SubtitleCue


class DatabaseManager:
    def __init__(self, db_path: str | Path = "subtitle_translator.db") -> None:
        self.db_path = Path(db_path)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self.conn = sqlite3.connect(str(self.db_path), check_same_thread=False)
        self.conn.row_factory = sqlite3.Row
        self.conn.execute("PRAGMA journal_mode = WAL;")
        self.conn.execute("PRAGMA foreign_keys = ON;")
        self._init_schema()
        self.recover_after_crash()

    def _init_schema(self) -> None:
        self.conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS projects (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                description TEXT NOT NULL DEFAULT '',
                default_tone TEXT NOT NULL DEFAULT 'documentary_direct',
                custom_tone_prompt TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL DEFAULT (datetime('now'))
            );

            CREATE TABLE IF NOT EXISTS folder_tones (
                project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                folder_path TEXT NOT NULL,
                tone TEXT NOT NULL,
                custom_prompt TEXT NOT NULL DEFAULT '',
                PRIMARY KEY (project_id, folder_path)
            );

            CREATE TABLE IF NOT EXISTS subtitle_files (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                relative_path TEXT NOT NULL,
                folder_path TEXT NOT NULL DEFAULT '',
                file_name TEXT NOT NULL,
                fmt TEXT NOT NULL,
                file_header TEXT NOT NULL DEFAULT '',
                line_ending TEXT NOT NULL DEFAULT '\n',
                tone_override TEXT,
                custom_tone_override TEXT,
                status TEXT NOT NULL DEFAULT 'idle',
                active_provider TEXT,
                active_model TEXT,
                total_tokens INTEGER NOT NULL DEFAULT 0,
                estimated_cost_usd REAL NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL DEFAULT (datetime('now'))
            );

            CREATE TABLE IF NOT EXISTS subtitle_cues (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                file_id INTEGER NOT NULL REFERENCES subtitle_files(id) ON DELETE CASCADE,
                cue_index INTEGER NOT NULL,
                cue_identifier TEXT NOT NULL DEFAULT '',
                raw_timecode_line TEXT NOT NULL,
                start_ms INTEGER NOT NULL DEFAULT 0,
                end_ms INTEGER NOT NULL DEFAULT 0,
                source_text TEXT NOT NULL,
                translated_text TEXT NOT NULL DEFAULT '',
                status TEXT NOT NULL DEFAULT 'pending',
                qa_issues_json TEXT NOT NULL DEFAULT '[]',
                provider_used TEXT,
                model_used TEXT,
                tokens_used INTEGER NOT NULL DEFAULT 0
            );

            CREATE TABLE IF NOT EXISTS api_providers (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                provider_type TEXT NOT NULL,
                base_url TEXT NOT NULL DEFAULT '',
                api_key TEXT NOT NULL DEFAULT '',
                model_name TEXT NOT NULL DEFAULT '',
                priority INTEGER NOT NULL DEFAULT 10,
                rpm_limit INTEGER NOT NULL DEFAULT 10,
                tpm_limit INTEGER NOT NULL DEFAULT 120000,
                timeout_sec INTEGER NOT NULL DEFAULT 300,
                enabled INTEGER NOT NULL DEFAULT 1,
                status TEXT NOT NULL DEFAULT 'untested',
                last_latency_ms INTEGER,
                last_error TEXT,
                total_tokens INTEGER NOT NULL DEFAULT 0
            );

            CREATE TABLE IF NOT EXISTS glossary_terms (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
                source_term TEXT NOT NULL,
                target_term TEXT NOT NULL,
                case_sensitive INTEGER NOT NULL DEFAULT 0,
                whole_word INTEGER NOT NULL DEFAULT 1,
                notes TEXT NOT NULL DEFAULT ''
            );

            CREATE TABLE IF NOT EXISTS operation_logs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                level TEXT NOT NULL DEFAULT 'info',
                message TEXT NOT NULL,
                provider_name TEXT,
                tokens_used INTEGER NOT NULL DEFAULT 0,
                latency_ms INTEGER,
                created_at TEXT NOT NULL DEFAULT (datetime('now'))
            );
            """
        )
        self.conn.commit()

    def recover_after_crash(self) -> None:
        self.conn.execute(
            "UPDATE subtitle_cues SET status = 'pending' WHERE status = 'translating'"
        )
        self.conn.execute(
            "UPDATE subtitle_files SET status = 'partial', active_provider = NULL, active_model = NULL "
            "WHERE status IN ('translating', 'queued')"
        )
        self.conn.commit()

    def create_project(
        self, name: str, default_tone: str = "documentary_direct", description: str = ""
    ) -> int:
        cur = self.conn.execute(
            "INSERT INTO projects (name, description, default_tone) VALUES (?, ?, ?)",
            (name, description, default_tone),
        )
        self.conn.commit()
        return int(cur.lastrowid)

    def import_subtitle_file(
        self, project_id: int, relative_path: str, parsed: ParsedSubtitle
    ) -> int:
        norm_rel = relative_path.replace("\\", "/").lstrip("/")
        parts = norm_rel.split("/")
        file_name = parts[-1]
        folder_path = "/".join(parts[:-1])

        cur = self.conn.execute(
            """
            INSERT INTO subtitle_files
                (project_id, relative_path, folder_path, file_name, fmt, file_header, line_ending)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                project_id,
                norm_rel,
                folder_path,
                file_name,
                parsed.fmt,
                parsed.file_header,
                parsed.line_ending,
            ),
        )
        file_id = int(cur.lastrowid)
        self.conn.executemany(
            """
            INSERT INTO subtitle_cues
                (file_id, cue_index, cue_identifier, raw_timecode_line, start_ms, end_ms, source_text, status)
            VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')
            """,
            [
                (
                    file_id,
                    c.cue_index,
                    c.cue_identifier,
                    c.raw_timecode_line,
                    c.start_ms,
                    c.end_ms,
                    c.source_text,
                )
                for c in parsed.cues
            ],
        )
        self.conn.commit()
        return file_id

    def load_parsed_file(self, file_id: int) -> Optional[ParsedSubtitle]:
        frow = self.conn.execute(
            "SELECT * FROM subtitle_files WHERE id = ?", (file_id,)
        ).fetchone()
        if not frow:
            return None
        crows = self.conn.execute(
            "SELECT * FROM subtitle_cues WHERE file_id = ? ORDER BY cue_index ASC",
            (file_id,),
        ).fetchall()
        cues = [
            SubtitleCue(
                cue_index=r["cue_index"],
                cue_identifier=r["cue_identifier"],
                raw_timecode_line=r["raw_timecode_line"],
                start_ms=r["start_ms"],
                end_ms=r["end_ms"],
                source_text=r["source_text"],
                translated_text=r["translated_text"],
                status=r["status"],
                qa_issues=json.loads(r["qa_issues_json"] or "[]"),
            )
            for r in crows
        ]
        return ParsedSubtitle(
            fmt=frow["fmt"],
            file_header=frow["file_header"],
            line_ending=frow["line_ending"],
            cues=cues,
        )

    def update_cue_translation(
        self,
        file_id: int,
        cue_index: int,
        translated_text: str,
        status: str,
        qa_issues: List[Dict[str, str]],
        provider_used: Optional[str] = None,
        model_used: Optional[str] = None,
        tokens_used: int = 0,
    ) -> None:
        self.conn.execute(
            """
            UPDATE subtitle_cues
            SET translated_text = ?, status = ?, qa_issues_json = ?,
                provider_used = COALESCE(?, provider_used),
                model_used = COALESCE(?, model_used),
                tokens_used = CASE WHEN ? > 0 THEN ? ELSE tokens_used END
            WHERE file_id = ? AND cue_index = ?
            """,
            (
                translated_text,
                status,
                json.dumps(qa_issues, ensure_ascii=False),
                provider_used,
                model_used,
                tokens_used,
                tokens_used,
                file_id,
                cue_index,
            ),
        )
        self.conn.commit()

    def delete_file(self, file_id: int) -> None:
        self.conn.execute("DELETE FROM subtitle_files WHERE id = ?", (file_id,))
        self.conn.commit()

    def delete_folder(self, project_id: int, folder_path: str) -> int:
        clean = folder_path.strip("/")
        if clean == "":
            cur = self.conn.execute(
                "DELETE FROM subtitle_files WHERE project_id = ? AND folder_path = ''",
                (project_id,),
            )
        else:
            cur = self.conn.execute(
                "DELETE FROM subtitle_files WHERE project_id = ? AND (folder_path = ? OR folder_path LIKE ?)",
                (project_id, clean, f"{clean}/%"),
            )
            self.conn.execute(
                "DELETE FROM folder_tones WHERE project_id = ? AND (folder_path = ? OR folder_path LIKE ?)",
                (project_id, clean, f"{clean}/%"),
            )
        self.conn.commit()
        return int(cur.rowcount or 0)

    def bulk_add_providers(self, items: List[Dict[str, Any]]) -> int:
        count = 0
        for idx, item in enumerate(items):
            ptype = str(item.get("provider_type", "gemini"))
            is_gemini = ptype == "gemini"
            self.conn.execute(
                """
                INSERT INTO api_providers
                    (name, provider_type, base_url, api_key, model_name, priority, rpm_limit, tpm_limit, timeout_sec)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    str(item.get("name") or f"{ptype.upper()} #{idx + 1}"),
                    ptype,
                    str(item.get("base_url") or ""),
                    str(item.get("api_key") or ""),
                    str(item.get("model_name") or ("gemini-3.5-flash-lite" if is_gemini else "gpt-4o-mini")),
                    int(item.get("priority", 10 + idx)),
                    int(item.get("rpm_limit", 10 if is_gemini else 20)),
                    int(item.get("tpm_limit", 120000)),
                    int(item.get("timeout_sec", 300)),
                ),
            )
            count += 1
        self.conn.commit()
        return count

    def export_backup_json(self, output_path: str | Path) -> None:
        tables = ["projects", "folder_tones", "subtitle_files", "subtitle_cues", "glossary_terms"]
        payload: Dict[str, Any] = {"schema_version": 1, "tables": {}}
        for t in tables:
            rows = self.conn.execute(f"SELECT * FROM {t}").fetchall()
            payload["tables"][t] = [dict(r) for r in rows]
        Path(output_path).write_text(
            json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8"
        )

    def close(self) -> None:
        self.conn.close()
