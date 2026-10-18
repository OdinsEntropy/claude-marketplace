import { test, expect, mock } from 'claude-code/testing'

import { costTier, formatClock, formatHour, formatIn, formatReload, formatTokens, formatUsd, parsePrices, reloadCostUsd } from './register'

const BAND = {
  plugin: 'desktop-statusline',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns: 120, scroll: { offset: 0, bodyRows: 20 }, view: {} },
} as const

test('figures read short', async () => {
  expect(formatTokens(245_000)).toBe('245k')
  expect(formatTokens(1_000_000)).toBe('1M')
  expect(formatIn(72 * 60_000)).toBe('1h 12m')
  expect(formatIn((3 * 24 + 4) * 3_600_000)).toBe('3d 4h')
  expect(formatUsd(4.123)).toBe('$4.12')
  expect(formatClock(52 * 60_000 + 10_000)).toBe('52:10')
  expect(formatHour(new Date('2026-10-24T14:30:00'))).toBe('2pm')
  expect(formatHour(new Date('2026-10-24T00:15:00'))).toBe('12am')
})

test('draws the usage card on desktop only, keeping the band beneath', async ($, on) => {
  const clock = mock.clock(on, { now: new Date('2026-10-18T14:00:00').getTime() })

  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  on('command.register', async (_$, e) => ({ value: { command: e.name } }))
  on('turn.complete', async () => ({ text: '' }))
  on('session.turns', async () => ({ value: 0 }))
  on('session.model', async () => ({ value: 'claude-opus-5-5' }))
  on('session.usage', async () => ({
    value: {
      startedAt: 0,
      context: { tokens: 245_000, window: 1_000_000, percent: 25 },
      rateLimits: [
        { kind: 'five_hour', percentUsed: 36.4, resetsAt: '2026-10-18T16:40:00' },
        { kind: 'seven_day', percentUsed: 92, resetsAt: '2026-10-24T14:00:00' },
      ],
      cost: { usd: 4.123 },
    },
  }))
  // Another mod's band beneath, which the card must keep.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e) => {
    const { Text } = $.ui.resolve(e)

    return h(Text, { key: 'beneath' }, 'other band')
  })

  await $.session.start({ cwd: 'C:/Users/Eric/proj' })

  const desktop = await $.ui.mount({ ...BAND, surface: 'desktop' })

  // The refresh runs unawaited: let it land in state, which redraws the band.
  for (let i = 0; i < 500 && (await desktop.find({ text: 'Context' })) === undefined; i++) {
    await Promise.resolve()
  }

  for (const text of ['Context', '25%', '· 245k', '36%', '· ↻ 2h 40m', '92%', '· ↻ Sat 2pm', '7d', 'Eq. API', '$4.12', 'other band']) {
    expect(await desktop.find({ text })).toBeDefined()
  }

  expect(await desktop.find({ type: 'Svg' })).toBeDefined()

  // No turn yet: no cache to count down. On a subscription it lives an hour.
  expect(await desktop.find({ text: '–' })).toBeDefined()
  await $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  await clock.advance(7 * 60_000 + 50_000)
  expect(await desktop.find({ text: '52:10' })).toBeDefined()
  await clock.advance(53 * 60_000)
  // 245k tokens on Opus 5.5 at $4/MTok, written at 2x for the one-hour cache.
  expect(await desktop.find({ text: '~$1.96' })).toBeDefined()
  await desktop.unmount()

  const terminal = await $.ui.mount({ ...BAND, surface: 'terminal' })

  expect(await terminal.find({ text: 'Context' })).toBeUndefined()
  expect(await terminal.find({ text: 'other band' })).toBeDefined()
  await terminal.unmount()
})

