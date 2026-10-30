#!/usr/bin/env bash
# Журнал закрытых чатов (задач) + сводка за день.
#
# В state.db нет времени архивации: у сессии есть только флаг archived и
# auto_archived, а ended_at перезаписывается при старте агента. Поэтому журнал
# ведёт сам скрипт: каждый прогон сравнивает текущий набор закрытых чатов с
# сохранённым и записывает момент, когда чат впервые обнаружен закрытым.
#
#   (без аргументов)  — тихий скан, обновляет журнал, ничего не печатает
#   --new             — закрытия, о которых ещё не сообщали (для уведомления)
#   --report [ДАТА]   — сводка за день (ДАТА в формате YYYY-MM-DD, по умолчанию сегодня)
#   --json [ДАТА]     — то же машинным видом
#   --list [N]        — последние N закрытых чатов из журнала (по умолчанию 20)
#
# «Закрытой задачей» считается чат с ручным архивом: archived=1 AND auto_archived=0
# (auto_archived=1 ставит автоматическая уборка по простою — это не закрытие).
set -uo pipefail
export HERMES_HOME="${HERMES_HOME:-$HOME/.hermes}"

exec python3 - "$@" <<'PY'
import datetime, json, os, re, sqlite3, sys

HERMES_HOME = os.environ.get("HERMES_HOME", os.path.expanduser("~/.hermes"))
DB = os.path.join(HERMES_HOME, "state.db")
LOG = os.path.join(HERMES_HOME, "day-log", "chat-closures.json")
LOG_DIR = os.path.dirname(LOG)
MSK = datetime.timezone(datetime.timedelta(hours=3))
EXCLUDED_SOURCES = {"cron", "oneshot", "kanban", "worker"}
_exclude_override = os.environ.get("CHAT_CLOSURES_EXCLUDE")
if _exclude_override is not None:
    EXCLUDED_SOURCES = {s.strip() for s in _exclude_override.split(",") if s.strip()}
SUMMARY_LIMIT = 170

args = [a for a in sys.argv[1:] if a]
mode = "scan"
day_arg = None
for a in args:
    if a == "--report":
        mode = "report"
    elif a == "--json":
        mode = "json"
    elif a == "--new":
        mode = "new"
    elif a == "--list":
        mode = "list"
    else:
        day_arg = a

def msk(ts):
    return datetime.datetime.fromtimestamp(ts, MSK) if ts else None

def load_log():
    try:
        with open(LOG, encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}

def save_log(log):
    os.makedirs(LOG_DIR, exist_ok=True)
    tmp = LOG + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(log, f, ensure_ascii=False, indent=1, sort_keys=True)
    os.replace(tmp, LOG)

def one_line(text, limit=SUMMARY_LIMIT):
    s = " ".join((text or "").split())
    if len(s) <= limit:
        return s
    cut = s.rfind(". ", 0, limit)
    return (s[: cut + 1] if cut > limit * 0.4 else s[:limit].rstrip(" ,;")) + "…"

_MD_LINK = re.compile(r"\[([^\]]+)\]\((?:[^)]+)\)")
_MD_WRAP = re.compile(r"`{1,3}|\*\*|__|~~")


def clip_summary(text):
    """Последний ответ ассистента — обычно «Готово: …». Чистим markdown."""
    s = " ".join((text or "").split())
    if not s:
        return ""
    s = _MD_LINK.sub(r"\1", s)
    s = _MD_WRAP.sub("", s)
    s = re.sub(r"^[>#\-\*\s]+(?=\S)", "", s)
    return s

def outcome_emoji(text):
    """Настроение итога — по последнему ответу в закрытом чате."""
    s = " ".join((text or "").split()).lower()
    if not s:
        return "🗂"
    if re.search(r"не принят|отклон|провал|не удал|ошибк|сломал|дубл", s):
        return "⚠️"
    if re.search(r"готово|принято|сделано|работает|проверено|почин|исправл|настро", s):
        return "✅"
    if re.search(r"жду|ждём|вопрос|уточн|остал|продолж|черновик", s):
        return "⏳"
    return "📝"


def union_hours(spans):
    """Часы «в задачах»: объединение интервалов, параллельные чаты не удваиваются."""
    if not spans:
        return 0.0
    total = 0
    start = end = None
    for left, right in sorted(spans):
        if start is None:
            start, end = left, right
        elif left <= end:
            end = max(end, right)
        else:
            total += end - start
            start, end = left, right
    total += end - start
    return round(total / 3600.0, 1)


