# Закрыто за день — задачи-чаты Hermes

<a href="hermes://plugin/install?repo=gp131313/closed-today&enable=1">Установить в Hermes</a>
(кнопка открывает диалог установки плагина в приложении Hermes Desktop)

Плагин к Hermes Desktop (панель + страница + настройки) и скрипт журнала, которые
показывают, какие чаты-задачи закрыты за день. Закрытая задача = чат с **ручным**
архивом: сессия `archived = 1 AND auto_archived = 0`.

Зачем: в Hermes одна задача — один чат; закрыв чат, задача уходит из списка и
исчезает из поля зрения. Этот пакет возвращает её: журнал закрытий, сводка за день
и наглядный список по дням.

## Состав

```
plugin.yaml                  агентская половина пакета (ставится в ~/.hermes/plugins/closed-today/)
__init__.py
dashboard/manifest.json      описание бэкенда плагина
dashboard/plugin_api.py      данные: /api/plugins/closed-today/days | /today
desktop/plugin.js            UI: панель, страница /closed-today, строка навигации,
                             настройки в Settings → Plugins, меню по правому клику
scripts/chat-closures.sh     журнал закрытий + сводка (python внутри)
scripts/chat-closures-new.sh обёртка для крона: уведомление о новых закрытиях
```

## Установка

1. Агентская половина + скрипты (на хосте агента):

```bash
mkdir -p ~/.hermes/plugins/closed-today ~/.hermes/scripts
cp -r plugin.yaml __init__.py dashboard desktop ~/.hermes/plugins/closed-today/
cp scripts/chat-closures.sh scripts/chat-closures-new.sh ~/.hermes/scripts/
chmod +x ~/.hermes/scripts/chat-closures*.sh
hermes plugins enable closed-today
```

2. UI-половина (на машине, где запущено приложение; при удалённом бэкенде файловая
   система агента приложению не видна):

```powershell
# Windows
scp <agent>:/home/<user>/.hermes/plugins/closed-today/desktop/plugin.js "$env:LOCALAPPDATA\hermes\desktop-plugins\closed-today\plugin.js"
```

Затем в приложении: `⌘K → Reload desktop plugins`.

3. Тихий крон, который ведёт журнал (каждые 15 минут) и сообщает о закрытиях:

```bash
hermes cron create --name 'Журнал закрытых чатов (сразу)' --script chat-closures-new.sh \
  --no-agent --deliver bot-chat '*/15 * * * *'
```

## Что умеет панель

- Список закрытых чатов по дням: время, длительность, краткое резюме задачи.
- Переключатели: **одна/две строки**, **резюме вместо названия**, **эмодзи-настроение**
  (✅ готово, ⚠️ не принято, ⏳ ждёт, 📝 прочее), **часы в задачах**.
  Меняются по правому клику на панели и в Settings → Plugins.
- Часы считаются объединением интервалов активности закрытых чатов (параллельные
  чаты не удваиваются), с порезкой по границам дня.
- **Структура форков:** продолжения чата (после сжатия/ветвления) идут под своим
  чатом со значком `↳` и подсказкой «Продолжение чата «…»».
- Клик по строке — переименовать задачу (пишет `session.title`), Ctrl/Cmd-клик или
  клик по времени — открыть чат.
- Только что закрытая задача въезжает с искрами (Web Animations API).
- Входы, которые нельзя потерять: строка **«Закрыто за день»** в левой навигации и
  страница `/closed-today` в главной области (панель при желании закрывается).

## Как считается «закрыто»

Точного времени архивации в `state.db` нет (`ended_at` перезаписывается при старте
агента), поэтому журнал ведёт скрипт: каждый прогон сравнивает текущий набор чатов с
ручным архивом с сохранённым и фиксирует момент первого обнаружения. Журнал:
`~/.hermes/day-log/chat-closures.json`. В нём же лежит итог задачи (последний ответ
ассистента), поэтому удалённый чат остаётся в истории.

## CLI

```bash
~/.hermes/scripts/chat-closures.sh --report [ГГГГ-ММ-ДД]   # сводка за день
~/.hermes/scripts/chat-closures.sh --list 20               # последние закрытые
~/.hermes/scripts/chat-closures.sh --json [ГГГГ-ММ-ДД]     # то же машинным видом
~/.hermes/scripts/chat-closures.sh                         # тихий скан журнала
```

## Лицензия

MIT
