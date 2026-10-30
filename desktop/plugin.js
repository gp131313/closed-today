/**
 * «Закрыто за день» — панель в десктоп-приложении.
 *
 * Показывает чаты-задачи с ручным архивом (закрытые), сгруппированные по дням.
 * Данные приходят с backend-половины пакета: ctx.rest → /api/plugins/closed-today/days
 * (см. dashboard/plugin_api.py рядом; журнал — $HERMES_HOME/day-log/chat-closures.json).
 *
 * Управление строкой: клик по названию — переименовать (Enter — сохранить,
 * Esc — отмена; имя уходит штатным вызовом session.title), Ctrl/Cmd-клик или
 * клик по времени — открыть сам чат.
 *
 * Только что закрытая задача появляется с анимацией: строка въезжает, вокруг
 * вспыхивают искры (Web Animations API — без глобального CSS).
 *
 * Живёт в desktop-plugins/<id>/ у приложения; при удалённом бэкенде копируется
 * сюда руками (файловая система бэкенда приложению не видна).
 */

import {
  atom,
  cn,
  ContextMenu,
  ContextMenuCheckboxItem,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
  host,
  PALETTE_AREA,
  pluginSettingsHref,
  queryClient,
  ROUTES_AREA,
  ScrollArea,
  SegmentedControl,
  SIDEBAR_NAV_AREA,
  Skeleton,
  Tip,
  ToggleRow,
  useMutation,
  useQuery,
  useValue
} from '@hermes/plugin-sdk'
import { useEffect, useRef, useState } from 'react'
import { jsx, jsxs } from 'react/jsx-runtime'

const ID = 'closed-today'
const QUERY_ROOT = ['closed-today']

// ctx доступен только внутри register(); компонентам нужен лишь ctx.rest.
let rest = null
let activeCtx = null

/** Настройки плагина:
 *  lines — '2': под главной строкой второй строкой идёт вторая часть (итог/название),
 *          '1': только одна строка;
 *  emoji1 — показывать эмодзи-настроение итога (✅/⚠️/⏳/📝) в начале строки;
 *  main   — что стоит крупно: 'title' (название задачи) или 'summary' (краткое резюме). */
const DEFAULT_PREFS = { lines: '1', emoji1: true, main: 'summary' }
const prefs = atom(DEFAULT_PREFS)

function loadPrefs(ctx) {
  try {
    const saved = ctx.storage?.get?.('prefs')
    if (saved && typeof saved === 'object') {
      prefs.set({ ...DEFAULT_PREFS, ...saved })
    }
  } catch {
    // storage недоступен — остаются значения по умолчанию
  }
}

function savePrefs(ctx, patch) {
  const next = { ...prefs.get(), ...patch }
  prefs.set(next)
  try {
    ctx.storage?.set?.('prefs', next)
  } catch {
    // не смогли сохранить — настройка всё равно применится до перезапуска
  }
}

const PERIODS = [
  { key: 1, label: 'Сегодня' },
  { key: 7, label: '7 дней' },
  { key: 30, label: '30 дней' }
]

const SPARKS = ['✨', '🌟', '💫', '🎉', '⭐']

/** Настроение итога — по тексту последнего ответа в закрытом чате. */
function outcomeEmoji(summary) {
  const text = (summary || '').toLowerCase()
  if (!text) return '🗂'
  if (/не принят|отклон|провал|не удал|ошибк|сломал|беда|дубл/.test(text)) return '⚠️'
  if (/готово|принято|сделано|работает|проверено|почин|исправл|настро/.test(text)) return '✅'
  if (/жду|ждём|вопрос|уточн|остал|продолж|черновик/.test(text)) return '⏳'
  return '📝'
}

function dayEmoji(label) {
  if (label === 'Сегодня') return '☀️'
  if (label === 'Вчера') return '🌙'
  return '📅'
}

