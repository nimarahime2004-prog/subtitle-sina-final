"""Parallel translation queue orchestrator with Anti-Block Gemini RPM spacing, failover, and Pause/Resume/Stop."""

from __future__ import annotations

import asyncio
import random
import time
from collections import deque
from typing import Callable, Deque, Dict, List, Optional, Tuple

from .ai_client import MultiProviderAIClient, ProviderConfig
from .database import DatabaseManager
from .qa_validator import analyze_cue_quality


class AntiBlockRateLimiter:
    """Enforces 1 in-flight request per API key + minimum RPM spacing + jitter."""

    def __init__(self) -> None:
        self._windows: Dict[int, Deque[Tuple[float, int]]] = {}
        self._last_sent: Dict[int, float] = {}
        self._locks: Dict[int, asyncio.Lock] = {}

    def get_lock(self, provider_id: int) -> asyncio.Lock:
        if provider_id not in self._locks:
            self._locks[provider_id] = asyncio.Lock()
        return self._locks[provider_id]

    async def acquire(self, provider: ProviderConfig, est_tokens: int) -> None:
        win = self._windows.setdefault(provider.id, deque())
        is_gemini = provider.provider_type == "gemini"
        safety = 1.18 if is_gemini else 1.08
        rpm = max(1, provider.rpm_limit or (10 if is_gemini else 20))
        min_spacing = (60.0 / rpm) * safety

        while True:
            now = time.monotonic()
            last = self._last_sent.get(provider.id, 0.0)
            if last > 0 and (now - last) < min_spacing:
                await asyncio.sleep(min(1.5, min_spacing - (now - last)))
                continue

            while win and now - win[0][0] > 60.0:
                win.popleft()
            cur_rpm = len(win)
            cur_tpm = sum(t for _, t in win)
            if cur_rpm < rpm and cur_tpm + est_tokens <= provider.tpm_limit:
                if last > 0:
                    await asyncio.sleep(random.uniform(0.25, 0.75))
                ts = time.monotonic()
                self._last_sent[provider.id] = ts
                win.append((ts, est_tokens))
                return
            await asyncio.sleep(0.6)


class TranslationOrchestrator:
    def __init__(self, db: DatabaseManager, client: MultiProviderAIClient) -> None:
        self.db = db
        self.client = client
        self.limiter = AntiBlockRateLimiter()
        self._paused = asyncio.Event()
        self._paused.set()
        self._stop_requested = False

    def pause(self) -> None:
        self._paused.clear()

    def resume(self) -> None:
        self._paused.set()

    def stop(self) -> None:
        self._stop_requested = True
        self._paused.set()

    async def translate_files(
        self,
        file_ids: List[int],
        providers: List[ProviderConfig],
        max_concurrent: int = 2,
        batch_size: int = 18,
        tone: str = "documentary_direct",
        on_progress: Optional[Callable[[int, int, int, str], None]] = None,
    ) -> None:
        self._stop_requested = False
        self._paused.set()
        sem = asyncio.Semaphore(max(1, max_concurrent))

        async def _worker(fid: int) -> None:
            async with sem:
                await self._translate_single_file(
                    fid, providers, batch_size, tone, on_progress
                )

        await asyncio.gather(*[_worker(fid) for fid in file_ids])

    async def _translate_single_file(
        self,
        file_id: int,
        providers: List[ProviderConfig],
        batch_size: int,
        tone: str,
        on_progress: Optional[Callable[[int, int, int, str], None]],
    ) -> None:
        parsed = self.db.load_parsed_file(file_id)
        if not parsed:
            return
        pending = [
            c
            for c in parsed.cues
            if c.status in ("pending", "error", "incomplete")
            or not c.translated_text.strip()
        ]
        done_count = len(parsed.cues) - len(pending)

        for offset in range(0, len(pending), batch_size):
            await self._paused.wait()
            if self._stop_requested:
                return

            batch = pending[offset : offset + batch_size]
            first_i = batch[0].cue_index
            last_i = batch[-1].cue_index
            ctx_before = [
                {"i": c.cue_index, "en": c.source_text}
                for c in parsed.cues
                if first_i - 4 <= c.cue_index < first_i
            ]
            ctx_after = [
                {"i": c.cue_index, "en": c.source_text}
                for c in parsed.cues
                if last_i < c.cue_index <= last_i + 3
            ]
            targets = [{"i": c.cue_index, "en": c.source_text} for c in batch]

            for provider in providers:
                try:
                    async with self.limiter.get_lock(provider.id):
                        await self.limiter.acquire(provider, 1200)
                        translations, tokens, _latency = await self.client.translate_batch(
                            provider, ctx_before, targets, ctx_after, tone=tone
                        )
                    per_cue_tok = max(1, tokens // max(1, len(batch)))
                    for cue in batch:
                        fa = translations.get(cue.cue_index, "")
                        issues = analyze_cue_quality(cue.source_text, fa)
                        status = "done" if fa and not issues else "incomplete"
                        self.db.update_cue_translation(
                            file_id,
                            cue.cue_index,
                            fa,
                            status,
                            issues,
                            provider.name,
                            provider.model_name,
                            per_cue_tok,
                        )
                    done_count += len(batch)
                    if on_progress:
                        on_progress(
                            file_id,
                            done_count,
                            len(parsed.cues),
                            f"{provider.name} / {provider.model_name}",
                        )
                    break
                except Exception:
                    continue
