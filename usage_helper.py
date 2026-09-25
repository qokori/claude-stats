#!/usr/bin/env python3
"""Usage collector for the Claude Usage GNOME Shell indicator.

Prints a single JSON document to stdout:
  * plan limits (5-hour session, weekly, per-model) from the endpoint that
    Claude Code's /usage command uses; the response is cached, so the API is
    hit at most once per --api-max-age seconds;
  * token counts aggregated from Claude Code transcripts
    (~/.claude/projects/**/*.jsonl), parsed incrementally via a per-file offset cache.

Run it by hand to debug the indicator:  python3 usage_helper.py --pretty
"""

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta

CLAUDE_DIR = os.environ.get('CLAUDE_CONFIG_DIR') or os.path.expanduser('~/.claude')
PROJECTS_DIR = os.path.join(CLAUDE_DIR, 'projects')
CREDENTIALS_FILE = os.path.join(CLAUDE_DIR, '.credentials.json')
GLOBAL_CONFIG_FILE = os.path.join(os.environ.get('CLAUDE_CONFIG_DIR') or os.path.expanduser('~'),
                                  '.claude.json')
CACHE_FILE = os.path.join(
    os.environ.get('XDG_CACHE_HOME') or os.path.expanduser('~/.cache'),
    'claude-usage-indicator', 'cache.json')
CACHE_VERSION = 2

USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
AUTH_ERRORS = ('token_expired', 'no_credentials')
HOME = os.path.expanduser('~')
SESSION_SECONDS = 5 * 3600
WEEK_SECONDS = 7 * 86400
KEEP_SECONDS = 32 * 86400  # entries older than this are dropped from the cache
TOP_N = 5

# Layout of a cached transcript entry.
KEY, TS, MODEL, PROJECT, INPUT, OUTPUT, CACHE_READ, CACHE_WRITE = range(8)


def load_cache():
    try:
        with open(CACHE_FILE) as fh:
            cache = json.load(fh)
        if cache.get('version') == CACHE_VERSION:
            return cache
    except (OSError, ValueError):
        pass
    return {'version': CACHE_VERSION, 'files': {}, 'api': {}, 'history': {}}


def save_cache(cache):
    os.makedirs(os.path.dirname(CACHE_FILE), exist_ok=True)
    tmp = f'{CACHE_FILE}.{os.getpid()}.tmp'
    with open(tmp, 'w') as fh:
        json.dump(cache, fh, separators=(',', ':'))
    os.replace(tmp, CACHE_FILE)


def parse_ts(value):
    try:
        return int(datetime.fromisoformat(value.replace('Z', '+00:00')).timestamp())
    except (AttributeError, TypeError, ValueError):
        return None


def parse_reset(value):
    # The API reports e.g. 10:59:59.87 for an 11:00 reset; snap to the minute.
    ts = parse_ts(value)
    return round(ts / 60) * 60 if ts is not None else None


def local_midnight(days_ago=0):
    today = datetime.now().replace(hour=0, minute=0, second=0, microsecond=0)
    return (today - timedelta(days=days_ago)).timestamp()


# ---------------------------------------------------------------- plan limits

def read_oauth():
    try:
        with open(CREDENTIALS_FILE) as fh:
            return json.load(fh).get('claudeAiOauth') or {}
    except (OSError, ValueError):
        return {}


def read_account():
    # .credentials.json keeps the plan as of the last login, so it goes stale
    # after an upgrade; Claude Code refreshes this profile copy on its own.
    try:
        with open(GLOBAL_CONFIG_FILE) as fh:
            return json.load(fh).get('oauthAccount') or {}
    except (OSError, ValueError):
        return {}