/** Мгновенно подменить имя в кэше — не ждём ни сервера, ни перезапроса. */
function patchTitle(id, title) {
  queryClient.setQueriesData({ queryKey: QUERY_ROOT }, old => {
    if (!old || !Array.isArray(old.days)) return old
    return {
      ...old,
      days: old.days.map(day => ({
        ...day,
        items: (day.items || []).map(item =>
          item.id === id ? { ...item, title } : item
        )
      }))
    }
  })
}

function openChat(id) {
  Promise.resolve(host.openSession?.(id, { intent: 'stack' })).catch(() => {})
}

function sparkle(node, index) {
  if (!node || typeof node.animate !== 'function') return
  node.animate(
    [
      { opacity: 0, transform: 'translateY(4px) scale(0.4) rotate(0deg)' },
      { opacity: 1, transform: 'translateY(-9px) scale(1.15) rotate(12deg)', offset: 0.35 },
      { opacity: 0, transform: 'translateY(-22px) scale(0.7) rotate(-8deg)' }
    ],
    {
      duration: 900 + index * 90,
      delay: index * 60,
      easing: 'cubic-bezier(.2,.8,.3,1)',
      fill: 'both'
    }
  )
}

function DayRow({ item, onRename, onRestore, fresh, showSummary, showEmoji, main, showHours, depth = 0, parentTitle = '' }) {
  const [draft, setDraft] = useState(null) // null = не редактируем
  const [busy, setBusy] = useState(false)
  const [party, setParty] = useState(false)

  useEffect(() => {
    if (!fresh) return undefined
    setParty(true)
    const timer = setTimeout(() => setParty(false), 1400)
    return () => clearTimeout(timer)
  }, [fresh])

  const rowRef = node => {
    if (!node || !fresh || typeof node.animate !== 'function') return
    node.animate(
      [
        { opacity: 0, transform: 'translateY(7px) scale(0.97)' },
        { opacity: 1, transform: 'translateY(0) scale(1)' }
      ],
      { duration: 340, easing: 'cubic-bezier(.22,.9,.3,1)' }
    )
  }

  const commit = async () => {
    const next = (draft || '').trim()
    const wasEditing = draft !== null
    setDraft(null)
    if (!wasEditing || !next || next === item.title) return
    setBusy(true)
    try {
      await onRename(item, next)
    } finally {
      setBusy(false)
    }
  }

  if (draft !== null) {
    return jsx('input', {
      autoFocus: true,
      className: cn(
        'min-w-0 flex-1 rounded-md border border-(--ui-stroke-secondary) bg-transparent',
        'px-1 py-0.5 text-xs text-(--ui-text-primary) outline-none'
      ),
      onBlur: () => void commit(),
      onChange: event => setDraft(event.target.value),
      onKeyDown: event => {
        if (event.key === 'Enter') {
          event.preventDefault()
          void commit()
        } else if (event.key === 'Escape') {
          event.preventDefault()
          setDraft(null)
        }
      },
      value: draft
    })
  }

  const timeText = showHours && hoursLabel(item.hours)
    ? `${item.time} · ${hoursLabel(item.hours)}`
    : item.time
  const time = jsx('button', {
    className: cn(
      'shrink-0 rounded px-0.5 text-[0.6875rem] tabular-nums text-(--ui-text-quaternary)',
      'transition-colors hover:text-(--ui-text-secondary)'
    ),
    onClick: () => openChat(item.id),
    type: 'button',
    children: timeText
  })

  const summary = (item.summary || '').trim()
  const mood = summary ? outcomeEmoji(summary) : ''
  const asSummary = main === 'summary' && !!summary
  // Крупная строка: либо краткое резюме задачи, либо её название.
  const mainText = asSummary ? summary : item.title
  const tipLines = []
  if (depth > 0 && parentTitle) tipLines.push(`Продолжение чата «${parentTitle}»`)
  tipLines.push(item.title)
  if (summary) tipLines.push(summary)
  tipLines.push('Клик — переименовать задачу, Ctrl-клик — открыть чат.')

  const mainBtn = jsx('button', {
    className: cn(
      'min-w-0 flex-1 truncate rounded px-0.5 text-left text-xs',
      asSummary ? 'text-(--ui-text-primary)' : 'text-(--ui-text-secondary)',
      'transition-colors hover:bg-(--chrome-action-hover) hover:text-(--ui-text-primary)',
      busy && 'opacity-60'
    ),
    onClick: event => {
      // Ctrl/Cmd-клик — провалиться в сам чат, обычный клик — переименовать.
      if (event && (event.ctrlKey || event.metaKey)) {
        openChat(item.id)
        return
      }
      setDraft(item.title)
    },
    type: 'button',
    children: mainText
  })

  // Эмодзи-настроение: перед крупной строкой — в режиме резюме (или когда
  // второй строки нет), иначе его несёт вторая строка с итогом.
  const emojiInFirstLine = showEmoji && mood && (asSummary || !showSummary)
  const firstLine = [jsx(Tip, { label: 'Открыть чат (или Ctrl-клик по строке)', children: time })]
  if (depth > 0) {
    firstLine.unshift(
      jsx(Tip, {
        label: parentTitle ? `Продолжение чата «${parentTitle}»` : 'Продолжение другого чата',
        children: jsx('span', {
          className: 'shrink-0 text-[0.6875rem] text-(--ui-text-quaternary)',
          children: '↳'
        })
      })
    )
  }
  if (emojiInFirstLine) {
    firstLine.push(jsx('span', { className: 'shrink-0 text-[0.7rem]', children: mood }))
  }
  firstLine.push(jsx(Tip, { label: tipLines.join('\n\n'), children: mainBtn }))

  const lines = [
    jsxs('div', {
      className: 'flex w-full items-baseline gap-1',
      children: firstLine
    })
  ]

  // Вторая строка: в режиме резюме она показывает название задачи, в режиме
  // названия — итог (с эмодзи-настроением).
  const secondText = showSummary ? (asSummary ? item.title : summary) : ''
  if (secondText) {
    lines.push(
      jsxs('div', {
        className: cn(
          'flex items-baseline gap-1 truncate pl-[2.6rem] pr-1 text-[0.6875rem] italic',
          'text-(--ui-text-quaternary)'
        ),
        children: [
          !asSummary && mood
            ? jsx('span', { className: 'shrink-0 not-italic', children: mood })
            : null,
          jsx('span', {
            className: cn('min-w-0 truncate', asSummary && 'not-italic'),
            children: secondText
          })
        ].filter(Boolean)
      })
    )
  }

  if (party) {
    lines.push(
      jsx('div', {
        className: 'pointer-events-none absolute inset-x-0 top-0 h-0',
        children: SPARKS.map((glyph, index) =>
          jsx(
            'span',
            {
              className: 'absolute text-[0.7rem]',
              key: glyph + index,
              ref: node => sparkle(node, index),
              style: { left: `${10 + index * 17}%` },
              children: glyph
            },
            glyph + index
          )
        )
      })
    )
  }

  const row = jsxs('div', {
    className: cn(
      'relative flex w-full flex-col rounded-md px-1 py-0.5',
      depth > 0 && 'pl-4'
    ),
    ref: rowRef,
    children: lines
  })

  // Правый клик по задаче: открыть, переименовать, вернуть из архива.
  return jsxs(ContextMenu, {
    children: [
      jsx(ContextMenuTrigger, {
        asChild: true,
        // Меню задачи важнее меню настроек панели: не даём событию всплыть.
        onContextMenu: event => event.stopPropagation(),
        children: row
      }),
      jsxs(ContextMenuContent, {
        children: [
          jsx(ContextMenuItem, { onSelect: () => openChat(item.id), children: 'Открыть чат' }),
          jsx(ContextMenuItem, { onSelect: () => setDraft(item.title), children: 'Переименовать' }),
          jsx(ContextMenuSeparator, {}),
          jsx(ContextMenuItem, {
            onSelect: () => void onRestore(item),
            children: 'Восстановить из архива'
          })
        ]
      })
    ]
  })
}

