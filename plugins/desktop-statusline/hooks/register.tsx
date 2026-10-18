// A usage card above the prompt in the desktop app: context, the 5-hour and
// weekly limits, what the session would cost at API prices and how long the
// prompt cache stays warm. The terminal keeps its own status line; this
// card draws on the desktop only.
import { atom, read, update } from 'claude-code'
import type { Color, EngineInterface, Register, SessionRateLimit } from 'claude-code'

import type { Meter, StatusSnapshot } from '../types'

const REFRESH_MS = 15_000
const BAR_HEIGHT = 6
const SUBSCRIPTION_CACHE_TTL_MS = 60 * 60_000
const API_CACHE_TTL_MS = 5 * 60_000

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

const snapshot = atom({ plugin: 'desktop-statusline', key: 'snapshot' } as const, null)
const lastTouch = atom({ plugin: 'desktop-statusline', key: 'lastTouch' } as const, null)
const now = atom({ plugin: 'desktop-statusline', key: 'now' } as const, 0)

let isRefreshing = false

// 245k / 1M
export const formatTokens = (n: number) => {
  if (n >= 1_000_000) {
    const v = Math.round(n / 100_000) / 10

    return Number.isInteger(v) ? `${v}M` : `${v.toFixed(1)}M`
  }

  return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n)
}

// 4:40pm, 2pm on the hour
const formatTime = (d: Date) => {
  const h = d.getHours() % 12 || 12
  const m = String(d.getMinutes()).padStart(2, '0')

  return `${h}${m === '00' ? '' : `:${m}`}${d.getHours() < 12 ? 'am' : 'pm'}`
}

// 2pm (the minutes left out)
export const formatHour = (d: Date) => `${d.getHours() % 12 || 12}${d.getHours() < 12 ? 'am' : 'pm'}`

// 1h 12m / 3d 4h / 8m
export const formatIn = (ms: number) => {
  const minutes = Math.max(0, Math.round(ms / 60_000))
  const days = Math.floor(minutes / 1440)
  const hours = Math.floor((minutes % 1440) / 60)

  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${minutes % 60}m`

  return `${minutes}m`
}

const toMeter = (limit: SessionRateLimit | undefined, now: number, isWeekly: boolean): Meter | undefined => {
  if (!limit) {
    return undefined
  }

  const pct = Math.floor(limit.percentUsed)
  const name = isWeekly ? '7-day limit' : '5-hour limit'
  const at = limit.resetsAt ? new Date(limit.resetsAt) : undefined

  if (at === undefined || Number.isNaN(at.getTime())) {
    return { pct, tooltip: `${name}: ${pct}% used` }
  }

  // ↻ 2h 0m / ↻ Sat 2pm; the hover has the whole date and time.
  const day = `${DAYS[at.getDay()]} ${MONTHS[at.getMonth()]} ${at.getDate()}`

  return {
    pct,
    detail: `↻ ${isWeekly ? `${DAYS[at.getDay()]} ${formatHour(at)}` : formatIn(at.getTime() - now)}`,
    tooltip: `${name}: ${pct}% used · resets ${isWeekly ? `${day}, ` : ''}${formatTime(at)} (in ${formatIn(at.getTime() - now)})`,
  }
}

// 52:10 / 4:05
export const formatClock = (ms: number) => {
  const s = Math.max(0, Math.ceil(ms / 1000))

  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

export const formatUsd = (usd: number) => (usd >= 100 ? `$${Math.round(usd)}` : `$${usd.toFixed(2)}`)

// Green under 50%, yellow, orange from 70%, red from 90%: text in theme colors, bars in fixed
// tones that read on the light and the dark theme alike.
const level = (pct: number) => (pct >= 90 ? 3 : pct >= 70 ? 2 : pct >= 50 ? 1 : 0)
const TEXT_COLORS: Color[] = ['success', 'warning', 'claude', 'error']
const BAR_COLORS = ['#2f9e6b', '#d4a20f', '#e07b39', '#e5484d']

// The API-cost bar fills up to $20; past that it stays full and changes colour
// at $40 (light blue) and $100 (gold).
const COST_FULL_USD = 20
export const costTier = (usd: number): { pct: number; bar: string; text: Color } =>
  usd >= 100
    ? { pct: 100, bar: '#d4af37', text: '#b8901c' }
    : usd >= 40
      ? { pct: 100, bar: '#4cc3f0', text: '#2a9fd0' }
      : { pct: Math.min(100, (usd / COST_FULL_USD) * 100), bar: BAR_COLORS[0]!, text: 'success' }

const escapeXml = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

// A bar of `pct` percent in `color`; `tooltip` shows while the pointer rests on it.
const barSvg = (pct: number, color: string, tooltip?: string) => {
  // No viewBox: percent widths resolve against the slot, so the bar stretches
  // with its block without squashing the rounded ends.
  const clamped = Math.max(0, Math.min(100, pct))
  const fill = clamped > 0 ? `<rect width="${Math.max(clamped, 3)}%" height="${BAR_HEIGHT}" rx="3" fill="${color}"/>` : ''
  const title = tooltip === undefined ? '' : `<title>${escapeXml(tooltip)}</title>`

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="${BAR_HEIGHT}">${title}` +
    `<rect width="100%" height="${BAR_HEIGHT}" rx="3" fill="#8a8a8a" fill-opacity="0.25"/>${fill}</svg>`
  )
}

