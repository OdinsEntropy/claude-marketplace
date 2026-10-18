# OdinsEntropys Claude Marketplace

Claude Code mods by OdinsEntropy.

## Usage

#### Installation

From a terminal:

```bash
claude plugin marketplace add OdinsEntropy/claude-marketplace
claude plugin install desktop-statusline@odinsentropy
```

Or at the prompt of a terminal session:
```bash
/plugin install desktop-statusline --marketplace OdinsEntropy/claude-marketplace
```

In the desktop app: click **+** next to the prompt box, then **Plugins**, **Add marketplace** with `OdinsEntropy/claude-marketplace`, then add **desktop-statusline**. Start a new session afterwards, or run `/reload-plugins` in an open one.

#### Update

```bash
claude plugin update desktop-statusline@odinsentropy
```

#### Remove

```bash
claude plugin uninstall desktop-statusline@odinsentropy
```

Mods need Claude Code 2.1.287 or newer. A mod runs with your permissions: this one reads the session's usage figures and draws them, and runs no commands. It sends a model request only when you press the cache's ↻ button.

## Plugins
Currently available plugins.

## desktop-statusline

> **Claude desktop app only.** It draws in the Code tab of the desktop app and nowhere else: in the terminal (CLI) and in the VS Code extension it shows nothing.

A usage bar above the prompt. It shows at a glance:

![The desktop-statusline bar above the prompt in the Claude desktop app](docs/taskbar.png)

| Block | Shows | Bar |
|---|---|---|
| **Context** | how full the context window is, and the tokens in it | green → yellow → orange → red as it fills |
| **5h** | the 5-hour usage limit, and the time until it resets | same colours |
| **7d** | the 7-day usage limit, and the day and hour it resets | same colours |
| **Cache** | how long the prompt cache stays warm, counting down live; **↻** keeps it warm now, **A** keeps it warm automatically (**⏸** pauses that). Once cold, the label turns red and the timer shows what reloading would cost (`Cache ~$3.70`) | runs down until the cache goes cold |
| **Eq. API** | what this session would cost at API prices | measured against your plan: fills up to 1x its monthly price, light blue from 2x, gold from 5x ($20, $40 and $100 on the default $20 plan) |

Rest the pointer on the Context, 5h or 7d bar for the full numbers and reset time.

Because it only draws on the desktop, a `statusLine` you set in `settings.json` for the terminal keeps working as before.

The cache countdown assumes the one-hour cache of a Claude subscription, and five minutes when there are no usage limits (an API key). The cost is Claude Code's own estimate, the same figure `/cost` shows, not what a subscription charges.

Pressing **↻** sends one tiny request over the session's own conversation. While the cache is warm that request reads it, which restarts its lifetime for about the cache-read price; once it is cold, the request writes it again. The reload estimate is the context's tokens at the model's API input price, times 2 for the one-hour cache (1.25 for five minutes).

The prices behind the reload estimate are **hard-coded** from Anthropic's API pricing of October 2026 (input per million tokens: Fable 5.1 $10, Opus 5.5 $4, Opus 5 $5, Sonnet 5.5 $2, Haiku 5.5 $0.10). If they change, set `inputPrices` (below) until the mod is updated.


**A** switches the automatic keep-warm on; while it runs the button reads **⏸**, which pauses it again. While it is on, the mod presses ↻ for you 10 minutes before the cache would lapse, whenever no reply is running, so a one-hour cache costs one tiny cache read about every 50 minutes. It stops after 6 hours without a message of yours, so a forgotten session doesn't keep spending. It belongs to its session: each session has its own cache and its own **A**, and it only runs while that session is open in the app.
`/cache-cold` shows the cold state and its reload estimate for 15 seconds, without touching the real cache, so you can see what a cold cache would cost right now.

### Settings

| Setting | Default | What it does |
|---|---|---|
| `subscriptionUsd` | `20` | What your Claude plan costs a month. The Eq. API bar is full at 1x this, light blue from 2x and gold from 5x. |
| `inputPrices` | empty | Price overrides for the reload estimate: part of a model id = input USD per million tokens, comma-separated, e.g. `opus-5-5=4, sonnet-5-5=2`. Empty uses the built-in prices. |

You're asked for them when you install from a terminal. Change them later in `/config` in a terminal session, under the plugin's rows; the desktop app picks them up the next time a session starts.