/** Порядок строк с учётом форков: продолжение идёт сразу под своим чатом. */
function withStructure(items) {
  const present = new Set(items.map(item => item.id))
  const children = new Map()
  const roots = []
  for (const item of items) {
    const parent = item.parent_id
    if (parent && present.has(parent) && parent !== item.id) {
      if (!children.has(parent)) children.set(parent, [])
      children.get(parent).push(item)
    } else {
      roots.push(item)
    }
  }
  const out = []
  const seen = new Set()
  const walk = (item, depth) => {
    if (seen.has(item.id)) return
    seen.add(item.id)
    out.push({ item, depth, parentTitle: item.parent_title || '' })
    const kids = (children.get(item.id) || [])
      .slice()
      .sort((a, b) => String(a.closed_at || '').localeCompare(String(b.closed_at || '')))
    kids.forEach(child => walk(child, depth + 1))
  }
  roots.forEach(item => walk(item, 0))
  items.forEach(item => walk(item, 0)) // страховка от циклов
  return out
}

function DayGroup({ day, onRename, onRestore, freshIds, showSummary, showEmoji, main, showHours }) {
  const empty = !day.count
  const hours = showHours ? hoursLabel(day.hours) : ''
  return jsxs('div', {
    className: 'flex flex-col gap-0.5',
    children: [
      jsxs('div', {
        className: 'flex items-baseline gap-1.5 px-1.5 pt-2 pb-0.5',
        children: [
          jsx('span', {
            className: 'text-[0.6875rem]',
            children: dayEmoji(day.label)
          }),
          jsx('span', {
            className: 'text-[0.6875rem] font-medium text-(--ui-text-tertiary)',
            children: day.label
          }),
          jsx('span', {
            className: 'text-[0.6875rem] text-(--ui-text-quaternary)',
            children: String(day.count)
          }),
          hours
            ? jsx('span', {
                className: 'text-[0.6875rem] tabular-nums text-(--ui-text-quaternary)',
                children: `· ${hours}`
              })
            : null
        ].filter(Boolean)
      }),
      empty
        ? jsx('div', {
            className: 'px-1.5 pb-0.5 text-[0.6875rem] text-(--ui-text-quaternary)',
            children: 'ничего не закрыто — и это тоже результат 🙂'
          })
        : withStructure(day.items || []).map(entry =>
            jsx(DayRow, {
              depth: entry.depth,
              fresh: freshIds ? freshIds.has(entry.item.id) : false,
              item: entry.item,
              key: entry.item.id,
              main,
              onRename,
              onRestore,
              parentTitle: entry.parentTitle,
              showEmoji,
              showHours,
              showSummary
            })
          )
    ]
  })
}

