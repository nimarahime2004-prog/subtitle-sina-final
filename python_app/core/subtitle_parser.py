"""SRT & VTT parser and 100% immutable timecode rebuilder."""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import List, Tuple

TIMECODE_LINE_RE = re.compile(
    r"^\s*((?:\d{1,2}:)?\d{2}:\d{2}[.,]\d{3})\s*-->\s*((?:\d{1,2}:)?\d{2}:\d{2}[.,]\d{3})(.*)$"
)


def parse_timestamp_ms(raw: str) -> int:
    normalized = raw.strip().replace(",", ".")
    parts = normalized.split(":")
    hours = 0
    minutes = 0
    sec_ms = "0.000"
    if len(parts) == 3:
        hours = int(parts[0])
        minutes = int(parts[1])
        sec_ms = parts[2]
    elif len(parts) == 2:
        minutes = int(parts[0])
        sec_ms = parts[1]
    sec_parts = sec_ms.split(".")
    seconds = int(sec_parts[0]) if sec_parts[0] else 0
    ms_str = (sec_parts[1] if len(sec_parts) > 1 else "0").ljust(3, "0")[:3]
    return ((hours * 3600 + minutes * 60 + seconds) * 1000) + int(ms_str)


@dataclass
class SubtitleCue:
    cue_index: int
    cue_identifier: str
    raw_timecode_line: str
    start_ms: int
    end_ms: int
    source_text: str
    translated_text: str = ""
    status: str = "pending"
    qa_issues: List[dict] = field(default_factory=list)


@dataclass
class ParsedSubtitle:
    fmt: str  # "srt" | "vtt"
    file_header: str
    line_ending: str  # "\r\n" | "\n"
    cues: List[SubtitleCue]


def parse_subtitle_content(content: str, filename: str) -> ParsedSubtitle:
    """Parse SRT/VTT preserving exact timecode lines, cue IDs, headers, and EOL."""
    has_bom = content.startswith("\ufeff")
    line_ending = "\r\n" if "\r\n" in content else "\n"
    normalized = content.replace("\r\n", "\n").replace("\r", "\n")
    clean = normalized[1:] if has_bom else normalized

    is_vtt = filename.lower().endswith(".vtt") or clean.lstrip().startswith("WEBVTT")
    fmt = "vtt" if is_vtt else "srt"

    blocks = re.split(r"\n{2,}", clean)
    header_blocks: List[str] = []
    cues: List[SubtitleCue] = []
    reached_first_cue = False

    for raw_block in blocks:
        if not raw_block.strip():
            continue
        lines = raw_block.split("\n")
        tc_idx = -1
        for i, line in enumerate(lines):
            if TIMECODE_LINE_RE.match(line):
                tc_idx = i
                break

        if tc_idx == -1:
            if not reached_first_cue:
                header_blocks.append(raw_block)
            elif cues and fmt == "srt":
                cues[-1].source_text += "\n\n" + raw_block
            continue

        reached_first_cue = True
        raw_tc_line = lines[tc_idx]
        m = TIMECODE_LINE_RE.match(raw_tc_line)
        start_ms = parse_timestamp_ms(m.group(1)) if m else 0
        end_ms = parse_timestamp_ms(m.group(2)) if m else 0

        id_lines = [l for l in lines[:tc_idx] if l.strip()]
        cue_identifier = "\n".join(id_lines).strip()
        source_text = "\n".join(lines[tc_idx + 1 :])

        cues.append(
            SubtitleCue(
                cue_index=len(cues),
                cue_identifier=cue_identifier,
                raw_timecode_line=raw_tc_line,
                start_ms=start_ms,
                end_ms=end_ms,
                source_text=source_text,
            )
        )

    file_header = "\n\n".join(header_blocks)
    if fmt == "vtt" and not file_header.lstrip().startswith("WEBVTT"):
        file_header = f"WEBVTT\n\n{file_header}" if file_header else "WEBVTT"
    if has_bom:
        file_header = "\ufeff" + file_header

    return ParsedSubtitle(
        fmt=fmt,
        file_header=file_header,
        line_ending=line_ending,
        cues=cues,
    )


def serialize_subtitle(
    parsed: ParsedSubtitle,
    fallback_to_source: bool = True,
    bilingual: bool = False,
) -> str:
    """Rebuild SRT/VTT using 100% untouched original headers, cue IDs, and timecodes."""
    eol = "\r\n" if parsed.line_ending == "\r\n" else "\n"
    sorted_cues = sorted(parsed.cues, key=lambda c: c.cue_index)
    parts: List[str] = []

    if parsed.file_header:
        parts.append(parsed.file_header.replace("\r\n", "\n").replace("\n", eol))
    elif parsed.fmt == "vtt":
        parts.append("WEBVTT")

    for idx, cue in enumerate(sorted_cues):
        has_tr = bool(cue.translated_text and cue.translated_text.strip())
        if has_tr:
            body = (
                f"{cue.translated_text}\n{cue.source_text}"
                if bilingual
                else cue.translated_text
            )
        else:
            body = cue.source_text if fallback_to_source else ""

        lines: List[str] = []
        if cue.cue_identifier:
            lines.append(cue.cue_identifier.replace("\r\n", "\n").replace("\n", eol))
        elif parsed.fmt == "srt":
            lines.append(str(idx + 1))

        # 100% immutable raw timecode line
        lines.append(cue.raw_timecode_line)
        lines.append(body.replace("\r\n", "\n").replace("\n", eol))
        parts.append(eol.join(lines))

    return (eol + eol).join(parts) + eol


def verify_timecode_integrity(
    original_cues: List[SubtitleCue], exported_content: str, filename: str
) -> Tuple[bool, List[str]]:
    """Verify 100% byte-for-byte preservation of cue count, IDs, and timecode lines."""
    reparsed = parse_subtitle_content(exported_content, filename)
    errors: List[str] = []
    sorted_orig = sorted(original_cues, key=lambda c: c.cue_index)

    if len(sorted_orig) != len(reparsed.cues):
        errors.append(
            f"Cue count mismatch: expected {len(sorted_orig)}, got {len(reparsed.cues)}"
        )

    for i in range(min(len(sorted_orig), len(reparsed.cues))):
        o = sorted_orig[i]
        e = reparsed.cues[i]
        if o.raw_timecode_line != e.raw_timecode_line:
            errors.append(
                f"Cue {i} timecode changed: '{o.raw_timecode_line}' != '{e.raw_timecode_line}'"
            )
        if o.cue_identifier and o.cue_identifier != e.cue_identifier:
            errors.append(
                f"Cue {i} identifier changed: '{o.cue_identifier}' != '{e.cue_identifier}'"
            )

    return (len(errors) == 0, errors)