def day_task_hours(db, items, day):
    """Сколько времени заняли закрытые в этот день чаты (по активности сессий)."""
    day_start = datetime.datetime.combine(day, datetime.time(0, 0), tzinfo=MSK).timestamp()
    day_end = day_start + 86400
    spans = []
    for _dt, sid, _entry in items:
        row = db.execute(
            "SELECT started_at, last_activity_at FROM sessions WHERE id=?", (sid,)
        ).fetchone()
        if not row or not row[0] or not row[1] or row[1] <= row[0]:
            continue
        left, right = max(row[0], day_start), min(row[1], day_end)
        if right > left:
            spans.append((left, right))
    return union_hours(spans)


def parent_map(db, ids):
    """{id: (parent_id, parent_title)} — кто чей форк/продолжение."""
    if not ids:
        return {}
    marks = ",".join("?" * len(ids))
    rows = db.execute(
        f"SELECT id, parent_session_id FROM sessions WHERE id IN ({marks})", tuple(ids)
    ).fetchall()
    parents = [r[1] for r in rows if r[1]]
    titles = {}
    if parents:
        pmarks = ",".join("?" * len(parents))
        for pid, title, disp in db.execute(
            f"SELECT id, title, display_name FROM sessions WHERE id IN ({pmarks})",
            tuple(parents),
        ):
            titles[pid] = (title or disp or "").strip()
    return {r[0]: (r[1], titles.get(r[1], "")) for r in rows if r[1]}


def ordered_with_structure(items, parents):
    """Список (dt, sid, entry, depth, parent_title): продолжения сразу под своим чатом."""
    present = {sid for _dt, sid, _e in items}
    by_parent = {}
    roots = []
    for row in items:
        sid = row[1]
        parent = (parents.get(sid) or (None, ""))[0] or (row[2].get("parent") or None)
        if parent and parent in present and parent != sid:
            by_parent.setdefault(parent, []).append(row)
        else:
            roots.append(row)

    out, seen = [], set()

    def walk(row, depth):
        sid = row[1]
        if sid in seen:
            return
        seen.add(sid)
        parent = (parents.get(sid) or (None, ""))[0] or (row[2].get("parent") or None)
        parent_title = (parents.get(sid) or (None, ""))[1] or ""
        out.append((row[0], sid, row[2], depth, parent_title))
        for child in sorted(by_parent.get(sid, []), key=lambda r: r[0]):
            walk(child, depth + 1)

    for row in sorted(roots, key=lambda r: r[0]):
        walk(row, 0)
    for row in sorted(items, key=lambda r: r[0]):
        walk(row, 0)
    return out


def open_db():
    return sqlite3.connect(f"file:{DB}?mode=ro", uri=True)

def closed_sessions(db):
    db.row_factory = sqlite3.Row
    rows = db.execute(
        """
        SELECT id, source, title, display_name, last_activity_at, started_at,
               message_count, cwd, parent_session_id
        FROM sessions
        WHERE archived = 1 AND auto_archived = 0 AND hidden = 0
        """
    ).fetchall()
    return [r for r in rows if (r["source"] or "") not in EXCLUDED_SOURCES]

def title_of(db, row):
    t = (row["title"] or row["display_name"] or "").strip()
    if t:
        return t
    r = db.execute(
        "SELECT content FROM messages WHERE session_id=? AND role='user' "
        "ORDER BY id ASC LIMIT 1", (row["id"],),
    ).fetchone()
    return one_line(r[0], 80) if r and r[0] else row["id"][:16]

def summary_of(db, session_id):
    for role in ("assistant",):
        rows = db.execute(
            "SELECT content FROM messages WHERE session_id=? AND role=? "
            "AND content IS NOT NULL AND TRIM(content) != '' "
            "AND (display_kind IS NULL OR display_kind = '') "
            "ORDER BY id DESC LIMIT 3",
            (session_id, role),
        ).fetchall()
        for (content,) in rows:
            s = clip_summary(content)
            if s:
                return one_line(s)
    return ""

def scan(log):
    db = open_db()
    now = datetime.datetime.now(MSK)
    seen = set()
    changed = 0
    for row in closed_sessions(db):
        sid = row["id"]
        seen.add(sid)
        if sid in log:
            # Чат уже в журнале: освежаем заголовок (чат могли переименовать
            # в приложении) — иначе старое имя вернётся в сводку из журнала.
            if not log[sid].get("reopened"):
                fresh = title_of(db, row)
                if fresh and fresh != log[sid].get("title"):
                    log[sid]["title"] = fresh
                    changed += 1
                if row["parent_session_id"] and row["parent_session_id"] != log[sid].get("parent"):
                    log[sid]["parent"] = row["parent_session_id"]
                    changed += 1
            continue
        last_act = msk(row["last_activity_at"]) or msk(row["started_at"])
        # Первый прогон: история берётся задним числом по последней активности.
        seeded = not log_exists
        closed_at = last_act or now
        log[sid] = {
            "title": title_of(db, row),
            "source": row["source"],
            "closed_at": closed_at.isoformat(timespec="seconds"),
            "approx": bool(seeded),
            "summary": summary_of(db, sid),
            "parent": row["parent_session_id"] or None,
            "message_count": row["message_count"],
        }
        changed += 1
    for sid in list(log):
        if sid not in seen:
            log[sid]["reopened"] = True  # чат разархивировали — из сводки уходит
        elif log[sid].get("reopened"):
            log[sid].pop("reopened", None)
    if changed:
        save_log(log)
    return changed

