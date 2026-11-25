import type { QueueRuntimeState, SubtitleCue } from '../src/shared/types.ts';
import {
  addLog,
  db,
  getCuesByFileId,
  getFileById,
  getGlossaryForProject,
  getSettings,
  recomputeFileStats,
  resolveEffectiveTone,
  type ProviderRow,
} from './db.ts';
import { ProviderApiError, translateBatchWithProvider } from './aiProviders.ts';
import { analyzeCueQuality } from './subtitleEngine.ts';

interface RateWindowEntry {
  timestamp: number;
  tokens: number;
}

/**
 * Anti-Block Pacing Engine for Gemini & Multi-AI Providers:
 * 1. Strict per-provider in-flight lock (max 1 concurrent request per API key)
 *    so parallel files NEVER burst-collide on the same Gemini key.
 * 2. Smooth minimum spacing + random jitter between requests derived from RPM
 *    (with a 15% safety margin for Gemini anti-spam heuristics).
 * 3. Rolling 60-second RPM & TPM budget enforcement.
 * 4. Adaptive throttle multiplier if a provider ever reports 429.
 */
class AntiBlockRateLimiter {
  private windows = new Map<number, RateWindowEntry[]>();
  private lastRequestAt = new Map<number, number>();
  private inFlight = new Set<number>();
  private throttleMultiplier = new Map<number, number>();
  private consecutive429 = new Map<number, number>();

  private prune(providerId: number): RateWindowEntry[] {
    const cutoff = Date.now() - 60_000;
    const list = (this.windows.get(providerId) || []).filter(
      (e) => e.timestamp >= cutoff
    );
    this.windows.set(providerId, list);
    return list;
  }

  isBusy(providerId: number): boolean {
    return this.inFlight.has(providerId);
  }

  async acquireSlot(
    provider: ProviderRow,
    estimatedTokens: number,
    shouldAbort: () => boolean,
    onWaitNote?: (note: string) => void
  ): Promise<boolean> {
    const isGemini =
      provider.provider_type === 'gemini' ||
      provider.provider_type === 'gemini_builtin';
    // Strict hard ceiling: never exceed 10 requests/min per Gemini API key
    const rpmLimit = isGemini
      ? Math.min(10, Math.max(1, provider.rpm_limit || 10))
      : Math.max(1, provider.rpm_limit || 20);
    const tpmLimit = Math.max(2000, provider.tpm_limit || 120000);
    const mult = this.throttleMultiplier.get(provider.id) ?? 1.0;

    // Evenly space requests across the minute + safety margin (~6.7s minimum per Gemini key at 10 RPM)
    const safetyFactor = isGemini ? 1.12 : 1.08;
    const baseSpacingMs = Math.ceil((60_000 / rpmLimit) * safetyFactor * mult);

    while (!shouldAbort()) {
      // Wait for any in-flight request on this exact same API key to finish first
      if (this.inFlight.has(provider.id)) {
        if (onWaitNote) {
          onWaitNote('انتظار برای اتمام درخواست قبلی روی همین کلید API (جلوگیری از بلاک)...');
        }
        await sleep(350);
        continue;
      }

      const now = Date.now();
      const last = this.lastRequestAt.get(provider.id) ?? 0;
      const elapsedSinceLast = now - last;
      if (last > 0 && elapsedSinceLast < baseSpacingMs) {
        const remaining = baseSpacingMs - elapsedSinceLast;
        if (onWaitNote && remaining > 1200) {
          onWaitNote(
            `فاصله‌گذاری هوشمند RPM برای جلوگیری از بلاک (${Math.ceil(remaining / 1000)} ثانیه)...`
          );
        }
        await sleep(Math.min(remaining, 1500));
        continue;
      }

      const list = this.prune(provider.id);
      const currentRpm = list.length;
      const currentTpm = list.reduce((sum, e) => sum + e.tokens, 0);

      if (currentRpm < rpmLimit && currentTpm + estimatedTokens <= tpmLimit) {
        // Add subtle organic jitter (250-750ms) so requests are never machine-burst synchronized
        const jitter = 250 + Math.floor(Math.random() * 500);
        if (last > 0) await sleep(jitter);
        if (shouldAbort()) return false;

        this.inFlight.add(provider.id);
        this.lastRequestAt.set(provider.id, Date.now());
        list.push({ timestamp: Date.now(), tokens: estimatedTokens });
        this.windows.set(provider.id, list);
        return true;
      }

      const oldest = list[0]?.timestamp ?? now;
      const waitMs = Math.min(Math.max(500, 61_000 - (now - oldest)), 3000);
      if (onWaitNote) {
        onWaitNote(`کنترل سقف RPM/TPM (${currentRpm}/${rpmLimit} در دقیقه)...`);
      }
      await sleep(waitMs);
    }

    return false;
  }