test('a reload into a session with turns starts the cache timer', async ($, on) => {
  const clock = mock.clock(on, { now: new Date('2026-10-18T14:00:00').getTime() })

  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  on('command.register', async (_$, e) => ({ value: { command: e.name } }))
  on('session.turns', async () => ({ value: 12 }))
  on('session.model', async () => ({ value: 'claude-opus-5-5' }))
  on('session.usage', async () => ({
    value: {
      startedAt: 0,
      context: { tokens: 1000, window: 200_000, percent: 0 },
      rateLimits: [{ kind: 'five_hour', percentUsed: 1 }],
    },
  }))
  on('ui.render', { component: 'AbovePrompt' }, async ($, e) => {
    const { Box } = $.ui.resolve(e)

    return h(Box, { key: 'beneath' })
  })

  await $.session.start({ cwd: 'C:/Users/Eric/proj' })

  const desktop = await $.ui.mount({ ...BAND, surface: 'desktop' })

  for (let i = 0; i < 500 && (await desktop.find({ text: 'Context' })) === undefined; i++) {
    await Promise.resolve()
  }

  await clock.advance(10_000)
  expect(await desktop.find({ text: '59:50' })).toBeDefined()
  await desktop.unmount()
})

test('the API-cost bar fills to $20, then turns light blue at $40 and gold at $100', async () => {
  expect(costTier(5).pct).toBe(25)
  expect(costTier(20).pct).toBe(100)
  expect(costTier(30)).toMatchObject({ pct: 100, bar: '#2f9e6b' })
  expect(costTier(40)).toMatchObject({ pct: 100, bar: '#4cc3f0' })
  expect(costTier(150)).toMatchObject({ pct: 100, bar: '#d4af37' })
})

test('reload cost: input price per model, 2x for the one-hour cache, 1.25x for five minutes', async () => {
  const hour = 60 * 60_000

  expect(reloadCostUsd('claude-opus-5-5', 1_000_000, hour)).toBe(8)
  expect(reloadCostUsd('claude-sonnet-5-5[1m]', 1_000_000, 5 * 60_000)).toBe(2.5)
  expect(reloadCostUsd('claude-fable-5-1', 100_000, hour)).toBe(2)
  expect(Math.round(reloadCostUsd('claude-haiku-5-5', 200_000, hour)! * 100)).toBe(20)
  expect(reloadCostUsd('some-other-model', 1000, hour)).toBeUndefined()
  expect(formatReload(1.964)).toBe('$1.96')
  expect(formatReload(0.04)).toBe('4¢')
})

test('pressing ↻ forks a tiny request and restarts the cache countdown', async ($, on) => {
  const clock = mock.clock(on, { now: new Date('2026-10-18T14:00:00').getTime() })
  const forks: string[] = []

  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  on('command.register', async (_$, e) => ({ value: { command: e.name } }))
  on('session.turns', async () => ({ value: 3 }))
  on('session.model', async () => ({ value: 'claude-opus-5-5' }))
  on('session.usage', async () => ({
    value: { startedAt: 0, context: { tokens: 50_000, window: 1_000_000, percent: 5 }, rateLimits: [{ kind: 'five_hour', percentUsed: 1 }] },
  }))
  on('model.fork', async (_$, e) => {
    forks.push(e.prompt)

    return {
      value: {
        isAnswered: true,
        text: 'ok',
        usage: { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 50_000, cache_creation_input_tokens: 0 },
      },
    }
  })
  on('ui.render', { component: 'AbovePrompt' }, async ($, e) => {
    const { Box } = $.ui.resolve(e)

    return h(Box, { key: 'beneath' })
  })

  await $.session.start({ cwd: 'C:/Users/Eric/proj' })

  const desktop = await $.ui.mount({ ...BAND, surface: 'desktop' })

  for (let i = 0; i < 500 && (await desktop.find({ text: 'Context' })) === undefined; i++) {
    await Promise.resolve()
  }

  await clock.advance(30 * 60_000)
  expect(await desktop.find({ text: '30:00' })).toBeDefined()

  await desktop.press({ key: 'warm' })
  expect(forks).toHaveLength(1)
  expect(await desktop.find({ text: '60:00' })).toBeDefined()
  await desktop.unmount()
})

test('the cost colours follow the subscription: full at 1x, light blue at 2x, gold at 5x', async () => {
  expect(costTier(50, 100).pct).toBe(50)
  expect(costTier(150, 100).bar).toBe('#2f9e6b')
  expect(costTier(200, 100).bar).toBe('#4cc3f0')
  expect(costTier(500, 100).bar).toBe('#d4af37')
})

