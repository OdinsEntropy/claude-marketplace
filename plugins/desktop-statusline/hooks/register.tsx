// A usage card above the prompt in the desktop app: context, the 5-hour and
// weekly limits, what the session would cost at API prices and how long the
// prompt cache stays warm, with a button that keeps it warm and, once it has
// gone cold, what writing it again would cost. The terminal keeps its own
// status line; this card draws on the desktop only.
import { atom, read, update } from 'claude-code'
import type { Color, EngineInterface, Register, RenderElement, SessionRateLimit } from 'claude-code'

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
const isWarming = atom({ plugin: 'desktop-statusline', key: 'isWarming' } as const, false)
const isAuto = atom({ plugin: 'desktop-statusline', key: 'isAuto' } as const, false)

let isRefreshing = false

// The userConfig options, set by register on each load.
let subscriptionUsd = 20
let priceOverrides: [RegExp, number][] = []

// Until when /cache-cold shows the cold state (a preview; the cache is untouched).
let previewColdUntil = 0
const PREVIEW_MS = 15_000

// Auto keep-warm: warm the cache this long before it lapses, stop after this
// long without a real turn (so an idle session does not spend forever), and
// wait this long after a try before the next one.
export const AUTO_LEAD_MS = 10 * 60_000
export const AUTO_MAX_IDLE_MS = 6 * 60 * 60_000
const AUTO_RETRY_MS = 60_000
let isTurnRunning = false
let lastRealTurn = 0
let lastAutoTry = 0

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

// The API-cost bar measures the session against your subscription: it fills up
// to 1x the monthly price (the `subscriptionUsd` option, $20 by default), then
// stays full and turns light blue at 2x and gold at 5x.
export const DEFAULT_SUBSCRIPTION_USD = 20
export const costTier = (usd: number, subscriptionUsd = DEFAULT_SUBSCRIPTION_USD): { pct: number; bar: string; text: Color } =>
  usd >= subscriptionUsd * 5
    ? { pct: 100, bar: '#d4af37', text: '#b8901c' }
    : usd >= subscriptionUsd * 2
      ? { pct: 100, bar: '#4cc3f0', text: '#2a9fd0' }
      : { pct: Math.min(100, (usd / subscriptionUsd) * 100), bar: BAR_COLORS[0]!, text: 'success' }

// Input price per million tokens at API rates, first match wins. Hard-coded from
// Anthropic's pricing of October 2026; the `inputPrices` option overrides it.
// Haiku 5.5 costs more past 100k tokens of prompt.
type PriceRow = [RegExp, number]
const INPUT_USD_PER_MTOK: PriceRow[] = [
  [/fable|mythos/, 10],
  [/opus-5-5/, 4],
  [/opus/, 5],
  [/sonnet-5/, 2],
  [/sonnet/, 3],
  [/haiku-5-5/, 0.1],
  [/haiku/, 1],
]
const HAIKU_LONG_PROMPT_USD_PER_MTOK = 0.5

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// "opus-5-5=4, sonnet=2.5": a part of the model id, then its input price per
// million tokens. Parts that do not parse are skipped.
export const parsePrices = (text: string): PriceRow[] =>
  text
    .split(/[,;\n]/)
    .map(part => /^\s*([\w.[\]-]+)\s*=\s*\$?\s*(\d+(?:\.\d+)?)\s*$/.exec(part))
    .filter((m): m is RegExpExecArray => m !== null)
    .map(m => [new RegExp(escapeRegExp(m[1]!.toLowerCase())), Number(m[2])])

// Writing to the cache costs 2x the input price with the one-hour lifetime and
// 1.25x with the five-minute one. `overrides` are tried before the built-in table.
export const reloadCostUsd = (model: string, tokens: number, ttlMs: number, overrides: PriceRow[] = []): number | undefined => {
  const id = model.toLowerCase()
  const override = overrides.find(([pattern]) => pattern.test(id))
  const match = override ?? INPUT_USD_PER_MTOK.find(([pattern]) => pattern.test(id))

  if (match === undefined || tokens <= 0) {
    return undefined
  }

  const perMTok = override === undefined && /haiku-5-5/.test(id) && tokens > 100_000 ? HAIKU_LONG_PROMPT_USD_PER_MTOK : match[1]

  return (tokens / 1_000_000) * perMTok * (ttlMs >= SUBSCRIPTION_CACHE_TTL_MS ? 2 : 1.25)
}

