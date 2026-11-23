import type { QaIssue, SubtitleFormat } from '../src/shared/types.ts';

export interface ParsedCue {
  cueIndex: number;
  cueIdentifier: string;
  rawTimecodeLine: string;
  startMs: number;
  endMs: number;
  sourceText: string;
}

export interface ParsedSubtitleFile {
  format: SubtitleFormat;
  fileHeader: string;
  lineEnding: '\r\n' | '\n';
  cues: ParsedCue[];
}

const TIMECODE_LINE_REGEX =
  /^\s*((?:\d{1,2}:)?\d{2}:\d{2}[.,]\d{3})\s*-->\s*((?:\d{1,2}:)?\d{2}:\d{2}[.,]\d{3})(.*)$/;

export function parseTimestampToMs(raw: string): number {
  const normalized = raw.trim().replace(',', '.');
  const parts = normalized.split(':');
  let hours = 0;
  let minutes = 0;
  let secMs = '0.000';
  if (parts.length === 3) {
    hours = Number(parts[0]) || 0;
    minutes = Number(parts[1]) || 0;
    secMs = parts[2] || '0.000';
  } else if (parts.length === 2) {
    minutes = Number(parts[0]) || 0;
    secMs = parts[1] || '0.000';
  }
  const [secStr, msStr] = secMs.split('.');
  const seconds = Number(secStr) || 0;
  const ms = Number((msStr || '0').padEnd(3, '0').slice(0, 3)) || 0;
  return ((hours * 3600 + minutes * 60 + seconds) * 1000) + ms;
}

/**
 * Parses SRT or VTT files while preserving 100% of original timing lines,
 * cue identifiers, WebVTT headers/styles/notes, and original line endings.
 */
export function parseSubtitleContent(
  content: string,
  fileName: string
): ParsedSubtitleFile {
  const hasBom = content.startsWith('\uFEFF');
  const lineEnding: '\r\n' | '\n' = content.includes('\r\n') ? '\r\n' : '\n';
  const normalized = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const cleanContent = hasBom ? normalized.slice(1) : normalized;

  const isVtt =
    fileName.toLowerCase().endsWith('.vtt') ||
    cleanContent.trimStart().startsWith('WEBVTT');
  const format: SubtitleFormat = isVtt ? 'vtt' : 'srt';

  const blocks = cleanContent.split(/\n{2,}/);
  const headerBlocks: string[] = [];
  const cues: ParsedCue[] = [];
  let reachedFirstCue = false;

  for (const rawBlock of blocks) {
    const trimmedBlock = rawBlock.trim();
    if (!trimmedBlock) continue;

    const lines = rawBlock.split('\n');
    let timecodeLineIdx = -1;
    for (let i = 0; i < lines.length; i++) {
      if (TIMECODE_LINE_REGEX.test(lines[i])) {
        timecodeLineIdx = i;
        break;
      }
    }

    if (timecodeLineIdx === -1) {
      // VTT header, NOTE, STYLE, REGION before first cue
      if (!reachedFirstCue) {
        headerBlocks.push(rawBlock);
      } else if (cues.length > 0 && format === 'srt') {
        // Rare case: empty-line inside SRT text block — append safely without changing timecode
        cues[cues.length - 1].sourceText += '\n\n' + rawBlock;
      }
      continue;
    }

    reachedFirstCue = true;
    const rawTimecodeLine = lines[timecodeLineIdx];
    const match = rawTimecodeLine.match(TIMECODE_LINE_REGEX);
    const startMs = match ? parseTimestampToMs(match[1]) : 0;
    const endMs = match ? parseTimestampToMs(match[2]) : 0;

    const identifierLines = lines
      .slice(0, timecodeLineIdx)
      .filter((l) => l.trim().length > 0);
    const cueIdentifier = identifierLines.join('\n').trim();
    const sourceText = lines.slice(timecodeLineIdx + 1).join('\n');

    cues.push({
      cueIndex: cues.length,
      cueIdentifier,
      rawTimecodeLine,
      startMs,
      endMs,
      sourceText,
    });
  }

  let fileHeader = headerBlocks.join('\n\n');
  if (format === 'vtt' && !fileHeader.trimStart().startsWith('WEBVTT')) {
    fileHeader = fileHeader ? `WEBVTT\n\n${fileHeader}` : 'WEBVTT';
  }
  if (hasBom) {
    fileHeader = '\uFEFF' + fileHeader;
  }

  return {
    format,
    fileHeader,
    lineEnding,
    cues,
  };
}