async function refresh($: EngineInterface) {
  if (isRefreshing) {
    return
  }

  isRefreshing = true

  try {
    const [usage, t] = await Promise.all([$.session.usage(), $.clock.now()])
    const { tokens = 0, window } = usage.context
    const limits = new Map(usage.rateLimits.map(l => [l.kind, l]))
    const next: StatusSnapshot = {
      context: {
        pct: usage.context.percent ?? (window > 0 ? Math.floor((tokens * 100) / window) : 0),
        detail: formatTokens(tokens),
        tooltip: `Context: ${formatTokens(tokens)} of ${formatTokens(window)} tokens used`,
      },
      fiveHour: toMeter(limits.get('five_hour'), t, false),
      sevenDay: toMeter(limits.get('seven_day'), t, true),
      costUsd: usage.cost?.usd,
      cacheTtlMs: usage.rateLimits.length > 0 ? SUBSCRIPTION_CACHE_TTL_MS : API_CACHE_TTL_MS,
    }

    await update($, snapshot, () => next)
  } finally {
    isRefreshing = false
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)

    // The first version pinned a footer line; the card replaces it.
    $.ui.status(undefined)

    // Loaded into a session that already ran turns (a reload, a resume): no turn
    // end was seen, so count from now rather than show no timer.
    if ((await read($, lastTouch)) === null && (await $.session.turns()) > 0) {
      const t = await $.clock.now()
      await update($, lastTouch, () => t)
      await update($, now, () => t)
    }

    void refresh($)
    $.clock.every(REFRESH_MS, () => refresh($))

    // Tick the cache countdown while it can still be warm.
    $.clock.every(1000, async () => {
      const touched = await read($, lastTouch)
      const s = await read($, snapshot)
      const t = await $.clock.now()

      if (touched !== null && s !== null && t - touched < s.cacheTtlMs + 2000) {
        await update($, now, () => t)
      }
    })

    return result
  })

  // Context, a rate-limit window or the cost moved.
  on('session.measure', async ($, e, next) => {
    void refresh($)

    return next(e)
  })

  // Every finished main-loop turn has just read or written the cache.
  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      const t = await $.clock.now()
      await update($, lastTouch, () => t)
      await update($, now, () => t)
    }

    return next(e)
  })

  // Desktop only; other mods' bands still draw beneath the card.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const below = await next(e)
    const s = await read($, snapshot)

    if (e.surface !== 'desktop' || s === null || e.props.hasSurvey) {
      return below
    }

    const touched = await read($, lastTouch)
    const t = await read($, now)
    const { Box, Text, Svg } = $.ui.resolve(e)

    // One text line (label, value, detail) with the bar under it; resting the
    // pointer on the bar shows `tooltip`.
    const block = (
      key: string,
      label: string,
      value: string,
      color: Color,
      pct: number,
      barColor: string,
      detail?: string,
      tooltip?: string,
    ) => (
      <Box key={key} flexDirection="column" gap={0} flexGrow={1} flexShrink={1} width={0}>
        <Box flexDirection="row" gap={1} alignItems="center">
          <Text size="caption" color="subtle">
            {label}
          </Text>
          <Text size="caption" weight="semibold" tabular color={color}>
            {value}
          </Text>
          {detail !== undefined && (
            <Text size="caption" color="subtle" tabular wrap="truncate-end">
              · {detail}
            </Text>
          )}
        </Box>
        <Svg
          source={barSvg(pct, barColor, tooltip)}
          alt={tooltip ?? `${label}: ${value}`}
          height={BAR_HEIGHT}
          isInteractive={tooltip !== undefined}
        />
      </Box>
    )

    const meter = (key: string, label: string, m: Meter) =>
      block(key, label, `${m.pct}%`, TEXT_COLORS[level(m.pct)], m.pct, BAR_COLORS[level(m.pct)]!, m.detail, m.tooltip)

    // The bar runs down as the cache's lifetime does, coloured by what is gone:
    // full while a turn uses it.
    const cache = () => {
      if (e.props.isWorking) {
        return block('cache', 'Cache', 'in use', 'success', 100, BAR_COLORS[0]!)
      }

      if (touched === null) {
        return block('cache', 'Cache', '–', 'inactive', 0, BAR_COLORS[0]!)
      }

      const left = touched + s.cacheTtlMs - Math.max(t, touched)
      const usedPct = 100 - (left / s.cacheTtlMs) * 100

      return left > 0
        ? block(
            'cache',
            'Cache',
            formatClock(left),
            TEXT_COLORS[level(usedPct)],
            100 - usedPct,
            BAR_COLORS[level(usedPct)]!,
          )
        : block('cache', 'Cache', 'cold', 'error', 0, BAR_COLORS[0]!)
    }

    const cost = (usd: number) => {
      const tier = costTier(usd)

      return block(
        'cost',
        'Eq. API',
        formatUsd(usd),
        tier.text,
        tier.pct,
        tier.bar,
      )
    }

    const card = (
      <Box
        key="statusline"
        flexDirection="row"
        paddingX={1}
        paddingY={0}
        columnGap={3}
        rowGap={0}
        flexWrap="nowrap"
        alignItems="flex-start"
        width="100%"
      >
        {meter('context', 'Context', s.context)}
        {s.fiveHour && meter('five-hour', '5h', s.fiveHour)}
        {s.sevenDay && meter('weekly', '7d', s.sevenDay)}
        {cache()}
        {s.costUsd !== undefined && cost(s.costUsd)}
      </Box>
    )

    return below ? (
      <Box flexDirection="column" gap={0}>
        {card}
        {below}
      </Box>
    ) : (
      card
    )
  })
}