// $2.10, or ¢ under a dime
export const formatReload = (usd: number) => (usd < 0.1 ? `${Math.max(1, Math.round(usd * 100))}¢` : `$${usd.toFixed(2)}`)

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
    const [usage, t, model] = await Promise.all([$.session.usage(), $.clock.now(), $.session.model()])
    const { tokens = 0, window } = usage.context
    const limits = new Map(usage.rateLimits.map(l => [l.kind, l]))
    const cacheTtlMs = usage.rateLimits.length > 0 ? SUBSCRIPTION_CACHE_TTL_MS : API_CACHE_TTL_MS
    const next: StatusSnapshot = {
      context: {
        pct: usage.context.percent ?? (window > 0 ? Math.floor((tokens * 100) / window) : 0),
        detail: formatTokens(tokens),
        tooltip: `Context: ${formatTokens(tokens)} of ${formatTokens(window)} tokens used`,
      },
      fiveHour: toMeter(limits.get('five_hour'), t, false),
      sevenDay: toMeter(limits.get('seven_day'), t, true),
      costUsd: usage.cost?.usd,
      cacheTtlMs,
      reloadUsd: reloadCostUsd(model, tokens, cacheTtlMs, priceOverrides),
    }

    await update($, snapshot, () => next)
  } finally {
    isRefreshing = false
  }
}

// Keeps the cache warm: one tiny request over the session's own transcript
// reads the cached prefix, which restarts its lifetime. Once the cache has
// gone cold the same request writes it again, at the reload price.
async function warm($: EngineInterface) {
  if (await read($, isWarming)) {
    return
  }

  await update($, isWarming, () => true)

  try {
    const r = await $.model.fork({ prompt: 'Reply with just: ok' })

    if (r.isAnswered) {
      const t = await $.clock.now()
      await update($, lastTouch, () => t)
      await update($, now, () => t)

      // The request runs in the background and posts nothing to the chat: say what it did.
      const { cache_read_input_tokens: hit, cache_creation_input_tokens: wrote } = r.usage
      $.ui.toast(
        hit >= wrote
          ? `Cache kept warm: ${formatTokens(hit)} tokens read from it.`
          : `Cache was cold: ${formatTokens(wrote)} tokens written to it again.`,
      )
    } else if (r.reason === 'nothing-to-fork') {
      $.ui.toast('Nothing cached yet: send a message first.')
    } else {
      $.ui.toast(`Cache refresh failed (${r.reason}).`)
    }
  } finally {
    await update($, isWarming, () => false)
  }

  void refresh($)
}

