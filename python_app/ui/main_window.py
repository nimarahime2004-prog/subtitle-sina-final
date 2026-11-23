"""Modern RTL Persian PySide6 Desktop Window for AI Subtitle Translator."""

from __future__ import annotations

import asyncio
from pathlib import Path
from typing import List, Optional

from PySide6.QtCore import QThread, Qt, Signal
from PySide6.QtWidgets import (
    QComboBox,
    QFileDialog,
    QHBoxLayout,
    QHeaderView,
    QLabel,
    QLineEdit,
    QMainWindow,
    QMessageBox,
    QPushButton,
    QSplitter,
    QTableWidget,
    QTableWidgetItem,
    QTabWidget,
    QTreeWidget,
    QTreeWidgetItem,
    QVBoxLayout,
    QWidget,
)

from core.ai_client import MultiProviderAIClient, ProviderConfig
from core.database import DatabaseManager
from core.qa_validator import analyze_cue_quality, exact_find_replace
from core.subtitle_parser import (
    parse_subtitle_content,
    serialize_subtitle,
    verify_timecode_integrity,
)
from core.translator_worker import TranslationOrchestrator


class TranslationThread(QThread):
    progress = Signal(int, int, int, str)
    finished_all = Signal()

    def __init__(
        self,
        orchestrator: TranslationOrchestrator,
        file_ids: List[int],
        providers: List[ProviderConfig],
        tone: str,
    ) -> None:
        super().__init__()
        self.orchestrator = orchestrator
        self.file_ids = file_ids
        self.providers = providers
        self.tone = tone

    def run(self) -> None:
        asyncio.run(
            self.orchestrator.translate_files(
                self.file_ids,
                self.providers,
                tone=self.tone,
                on_progress=lambda fid, done, tot, prov: self.progress.emit(
                    fid, done, tot, prov
                ),
            )
        )
        self.finished_all.emit()