def plan_name(account, oauth):
    if account.get('organizationType'):
        sub = account['organizationType'].lower().removeprefix('claude_')
        tier = account.get('userRateLimitTier') or account.get('organizationRateLimitTier') or ''
    else:
        sub = (oauth.get('subscriptionType') or '').lower()
        tier = oauth.get('rateLimitTier') or ''
    tier = tier.lower()
    if sub == 'max':
        for mult in ('20x', '5x'):
            if mult in tier:
                return f'Max {mult[:-1]}×'
    return sub.capitalize() or None


def fetch_usage(token):
    req = urllib.request.Request(USAGE_URL, headers={
        'Authorization': f'Bearer {token}',
        'anthropic-beta': 'oauth-2025-04-20',
        'Accept': 'application/json',
        'User-Agent': 'claude-usage-indicator/1.0',
    })
    with urllib.request.urlopen(req, timeout=15) as resp:
        return json.load(resp)


def update_api(api, oauth, max_age, now):
    """Refresh the cached API response in place when it is older than max_age."""
    try:
        cred_mtime = os.stat(CREDENTIALS_FILE).st_mtime
    except OSError:
        cred_mtime = None
    # Auth errors are retried as soon as Claude Code rewrites the credentials.
    retry_auth = api.get('error') in AUTH_ERRORS and api.get('cred_mtime') != cred_mtime
    if now - api.get('attempted_at', 0) < max_age and not retry_auth:
        return
    api['attempted_at'] = now
    api['cred_mtime'] = cred_mtime

    token = oauth.get('accessToken')
    if not token:
        api['error'] = 'no_credentials'
        return
    # Refreshing the token ourselves would race with Claude Code, which rotates
    # the refresh token; it renews the access token on its next run anyway.
    if (oauth.get('expiresAt') or 0) / 1000 < now:
        api['error'] = 'token_expired'
        return
    try:
        api['data'] = fetch_usage(token)
        api['fetched_at'] = now
        api['error'] = None
    except urllib.error.HTTPError as e:
        api['error'] = {401: 'token_expired', 403: 'forbidden', 429: 'rate_limited'}.get(
            e.code, f'HTTP {e.code}')
    except (urllib.error.URLError, OSError, ValueError) as e:
        api['error'] = f'network: {getattr(e, "reason", e)}'


def scope_name(scope):
    for value in (scope or {}).values():
        if isinstance(value, dict) and value.get('display_name'):
            return value['display_name']
    return None


def normalize_limits(data):
    items = []
    for lim in data.get('limits') or []:
        if lim.get('percent') is None:
            continue
        items.append({
            'kind': lim.get('kind'),
            'group': lim.get('group'),
            'scope': scope_name(lim.get('scope')),
            'percent': lim['percent'],
            'resets_at': parse_reset(lim.get('resets_at')),
            'severity': lim.get('severity'),
        })
    if not items:  # older response shape without the generic "limits" list
        for field, kind, group, scope in (
                ('five_hour', 'session', 'session', None),
                ('seven_day', 'weekly_all', 'weekly', None),
                ('seven_day_opus', 'weekly_scoped', 'weekly', 'Opus'),
                ('seven_day_sonnet', 'weekly_scoped', 'weekly', 'Sonnet')):
            window = data.get(field)
            if window and window.get('utilization') is not None:
                items.append({
                    'kind': kind, 'group': group, 'scope': scope,
                    'percent': round(window['utilization']),
                    'resets_at': parse_reset(window.get('resets_at')),
                    'severity': None,
                })

    rows = (data.get('seven_day_breakdown') or {}).get('rows') or []
    breakdown = [{'key': r.get('key'), 'name': r.get('display_name') or r.get('key'),
                  'percent': r['percent']} for r in rows if r.get('percent')]

    spend = data.get('spend') or {}
    extra = None
    if spend.get('enabled'):
        used, limit = spend.get('used') or {}, spend.get('limit') or {}
        extra = {
            'used': used.get('amount_minor', 0) / 10 ** used.get('exponent', 2),
            'limit': limit.get('amount_minor', 0) / 10 ** limit.get('exponent', 2),
            'currency': used.get('currency') or 'USD',
            'percent': spend.get('percent') or 0,
        }
    return items, breakdown, extra