export const register: Register = (on, options) => {
  subscriptionUsd = typeof options.subscriptionUsd === 'number' && options.subscriptionUsd > 0 ? options.subscriptionUsd : DEFAULT_SUBSCRIPTION_USD
  priceOverrides = typeof options.inputPrices === 'string' ? parsePrices(options.inputPrices) : []

  on('session.start', async ($, e, next) => {
    const result = await next(e)

    await $.command.register({
      name: 'cache-cold',
      description: 'Preview the cold-cache state and its reload estimate for 15 seconds (the cache is untouched)',
    })

    // The first version pinned a footer line; the card replaces it.
    $.ui.status(undefined)

    // Loaded into a session that already ran turns (a reload, a resume): no turn
    // end was seen, so count from now rather than show no timer.
    lastRealTurn = await $.clock.now()

    if ((await read($, lastTouch)) === null && (await $.session.turns()) > 0) {
      const t = await $.clock.now()
      await update($, lastTouch, () => t)
      await update($, now, () => t)
    }

    void refresh($)
    $.clock.every(REFRESH_MS, () => refresh($))

    // Tick the cache countdown while it can still be warm, and while a
    // /cache-cold preview runs, so it ends on time.
    $.clock.every(1000, async () => {
      const touched = await read($, lastTouch)
      const s = await read($, snapshot)
      const t = await $.clock.now()
      const isWarmish = touched !== null && s !== null && t - touched < s.cacheTtlMs + 2000

      if (isWarmish || t < previewColdUntil + 2000) {
        await update($, now, () => t)
      }

      // Auto keep-warm: shortly before the cache lapses, while the session is
      // idle, and only within AUTO_MAX_IDLE_MS of the last real turn.
      if (touched === null || s === null || !(await read($, isAuto))) {
        return
      }

      const left = touched + s.cacheTtlMs - t
      const isDue = left > 0 && left <= AUTO_LEAD_MS
      const isIdleTooLong = t - lastRealTurn > AUTO_MAX_IDLE_MS

      if (isDue && !isIdleTooLong && !isTurnRunning && t - lastAutoTry >= AUTO_RETRY_MS) {
        lastAutoTry = t
        await warm($)
      }
    })

    return result
  })

  on('command.run', { command: 'cache-cold' }, async $ => {
    const t = await $.clock.now()
    previewColdUntil = t + PREVIEW_MS
    await refresh($)
    await update($, now, () => t)

    const s = await read($, snapshot)
    const estimate = s?.reloadUsd === undefined ? 'no estimate for this model' : `~${formatReload(s.reloadUsd)} to reload`

    return { text: `Showing the cache as cold for ${PREVIEW_MS / 1000} seconds (${estimate}). The real cache is untouched.` }
  })

  // Context, a rate-limit window or the cost moved.
  on('session.measure', async ($, e, next) => {
    void refresh($)

    return next(e)
  })

  // A main-loop turn uses the cache itself: auto keep-warm waits for it.
  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      isTurnRunning = true
    }

    return next(e)
  })

  // Every finished main-loop turn has just read or written the cache.
  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      const t = await $.clock.now()
      isTurnRunning = false
      lastRealTurn = t
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
    const warming = await read($, isWarming)
    const auto = await read($, isAuto)
    const { Box, Text, Svg, Button } = $.ui.resolve(e)

    // One text line (label, value, an optional button, detail) with the bar
    // under it; resting the pointer on the bar shows `tooltip`.
    const block = (
      key: string,
      label: string,
      value: string,
      color: Color,
      pct: number,
      barColor: string,
      detail?: string,
      tooltip?: string,
      actions?: RenderElement[],
      labelColor: Color = 'subtle',
    ) => (
      <Box key={key} position="relative" flexDirection="column" gap={0} flexGrow={1} flexShrink={1} width={0}>
        <Box flexDirection="row" gap={1} alignItems="center" width="100%">
          <Text size="caption" color={labelColor}>
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
          {actions !== undefined && (
            // Pinned to the block's right edge, over the end of the bar (the
            // desktop does not stretch a growing spacer in this row).
            <Box key="actions" position="absolute" top={0} right={0} flexDirection="row" gap={0} alignItems="center">
              {actions}
            </Box>
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

    // ↻ keeps the cache warm (or writes it again once cold); A switches the
    // automatic keep-warm on and off. Both are hidden while a reply or a
    // refresh already uses the cache.
    const buttons = [
      <Button key="warm" label="↻" plain dimColor hover={{ color: 'claude' }} onPress={() => warm($)} />,
      // A starts auto keep-warm; ⏸ (shown while it runs) pauses it again.
      <Button key="auto" label={auto ? '⏸' : 'A'} plain dimColor hover={{ color: 'claude' }} onPress={() => update($, isAuto, v => !v)} />,
    ]

    // The bar runs down as the cache's lifetime does, coloured by what is gone:
    // full while a turn uses it.
    const cache = () => {
      if (e.props.isWorking) {
        return block('cache', 'Cache', 'in use', 'success', 100, BAR_COLORS[0]!)
      }

      if (warming) {
        return block('cache', 'Cache', 'refreshing…', 'subtle', 100, BAR_COLORS[0]!)
      }

      // /cache-cold shows the cold state for a few seconds without touching the cache.
      const isPreview = t < previewColdUntil

      if (touched === null && !isPreview) {
        return block('cache', 'Cache', '–', 'inactive', 0, BAR_COLORS[0]!)
      }

      const left = isPreview || touched === null ? 0 : touched + s.cacheTtlMs - Math.max(t, touched)
      const usedPct = 100 - (left / s.cacheTtlMs) * 100

      if (left > 0) {
        return block(
          'cache',
          'Cache',
          formatClock(left),
          TEXT_COLORS[level(usedPct)],
          100 - usedPct,
          BAR_COLORS[level(usedPct)]!,
          undefined,
          undefined,
          buttons,
        )
      }

      // Cold: a red label, and what the next message (or ↻) pays to write the
      // context again where the timer was.
      return block(
        'cache',
        'Cache',
        s.reloadUsd === undefined ? 'cold' : `~${formatReload(s.reloadUsd)}`,
        'error',
        0,
        BAR_COLORS[0]!,
        undefined,
        undefined,
        buttons,
        'error',
      )
    }

    const cost = (usd: number) => {
      const tier = costTier(usd, subscriptionUsd)

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