class MainWindow(QMainWindow):
    def __init__(self, db_path: str = "subtitle_translator.db") -> None:
        super().__init__()
        self.setWindowTitle("AI Subtitle Translator — استودیو ترجمه زیرنویس")
        self.resize(1380, 860)
        self.setLayoutDirection(Qt.LayoutDirection.RightToLeft)

        self.db = DatabaseManager(db_path)
        self.ai_client = MultiProviderAIClient()
        self.orchestrator = TranslationOrchestrator(self.db, self.ai_client)
        self.worker_thread: Optional[TranslationThread] = None
        self.current_file_id: Optional[int] = None
        self._suppress_cell_save = False

        row = self.db.conn.execute("SELECT id FROM projects ORDER BY id ASC LIMIT 1").fetchone()
        self.project_id = int(row["id"]) if row else self.db.create_project("پروژه اصلی")

        self._build_ui()
        self._apply_dark_theme()
        self._reload_file_tree()

    def _build_ui(self) -> None:
        tabs = QTabWidget()
        self.setCentralWidget(tabs)

        # Tab 1: Workspace & Dual-Language Editor
        workspace = QWidget()
        ws_layout = QVBoxLayout(workspace)

        toolbar = QHBoxLayout()
        btn_import_files = QPushButton("وارد کردن فایل SRT/VTT")
        btn_import_files.clicked.connect(self._import_files)
        btn_import_folder = QPushButton("وارد کردن پوشه کامل")
        btn_import_folder.clicked.connect(self._import_folder)

        self.tone_combo = QComboBox()
        self.tone_combo.addItems(
            [
                "documentary_direct",
                "conversational",
                "formal",
                "scientific",
                "philosophical",
                "spiritual",
                "cinematic",
            ]
        )

        btn_start = QPushButton("شروع ترجمه")
        btn_start.clicked.connect(self._start_translation)
        btn_pause = QPushButton("توقف موقت")
        btn_pause.clicked.connect(self.orchestrator.pause)
        btn_resume = QPushButton("ادامه")
        btn_resume.clicked.connect(self.orchestrator.resume)
        btn_stop = QPushButton("توقف کامل")
        btn_stop.clicked.connect(self.orchestrator.stop)
        btn_del_file = QPushButton("حذف فایل")
        btn_del_file.clicked.connect(self._delete_current_file)
        btn_del_folder = QPushButton("حذف پوشه")
        btn_del_folder.clicked.connect(self._delete_current_folder)
        btn_export = QPushButton("خروجی با حفظ زمان‌بندی")
        btn_export.clicked.connect(self._export_current_file)

        for w in [
            btn_import_files,
            btn_import_folder,
            QLabel("لحن:"),
            self.tone_combo,
            btn_start,
            btn_pause,
            btn_resume,
            btn_stop,
            btn_del_file,
            btn_del_folder,
            btn_export,
        ]:
            toolbar.addWidget(w)
        toolbar.addStretch()
        ws_layout.addLayout(toolbar)

        splitter = QSplitter(Qt.Orientation.Horizontal)
        self.file_tree = QTreeWidget()
        self.file_tree.setHeaderLabels(["فایل‌ها و پوشه‌ها"])
        self.file_tree.itemClicked.connect(self._on_tree_select)
        splitter.addWidget(self.file_tree)

        self.cue_table = QTableWidget(0, 4)
        self.cue_table.setHorizontalHeaderLabels(
            ["#", "Timecode (قفل‌شده)", "متن انگلیسی (اصلی)", "ترجمه فارسی (ذخیره خودکار)"]
        )
        self.cue_table.horizontalHeader().setSectionResizeMode(2, QHeaderView.ResizeMode.Stretch)
        self.cue_table.horizontalHeader().setSectionResizeMode(3, QHeaderView.ResizeMode.Stretch)
        self.cue_table.cellChanged.connect(self._on_cue_edited)
        splitter.addWidget(self.cue_table)
        splitter.setSizes([320, 1020])
        ws_layout.addWidget(splitter)

        self.status_label = QLabel("آماده به کار — زمان‌بندی فایل‌ها ۱۰۰٪ محفوظ می‌ماند.")
        ws_layout.addWidget(self.status_label)
        tabs.addTab(workspace, "فضای کار و ادیتور دوزبانه")

        # Tab 2: Exact Find & Replace
        fr_tab = QWidget()
        fr_layout = QVBoxLayout(fr_tab)
        self.find_input = QLineEdit()
        self.find_input.setPlaceholderText("عبارت دقیق برای جستجو در فارسی...")
        self.replace_input = QLineEdit()
        self.replace_input.setPlaceholderText("عبارت جایگزین...")
        btn_apply_fr = QPushButton("جایگزینی دقیق کلمه کامل در فایل فعلی")
        btn_apply_fr.clicked.connect(self._apply_find_replace)
        fr_layout.addWidget(QLabel("جستجو و جایگزینی دقیق بدون تغییر ناخواسته کلمات مشابه:"))
        fr_layout.addWidget(self.find_input)
        fr_layout.addWidget(self.replace_input)
        fr_layout.addWidget(btn_apply_fr)
        fr_layout.addStretch()
        tabs.addTab(fr_tab, "جستجو و جایگزینی دقیق")

    def _apply_dark_theme(self) -> None:
        self.setStyleSheet(
            """
            QMainWindow, QWidget { background-color: #0B1120; color: #F1F5F9; font-size: 13px; }
            QPushButton { background-color: #1E293B; border: 1px solid #334155; padding: 6px 12px; border-radius: 6px; }
            QPushButton:hover { background-color: #2563EB; border-color: #3B82F6; }
            QTableWidget, QTreeWidget, QLineEdit, QComboBox { background-color: #111827; border: 1px solid #1F2937; padding: 4px; }
            """
        )

    def _import_files(self) -> None:
        paths, _ = QFileDialog.getOpenFileNames(
            self, "انتخاب فایل‌های زیرنویس", "", "Subtitles (*.srt *.vtt)"
        )
        for p in paths:
            path_obj = Path(p)
            parsed = parse_subtitle_content(path_obj.read_text(encoding="utf-8-sig"), path_obj.name)
            self.db.import_subtitle_file(self.project_id, path_obj.name, parsed)
        self._reload_file_tree()

    def _import_folder(self) -> None:
        folder = QFileDialog.getExistingDirectory(self, "انتخاب پوشه زیرنویس‌ها")
        if not folder:
            return
        root = Path(folder)
        for p in sorted(root.rglob("*")):
            if p.suffix.lower() in (".srt", ".vtt") and p.is_file():
                rel = str(p.relative_to(root)).replace("\\", "/")
                parsed = parse_subtitle_content(p.read_text(encoding="utf-8-sig"), p.name)
                self.db.import_subtitle_file(self.project_id, rel, parsed)
        self._reload_file_tree()

    def _reload_file_tree(self) -> None:
        self.file_tree.clear()
        rows = self.db.conn.execute(
            "SELECT id, relative_path FROM subtitle_files WHERE project_id = ? ORDER BY relative_path ASC",
            (self.project_id,),
        ).fetchall()
        for r in rows:
            item = QTreeWidgetItem([r["relative_path"]])
            item.setData(0, Qt.ItemDataRole.UserRole, int(r["id"]))
            self.file_tree.addTopLevelItem(item)

    def _on_tree_select(self, item: QTreeWidgetItem) -> None:
        fid = item.data(0, Qt.ItemDataRole.UserRole)
        if not fid:
            return
        self.current_file_id = int(fid)
        self._load_cues_table(self.current_file_id)

    def _load_cues_table(self, file_id: int) -> None:
        parsed = self.db.load_parsed_file(file_id)
        if not parsed:
            return
        self._suppress_cell_save = True
        self.cue_table.setRowCount(len(parsed.cues))
        for row_idx, cue in enumerate(parsed.cues):
            id_item = QTableWidgetItem(cue.cue_identifier or str(cue.cue_index + 1))
            id_item.setFlags(id_item.flags() & ~Qt.ItemFlag.ItemIsEditable)
            tc_item = QTableWidgetItem(cue.raw_timecode_line)
            tc_item.setFlags(tc_item.flags() & ~Qt.ItemFlag.ItemIsEditable)
            src_item = QTableWidgetItem(cue.source_text)
            src_item.setFlags(src_item.flags() & ~Qt.ItemFlag.ItemIsEditable)
            tr_item = QTableWidgetItem(cue.translated_text)
            self.cue_table.setItem(row_idx, 0, id_item)
            self.cue_table.setItem(row_idx, 1, tc_item)
            self.cue_table.setItem(row_idx, 2, src_item)
            self.cue_table.setItem(row_idx, 3, tr_item)
        self._suppress_cell_save = False

    def _on_cue_edited(self, row: int, col: int) -> None:
        if self._suppress_cell_save or col != 3 or self.current_file_id is None:
            return
        src = self.cue_table.item(row, 2).text()
        fa = self.cue_table.item(row, 3).text()
        issues = analyze_cue_quality(src, fa)
        status = "incomplete" if issues else "edited"
        self.db.update_cue_translation(self.current_file_id, row, fa, status, issues)
        self.status_label.setText(f"خط {row + 1} به صورت خودکار در دیتابیس ذخیره شد.")

    def _apply_find_replace(self) -> None:
        if self.current_file_id is None:
            return
        find_t = self.find_input.text()
        rep_t = self.replace_input.text()
        parsed = self.db.load_parsed_file(self.current_file_id)
        if not parsed or not find_t:
            return
        total = 0
        for cue in parsed.cues:
            updated, count = exact_find_replace(cue.translated_text, find_t, rep_t, whole_word=True)
            if count > 0:
                total += count
                issues = analyze_cue_quality(cue.source_text, updated)
                self.db.update_cue_translation(
                    self.current_file_id, cue.cue_index, updated, "edited", issues
                )
        self._load_cues_table(self.current_file_id)
        QMessageBox.information(self, "نتیجه جایگزینی", f"{total} مورد دقیق جایگزین شد.")

    def _start_translation(self) -> None:
        if self.current_file_id is None:
            QMessageBox.warning(self, "انتخاب فایل", "لطفاً ابتدا یک فایل زیرنویس انتخاب کنید.")
            return
        rows = self.db.conn.execute(
            "SELECT * FROM api_providers WHERE enabled = 1 ORDER BY priority ASC"
        ).fetchall()
        providers = [
            ProviderConfig(
                id=r["id"],
                name=r["name"],
                provider_type=r["provider_type"],
                base_url=r["base_url"],
                api_key=r["api_key"],
                model_name=r["model_name"],
                rpm_limit=r["rpm_limit"],
                tpm_limit=r["tpm_limit"],
                timeout_sec=r["timeout_sec"],
            )
            for r in rows
        ]
        if not providers:
            QMessageBox.warning(
                self, "نیاز به API", "هیچ API فعالی در دیتابیس ثبت نشده است."
            )
            return
        self.worker_thread = TranslationThread(
            self.orchestrator,
            [self.current_file_id],
            providers,
            self.tone_combo.currentText(),
        )
        self.worker_thread.progress.connect(
            lambda _fid, done, tot, prov: self.status_label.setText(
                f"در حال ترجمه با {prov} — پیشرفت: {done}/{tot}"
            )
        )
        self.worker_thread.finished_all.connect(
            lambda: self._load_cues_table(self.current_file_id or 0)
        )
        self.worker_thread.start()

    def _export_current_file(self) -> None:
        if self.current_file_id is None:
            return
        parsed = self.db.load_parsed_file(self.current_file_id)
        if not parsed:
            return
        ext = f".{parsed.fmt}"
        out_path, _ = QFileDialog.getSaveFileName(
            self, "ذخیره خروجی زیرنویس", f"translated{ext}", f"Subtitle (*{ext})"
        )
        if not out_path:
            return
        content = serialize_subtitle(parsed)
        ok, errs = verify_timecode_integrity(parsed.cues, content, Path(out_path).name)
        if not ok:
            QMessageBox.critical(self, "خطای تایم‌کد", "\n".join(errs))
            return
        Path(out_path).write_text(content, encoding="utf-8")
        QMessageBox.information(
            self,
            "خروجی موفق",
            "فایل با تایید ۱۰۰٪ یکپارچگی Timecode با موفقیت ذخیره شد.",
        )

    def _delete_current_file(self) -> None:
        if self.current_file_id is None:
            return
        self.db.delete_file(self.current_file_id)
        self.current_file_id = None
        self.cue_table.setRowCount(0)
        self._reload_file_tree()
        self.status_label.setText("فایل زیرنویس انتخاب‌شده حذف شد.")

    def _delete_current_folder(self) -> None:
        if self.current_file_id is None:
            return
        row = self.db.conn.execute(
            "SELECT folder_path FROM subtitle_files WHERE id = ?",
            (self.current_file_id,),
        ).fetchone()
        if not row:
            return
        folder_path = row["folder_path"]
        deleted = self.db.delete_folder(self.project_id, folder_path)
        self.current_file_id = None
        self.cue_table.setRowCount(0)
        self._reload_file_tree()
        self.status_label.setText(f"پوشه «{folder_path or 'ریشه'}» ({deleted} فایل) حذف شد.")