# ---------------------------------------------------------------- tokens

def project_name(cwd):
    if not cwd:
        return '?'
    cwd = cwd.split('/.claude/worktrees/')[0]
    if cwd == HOME:
        return '~'
    if cwd.startswith(HOME + '/'):
        parts = cwd[len(HOME) + 1:].split('/')
        return '/'.join(parts[-2:]) if len(parts) > 2 else '~/' + '/'.join(parts)
    return '/'.join(cwd.rstrip('/').split('/')[-2:])


def model_name(model):
    parts = model.removeprefix('claude-').split('-')
    if len(parts[-1]) == 8 and parts[-1].isdigit():  # release date suffix
        parts = parts[:-1]
    family = ' '.join(p.capitalize() for p in parts if not p.isdigit())
    version = '.'.join(p for p in parts if p.isdigit())
    return f'{family} {version}'.strip()


def read_entries(path, offset, entries):
    """Append usage entries found after `offset`; return the new offset."""
    with open(path, 'rb') as fh:
        fh.seek(offset)
        data = fh.read()
    end = data.rfind(b'\n') + 1  # leave a partially written last line for later
    for line in data[:end].splitlines():
        if b'"usage"' not in line:
            continue
        try:
            rec = json.loads(line)
        except ValueError:
            continue
        msg = rec.get('message') if rec.get('type') == 'assistant' else None
        usage = msg and msg.get('usage')
        model = (msg or {}).get('model') or ''
        ts = parse_ts(rec.get('timestamp'))
        if not usage or not model or model.startswith('<') or ts is None:
            continue
        entries.append([
            f"{msg.get('id')}:{rec.get('requestId')}", ts, model, project_name(rec.get('cwd')),
            usage.get('input_tokens') or 0, usage.get('output_tokens') or 0,
            usage.get('cache_read_input_tokens') or 0, usage.get('cache_creation_input_tokens') or 0,
        ])
    return offset + end


def scan_transcripts(files, now):
    """Bring the per-file cache up to date and return deduplicated entries."""
    present = set()
    for root, _dirs, names in os.walk(PROJECTS_DIR):
        for name in names:
            if not name.endswith('.jsonl'):
                continue
            path = os.path.join(root, name)
            try:
                st = os.stat(path)
            except OSError:
                continue
            present.add(path)
            cached = files.get(path)
            if cached and cached['size'] == st.st_size and cached['mtime'] == st.st_mtime:
                continue
            if not cached or st.st_size < cached['offset']:
                cached = {'offset': 0, 'entries': []}
            try:
                cached['offset'] = read_entries(path, cached['offset'], cached['entries'])
            except OSError:
                continue
            cached['size'], cached['mtime'] = st.st_size, st.st_mtime
            files[path] = cached
    for path in list(files):
        if path not in present:
            del files[path]

    # One API response is logged once per content block, and resumed sessions
    # copy history into new files; keep the copy with the final output count.
    unique = {}
    for cached in files.values():
        cached['entries'] = [e for e in cached['entries'] if e[TS] >= now - KEEP_SECONDS]
        for e in cached['entries']:
            prev = unique.get(e[KEY])
            if prev is None or e[OUTPUT] > prev[OUTPUT]:
                unique[e[KEY]] = e
    return list(unique.values())


def new_bucket():
    return {'input': 0, 'output': 0, 'cache_read': 0, 'cache_write': 0, 'total': 0, 'requests': 0}


def add(bucket, e):
    bucket['input'] += e[INPUT]
    bucket['output'] += e[OUTPUT]
    bucket['cache_read'] += e[CACHE_READ]
    bucket['cache_write'] += e[CACHE_WRITE]
    bucket['total'] += e[INPUT] + e[OUTPUT] + e[CACHE_READ] + e[CACHE_WRITE]
    bucket['requests'] += 1


