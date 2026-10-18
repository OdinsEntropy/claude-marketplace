import { test, expect, mock } from 'claude-code/testing'

import { costTier, formatClock, formatHour, formatIn, formatTokens, formatUsd } from './register'

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
  on('turn.complete', async () => ({ text: '' }))
  on('session.turns', async () => ({ value: 0 }))
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
  expect(await desktop.find({ text: 'cold' })).toBeDefined()
  await desktop.unmount()

  const terminal = await $.ui.mount({ ...BAND, surface: 'terminal' })

  expect(await terminal.find({ text: 'Context' })).toBeUndefined()
  expect(await terminal.find({ text: 'other band' })).toBeDefined()
  await terminal.unmount()
})

test('a reload into a session with turns starts the cache timer', async ($, on) => {
  const clock = mock.clock(on, { now: new Date('2026-10-18T14:00:00').getTime() })

  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  on('session.turns', async () => ({ value: 12 }))
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