function PeriodSwitch({ value, onChange }) {
  return jsx('div', {
    className: 'flex flex-wrap items-center gap-1',
    children: PERIODS.map(period =>
      jsx(
        'button',
        {
          className: cn(
            'rounded-md px-1.5 py-0.5 text-[0.6875rem] whitespace-nowrap transition-colors',
            period.key === value
              ? 'bg-(--chrome-action-hover) text-(--ui-text-primary)'
              : 'text-(--ui-text-tertiary) hover:bg-(--chrome-action-hover)'
          ),
          key: period.key,
          type: 'button',
          onClick: () => onChange(period.key),
          children: period.label
        },
        period.key
      )
    )
  })
}

/** Часы в человеческом виде: 3.4 → «3,4 ч». */
function hoursLabel(hours) {
  const value = Math.round((Number(hours) || 0) * 10) / 10
  return value > 0 ? `${String(value).replace('.', ',')} ч` : ''
}

/** Правый клик по панели — те же переключатели плагина, без похода в Settings. */
function PaneMenu({ children }) {
  const { lines, emoji1, main, hours } = useValue(prefs)
  const set = patch => activeCtx && savePrefs(activeCtx, patch)

  return jsxs(ContextMenu, {
    children: [
      jsx(ContextMenuTrigger, { asChild: true, children }),
      jsxs(ContextMenuContent, {
        children: [
          jsx(ContextMenuCheckboxItem, {
            checked: lines === '2',
            children: 'Две строки',
            onCheckedChange: value => set({ lines: value ? '2' : '1' })
          }),
          jsx(ContextMenuCheckboxItem, {
            checked: main === 'summary',
            children: 'Резюме вместо названия',
            onCheckedChange: value => set({ main: value ? 'summary' : 'title' })
          }),
          jsx(ContextMenuCheckboxItem, {
            checked: emoji1 !== false,
            children: 'Эмодзи-настроение',
            onCheckedChange: value => set({ emoji1: !!value })
          }),
          jsx(ContextMenuCheckboxItem, {
            checked: hours !== false,
            children: 'Часы в задачах',
            onCheckedChange: value => set({ hours: !!value })
          }),
          jsx(ContextMenuSeparator, {}),
          jsx(ContextMenuItem, {
            children: 'Все настройки…',
            onSelect: () => host.navigate(pluginSettingsHref(ID))
          })
        ]
      })
    ]
  })
}

