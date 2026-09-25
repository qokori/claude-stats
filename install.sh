#!/usr/bin/env bash
# Installs or updates the Claude Usage GNOME Shell extension.
#
#   curl -fsSL https://raw.githubusercontent.com/qokori/claude-stats/main/install.sh | bash
#
# The extension directory is a git clone, so running the script again updates it.

set -euo pipefail

UUID=claude-usage@neorcage
REPO=qokori/claude-stats
DEST="${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions/$UUID"

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
warn() { printf '\033[33m! %s\033[0m\n' "$*" >&2; }
die() { printf '\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

# settings_list KEY add|remove: edits a list of extension UUIDs in org.gnome.shell.
settings_list() {
    local value
    value=$(gsettings get org.gnome.shell "$1")
    gsettings set org.gnome.shell "$1" "$(python3 -c '
import ast, sys
value, action, uuid = sys.argv[1:]
items = [i for i in ast.literal_eval(value.removeprefix("@as ")) if i != uuid]
if action == "add":
    items.append(uuid)
print(items)' "$value" "$2" "$UUID")"
}

# `gnome-extensions enable` refuses extensions the running shell hasn't loaded
# yet, so on a first install the settings are edited directly.
enable_extension() {
    gnome-extensions enable "$UUID" 2>/dev/null && return
    settings_list enabled-extensions add
    settings_list disabled-extensions remove
}

main() {
    for cmd in git python3 gsettings gnome-extensions; do
        command -v "$cmd" >/dev/null || die "Не найдена команда $cmd"
    done

    local fresh='' changed='' old
    if [ -d "$DEST/.git" ]; then
        old=$(git -C "$DEST" rev-parse HEAD)
        git -C "$DEST" pull --ff-only --quiet </dev/null ||
            die "Не удалось обновить $DEST: там есть локальные коммиты или изменения"
        changed=$(git -C "$DEST" diff --name-only "$old" HEAD)
    elif [ -e "$DEST" ]; then
        die "$DEST уже существует и это не git-клон. Перенесите или удалите папку и запустите скрипт снова"
    else
        mkdir -p "$(dirname "$DEST")"
        GIT_TERMINAL_PROMPT=0 git clone --quiet "https://github.com/$REPO.git" "$DEST" </dev/null ||
            die "Не удалось скачать https://github.com/$REPO"
        fresh=1
    fi

    local shell_major
    shell_major=$(gnome-shell --version 2>/dev/null | grep -oE '[0-9]+' | head -1 || true)
    if [ -n "$shell_major" ] && ! python3 -c '
import json, sys
sys.exit(sys.argv[2] not in json.load(open(sys.argv[1]))["shell-version"])' "$DEST/metadata.json" "$shell_major"; then
        warn "GNOME Shell $shell_major нет среди поддерживаемых версий, расширение может не запуститься"
    fi

    enable_extension
    if [ "$(gsettings get org.gnome.shell disable-user-extensions)" = true ]; then
        warn "Пользовательские расширения отключены целиком, включите их в приложении «Расширения»"
    fi
    if [ ! -f "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/.credentials.json" ]; then
        warn "Нет входа в Claude Code: лимиты появятся после claude → /login, токены считаются и без него"
    fi

    local relogin='выйдите из сеанса и войдите снова'
    [ "${XDG_SESSION_TYPE:-}" = x11 ] && relogin='перезапустите GNOME Shell: Alt+F2, r, Enter'

    if [ -n "$fresh" ] || ! gnome-extensions list | grep -qxF "$UUID"; then
        bold "Установлено в $DEST. Чтобы расширение появилось в панели, $relogin."
    elif [ -z "$changed" ]; then
        bold "Уже установлена последняя версия."
    elif grep -qvxE 'usage_helper\.py|statusline\.py|README\.md|install\.sh|\.gitignore' <<<"$changed"; then
        bold "Обновлено. Чтобы применить изменения интерфейса, $relogin."
    else
        bold "Обновлено, данные в панели обновятся в течение минуты."
    fi
}

main "$@"