  releaseSlot(providerId: number, actualTokens?: number): void {
    this.inFlight.delete(providerId);
    if (actualTokens && actualTokens > 0) {
      const list = this.prune(providerId);
      if (list.length > 0) {
        list[list.length - 1].tokens = actualTokens;
      }
    }
  }

  recordSuccess(providerId: number): void {
    this.consecutive429.set(providerId, 0);
    const mult = this.throttleMultiplier.get(providerId) ?? 1.0;
    if (mult > 1.0) {
      this.throttleMultiplier.set(providerId, Math.max(1.0, mult - 0.1));
    }
  }

  recordRateLimit(providerId: number, retryAfterSec?: number): number {
    const count = (this.consecutive429.get(providerId) ?? 0) + 1;
    this.consecutive429.set(providerId, count);
    // Step down pacing speed automatically for this key so it stays below block threshold
    const currMult = this.throttleMultiplier.get(providerId) ?? 1.0;
    this.throttleMultiplier.set(providerId, Math.min(3.0, currMult * 1.45));

    const expCooldownSec = Math.min(300, 60 * Math.pow(2, count - 1));
    return Math.max(retryAfterSec ?? 0, expCooldownSec);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface EnqueueOptions {
  fileIds: number[];
  mode: 'pending' | 'repair' | 'selective';
  selectedCueIds?: number[];
  preferredProviderId?: number | null;
}

interface QueueJob {
  fileId: number;
  mode: 'pending' | 'repair' | 'selective';
  selectedCueIds?: number[];
  preferredProviderId?: number | null;
}

interface ActiveWorkerInfo {
  fileId: number;
  fileName: string;
  providerName: string;
  modelName: string;
  batchProgress: string;
  requestStartedAtMs?: number;
  waitingNote?: string;
}

class TranslationQueueManager {
  private state: QueueRuntimeState['state'] = 'idle';
  private queue: QueueJob[] = [];
  private activeWorkers = new Map<number, ActiveWorkerInfo>();
  private totalProcessedInSession = 0;
  private startedAt: string | null = null;
  private rateLimiter = new AntiBlockRateLimiter();
  private roundRobinOffset = 0;

  getState(): QueueRuntimeState {
    const now = Date.now();
    const workers = Array.from(this.activeWorkers.values()).map((w) => {
      let note = w.waitingNote;
      if (w.requestStartedAtMs && now - w.requestStartedAtMs > 18_000) {
        const sec = Math.floor((now - w.requestStartedAtMs) / 1000);
        note =
          w.waitingNote && w.waitingNote.includes('تدریجی')
            ? w.waitingNote
            : `پاسخ API کند است (${sec} ثانیه) — ادامه انتظار صبورانه بدون قطع اتصال...`;
      }
      return { ...w, waitingNote: note };
    });

    return {
      state: this.state,
      activeFileIds: Array.from(this.activeWorkers.keys()),
      queuedFileIds: this.queue.map((q) => q.fileId),
      activeWorkers: workers,
      totalProcessedInSession: this.totalProcessedInSession,
      startedAt: this.startedAt,
    };
  }

  enqueue(options: EnqueueOptions): QueueRuntimeState {
    const existingIds = new Set([
      ...this.queue.map((q) => q.fileId),
      ...this.activeWorkers.keys(),
    ]);

    for (const fileId of options.fileIds) {
      if (existingIds.has(fileId)) continue;
      const file = getFileById(fileId);
      if (!file) continue;

      this.queue.push({
        fileId,
        mode: options.mode,
        selectedCueIds: options.selectedCueIds,
        preferredProviderId: options.preferredProviderId,
      });

      db.prepare(
        `UPDATE subtitle_files SET status = 'queued', last_error = NULL, updated_at = datetime('now') WHERE id = ?`
      ).run(fileId);
    }

    if (this.queue.length > 0 && (this.state === 'idle' || this.state === 'paused')) {
      this.state = 'running';
      if (!this.startedAt) {
        this.startedAt = new Date().toISOString();
      }
      this.pump();
    }

    return this.getState();
  }

  pause(): QueueRuntimeState {
    if (this.state === 'running') {
      this.state = 'paused';
      addLog({
        level: 'info',
        category: 'queue',
        message: 'صف ترجمه به حالت توقف موقت (Pause) در آمد.',
      });
    }
    return this.getState();
  }

  resume(): QueueRuntimeState {
    if (this.state === 'paused') {
      this.state = 'running';
      addLog({
        level: 'info',
        category: 'queue',
        message: 'صف ترجمه مجدداً از سر گرفته شد (Resume).',
      });
      this.pump();
    } else if (this.state === 'idle' && this.queue.length > 0) {
      this.state = 'running';
      this.pump();
    }
    return this.getState();
  }

  stop(): QueueRuntimeState {
    this.state = 'stopping';
    const dropped = this.queue.splice(0, this.queue.length);
    for (const job of dropped) {
      recomputeFileStats(job.fileId);
    }
    addLog({
      level: 'warn',
      category: 'queue',
      message: 'دستور توقف کامل صف ترجمه صادر شد. تمام بخش‌های ترجمه‌شده در دیتابیس ذخیره مانده‌اند.',
    });
    if (this.activeWorkers.size === 0) {
      this.state = 'idle';
      this.startedAt = null;
    }
    return this.getState();
  }

  private countUsableEnabledProviders(): number {
    const rows = db
      .prepare(
        `SELECT id, provider_type, api_key FROM api_providers
         WHERE enabled = 1 AND status != 'error'`
      )
      .all() as Array<{ id: number; provider_type: string; api_key: string }>;
    return rows.filter((p) => {
      if (p.provider_type === 'gemini_builtin') {
        return Boolean(process.env.GEMINI_API_KEY);
      }
      return Boolean(p.api_key) || p.provider_type === 'custom_proxy';
    }).length;
  }

  private pump(): void {
    if (this.state !== 'running') return;
    const settings = getSettings();
    const usableCount = this.countUsableEnabledProviders();
    // Never run more concurrent files than actual usable non-error API keys (prevents collisions on 1 key)
    const configuredConcurrency = Math.max(1, Math.min(8, settings.maxConcurrentFiles || 2));
    const concurrency = Math.max(1, Math.min(configuredConcurrency, Math.max(1, usableCount)));

    while (
      this.state === 'running' &&
      this.activeWorkers.size < concurrency &&
      this.queue.length > 0
    ) {
      const nextJob = this.queue.shift()!;
      void this.runFileWorker(nextJob);
    }

    if (this.activeWorkers.size === 0 && this.queue.length === 0) {
      this.state = 'idle';
      this.startedAt = null;
    }
  }

  private getHealthyProviders(
    preferredProviderId?: number | null,
    excludeIds?: Set<number>
  ): ProviderRow[] {
    const nowIso = new Date().toISOString();
    db.prepare(
      `UPDATE api_providers
       SET status = 'healthy', cooldown_until = NULL
       WHERE status = 'cooldown' AND cooldown_until IS NOT NULL AND cooldown_until <= ?`
    ).run(nowIso);

    // CRITICAL: Exclude status = 'error' (permanent 403 suspended / 401 invalid keys)
    // so broken keys never block the pool or burn retry attempts!
    const rows = db
      .prepare(
        `SELECT * FROM api_providers
         WHERE enabled = 1
           AND status != 'error'
           AND (cooldown_until IS NULL OR cooldown_until <= ?)
         ORDER BY priority ASC, id ASC`
      )
      .all(nowIso) as unknown as ProviderRow[];

    const usable = rows.filter((p) => {
      if (excludeIds?.has(p.id)) return false;
      if (p.provider_type === 'gemini_builtin') {
        return Boolean(process.env.GEMINI_API_KEY);
      }
      return Boolean(p.api_key) || p.provider_type === 'custom_proxy';
    });

    if (preferredProviderId) {
      const idx = usable.findIndex((p) => p.id === preferredProviderId);
      if (idx > 0) {
        const [pref] = usable.splice(idx, 1);
        usable.unshift(pref);
      }
      return usable;
    }

    // Prefer proven healthy keys and idle keys first so requests succeed on the first try
    const idleProviders = usable.filter((p) => !this.rateLimiter.isBusy(p.id));
    const busyProviders = usable.filter((p) => this.rateLimiter.isBusy(p.id));
    const ordered = [...idleProviders, ...busyProviders];

    if (idleProviders.length > 1) {
      const topPriority = idleProviders[0].priority;
      const topGroup = idleProviders.filter((p) => p.priority === topPriority);
      if (topGroup.length > 1) {
        const shift = this.roundRobinOffset % topGroup.length;
        this.roundRobinOffset += 1;
        const rotated = [...topGroup.slice(shift), ...topGroup.slice(0, shift)];
        const restIdle = idleProviders.filter((p) => p.priority !== topPriority);
        return [...rotated, ...restIdle, ...busyProviders];
      }
    }

    return ordered;
  }

  private isStopping(): boolean {
    return this.state === 'stopping';
  }

  private isPaused(): boolean {
    return this.state === 'paused';
  }

  private setWorkerNote(fileId: number, note: string | undefined): void {
    const curr = this.activeWorkers.get(fileId);
    if (curr) {
      curr.waitingNote = note;
      this.activeWorkers.set(fileId, curr);
    }
  }

  private async runFileWorker(job: QueueJob): Promise<void> {
    const file = getFileById(job.fileId);
    if (!file) {
      this.pump();
      return;
    }

    const settings = getSettings();
    const allCues = getCuesByFileId(file.id);
    const { tone, customPrompt } = resolveEffectiveTone(file.id);
    const glossary = getGlossaryForProject(file.projectId);

    const targetCues = this.selectTargetCues(allCues, job);
    if (targetCues.length === 0) {
      recomputeFileStats(file.id);
      this.pump();
      return;
    }

    this.activeWorkers.set(file.id, {
      fileId: file.id,
      fileName: file.fileName,
      providerName: 'در حال انتخاب API...',
      modelName: '—',
      batchProgress: `0 / ${targetCues.length}`,
    });

    db.prepare(
      `UPDATE subtitle_files
       SET status = 'translating', last_error = NULL, updated_at = datetime('now')
       WHERE id = ?`
    ).run(file.id);

    addLog({
      level: 'info',
      category: 'queue',
      projectId: file.projectId,
      fileId: file.id,
      message: `شروع ترجمه فایل «${file.fileName}» (${targetCues.length} خط هدف، لحن: ${tone})`,
    });

    const batchSize = Math.max(4, Math.min(80, settings.batchSize || 35));
    let processedForFile = 0;

    const processCueList = async (
      cuesToTranslate: SubtitleCue[],
      effectiveBatchSize: number,
      phaseLabel?: string
    ): Promise<boolean> => {
      let anySucceeded = false;
      let consecutiveBatchFailures = 0;
      let phaseProcessed = 0;
      const latestAll = getCuesByFileId(file.id);

      for (let offset = 0; offset < cuesToTranslate.length; offset += effectiveBatchSize) {
        while (this.isPaused()) {
          db.prepare(
            `UPDATE subtitle_files SET status = 'paused', updated_at = datetime('now') WHERE id = ?`
          ).run(file.id);
          await sleep(450);
        }

        if (this.isStopping()) {
          break;
        }

        db.prepare(
          `UPDATE subtitle_files SET status = 'translating', updated_at = datetime('now') WHERE id = ?`
        ).run(file.id);

        const batch = cuesToTranslate.slice(offset, offset + effectiveBatchSize);
        const firstIdx = batch[0].cueIndex;
        const lastIdx = batch[batch.length - 1].cueIndex;

        const contextBefore = latestAll
          .filter(
            (c) =>
              c.cueIndex >= firstIdx - settings.contextBefore &&
              c.cueIndex < firstIdx
          )
          .map((c) => ({ cueIndex: c.cueIndex, sourceText: c.sourceText }));

        const contextAfter = latestAll
          .filter(
            (c) =>
              c.cueIndex > lastIdx &&
              c.cueIndex <= lastIdx + settings.contextAfter
          )
          .map((c) => ({ cueIndex: c.cueIndex, sourceText: c.sourceText }));

        const markTranslating = db.prepare(
          `UPDATE subtitle_cues SET status = 'translating' WHERE id = ?`
        );
        for (const c of batch) {
          markTranslating.run(c.id);
        }

        const success = await this.executeBatchWithFailover({
          file,
          batch,
          contextBefore,
          contextAfter,
          tone,
          customPrompt,
          glossary,
          preferredProviderId: job.preferredProviderId,
          preserveHtmlTags: settings.preserveHtmlTags,
          maxRetries: settings.maxRetries || 4,
          adaptiveTimeoutFloorMs: settings.adaptiveProxyTimeoutMs || 300_000,
          processedBefore: phaseLabel ? phaseProcessed : processedForFile,
          totalTargets: phaseLabel ? cuesToTranslate.length : targetCues.length,
          phaseLabel,
        });

        if (success) {
          anySucceeded = true;
          consecutiveBatchFailures = 0;
        } else {
          consecutiveBatchFailures += 1;
          if (this.isStopping() || this.countUsableEnabledProviders() === 0 || consecutiveBatchFailures >= 2) {
            // Stop rushing through remaining batches when no healthy API is currently reachable
            // Leave remaining cues untouched as 'pending' so user can resume cleanly!
            break;
          }
        }
        phaseProcessed += batch.length;
        processedForFile += batch.length;
        this.totalProcessedInSession += batch.length;
      }

      return anySucceeded;
    };

    try {
      await processCueList(targetCues, batchSize);

      // Automatic multi-pass completion of any missing/incomplete/English-leftover lines BEFORE moving to the next file
      if (
        !this.isStopping() &&
        job.mode !== 'selective' &&
        settings.autoRepairIncomplete !== false
      ) {
        const MAX_AUTO_REPAIR_PASSES = 3;
        for (let pass = 1; pass <= MAX_AUTO_REPAIR_PASSES; pass++) {
          if (this.isStopping()) break;

          const currentCues = getCuesByFileId(file.id);
          const missingOrIncomplete = currentCues.filter((c) => {
            if (!c.sourceText.replace(/<[^>]+>/g, '').trim()) return false;
            if (!c.translatedText.trim()) return true;
            if (
              c.status === 'pending' ||
              c.status === 'error' ||
              c.status === 'incomplete'
            ) {
              return true;
            }
            return analyzeCueQuality(c.sourceText, c.translatedText).length > 0;
          });

          if (missingOrIncomplete.length === 0) {
            break;
          }

          addLog({
            level: 'info',
            category: 'qa',
            projectId: file.projectId,
            fileId: file.id,
            message: `تکمیل خودکار ${missingOrIncomplete.length} ردیف ناقص یا جاافتاده در «${file.fileName}» (دور ${pass} از ${MAX_AUTO_REPAIR_PASSES}) پیش از رفتن به فایل بعدی...`,
          });

          const repairBatchSize = Math.min(batchSize, 15);
          const repairedAny = await processCueList(
            missingOrIncomplete,
            repairBatchSize,
            `تکمیل خودکار ناقص‌ها (دور ${pass}/${MAX_AUTO_REPAIR_PASSES})`
          );

          if (!repairedAny) {
            break;
          }
        }
      }
    } finally {
      this.activeWorkers.delete(file.id);
      db.prepare(
        `UPDATE subtitle_cues SET status = 'pending' WHERE file_id = ? AND status = 'translating'`
      ).run(file.id);
      db.prepare(
        `UPDATE subtitle_files
         SET active_provider_name = NULL, active_model_name = NULL,
             status = CASE WHEN status = 'translating' THEN 'idle' ELSE status END
         WHERE id = ?`
      ).run(file.id);

      const updated = recomputeFileStats(file.id);
      if (updated && updated.status === 'completed') {
        addLog({
          level: 'success',
          category: 'queue',
          projectId: file.projectId,
          fileId: file.id,
          message: `ترجمه فایل «${file.fileName}» به صورت ۱۰۰٪ کامل شد (${updated.totalCues} خط، ${updated.totalTokens.toLocaleString()} توکن).`,
          tokensUsed: updated.totalTokens,
        });
      }

      if (this.isStopping() && this.activeWorkers.size === 0) {
        this.state = 'idle';
        this.startedAt = null;
      } else {
        this.pump();
      }
    }
  }

  private selectTargetCues(allCues: SubtitleCue[], job: QueueJob): SubtitleCue[] {
    if (job.mode === 'selective' && job.selectedCueIds?.length) {
      const idSet = new Set(job.selectedCueIds);
      return allCues.filter((c) => idSet.has(c.id));
    }
    if (job.mode === 'repair') {
      return allCues.filter(
        (c) =>
          c.status === 'pending' ||
          c.status === 'error' ||
          c.status === 'incomplete' ||
          c.qaIssues.length > 0 ||
          !c.translatedText.trim()
      );
    }
    return allCues.filter(
      (c) =>
        c.status === 'pending' ||
        c.status === 'error' ||
        !c.translatedText.trim()
    );
  }

  private async executeBatchWithFailover(params: {
    file: ReturnType<typeof getFileById> & object;
    batch: SubtitleCue[];
    contextBefore: Array<{ cueIndex: number; sourceText: string }>;
    contextAfter: Array<{ cueIndex: number; sourceText: string }>;
    tone: ReturnType<typeof resolveEffectiveTone>['tone'];
    customPrompt: string;
    glossary: ReturnType<typeof getGlossaryForProject>;
    preferredProviderId?: number | null;
    preserveHtmlTags: boolean;
    maxRetries: number;
    adaptiveTimeoutFloorMs: number;
    processedBefore: number;
    totalTargets: number;
    phaseLabel?: string;
  }): Promise<boolean> {
    const triedInThisBatch = new Set<number>();
    const estimatedTokens = Math.ceil(
      params.batch.reduce((s, c) => s + c.sourceText.length, 0) / 2.2 + 500
    );

    const totalUsable = Math.max(1, this.countUsableEnabledProviders());
    // Ensure we can traverse ALL enabled providers AND patiently wait through up to 3 cooldown cycles
    const maxAttempts = Math.max(params.maxRetries + 6, totalUsable * 2 + 6);
    let cooldownWaitCycles = 0;
    const MAX_COOLDOWN_WAIT_CYCLES = 3;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (this.isStopping()) return false;

      while (this.isPaused()) {
        await sleep(450);
      }
      if (this.isStopping()) return false;

      let candidates = this.getHealthyProviders(
        params.preferredProviderId,
        triedInThisBatch
      );

      // If we exhausted untried providers in this round, check if any non-excluded healthy providers exist
      // OR wait patiently for the soonest provider in temporary cooldown (429 / 503) to recover!
      if (candidates.length === 0) {
        triedInThisBatch.clear();
        candidates = this.getHealthyProviders(params.preferredProviderId);
      }

      if (candidates.length === 0) {
        const soonest = db
          .prepare(
            `SELECT name, cooldown_until FROM api_providers
             WHERE enabled = 1 AND status = 'cooldown' AND cooldown_until IS NOT NULL
             ORDER BY cooldown_until ASC LIMIT 1`
          )
          .get() as { name: string; cooldown_until: string } | undefined;

        if (soonest?.cooldown_until && cooldownWaitCycles < MAX_COOLDOWN_WAIT_CYCLES) {
          cooldownWaitCycles += 1;
          const totalWaitMs = Math.min(
            Math.max(3000, Date.parse(soonest.cooldown_until) - Date.now() + 1500),
            95_000
          );
          const endWaitAt = Date.now() + totalWaitMs;
          addLog({
            level: 'info',
            category: 'queue',
            projectId: params.file.projectId,
            fileId: params.file.id,
            message: `همه کلیدهای سالم موقتاً در استراحت Rate Limit هستند — انتظار صبورانه ${Math.ceil(totalWaitMs / 1000)} ثانیه‌ای تا آماده شدن «${soonest.name}» (دور ${cooldownWaitCycles}/${MAX_COOLDOWN_WAIT_CYCLES})...`,
          });

          while (Date.now() < endWaitAt && !this.isStopping()) {
            const remSec = Math.max(1, Math.ceil((endWaitAt - Date.now()) / 1000));
            this.setWorkerNote(
              params.file.id,
              `انتظار صبورانه تا پایان استراحت «${soonest.name}» (${remSec} ثانیه باقیمانده)...`
            );
            await sleep(1000);
          }

          if (this.isStopping()) return false;
          candidates = this.getHealthyProviders(params.preferredProviderId);
        }
      }

      if (candidates.length === 0) {
        const msg =
          'هیچ کلید API سالم و فعالی باقی نمانده است (کلیدهای 403 مسدود به‌صورت خودکار قرنطینه شدند). لطفاً در بخش گزارش‌ها ابزار عیب‌یابی را بررسی و کلید سالم جایگزین کنید.';
        this.markBatchError(params.file.id, params.batch, msg);
        addLog({
          level: 'error',
          category: 'api',
          projectId: params.file.projectId,
          fileId: params.file.id,
          message: msg,
        });
        return false;
      }

      const provider = candidates[0];
      triedInThisBatch.add(provider.id);

      this.activeWorkers.set(params.file.id, {
        fileId: params.file.id,
        fileName: params.file.fileName,
        providerName: provider.name,
        modelName: provider.model_name,
        batchProgress: `${Math.min(params.processedBefore + params.batch.length, params.totalTargets)} / ${params.totalTargets}`,
        waitingNote: params.phaseLabel
          ? `${params.phaseLabel} — تنظیم نرخ RPM...`
          : 'تنظیم نرخ ایمن RPM پیش از ارسال...',
      });
      db.prepare(
        `UPDATE subtitle_files
         SET active_provider_name = ?, active_model_name = ?, updated_at = datetime('now')
         WHERE id = ?`
      ).run(provider.name, provider.model_name, params.file.id);

      const acquired = await this.rateLimiter.acquireSlot(
        provider,
        estimatedTokens,
        () => this.isStopping(),
        (note) => this.setWorkerNote(params.file.id, note)
      );
      if (!acquired || this.isStopping()) return false;

      // Mark exact send timestamp so slow-proxy elapsed UI works accurately
      const worker = this.activeWorkers.get(params.file.id);
      if (worker) {
        worker.requestStartedAtMs = Date.now();
        worker.waitingNote = `درخواست به «${provider.name}» ارسال شد — منتظر دریافت کامل پاسخ...`;
        this.activeWorkers.set(params.file.id, worker);
      }

      try {
        const result = await translateBatchWithProvider({
          provider,
          tone: params.tone,
          customTonePrompt: params.customPrompt,
          glossary: params.glossary,
          contextBefore: params.contextBefore,
          targets: params.batch.map((c) => ({
            cueIndex: c.cueIndex,
            sourceText: c.sourceText,
          })),
          contextAfter: params.contextAfter,
          preserveHtmlTags: params.preserveHtmlTags,
          adaptiveTimeoutFloorMs: params.adaptiveTimeoutFloorMs,
          onProgressNote: (note) => this.setWorkerNote(params.file.id, note),
        });

        this.rateLimiter.releaseSlot(provider.id, result.totalTokens);
        this.rateLimiter.recordSuccess(provider.id);

        const costUsd =
          (result.inputTokens / 1_000_000) * (provider.input_price_per_1m || 0) +
          (result.outputTokens / 1_000_000) * (provider.output_price_per_1m || 0);

        const perCueTokens = Math.max(
          1,
          Math.round(result.totalTokens / Math.max(1, params.batch.length))
        );

        const updateCue = db.prepare(
          `UPDATE subtitle_cues
           SET translated_text = ?, status = ?, qa_issues_json = ?,
               provider_used = ?, model_used = ?, tokens_used = ?,
               updated_at = datetime('now')
           WHERE id = ?`
        );

        db.exec('BEGIN');
        try {
          for (const cue of params.batch) {
            const translated = result.translations.get(cue.cueIndex) ?? '';
            if (translated.trim().length > 0) {
              const issues = analyzeCueQuality(cue.sourceText, translated);
              const nextStatus = issues.length > 0 ? 'incomplete' : 'done';
              updateCue.run(
                translated,
                nextStatus,
                JSON.stringify(issues),
                provider.name,
                result.modelUsed,
                perCueTokens,
                cue.id
              );
            } else {
              const issues = analyzeCueQuality(cue.sourceText, '');
              updateCue.run(
                '',
                'incomplete',
                JSON.stringify(issues),
                provider.name,
                result.modelUsed,
                0,
                cue.id
              );
            }
          }

          db.prepare(
            `UPDATE api_providers
             SET status = 'healthy', last_latency_ms = ?, last_error = NULL,
                 total_requests = total_requests + 1,
                 total_tokens = total_tokens + ?,
                 cooldown_until = NULL
             WHERE id = ?`
          ).run(result.latencyMs, result.totalTokens, provider.id);

          db.prepare(
            `UPDATE subtitle_files
             SET estimated_cost_usd = estimated_cost_usd + ?, updated_at = datetime('now')
             WHERE id = ?`
          ).run(costUsd, params.file.id);

          db.exec('COMMIT');
        } catch (dbErr) {
          db.exec('ROLLBACK');
          throw dbErr;
        }

        recomputeFileStats(params.file.id);

        if (result.fallbackFromModel) {
          db.prepare(
            `UPDATE subtitle_files SET active_model_name = ? WHERE id = ?`
          ).run(result.modelUsed, params.file.id);
          addLog({
            level: 'warn',
            category: 'api',
            projectId: params.file.projectId,
            fileId: params.file.id,
            providerName: provider.name,
            modelName: result.modelUsed,
            message: `مدل ${result.fallbackFromModel} با خطای 503/شلوغی مواجه شد — سوئیچ خودکار به ${result.modelUsed} با موفقیت انجام شد.`,
          });
        }

        addLog({
          level: 'info',
          category: 'api',
          projectId: params.file.projectId,
          fileId: params.file.id,
          providerName: provider.name,
          modelName: result.modelUsed,
          message: `${params.phaseLabel ? `[${params.phaseLabel}] ` : ''}بسته ${params.batch.length} خطی از «${params.file.fileName}» ترجمه شد (${result.translations.size}/${params.batch.length} خط معتبر، زمان پاسخ ${(result.latencyMs / 1000).toFixed(1)}s).`,
          tokensUsed: result.totalTokens,
          latencyMs: result.latencyMs,
        });

        return true;
      } catch (err) {
        this.rateLimiter.releaseSlot(provider.id);

        const apiErr =
          err instanceof ProviderApiError
            ? err
            : new ProviderApiError(err instanceof Error ? err.message : String(err), {
                retryable: true,
              });

        if (apiErr.isRateLimit) {
          const cooldownSec = this.rateLimiter.recordRateLimit(
            provider.id,
            apiErr.retryAfterSec
          );
          const cooldownUntil = new Date(Date.now() + cooldownSec * 1000).toISOString();
          db.prepare(
            `UPDATE api_providers
             SET status = 'cooldown', cooldown_until = ?, last_error = ?
             WHERE id = ?`
          ).run(cooldownUntil, apiErr.message, provider.id);

          addLog({
            level: 'warn',
            category: 'api',
            projectId: params.file.projectId,
            fileId: params.file.id,
            providerName: provider.name,
            modelName: provider.model_name,
            message: `محدودیت نرخ یا سهمیه (429) در «${provider.name}» — استراحت ایمن ${cooldownSec} ثانیه‌ای و سوئیچ خودکار به API بعدی.`,
          });
        } else if (apiErr.isAuthError) {
          // Quarantine permanent 401/403 (e.g., CONSUMER_SUSPENDED / API_KEY_INVALID) out of active rotation
          // Keep builtin enabled=1 only in case env key changes, but status='error' excludes it from getHealthyProviders
          const disableOnAuthErr = provider.provider_type !== 'gemini_builtin' ? 0 : 1;
          db.prepare(
            `UPDATE api_providers
             SET status = 'error', enabled = ?, cooldown_until = NULL, last_error = ?
             WHERE id = ?`
          ).run(disableOnAuthErr, apiErr.message, provider.id);

          addLog({
            level: 'error',
            category: 'api',
            projectId: params.file.projectId,
            fileId: params.file.id,
            providerName: provider.name,
            modelName: provider.model_name,
            message: `کلید «${provider.name}» به دلیل خطای دائمی احراز هویت/تعلیق (${apiErr.statusCode}) از چرخه حذف شد — سوئیچ خودکار به API بعدی: ${apiErr.message}`,
          });

          // Don't burn retry attempts on permanently dead keys!
          attempt -= 1;
        } else {
          const cooldownUntil = new Date(Date.now() + 25_000).toISOString();
          db.prepare(
            `UPDATE api_providers
             SET status = 'cooldown', cooldown_until = ?, last_error = ?
             WHERE id = ?`
          ).run(cooldownUntil, apiErr.message, provider.id);

          addLog({
            level: 'warn',
            category: 'api',
            projectId: params.file.projectId,
            fileId: params.file.id,
            providerName: provider.name,
            modelName: provider.model_name,
            message: `تأخیر یا خطا (${apiErr.statusCode}) در «${provider.name}» — سوئیچ خودکار به API بعدی: ${apiErr.message}`,
          });
        }
      }
    }

    const finalMsg =
      'تلاش‌های متعدد برای ترجمه این بسته ناموفق بود. لطفاً وضعیت کلیدها را در ابزار عیب‌یابی «گزارش‌ها» بررسی کرده و سپس «تکمیل موارد ناقص» را بزنید.';
    this.markBatchError(params.file.id, params.batch, finalMsg);
    return false;
  }

  private markBatchError(fileId: number, batch: SubtitleCue[], message: string): void {
    const stmt = db.prepare(
      `UPDATE subtitle_cues SET status = 'error', updated_at = datetime('now') WHERE id = ?`
    );
    for (const c of batch) {
      stmt.run(c.id);
    }
    db.prepare(
      `UPDATE subtitle_files SET last_error = ?, updated_at = datetime('now') WHERE id = ?`
    ).run(message, fileId);
    recomputeFileStats(fileId);
  }
}

export const translationManager = new TranslationQueueManager();