function ClosedTodayPane() {
  const [period, setPeriod] = useState(7)
  const query = useQuery({
    queryKey: QUERY_ROOT.concat(period),
    queryFn: () => (rest ? rest(`/days?n=${period}`) : Promise.resolve({ days: [] })),
    refetchInterval: 30000
  })

  const rename = useMutation({
    mutationFn: ({ id, title }) =>
      host.request('session.title', { session_id: id, title }),
    onError: (error, variables) => {
      host.notify({
        kind: 'error',
        message: `Не удалось переименовать: ${(error && error.message) || error}`
      })
      void variables
      void queryClient.invalidateQueries({ queryKey: QUERY_ROOT })
    },
    onSuccess: (_result, variables) => {
      patchTitle(variables.id, variables.title)
      void queryClient.invalidateQueries({ queryKey: QUERY_ROOT })
    }
  })

  const onRename = (item, title) => {
    patchTitle(item.id, title) // мгновенно, не дожидаясь ответа
    return rename.mutateAsync({ id: item.id, title })
  }

  // Восстановление из архива: строка уходит сразу, журнал подчистится сам
  // (скрипт помечает разархивированный чат как reopened).
  const [hideIds, setHideIds] = useState(() => new Set())
  const restore = useMutation({
    mutationFn: ({ id }) => host.request('session.archive', { session_id: id, archived: false }),
    onError: error => {
      host.notify({
        kind: 'error',
        message: `Не удалось восстановить: ${(error && error.message) || error}`
      })
    },
    onSuccess: (_result, variables) => {
      setHideIds(prev => new Set(prev).add(variables.id))
      host.notify({ kind: 'success', message: 'Задача восстановлена из архива' })
      void queryClient.invalidateQueries({ queryKey: QUERY_ROOT })
    }
  })
  const onRestore = item => restore.mutateAsync({ id: item.id })

  const data = query.data || {}
  const { lines, emoji1, main: mainMode, hours: hoursOn } = useValue(prefs)
  const showSummary = lines !== '1'
  const showEmoji = emoji1 !== false
  const showHours = hoursOn !== false
  const main = mainMode === 'title' ? 'title' : 'summary'
  const todayKey = data.today
  let days = (data.days || []).slice()
  const todayCount = data.today_count || 0
  // Сегодняшний день показываем всегда — вкладка «Сегодня» и «7 дней» должны
  // включать сегодняшний день, даже когда закрывать было нечего.
  if (todayKey && !days.some(day => day.date === todayKey)) {
    days.unshift({ date: todayKey, label: 'Сегодня', count: 0, items: [] })
  }
  if (hideIds.size) {
    days = days.map(day => {
      const kept = (day.items || []).filter(item => !hideIds.has(item.id))
      return { ...day, items: kept, count: kept.length }
    })
  }

  // Кто появился с прошлого показа — тем и достаётся анимация.
  const seenRef = useRef(null)
  const freshIds = new Set()
  const allIds = days.flatMap(day => (day.items || []).map(item => item.id))
  if (seenRef.current === null) {
    seenRef.current = new Set(allIds) // первый показ — без фейерверка
  } else {
    for (const id of allIds) {
      if (!seenRef.current.has(id)) {
        freshIds.add(id)
        seenRef.current.add(id)
      }
    }
  }

  const head = jsxs('div', {
    className: 'flex flex-col gap-1 px-3 pt-2 pb-1',
    children: [
      jsxs('div', {
        className: 'flex items-center gap-2',
        children: [
          jsx('span', {
            className: 'text-xs font-medium text-(--ui-text-primary)',
            children: todayCount ? '🎉 Закрыто за день' : 'Закрыто за день'
          }),
          jsx('span', {
            className: cn(
              'rounded-full px-1.5 text-[0.625rem] tabular-nums',
              todayCount
                ? 'bg-(--ui-accent) text-(--ui-accent-foreground, #fff)'
                : 'bg-(--chrome-action-hover) text-(--ui-text-secondary)'
            ),
            children: String(todayCount)
          }),
          showHours && data.total_hours
            ? jsx('span', {
                className: 'text-[0.625rem] tabular-nums text-(--ui-text-quaternary)',
                children: `${hoursLabel(data.total_hours)} в задачах`
              })
            : null
        ].filter(Boolean)
      }),
      jsx(PeriodSwitch, { value: period, onChange: setPeriod })
    ]
  })

  let body
  if (query.isLoading) {
    body = jsx('div', {
      className: 'flex flex-col gap-1 p-3',
      children: [0, 1, 2].map(i =>
        jsx(Skeleton, { className: 'h-4 w-full rounded', key: i })
      )
    })
  } else if (query.error || data.ok === false) {
    body = jsx('div', {
      className: 'p-3 text-[0.6875rem] text-(--ui-text-tertiary)',
      children: 'Данные недоступны: включён ли плагин closed-today на стороне агента?'
    })
  } else if (!days.length) {
    body = jsx('div', {
      className: 'p-3 text-[0.6875rem] text-(--ui-text-tertiary)',
      children: 'За этот период закрытых чатов нет.'
    })
  } else {
    body = jsxs('div', {
      className: 'flex flex-col pb-2',
      children: days.map(day =>
        jsx(DayGroup, {
          day,
          freshIds,
          key: day.date,
          main,
          onRename,
          onRestore,
          showEmoji,
          showHours,
          showSummary
        })
      )
    })
  }

  // Меню настроек — только на шапке панели: правый клик по задаче открывает
  // меню самой задачи, и два меню не спорят за одно событие.
  return jsxs('div', {
    className: 'flex h-full min-h-0 flex-col',
    children: [
      jsx(PaneMenu, { children: head }),
      jsx(ScrollArea, { className: 'min-h-0 flex-1', children: body })
    ]
  })
}

