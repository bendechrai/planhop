# planhop

https://bendechrai.github.io/planhop

Run [Claude Code](https://code.claude.com) on whichever of your subscriptions has quota closest to expiring, while every account shares the same config, sessions and history.

```
$ planhop run
[planhop] using b (b@example.com): 7d 60% resets 1d21h, 5h 25% resets 2h29m | a 7d 31% resets 5d04h
```

planhop is an independent project. It is not made by, affiliated with, or endorsed by Anthropic. "Claude" and "Claude Code" are trademarks of Anthropic.

## Why

With more than one Claude subscription, each account's weekly and 5-hour quota expires on its own schedule. planhop checks every account's usage when you launch Claude Code and picks the one whose quota will be lost soonest if you don't use it.

## How it picks

You only use one account at a time, so planhop spends quota in **earliest-deadline-first** order:

1. Skip accounts at 100% of their 5-hour or weekly limit. If every account is at a limit, use the one that frees up soonest.
2. Pick the account whose weekly quota resets soonest. An account whose week hasn't started goes last, since nothing on it is expiring.
3. If other accounts' weekly resets are within 6 hours of that one, treat it as a tie and prefer the account with the most 5-hour quota about to expire unused.

The account is chosen at launch only. If a session hits a limit, quit and start again with `planhop run -c` (or `claude -c` if you installed the shim), and planhop will move you to another account with the same conversation.

Usage comes from the same endpoint Claude Code's `/usage` uses. Checking it costs no quota and doesn't start a 5-hour window.

## How accounts share everything

Each account gets its own `CLAUDE_CONFIG_DIR` with its own interactive `/login`, so Chrome integration and claude.ai connectors keep working. That wouldn't be possible with `CLAUDE_CODE_OAUTH_TOKEN` (see [Chrome](#chrome)).

Your existing `~/.claude` stays as it is. Every other account's folder (for example `~/.claude-b`) is mostly symlinks back into `~/.claude`: settings, `CLAUDE.md`, sessions and transcripts (`projects/`), history, skills, agents, plugins and so on. So `claude --resume` sees every session whichever account created it.

What stays per account:

- the login (macOS Keychain, or `.credentials.json` on Linux)
- `.claude.json`, which holds login details and project state. Its MCP servers (user and project level) are kept the same on every account: add, change or remove one on any account and planhop applies it to the others at the next launch. If two accounts change the same server differently, your `~/.claude` account's version wins.
- caches, telemetry and the background daemon's state

planhop assumes you want every account to work the same way, so everything else is shared. To keep something per account instead, list it under `keepSeparate` in `~/.config/planhop/config.json`: any item in `~/.claude` by name, and/or `"mcpServers"`.

```json
{
  "accounts": { "a": "~/.claude", "b": "~/.claude-b" },
  "keepSeparate": ["settings.json", "mcpServers"]
}
```

### planhop never deletes your files

If an account folder already has its own copy of something that should be shared (Claude Code sometimes replaces a symlink with a real file when it saves), planhop asks which copy to share the next time you launch in a terminal. The copy you don't pick is moved to `~/.local/state/planhop/moved/<time>/`, never deleted. Identical copies are moved there without asking. With no terminal to ask in, planhop leaves both copies alone and says so.

planhop also refuses to use a folder as an account if it's really `~/.claude` under another name (a symlink, or different letter case on macOS), or sits inside it.

## Install

Requires Node.js 20+ and Claude Code, on macOS or Linux.

```sh
npm install -g planhop
# or
brew install bendechrai/tap/planhop
```

Installing planhop doesn't change what `claude` does. Start Claude Code with `planhop run` (it takes the same arguments as `claude`), or install the shim (step 4 below) to keep typing `claude`.

## Setup

```sh
# 1. Register the account you're already logged into
planhop add a ~/.claude

# 2. Add each other subscription, then log it in (opens your browser)
planhop add b                 # creates ~/.claude-b
planhop login b

# 3. Check, then start Claude Code on the account planhop picks
planhop status
planhop run

# 4. Optional: make plain `claude` go through planhop too
planhop shim                  # writes ~/.local/share/planhop/bin/claude, then offers to
                              # add it to your shell's startup file (zsh, bash or fish)
```

`planhop shim` puts a marked block at the end of your startup file, checks that a new terminal now finds planhop's `claude` first, and warns if something else still wins. `planhop shim --remove` takes it all out again. For other shells it prints the line to add yourself.


### Statusline

Show which account a session is on, with that account's own 5-hour and weekly usage, in `~/.claude/settings.json`:

```json
{ "statusLine": { "type": "command", "command": "planhop statusline" } }
```

To keep an existing statusline script and just add the account in front of it:

```json
{ "statusLine": { "type": "command", "command": "planhop statusline --wrap 'bash ~/.claude/statusline-command.sh'" } }
```

The wrapped command gets `PLANHOP_ACCOUNT`, `PLANHOP_EMAIL`, `PLANHOP_5H_PCT`, `PLANHOP_5H_RESET`, `PLANHOP_7D_PCT` and `PLANHOP_7D_RESET` (resets are Unix seconds) in its environment. If the script comes from the macOS "Claude Usage" menu bar app, add `--usage-app-compat` so it shows each account's own usage rather than the app's account.

## Everyday use

| | |
|---|---|
| `planhop run ...` | picks an account and runs Claude Code, with the same arguments as `claude` |
| `claude ...` | the same, once you've installed the shim |
| `PLANHOP_ACCOUNT=b planhop run` | force an account |
| `planhop status` | usage table and which account would be picked |
| `planhop login <name>` | log an account in again |
| `planhop remove <name>` | stop using an account (its folder is left alone) |

Inside a planhop session, anything that starts Claude Code again (a script, a subagent calling `claude -p`) stays on the same account: planhop sets `PLANHOP_ACTIVE` in the session and passes straight through when it sees it. It does the same when `CLAUDE_CONFIG_DIR` or `CLAUDE_CODE_OAUTH_TOKEN` is already set.

Commands for shared things (`mcp`, `config`, `plugin`, `doctor`, `update`, `--version`) run without picking an account. `claude auth` and `claude setup-token` change one account's login, so planhop makes you name it: `PLANHOP_ACCOUNT=b claude auth login`, or `planhop login b`.

## Chrome

The Claude in Chrome extension only works with Claude Code sessions logged into **the same account as the extension**. To use the browser from more than one subscription:

1. Create a browser profile for each subscription (in Chrome or Brave, click your profile picture, then Add).
2. Install the Claude in Chrome extension in each profile, and sign each one in with its own subscription's claude.ai account. [Anthropic's Chrome docs](https://code.claude.com/docs/en/chrome) cover installing it.
3. Keep those profiles open. Each session finds the extension signed into its account; if one connects to the wrong browser, run `/chrome` and choose "Select browser...".

Browser profiles don't share site logins, so browser work in a second subscription's profile won't be signed into your usual sites unless you sign in there too.

## Limitations

- **Undocumented internals.** planhop relies on the usage endpoint, and on macOS on how Claude Code names Keychain entries for a custom config dir. A Claude Code release could change either. When usage can't be read, planhop falls back to the last reading it saved, then to your first account.
- **Idle accounts use saved readings.** A stored login only renews while Claude Code is running on that account. Once an idle account's login has expired, planhop uses its last saved reading, which stays accurate unless you've used that account in the claude.ai apps since.
- **Per-account sign-ins.** MCP servers that sign in through a browser need signing in once per account. claude.ai connectors are per claude.ai account.

## Terms

Only use planhop with subscriptions that are yours. Check [Anthropic's Consumer Terms](https://www.anthropic.com/legal/consumer-terms) and [Usage Policy](https://www.anthropic.com/legal/aup) for what they allow.

## Development

```sh
pnpm install
pnpm lint && pnpm typecheck && pnpm test
pnpm build && node dist/cli.js status
```

## License

MIT
