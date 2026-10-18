/** One usage meter, ready to draw. */
export type Meter = {
  /** whole percent used, 0 to 100 */
  pct: number
  /** the text after the percent ("219k / 1M", "resets in 1h 12m") */
  detail?: string
  /** the full text shown when the pointer rests on the bar */
  tooltip?: string
}

/** Everything the card draws, gathered by one refresh. */
export type StatusSnapshot = {
  context: Meter
  fiveHour?: Meter
  sevenDay?: Meter
  /** what the session would have cost at API prices, in US dollars */
  costUsd?: number
  /** how long the prompt cache lives: an hour on a subscription, else five minutes */
  cacheTtlMs: number
}

declare module 'claude-code' {
  interface PluginState {
    'desktop-statusline': {
      /** the last refresh's figures; null before the first */
      snapshot: StatusSnapshot | null
      /** when the main loop's last turn ended, the cache's last read or write; null before one */
      lastTouch: number | null
      /** the clock, bumped every second so the cache countdown redraws */
      now: number
    }
  }
}