/** Та же сводка, но как страница в главной области — её нельзя «потерять». */
function ClosedTodayPage() {
  return jsx('div', {
    className: 'flex h-full min-h-0 flex-col gap-1 p-3',
    children: jsx(ClosedTodayPane, {})
  })
}

function SettingsPage() {
  const { lines, emoji1, main, hours } = useValue(prefs)
  const set = patch => activeCtx && savePrefs(activeCtx, patch)
  const second = main === 'summary' ? 'название задачи' : 'итог задачи'

  return jsxs('div', {
    className: 'flex flex-col gap-4',
    children: [
      jsxs('div', {
        className: 'flex flex-col gap-1.5',
        children: [
          jsx('div', {
            className: 'text-sm font-medium text-(--ui-text-primary)',
            children: 'Строк в задаче'
          }),
          jsx(SegmentedControl, {
            onChange: value => set({ lines: value }),
            options: [
              { id: '1', label: 'Одна строка' },
              { id: '2', label: 'Две строки' }
            ],
            value: lines === '1' ? '1' : '2'
          }),
          jsx('div', {
            className: 'text-xs text-(--ui-text-tertiary)',
            children:
              lines === '1'
                ? 'Одна строка: только главный текст задачи.'
                : `Две строки: вторая показывает ${second}.`
          })
        ]
      }),
      jsxs('div', {
        className: 'flex flex-col gap-1.5',
        children: [
          jsx('div', {
            className: 'text-sm font-medium text-(--ui-text-primary)',
            children: 'Что показывать крупно'
          }),
          jsx(SegmentedControl, {
            onChange: value => set({ main: value }),
            options: [
              { id: 'summary', label: 'Краткое резюме' },
              { id: 'title', label: 'Название задачи' }
            ],
            value: main === 'title' ? 'title' : 'summary'
          }),
          jsx('div', {
            className: 'text-xs text-(--ui-text-tertiary)',
            children:
              'Резюме — последний итог задачи («Не принято: …», «Готово: …»). Название и полный итог всегда видны в подсказке при наведении.'
          })
        ]
      }),
      jsx(ToggleRow, {
        checked: emoji1 !== false,
        description: '✅ готово, ⚠️ не принято, ⏳ ждёт ответа, 📝 прочее — эмодзи перед строкой задачи.',
        label: 'Эмодзи-настроение итога',
        onChange: value => set({ emoji1: !!value })
      }),
      jsx(ToggleRow, {
        checked: hours !== false,
        description:
          'Сколько времени заняли задачи: у каждой строки, в заголовке дня и всего за период. Считается объединение интервалов, поэтому параллельные чаты не удваиваются.',
        label: 'Часы в задачах',
        onChange: value => set({ hours: !!value })
      }),
      jsx('div', {
        className: 'text-xs text-(--ui-text-quaternary)',
        children:
          'Клик по строке — переименовать, Ctrl-клик — открыть чат, правый клик — меню задачи (в т.ч. вернуть из архива). Правый клик по панели — переключатели. Закрытая задача въезжает с искрами ✨'
      })
    ]
  })
}

