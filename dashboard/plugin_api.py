"""Закрытые за день задачи (чаты) — данные для панели в десктоп-приложении.

Даёт список чатов с ручным архивом (archived=1, auto_archived=0) из журнала
`$HERMES_HOME/day-log/chat-closures.json`, который ведёт
`$HERMES_HOME/scripts/chat-closures.sh` (крон раз в 15 минут). Журнал, а не
state.db, потому что времени архивации в базе нет.

Монтируется как /api/plugins/closed-today/.
"""

from __future__ import annotations

import datetime
import json
import os
import re
from pathlib import Path

from fastapi import APIRouter

router = APIRouter()

MSK = datetime.timezone(datetime.timedelta(hours=3))
WEEKDAYS = ("пн", "вт", "ср", "чт", "пт", "сб", "вс")


def _home() -> Path:
    return Path(os.environ.get("HERMES_HOME") or (Path.home() / ".hermes"))


def _journal_path() -> Path:
    return _home() / "day-log" / "chat-closures.json"


def _plain(text: str) -> str:
    """Убираем markdown из итога: в панели он выглядит как мусор (**Issue**, `код`)."""
    s = " ".join((text or "").split())
    if not s:
        return ""
    s = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", s)
    s = re.sub(r"`{1,3}|\*\*|__|~~", "", s)
    s = re.sub(r"^[>#\-*\s]+(?=\S)", "", s)
    return s


