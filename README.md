# claude-stats

**Claude Usage** is a GNOME Shell extension that shows your Claude plan limits and Claude Code token usage in the top
bar.

The interface and the installer's messages are in Russian.

## What it shows

The top bar shows an icon and your session and weekly limit usage as percentages, e.g. `12% · 40%`. The numbers turn
orange at 75% and red at 90%.

Hovering over the icon opens a menu, and clicking pins it open. The menu contains:

- **Your plan** (Pro, Max 5×, Max 20×) and **limits** with progress bars and reset times: the 5-hour session, the
  weekly limit across all models, per-model weekly limits, the weekly breakdown by Claude Code, chats and Cowork, and
  extra credits if they're enabled.
- **Claude Code tokens** for the current session, today, this week, the last 30 days and all time: total, output and
  number of requests.
- **Details for today and this week**: input, output, cache writes and reads, and the top 5 models and projects.
- A link to the usage page on claude.ai and a refresh button.

If the data can't be fetched (the token expired, there's no network, or the API asks to wait), a warning appears at the
top of the menu.

## Requirements

- GNOME Shell 48, 49 or 50.
- `git` and `python3` (standard library only).
- [Claude Code](https://docs.claude.com/en/docs/claude-code), signed in with a claude.ai subscription (run `claude`,
  then `/login`). Without it, plan limits aren't shown, but token stats from local logs still work.

## Installation

```bash
curl -fsSL https://raw.githubusercontent.com/qokori/claude-stats/main/install.sh | bash
```

If you'd rather not run a script straight from the internet, clone the repository and run it locally:

```bash
git clone https://github.com/qokori/claude-stats.git ~/.local/share/gnome-shell/extensions/claude-usage@neorcage
~/.local/share/gnome-shell/extensions/claude-usage@neorcage/install.sh
```

`install.sh`:

- checks the dependencies and the GNOME Shell version;
- clones the repository into `~/.local/share/gnome-shell/extensions/claude-usage@neorcage`;
- enables the extension right away, so you don't have to turn it on in the Extensions app;
- warns you if user extensions are turned off or you aren't signed in to Claude Code.

After the first install, log out and back in once: on Wayland, GNOME Shell only discovers new extensions at startup.

## Updating

Run the same command, or the script from the installed folder:

```bash
~/.local/share/gnome-shell/extensions/claude-usage@neorcage/install.sh
```

The script pulls the changes and tells you whether you need to log in again. Changes to `usage_helper.py` take effect
on their own within a minute. Changes to `extension.js` and `stylesheet.css` need a logout and login.

## Uninstalling

```bash
gnome-extensions disable claude-usage@neorcage
rm -rf ~/.local/share/gnome-shell/extensions/claude-usage@neorcage ~/.cache/claude-usage-indicator
```

## Claude Code status line

`statusline.py` puts the model, context usage, plan limits, project and git branch into Claude Code's status line:

```
Opus 5.5 · контекст 45% · сессия 12% · неделя 40% · Trucks/frontend ⎇ team-dev
```

Values turn orange at 75% and red at 90%, and a limit that high also shows when it resets. The script only reads the
data Claude Code passes to the status line, so it works without the GNOME extension. Plan limits appear when you're
signed in with a claude.ai subscription.

To turn it on, add this to `~/.claude/settings.json`:

```json
"statusLine": {
  "type": "command",
  "command": "python3 ~/.local/share/gnome-shell/extensions/claude-usage@neorcage/statusline.py"
}
```

## How it works

- `extension.js` draws the indicator and the menu. Once a minute it runs `usage_helper.py` as a separate process, so
  parsing logs never blocks the shell.
- `usage_helper.py` collects the data and prints a single JSON document:
  - **limits** come from the same endpoint that Claude Code's `/usage` command uses
    (`api.anthropic.com/api/oauth/usage`), fetched at most once every 3 minutes. Opening the menu refetches them if
    they're more than a minute old, and the refresh button refetches them right away. The endpoint is undocumented and
    may change;
  - **the plan** is read from `~/.claude.json`, which Claude Code keeps up to date;
  - **tokens** are counted from Claude Code's logs in `~/.claude/projects/**/*.jsonl`. Files are read incrementally,
    and repeated entries for the same response are dropped. Claude Code deletes logs older than 30 days, so totals for
    past days are kept in the cache and the all-time count doesn't reset.
- The cache lives in `~/.cache/claude-usage-indicator/cache.json`.
- `CLAUDE_CONFIG_DIR` is respected if Claude Code is set up to use a different folder.

### Token and privacy

The access token is read from `~/.claude/.credentials.json` and sent only to `api.anthropic.com`. The extension never
refreshes the token itself, so it doesn't conflict with Claude Code. If the token has expired, run `claude` and the
data will update. Logs are parsed locally and never leave your machine.

## Debugging

Run the collector by hand to see what it outputs:

```bash
python3 ~/.local/share/gnome-shell/extensions/claude-usage@neorcage/usage_helper.py --pretty
```

Extension logs:

```bash
journalctl -f -o cat /usr/bin/gnome-shell | grep "Claude Usage"
```