def top(groups):
    ranked = sorted(groups.items(), key=lambda kv: kv[1]['total'], reverse=True)
    return [{'name': name, **bucket} for name, bucket in ranked[:TOP_N]]


def token_windows(limits, now):
    """Periods to report: (key, start, rolling). Session/week follow the plan windows."""
    def window_start(kind, length):
        lim = next((l for l in limits if l['kind'] == kind and (l['resets_at'] or 0) > now), None)
        return lim['resets_at'] - length if lim else None

    session = window_start('session', SESSION_SECONDS)
    week = window_start('weekly_all', WEEK_SECONDS)
    return [
        ('session', session or now - SESSION_SECONDS, session is None),
        ('today', local_midnight(), False),
        ('week', week or local_midnight(6), week is None),
        ('month', local_midnight(29), True),
    ]


def local_date(ts):
    return datetime.fromtimestamp(ts).strftime('%Y-%m-%d')


def all_time(entries, history):
    """Totals since the first logged request.

    Claude Code deletes transcripts after 30 days, so finished days are frozen
    into `history` (kept in the cache) and only recent days come from entries.
    Claude Code's own stats-cache.json is not used: it counts every transcript
    line, and one API response is logged once per content block.
    """
    frozen_before = datetime.fromtimestamp(local_midnight(1)).strftime('%Y-%m-%d')
    days = {}
    for e in entries:
        day = local_date(e[TS])
        if day not in history:
            add(days.setdefault(day, new_bucket()), e)
    for day in [d for d in days if d < frozen_before]:
        history[day] = days.pop(day)
    total = new_bucket()
    for bucket in [*history.values(), *days.values()]:
        for field in total:
            total[field] += bucket[field]
    first = min([*history, *days], default=None)
    since = datetime.strptime(first, '%Y-%m-%d').timestamp() if first else None
    return {'since': since, **total}


def summarize_tokens(entries, windows, history):
    periods = [{'key': key, 'start': int(start), 'rolling': rolling, **new_bucket()}
               for key, start, rolling in windows]
    groups = {key: {'models': {}, 'projects': {}} for key in ('today', 'week')}
    for e in entries:
        for period in periods:
            if e[TS] < period['start']:
                continue
            add(period, e)
            group = groups.get(period['key'])
            if group:
                add(group['models'].setdefault(model_name(e[MODEL]), new_bucket()), e)
                add(group['projects'].setdefault(e[PROJECT], new_bucket()), e)
    details = {key: {'models': top(g['models']), 'projects': top(g['projects'])}
               for key, g in groups.items()}
    return {'periods': periods, 'details': details, 'all_time': all_time(entries, history)}


def main():
    parser = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    parser.add_argument('--api-max-age', type=float, default=180,
                        help='re-fetch plan limits only if the cached response is older (seconds)')
    parser.add_argument('--pretty', action='store_true', help='indent the JSON output')
    args = parser.parse_args()

    now = time.time()
    cache = load_cache()
    oauth = read_oauth()
    api = cache.setdefault('api', {})
    update_api(api, oauth, args.api_max_age, now)
    entries = scan_transcripts(cache['files'], now)
    items, breakdown, extra = normalize_limits(api.get('data') or {})
    tokens = summarize_tokens(entries, token_windows(items, now), cache.setdefault('history', {}))
    save_cache(cache)

    result = {
        'generated_at': int(now),
        'plan': plan_name(read_account(), oauth),
        'limits': {
            'items': items,
            'breakdown': breakdown,
            'extra': extra,
            'fetched_at': api.get('fetched_at'),
            'error': api.get('error'),
        },
        'tokens': tokens,
    }
    json.dump(result, sys.stdout, ensure_ascii=False, indent=2 if args.pretty else None)
    sys.stdout.write('\n')


if __name__ == '__main__':
    main()