test('price overrides come before the built-in prices', async () => {
  const overrides = parsePrices('opus-5-5 = 3, sonnet=$2.5 ; junk')
  const hour = 60 * 60_000

  expect(overrides).toHaveLength(2)
  expect(reloadCostUsd('claude-opus-5-5', 1_000_000, hour, overrides)).toBe(6)
  expect(reloadCostUsd('claude-sonnet-5-5', 1_000_000, hour, overrides)).toBe(5)
  expect(reloadCostUsd('claude-fable-5-1', 1_000_000, hour, overrides)).toBe(20)
})

test('/cache-cold previews the cold state for 15 seconds without touching the cache', async ($, on) => {
  const clock = mock.clock(on, { now: new Date('2026-10-18T14:00:00').getTime() })

  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  on('command.register', async (_$, e) => ({ value: { command: e.name } }))
  on('session.turns', async () => ({ value: 3 }))
  on('session.model', async () => ({ value: 'claude-opus-5-5' }))
  on('session.usage', async () => ({
    value: { startedAt: 0, context: { tokens: 500_000, window: 1_000_000, percent: 50 }, rateLimits: [{ kind: 'five_hour', percentUsed: 1 }] },
  }))
  on('ui.render', { component: 'AbovePrompt' }, async ($, e) => {
    const { Box } = $.ui.resolve(e)

    return h(Box, { key: 'beneath' })
  })

  await $.session.start({ cwd: 'C:/Users/Eric/proj' })

  const desktop = await $.ui.mount({ ...BAND, surface: 'desktop' })

  for (let i = 0; i < 500 && (await desktop.find({ text: 'Context' })) === undefined; i++) {
    await Promise.resolve()
  }

  const r = await $.command.run({ command: 'cache-cold', args: '' })

  // 500k tokens on Opus 5.5 at $4/MTok, written at 2x for the one-hour cache.
  expect(r.text).toContain('~$4.00 to reload')
  expect(await desktop.find({ text: '~$4.00' })).toBeDefined()

  await clock.advance(16_000)
  expect(await desktop.find({ text: '~$4.00' })).toBeUndefined()
  expect(await desktop.find({ text: '59:44' })).toBeDefined()
  await desktop.unmount()
})

test('auto keep-warm (A/⏸) warms the cache 10 minutes before it lapses, and only when switched on', async ($, on) => {
  const clock = mock.clock(on, { now: new Date('2026-10-18T14:00:00').getTime() })
  let forks = 0

  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  on('command.register', async (_$, e) => ({ value: { command: e.name } }))
  on('session.turns', async () => ({ value: 3 }))
  on('session.model', async () => ({ value: 'claude-opus-5-5' }))
  on('session.usage', async () => ({
    value: { startedAt: 0, context: { tokens: 50_000, window: 1_000_000, percent: 5 }, rateLimits: [{ kind: 'five_hour', percentUsed: 1 }] },
  }))
  on('model.fork', async () => {
    forks += 1

    return {
      value: { isAnswered: true, text: 'ok', usage: { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 50_000, cache_creation_input_tokens: 0 } },
    }
  })
  on('ui.render', { component: 'AbovePrompt' }, async ($, e) => {
    const { Box } = $.ui.resolve(e)

    return h(Box, { key: 'beneath' })
  })

  await $.session.start({ cwd: 'C:/Users/Eric/proj' })

  const desktop = await $.ui.mount({ ...BAND, surface: 'desktop' })

  for (let i = 0; i < 500 && (await desktop.find({ text: 'Context' })) === undefined; i++) {
    await Promise.resolve()
  }

  // Off: the button reads A, and the cache runs down untouched.
  expect(await desktop.find({ text: 'A' })).toBeDefined()
  expect(await desktop.find({ text: '⏸' })).toBeUndefined()
  await clock.advance(51 * 60_000)
  expect(forks).toBe(0)

  // On, with 9 minutes left: the next tick warms it and the countdown restarts.
  await desktop.press({ key: 'auto' })
  await clock.advance(2000)
  expect(forks).toBe(1)
  expect(await desktop.find({ text: '⏸' })).toBeDefined()

  // ⏸ pauses it again, and the button reads A once more.
  await desktop.press({ key: 'auto' })
  expect(await desktop.find({ text: '⏸' })).toBeUndefined()
  expect(await desktop.find({ text: 'A' })).toBeDefined()
  expect(await desktop.find({ text: /^59:5\d$/ })).toBeDefined()
  await desktop.unmount()
})
