#!/usr/bin/env python3
"""Claude Code status line: model, context, plan limits, project and git branch.

Reads the JSON that Claude Code passes on stdin and prints one line, e.g.
  Opus 5.5 · контекст 45% · сессия 12% · неделя 40% · Trucks/frontend ⎇ team-dev

Enable it in ~/.claude/settings.json:
  "statusLine": {"type": "command",
                 "command": "python3 ~/.local/share/gnome-shell/extensions/claude-usage@neorcage/statusline.py"}
"""

import json
import os
import subprocess
import sys
import time
from datetime import datetime

DIM, RESET = '\033[2m', '\033[0m'
COLORS = {'warn': '\033[33m', 'crit': '\033[31m'}
SEP = f'{DIM} · {RESET}'
WEEKDAYS = ['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс']
HOME = os.path.expanduser('~')


def level(percent):
    # Same thresholds as the panel indicator.
    if percent >= 90:
        return 'crit'
    if percent >= 75:
        return 'warn'
    return ''


def paint(text, lvl):
    return f'{COLORS[lvl]}{text}{RESET}' if lvl else text


def moment(ts):
    date = datetime.fromtimestamp(ts)
    if date.date() == datetime.now().date():
        return f'{date:%H:%M}'
    return f'{WEEKDAYS[date.weekday()]} {date:%H:%M}'


def usage(label, percent, resets_at=None):
    percent = round(percent)
    lvl = level(percent)
    text = f'{label} {percent}%'
    if lvl and resets_at:  # when it matters, say when the limit frees up
        text += f' до {moment(resets_at)}'
    return paint(text, lvl)


def limit(name, window, now):
    if not window or window.get('used_percentage') is None:
        return None
    resets_at = window.get('resets_at')
    # A window that has already reset is at 0% until the next API response says otherwise.
    percent = 0 if resets_at and resets_at <= now else window['used_percentage']
    return usage(name, percent, resets_at)


def project_name(path):
    path = path.split('/.claude/worktrees/')[0].rstrip('/')
    if path == HOME:
        return '~'
    return '/'.join(path.split('/')[-2:])


def git_branch(path, data):
    branch = (data.get('worktree') or {}).get('branch')
    if branch:
        return branch
    try:
        out = subprocess.run(['git', '-C', path, 'branch', '--show-current'],
                             capture_output=True, text=True, timeout=1)
    except (OSError, subprocess.TimeoutExpired):
        return None
    return out.stdout.strip() or None


def status(data):
    now = time.time()
    parts = [(data.get('model') or {}).get('display_name')]

    context = (data.get('context_window') or {}).get('used_percentage')
    if context is not None:
        parts.append(usage('контекст', context))

    limits = data.get('rate_limits') or {}
    parts.append(limit('сессия', limits.get('five_hour'), now))
    parts.append(limit('неделя', limits.get('seven_day'), now))

    path = (data.get('workspace') or {}).get('current_dir') or data.get('cwd')
    if path:
        branch = git_branch(path, data)
        parts.append(project_name(path) + (f' {DIM}⎇{RESET} {branch}' if branch else ''))

    return SEP.join(p for p in parts if p)


def main():
    try:
        print(status(json.load(sys.stdin)))
    except Exception as e:  # a broken status line is worse than a short one
        print(f'statusline: {e}')


if __name__ == '__main__':
    main()