def refresh(db, sid, entry):
    """Свежие заголовок и итог из базы (для чатов, которые ещё живы).
    Журнальная копия остаётся резервом на случай удаления чата."""
    row = db.execute(
        "SELECT title, display_name FROM sessions WHERE id=?", (sid,)
    ).fetchone()
    if not row:
        return
    title = (row[0] or row[1] or "").strip()
    if title:
        entry["title"] = title
    s = summary_of(db, sid)
    if s:
        entry["summary"] = s


def report(log, day, db):
    def closed_day(entry):
        try:
            dt = datetime.datetime.fromisoformat(entry["closed_at"])
        except (KeyError, ValueError):
            return False
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=MSK)
        return dt.astimezone(MSK).date() == day

    items = [
        (datetime.datetime.fromisoformat(e["closed_at"]).astimezone(MSK), sid, e)
        for sid, e in log.items()
        if closed_day(e) and not e.get("reopened")
    ]
    items.sort()
    for _, sid, e in items:
        refresh(db, sid, e)
    return items

log_exists = os.path.exists(LOG)
log = load_log()

if mode == "scan":
    changed = scan(log)
    if changed:
        pass  # тихий режим: журнал обновлён, печатать нечего
    sys.exit(0)

if mode == "new":
    scan(log)
    fresh = [
        (datetime.datetime.fromisoformat(e["closed_at"]).astimezone(MSK), sid, e)
        for sid, e in log.items()
        if not e.get("reopened") and not e.get("notified") and not e.get("approx")
    ]
    fresh.sort()
    if fresh:
        out = [f"🎉 Закрыто: {len(fresh)}"]
        for dt, sid, e in fresh:
            out.append(f"• {dt:%H:%M} {e.get('title', sid)}")
        print("\n".join(out))
        for _, sid, e in fresh:
            e["notified"] = True
        save_log(log)
    sys.exit(0)

if mode == "list":
    limit = int(day_arg) if day_arg and day_arg.isdigit() else 20
    items = sorted(
        (
            (datetime.datetime.fromisoformat(e["closed_at"]).astimezone(MSK), sid, e)
            for sid, e in log.items()
            if not e.get("reopened")
        ),
        reverse=True,
    )[:limit]
    print(f"Последние закрытые чаты ({len(items)}):")
    for dt, sid, e in items:
        print(f"• {dt:%d.%m %H:%M} {e.get('title', sid)}")
    sys.exit(0)

if mode in ("report", "json"):
    scan(log)
    day = (
        datetime.date.fromisoformat(day_arg)
        if day_arg
        else datetime.datetime.now(MSK).date()
    )
    items = report(log, day, open_db())
    if mode == "json":
        print(json.dumps(
            [
                {"id": sid, "time": dt.strftime("%H:%M"), "date": day.isoformat(), **e}
                for dt, sid, e in items
            ],
            ensure_ascii=False, indent=1,
        ))
        sys.exit(0)
    if not items:
        print(
            f"😌 За {day:%d.%m} закрытых чатов нет — значит, всё ещё в работе.\n"
            f"Спросить про другой день: chat-closures.sh --report ГГГГ-ММ-ДД"
        )
        sys.exit(0)
    spark = sum(1 for _, _, e in items if outcome_emoji(e.get("summary")) == "✅")
    hours = day_task_hours(open_db(), items, day)
    head = f"🎉 Закрыто за {day:%d.%m}: {len(items)}"
    parents = parent_map(open_db(), [sid for _dt, sid, _e in items])
    out = [head]
    for dt, sid, e, depth, parent_title in ordered_with_structure(items, parents):
        mark = "≈" if e.get("approx") else ""
        fork = "↳ " if depth else ""
        indent = "   " * depth
        out.append(
            f"\n{indent}{fork}{outcome_emoji(e.get('summary'))} {dt:%H:%M}{mark} {e.get('title', sid)}"
        )
        if parent_title:
            out.append(f"{indent}   ↳ продолжение чата «{parent_title}»")
        if e.get("summary"):
            out.append(f"{indent}   {e['summary']}")
    tail = f"\n⏱ в задачах: {str(hours).replace('.', ',')} ч"
    if spark:
        tail += f" · доведено до «готово»: {spark}"
    out.append(tail)
    if any(e.get("approx") for _, _, e in items):
        out.append("≈ — время приблизительное (журнал начал вестись позже)")
    print("\n".join(out))
PY
