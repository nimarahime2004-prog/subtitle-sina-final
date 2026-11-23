"""Quality Assurance analyzer & Persian-aware exact Find & Replace."""

from __future__ import annotations

import re
from typing import Dict, List, Tuple

ARTIFACT_PATTERNS = [
    re.compile(r"^(?:ترجمه|پاسخ|زیرنویس)\s*[:：]"),
    re.compile(r"^(?:translation|here is the translation)\s*[:：]", re.IGNORECASE),
    re.compile(r"```"),
    re.compile(r"^\[\d+\]\s*"),
]

# Includes Persian/Arabic letters, ZWNJ (\u200c), Latin letters, digits, underscore
WORD_CHAR = r"[\u0600-\u06FF\u0750-\u077F\uFB50-\uFDFF\uFE70-\uFEFF\u200CA-Za-z0-9_]"


def analyze_cue_quality(source_text: str, translated_text: str) -> List[Dict[str, str]]:
    """Detect empty, untranslated English, truncated, artifact, or broken-tag cues."""
    issues: List[Dict[str, str]] = []
    src_clean = re.sub(r"<[^>]+>", "", source_text).strip()
    tr_clean = re.sub(r"<[^>]+>", "", translated_text or "").strip()

    if not src_clean:
        return issues

    if not tr_clean:
        return [{"code": "empty", "message": "متن فارسی خالی است"}]

    latin_chars = len(re.findall(r"[A-Za-z]", tr_clean))
    persian_chars = len(re.findall(r"[\u0600-\u06FF]", tr_clean))
    if re.search(r"[A-Za-z]{2,}", src_clean) and latin_chars >= 4:
        ratio = latin_chars / max(1, latin_chars + persian_chars)
        if persian_chars == 0 or ratio > 0.35:
            issues.append(
                {
                    "code": "untranslated_english",
                    "message": "بخش قابل توجهی از متن انگلیسی باقی مانده است",
                }
            )

    if len(src_clean) >= 40 and len(tr_clean) < max(6, int(len(src_clean) * 0.18)):
        issues.append(
            {
                "code": "truncated",
                "message": "ترجمه بیش از حد کوتاه یا ناقص است",
            }
        )

    for rx in ARTIFACT_PATTERNS:
        if rx.search(tr_clean):
            issues.append(
                {
                    "code": "ai_artifact",
                    "message": "پیشوند یا متن اضافی هوش مصنوعی شناسایی شد",
                }
            )
            break

    open_i = len(re.findall(r"<i>", translated_text, re.IGNORECASE))
    close_i = len(re.findall(r"</i>", translated_text, re.IGNORECASE))
    if open_i != close_i:
        issues.append(
            {
                "code": "unbalanced_tags",
                "message": "تگ‌های <i> در ترجمه متوازن نیستند",
            }
        )

    return issues


def exact_find_replace(
    text: str,
    find_text: str,
    replace_text: str,
    whole_word: bool = True,
    case_sensitive: bool = False,
) -> Tuple[str, int]:
    """Unicode-aware Persian + English Find & Replace without corrupting partial words."""
    if not find_text:
        return text, 0
    escaped = re.escape(find_text)
    flags = 0 if case_sensitive else re.IGNORECASE
    pattern = (
        f"(?<!{WORD_CHAR}){escaped}(?!{WORD_CHAR})" if whole_word else escaped
    )
    rx = re.compile(pattern, flags)
    return rx.subn(lambda _m: replace_text, text)