export interface SerializableCue {
  cueIndex: number;
  cueIdentifier: string;
  rawTimecodeLine: string;
  sourceText: string;
  translatedText: string;
}

/**
 * Rebuilds SRT or VTT strictly from the immutable stored fileHeader,
 * cueIdentifier, rawTimecodeLine, and lineEnding.
 */
export function serializeSubtitleFile(params: {
  format: SubtitleFormat;
  fileHeader: string;
  lineEnding: string;
  cues: SerializableCue[];
  fallbackToSource?: boolean;
  bilingual?: boolean;
}): string {
  const eol = params.lineEnding === '\r\n' ? '\r\n' : '\n';
  const sorted = [...params.cues].sort((a, b) => a.cueIndex - b.cueIndex);

  const parts: string[] = [];
  if (params.fileHeader && params.fileHeader.length > 0) {
    parts.push(params.fileHeader.replace(/\r?\n/g, eol));
  } else if (params.format === 'vtt') {
    parts.push('WEBVTT');
  }

  for (let i = 0; i < sorted.length; i++) {
    const cue = sorted[i];
    const hasTranslation = cue.translatedText && cue.translatedText.trim().length > 0;
    let bodyText = hasTranslation
      ? cue.translatedText
      : params.fallbackToSource !== false
        ? cue.sourceText
        : '';

    if (params.bilingual && hasTranslation) {
      bodyText = `${cue.translatedText}\n${cue.sourceText}`;
    }

    const lines: string[] = [];
    if (cue.cueIdentifier && cue.cueIdentifier.length > 0) {
      lines.push(cue.cueIdentifier.replace(/\r?\n/g, eol));
    } else if (params.format === 'srt') {
      lines.push(String(i + 1));
    }
    // 100% untouched original raw timecode line
    lines.push(cue.rawTimecodeLine);
    lines.push(bodyText.replace(/\r?\n/g, eol));

    parts.push(lines.join(eol));
  }

  return parts.join(eol + eol) + eol;
}

export interface TimecodeIntegrityReport {
  valid: boolean;
  originalCount: number;
  exportedCount: number;
  mismatches: Array<{
    cueIndex: number;
    expectedTimecode: string;
    actualTimecode: string;
    expectedId: string;
    actualId: string;
  }>;
}

/**
 * Parses the generated subtitle output back and verifies byte-for-byte
 * that count, ordering, identifiers, and rawTimecodeLines are 100% identical.
 */
export function verifyTimecodeIntegrity(
  originalCues: SerializableCue[],
  exportedContent: string,
  fileName: string
): TimecodeIntegrityReport {
  const reparsed = parseSubtitleContent(exportedContent, fileName);
  const sorted = [...originalCues].sort((a, b) => a.cueIndex - b.cueIndex);
  const mismatches: TimecodeIntegrityReport['mismatches'] = [];

  const maxLen = Math.max(sorted.length, reparsed.cues.length);
  for (let i = 0; i < maxLen; i++) {
    const orig = sorted[i];
    const exp = reparsed.cues[i];
    if (!orig || !exp) {
      mismatches.push({
        cueIndex: i,
        expectedTimecode: orig?.rawTimecodeLine ?? '<missing>',
        actualTimecode: exp?.rawTimecodeLine ?? '<missing>',
        expectedId: orig?.cueIdentifier ?? '<missing>',
        actualId: exp?.cueIdentifier ?? '<missing>',
      });
      continue;
    }
    if (
      orig.rawTimecodeLine !== exp.rawTimecodeLine ||
      (orig.cueIdentifier && orig.cueIdentifier !== exp.cueIdentifier)
    ) {
      mismatches.push({
        cueIndex: i,
        expectedTimecode: orig.rawTimecodeLine,
        actualTimecode: exp.rawTimecodeLine,
        expectedId: orig.cueIdentifier,
        actualId: exp.cueIdentifier,
      });
    }
  }

  return {
    valid: mismatches.length === 0 && sorted.length === reparsed.cues.length,
    originalCount: sorted.length,
    exportedCount: reparsed.cues.length,
    mismatches,
  };
}