def _load_journal() -> dict:
    try:
        data = json.loads(_journal_path().read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


def _parse(entry: dict) -> datetime.datetime | None:
    raw = entry.get("closed_at")
    if not raw:
        return None
    try:
        dt = datetime.datetime.fromisoformat(str(raw))
    except ValueError:
        return None
    return dt.replace(tzinfo=MSK) if dt.tzinfo is None else dt.astimezone(MSK)


def _session_intervals(session_ids):
    """Интервалы активности {id: (start, end)} по чатам из state.db."""
    if not session_ids:
        return {}
    out = {}
    try:
        import sqlite3

        path = _home() / "state.db"
        conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    except Exception:
        return {}
    try:
        marks = ",".join("?" * len(session_ids))
        rows = conn.execute(
            f"SELECT id, started_at, last_activity_at FROM sessions WHERE id IN ({marks})",
            tuple(session_ids),
        ).fetchall()
        for sid, started, last in rows:
            if started and last and last > started:
                out[sid] = (int(started), int(last))
    except Exception:
        return {}
    finally:
        conn.close()
    return out


def _parents(session_ids):
    """{id: (parent_id, parent_title)} — кто чей форк/продолжение."""
    if not session_ids:
        return {}
    out = {}
    try:
        import sqlite3

        path = _home() / "state.db"
        conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    except Exception:
        return {}
    try:
        marks = ",".join("?" * len(session_ids))
        rows = conn.execute(
            f"SELECT id, parent_session_id FROM sessions WHERE id IN ({marks})",
            tuple(session_ids),
        ).fetchall()
        parent_ids = [r[1] for r in rows if r[1]]
        titles = {}
        if parent_ids:
            pmarks = ",".join("?" * len(parent_ids))
            for pid, title, disp in conn.execute(
                f"SELECT id, title, display_name FROM sessions WHERE id IN ({pmarks})",
                tuple(parent_ids),
            ):
                titles[pid] = (title or disp or "").strip()
        for sid, parent in rows:
            if parent:
                out[sid] = (parent, titles.get(parent, ""))
    except Exception:
        return {}
    finally:
        conn.close()
    return out


def _union_hours(intervals):
    """Часы «в задачах» — объединение интервалов, чтобы параллельные чаты не удваивались."""
    if not intervals:
        return 0.0
    total = 0
    cur_start, cur_end = None, None
    for started, ended in sorted(intervals):
        if cur_start is None:
            cur_start, cur_end = started, ended
        elif started <= cur_end:
            cur_end = max(cur_end, ended)
        else:
            total += cur_end - cur_start
            cur_start, cur_end = started, ended
    total += cur_end - cur_start
    return round(total / 3600.0, 1)


def closed_days(days: int = 7) -> dict:
    """Закрытые чаты, сгруппированные по дням (свежие сверху)."""
    days = max(1, min(int(days or 7), 60))
    today = datetime.datetime.now(MSK).date()
    first = today - datetime.timedelta(days=days - 1)

    buckets: dict[datetime.date, list] = {}
    for session_id, entry in _load_journal().items():
        if not isinstance(entry, dict) or entry.get("reopened"):
            continue
        dt = _parse(entry)
        if dt is None or dt.date() < first or dt.date() > today:
            continue
        buckets.setdefault(dt.date(), []).append(
            {
                "id": session_id,
                "time": dt.strftime("%H:%M"),
                "closed_at": dt.isoformat(),
                "title": entry.get("title") or session_id[:16],
                "summary": _plain(entry.get("summary") or ""),
                "source": entry.get("source") or "",
                "approx": bool(entry.get("approx")),
                "parent_id": None,
                "parent_title": "",
            }
        )

    out = []
    # Сегодняшний день присутствует всегда (пусть и с нулём): «7 дней» — это
    # сегодня + 6 предыдущих, и отсутствие сегодняшнего дня в ответе сбивает с толку.
    buckets.setdefault(today, [])

    # Сколько времени ушло на задачи: объединение интервалов активности чатов
    # (параллельные чаты не удваиваются), порезанное по границам дня.
    all_ids = [item["id"] for items in buckets.values() for item in items]
    intervals = _session_intervals(all_ids)

    def day_bounds(day):
        start = int(
            datetime.datetime.combine(
                day, datetime.time(0, 0), tzinfo=MSK
            ).timestamp()
        )
        return start, start + 86400

    def clamp(span, day):
        start, end = day_bounds(day)
        left, right = max(span[0], start), min(span[1], end)
        return (left, right) if right > left else None

    parents = _parents(all_ids)
    for items in buckets.values():
        for item in items:
            parent = parents.get(item["id"])
            if parent:
                item["parent_id"], item["parent_title"] = parent[0], _plain(parent[1])

    total_hours = 0.0
    for day in sorted(buckets, reverse=True):
        items = sorted(buckets[day], key=lambda item: item["closed_at"])
        spans = []
        for item in items:
            span = intervals.get(item["id"])
            clipped = clamp(span, day) if span else None
            item["hours"] = round((clipped[1] - clipped[0]) / 3600.0, 1) if clipped else 0.0
            if clipped:
                spans.append(clipped)
        hours = _union_hours(spans)
        total_hours = round(total_hours + hours, 1)
        out.append(
            {
                "date": day.isoformat(),
                "label": "Сегодня" if day == today else (
                    "Вчера" if day == today - datetime.timedelta(days=1)
                    else f"{day:%d.%m}, {WEEKDAYS[day.weekday()]}"
                ),
                "count": len(items),
                "hours": hours,
                "items": items,
            }
        )
    return {
        "ok": True,
        "today": today.isoformat(),
        "today_count": len(buckets.get(today, [])),
        "total": sum(day["count"] for day in out),
        "total_hours": total_hours,
        "days": out,
    }


@router.get("/days")
async def days(n: int = 7):
    """Закрытые чаты за последние N дней (по умолчанию 7)."""
    try:
        return closed_days(n)
    except Exception as exc:  # контракт плагина: наружу никогда не бросаем
        return {"ok": False, "error": f"{type(exc).__name__}: {exc}", "days": []}


@router.get("/today")
async def today():
    """Только сегодняшние закрытия."""
    try:
        data = closed_days(1)
    except Exception as exc:
        return {"ok": False, "error": f"{type(exc).__name__}: {exc}", "days": []}
    for day in data.get("days", []):
        if day["date"] == data["today"]:
            return day
    return {"date": data["today"], "label": "Сегодня", "count": 0, "items": []}
