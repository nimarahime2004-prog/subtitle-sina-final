"""Multi-provider async AI client (Gemini, OpenAI, DeepSeek, OpenRouter, Proxies)."""

from __future__ import annotations

import json
import re
import time
from dataclasses import dataclass
from typing import Dict, List, Optional, Tuple

import httpx

TONE_INSTRUCTIONS = {
    "documentary_direct": "Use crisp, direct, unembellished documentary Persian (فارسی مستند، صریح، شفاف و بی‌پیرایه). Translate exact meaning and bluntness faithfully without softening, censoring, or filler.",
    "conversational": "Use natural, fluid spoken Persian (محاوره‌ای استاندارد و خوانا برای زیرنویس).",
    "formal": "Use polished standard written Persian (فارسی معیار و رسمی).",
    "scientific": "Use accurate academic and scientific Persian preserving technical precision.",
    "philosophical": "Use nuanced, articulate Persian suited to philosophical discourse.",
    "spiritual": "Use serene, dignified, resonant Persian suited to contemplative and spiritual content.",
    "cinematic": "Use expressive Persian cinema subtitling preserving emotional subtext and pacing.",
}


@dataclass
class ProviderConfig:
    id: int
    name: str
    provider_type: str  # gemini | openai | deepseek | openrouter | custom_proxy
    base_url: str
    api_key: str
    model_name: str = "gemini-3.5-flash-lite"
    rpm_limit: int = 10
    tpm_limit: int = 120000
    timeout_sec: int = 300


class MultiProviderAIClient:
    """Calls Gemini or OpenAI-compatible APIs with proxy-tolerant timeouts."""

    def build_system_prompt(
        self,
        tone: str,
        custom_prompt: str = "",
        glossary: Optional[List[Tuple[str, str]]] = None,
    ) -> str:
        tone_guide = custom_prompt.strip() if tone == "custom" and custom_prompt.strip() else TONE_INSTRUCTIONS.get(tone, TONE_INSTRUCTIONS["conversational"])
        glossary_lines = ""
        if glossary:
            glossary_lines = "\nMANDATORY GLOSSARY:\n" + "\n".join(
                f'- "{en}" => "{fa}"' for en, fa in glossary
            )
        return (
            "You are an expert English-to-Persian subtitle translator.\n"
            "RULES:\n"
            "1. Translate ONLY items in `targets`. Use `context_before` and `context_after` strictly for context.\n"
            "2. Keep every cue index `i` strictly 1-to-1. Never merge, skip, summarize, or add commentary.\n"
            "3. Produce natural, idiomatic Persian with proper half-space (نیم‌فاصله) and preserve inline <i> tags.\n"
            f"4. TONE: {tone_guide}{glossary_lines}\n"
            '5. Return strict JSON: {"items": [{"i": <int>, "t": "<persian>"}]}.'
        )

    def _parse_json_items(self, raw_text: str, expected_indices: List[int]) -> Dict[int, str]:
        cleaned = re.sub(r"^```(?:json)?\s*", "", raw_text.strip(), flags=re.IGNORECASE)
        cleaned = re.sub(r"\s*```$", "", cleaned).strip()
        try:
            parsed = json.loads(cleaned)
        except json.JSONDecodeError:
            m = re.search(r"\{[\s\S]*\}", cleaned)
            if not m:
                raise ValueError("Invalid JSON response from model")
            parsed = json.loads(m.group(0))
        items = parsed.get("items", []) if isinstance(parsed, dict) else parsed
        expected = set(expected_indices)
        out: Dict[int, str] = {}
        for item in items:
            idx = int(item.get("i", -1))
            text = str(item.get("t", "")).strip()
            if idx in expected and text:
                out[idx] = text
        return out

    async def translate_batch(
        self,
        provider: ProviderConfig,
        context_before: List[Dict[str, object]],
        targets: List[Dict[str, object]],
        context_after: List[Dict[str, object]],
        tone: str = "documentary_direct",
        custom_prompt: str = "",
        glossary: Optional[List[Tuple[str, str]]] = None,
    ) -> Tuple[Dict[int, str], int, int]:
        """Returns (index->translation map, total_tokens, latency_ms)."""
        sys_prompt = self.build_system_prompt(tone, custom_prompt, glossary)
        payload = json.dumps(
            {
                "context_before": context_before,
                "targets": targets,
                "context_after": context_after,
            },
            ensure_ascii=False,
        )
        expected_indices = [int(t["i"]) for t in targets]
        started = time.perf_counter()

        if provider.provider_type == "gemini":
            from google import genai
            from google.genai import types

            client = genai.Client(api_key=provider.api_key)
            resp = client.models.generate_content(
                model=provider.model_name or "gemini-3.5-flash-lite",
                contents=payload,
                config=types.GenerateContentConfig(
                    system_instruction=sys_prompt,
                    response_mime_type="application/json",
                ),
            )
            latency_ms = int((time.perf_counter() - started) * 1000)
            tokens = getattr(getattr(resp, "usage_metadata", None), "total_token_count", 0) or 0
            return self._parse_json_items(resp.text or "", expected_indices), tokens, latency_ms

        base = (provider.base_url or "https://api.openai.com/v1").rstrip("/")
        headers = {"Content-Type": "application/json"}
        if provider.api_key:
            headers["Authorization"] = f"Bearer {provider.api_key}"

        timeout = httpx.Timeout(
            connect=45.0,
            read=float(max(300, provider.timeout_sec)),
            write=45.0,
            pool=45.0,
        )
        async with httpx.AsyncClient(timeout=timeout) as client:
            r = await client.post(
                f"{base}/chat/completions",
                headers=headers,
                json={
                    "model": provider.model_name,
                    "messages": [
                        {"role": "system", "content": sys_prompt},
                        {"role": "user", "content": payload},
                    ],
                    "response_format": {"type": "json_object"},
                },
            )
            r.raise_for_status()
            data = r.json()
            latency_ms = int((time.perf_counter() - started) * 1000)
            content = data["choices"][0]["message"]["content"]
            tokens = int(data.get("usage", {}).get("total_tokens", 0))
            return self._parse_json_items(content, expected_indices), tokens, latency_ms