const ARTIFACT_PATTERNS = [
  /^(?:ترجمه|پاسخ|زیرنویس)\s*[:：]/,
  /^(?:translation|here is the translation|translated text)\s*[:：]/i,
  /```/,
  /^\[\d+\]\s*/,
];

/**
 * Inspects a cue translation to detect empty text, leftover English,
 * truncated translations, AI meta-artifacts, or broken HTML tags.
 */
export function analyzeCueQuality(
  sourceText: string,
  translatedText: string
): QaIssue[] {
  const issues: QaIssue[] = [];
  const srcClean = sourceText.replace(/<[^>]+>/g, '').trim();
  const trClean = translatedText.replace(/<[^>]+>/g, '').trim();

  if (!srcClean) {
    return issues;
  }

  if (!trClean) {
    issues.push({
      code: 'empty',
      messageFa: 'متن فارسی خالی است و هنوز ترجمه نشده',
    });
    return issues;
  }

  const latinChars = (trClean.match(/[A-Za-z]/g) || []).length;
  const persianChars = (trClean.match(/[\u0600-\u06FF]/g) || []).length;
  const srcHasLetters = /[A-Za-z]{2,}/.test(srcClean);

  if (srcHasLetters && latinChars >= 4) {
    const latinRatio = latinChars / Math.max(1, latinChars + persianChars);
    if (persianChars === 0 || latinRatio > 0.35) {
      issues.push({
        code: 'untranslated_english',
        messageFa: 'بخش قابل توجهی از متن انگلیسی بدون ترجمه باقی مانده است',
      });
    }
  }

  // Check severe truncation on substantial lines
  if (srcClean.length >= 40 && trClean.length < Math.max(6, srcClean.length * 0.18)) {
    issues.push({
      code: 'truncated',
      messageFa: 'ترجمه نسبت به متن اصلی بیش از حد کوتاه یا ناقص به نظر می‌رسد',
    });
  }

  // Check AI commentary artifacts
  for (const rx of ARTIFACT_PATTERNS) {
    if (rx.test(trClean)) {
      issues.push({
        code: 'ai_artifact',
        messageFa: 'عبارت اضافی هوش مصنوعی (مانند پیشوند ترجمه یا کد) شناسایی شد',
      });
      break;
    }
  }

  // Check basic inline tag balance (e.g. <i> ... </i>)
  const openI = (translatedText.match(/<i>/gi) || []).length;
  const closeI = (translatedText.match(/<\/i>/gi) || []).length;
  if (openI !== closeI) {
    issues.push({
      code: 'unbalanced_tags',
      messageFa: 'تگ‌های قالب‌بندی (مانند <i>) در ترجمه متوازن نیستند',
    });
  }

  return issues;
}

/**
 * Unicode-aware exact Find & Replace for Persian & English.
 * Prevents partial matches inside longer words (including Persian ZWNJ \u200C).
 */
const WORD_CHAR_CLASS = '[\\u0600-\\u06FF\\u0750-\\u077F\\uFB50-\\uFDFF\\uFE70-\\uFEFF\\u200CA-Za-z0-9_]';

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function buildExactSearchRegex(
  query: string,
  options: { wholeWord: boolean; caseSensitive: boolean }
): RegExp {
  const escaped = escapeRegExp(query);
  const flags = options.caseSensitive ? 'gu' : 'giu';
  if (!options.wholeWord) {
    return new RegExp(escaped, flags);
  }
  return new RegExp(
    `(?<!${WORD_CHAR_CLASS})${escaped}(?!${WORD_CHAR_CLASS})`,
    flags
  );
}

export function applyExactFindReplace(
  text: string,
  findText: string,
  replaceText: string,
  options: { wholeWord: boolean; caseSensitive: boolean }
): { updated: string; count: number } {
  if (!findText) return { updated: text, count: 0 };
  const rx = buildExactSearchRegex(findText, options);
  let count = 0;
  const updated = text.replace(rx, () => {
    count += 1;
    return replaceText;
  });
  return { updated, count };
}