export default {
  id: ID, // совпадает с именем папки
  name: 'Закрыто за день',
  register(ctx) {
    console.log('[closed-today] build restore-menu 2026-10-30')
    rest = ctx.rest
    activeCtx = ctx
    loadPrefs(ctx)

    // Настройки живут в Settings → Plugins (штатное место для этого).
    ctx.registerSettingsPage?.({
      id: 'settings',
      title: 'Закрыто за день',
      icon: 'archive',
      order: 40,
      render: () => jsx(SettingsPage, {})
    })

    // Вход, который невозможно потерять: страница в главной области и строка
    // в левой навигации (панель можно закрыть или утащить — эти остаются).
    ctx.register({
      id: 'page',
      area: ROUTES_AREA,
      data: { path: '/closed-today' },
      render: () => jsx(ClosedTodayPage, {})
    })

    ctx.register({
      id: 'nav',
      area: SIDEBAR_NAV_AREA,
      order: 45,
      data: { codicon: 'archive', label: 'Закрыто за день', path: '/closed-today' }
    })

    ctx.register({
      id: 'command',
      area: PALETTE_AREA,
      data: {
        title: 'Закрыто за день',
        run: () => host.navigate('/closed-today')
      }
    })

    ctx.register({
      id: 'pane',
      area: 'panes',
      title: 'Закрыто за день',
      data: {
        // Правая зона: панель не зависит от панели сеансов и не «теряется»,
        // если та закрыта или свёрнута.
        placement: 'right',
        width: '320px'
      },
      render: () => jsx(ClosedTodayPane, {})
    })
  }
}