// Claude Usage: plan limits and Claude Code token usage in the GNOME top bar.
//
// All data comes from usage_helper.py (run as a subprocess so that parsing
// transcripts never blocks the shell); this file only renders its JSON.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

Gio._promisify(Gio.Subprocess.prototype, 'communicate_utf8_async');

const REFRESH_INTERVAL = 60; // seconds between helper runs
const API_MAX_AGE = 180; // plan limits are re-fetched at most this often...
const API_MAX_AGE_ON_OPEN = 60; // ...or this often when the menu is opened
const STALE_LIMITS = 15 * 60;
const USAGE_PAGE = 'https://claude.ai/settings/usage';
const DIM = 170; // opacity of secondary text
const HOVER_OPEN_DELAY = 150; // ms of hovering the icon before the menu opens
const HOVER_CLOSE_DELAY = 350; // ms outside the icon and menu before it closes
const HOVER_POLL = 100; // ms; the open menu holds a grab, so the pointer is polled

const WEEKDAYS = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
const MONTHS = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];

const LIMIT_TITLES = {session: 'Сессия · 5 часов', weekly_all: 'Неделя · все модели'};
const GROUP_TITLES = {session: 'Сессия', weekly: 'Неделя'};
const SURFACES = {claude_code: 'Claude Code', chat: 'Чаты', cowork: 'Cowork', other: 'Другое'};
const ERRORS = {
    token_expired: 'Токен Claude истёк — запусти claude, он обновит его сам',
    no_credentials: 'Нет входа в Claude — запусти claude и выполни /login',
    rate_limited: 'API просит подождать, лимиты обновятся позже',
    forbidden: 'API отказал в доступе к лимитам',
};

// ---------------------------------------------------------------- formatting

const pad2 = n => String(n).padStart(2, '0');
const clock = date => `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
const shortDate = date => `${date.getDate()} ${MONTHS[date.getMonth()]}`;

function formatTokens(n) {
    for (const [size, suffix] of [[1e9, 'B'], [1e6, 'M'], [1e3, 'K']]) {
        if (n >= size) {
            const v = n / size;
            return `${v >= 100 ? v.toFixed(0) : v.toFixed(1).replace(/\.0$/, '')}${suffix}`;
        }
    }
    return String(n);
}

function formatCount(n) {
    return n === null || n === undefined ? '—' : String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

function formatDuration(seconds) {
    const total = Math.max(1, Math.round(seconds / 60));
    const days = Math.floor(total / 1440), hours = Math.floor(total % 1440 / 60), mins = total % 60;
    if (days)
        return hours ? `${days} д ${hours} ч` : `${days} д`;
    if (hours)
        return mins ? `${hours} ч ${mins} мин` : `${hours} ч`;
    return `${mins} мин`;
}

// "14:00", "завтра 14:00" or "ср 30 сен, 13:00"
function formatMoment(ts) {
    const date = new Date(ts * 1000);
    const now = new Date();
    const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    if (date.toDateString() === now.toDateString())
        return clock(date);
    if (date.toDateString() === tomorrow.toDateString())
        return `завтра ${clock(date)}`;
    return `${WEEKDAYS[date.getDay()]} ${shortDate(date)}, ${clock(date)}`;
}

function formatMoney(value, currency) {
    return currency === 'USD' ? `$${value.toFixed(2)}` : `${value.toFixed(2)} ${currency}`;
}

function resetText(resetsAt, now) {
    if (!resetsAt)
        return null;
    if (resetsAt <= now)
        return 'Окно сброшено, ждём свежие данные';
    return `Сброс через ${formatDuration(resetsAt - now)} · ${formatMoment(resetsAt)}`;
}

function limitTitle(item) {
    return LIMIT_TITLES[item.kind] ??
        [GROUP_TITLES[item.group] ?? item.group, item.scope ?? item.kind].filter(Boolean).join(' · ');
}

function periodTitle(period) {
    const start = new Date(period.start * 1000);
    switch (period.key) {
    case 'session':
        return period.rolling ? 'Последние 5 ч' : `Сессия · с ${clock(start)}`;
    case 'today':
        return 'Сегодня';
    case 'week':
        return period.rolling ? '7 дней' : `Неделя · с ${shortDate(start)}`;
    case 'month':
        return '30 дней';
    default:
        return period.key;
    }
}

// A window that has already reset is at 0% until the API says otherwise.
function currentPercent(item, now) {
    return item.resets_at && item.resets_at <= now ? 0 : item.percent;
}

function usageLevel(percent, severity = 'normal') {
    if (percent >= 90 || severity === 'critical')
        return 'crit';
    if (percent >= 75 || (severity && severity !== 'normal'))
        return 'warn';
    return '';
}

function worstLevel(levels) {
    return levels.find(l => l === 'crit') ?? levels.find(l => l === 'warn') ?? '';
}

// ---------------------------------------------------------------- widgets

function makeLabel(text, {styleClass = '', dim = false, expand = false, align = Clutter.ActorAlign.START} = {}) {
    const label = new St.Label({
        text,
        style_class: styleClass,
        x_expand: expand,
        x_align: align,
        y_align: Clutter.ActorAlign.CENTER,
    });
    if (dim)
        label.opacity = DIM;
    return label;
}

function infoItem() {
    return new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
}

function textItem(text) {
    const item = infoItem();
    item.add_child(makeLabel(text, {dim: true}));
    return item;
}

function headingItem(text) {
    const item = infoItem();
    item.add_style_class_name('claude-usage-compact');
    item.add_child(makeLabel(text.toUpperCase(), {styleClass: 'claude-usage-section-title', dim: true}));
    return item;
}

function valueItem(name, value, note = null) {
    const item = infoItem();
    item.add_style_class_name('claude-usage-compact');
    item.add_child(makeLabel(name, {expand: true}));
    if (note)
        item.add_child(makeLabel(note, {styleClass: 'claude-usage-small', dim: true}));
    item.add_child(makeLabel(value, {styleClass: 'claude-usage-cell claude-usage-value'}));
    return item;
}

const ProgressBar = GObject.registerClass(
class ProgressBar extends St.Widget {
    _init(fraction, level) {
        super._init({style_class: 'claude-usage-bar', x_expand: true});
        this._fraction = Math.min(Math.max(fraction, 0), 1);
        this._fill = new St.Widget({style_class: `claude-usage-bar-fill ${level}`.trim()});
        this.add_child(this._fill);
    }

    vfunc_allocate(box) {
        this.set_allocation(box);
        const content = this.get_theme_node().get_content_box(box);
        const fill = new Clutter.ActorBox();
        fill.x1 = content.x1;
        fill.y1 = content.y1;
        fill.x2 = content.x1 + Math.round((content.x2 - content.x1) * this._fraction);
        fill.y2 = content.y2;
        this._fill.allocate(fill);
    }
});

function limitItem(title, value, fraction, level, lines) {
    const item = infoItem();
    const box = new St.BoxLayout({
        orientation: Clutter.Orientation.VERTICAL,
        x_expand: true,
        style_class: 'claude-usage-limit',
    });
    const row = new St.BoxLayout({x_expand: true});
    row.add_child(makeLabel(title, {expand: true}));
    row.add_child(makeLabel(value, {styleClass: 'claude-usage-limit-percent'}));
    box.add_child(row);
    box.add_child(new ProgressBar(fraction, level));
    for (const line of lines.filter(Boolean))
        box.add_child(makeLabel(line, {styleClass: 'claude-usage-small', dim: true}));
    item.add_child(box);
    return item;
}

// ---------------------------------------------------------------- indicator

const UsageIndicator = GObject.registerClass(
class UsageIndicator extends PanelMenu.Button {
    _init(extension) {
        super._init(0.5, 'Claude Usage');
        this._helper = GLib.build_filenamev([extension.path, 'usage_helper.py']);
        this._cancellable = new Gio.Cancellable();
        this._data = null;
        this._helperError = null;
        this._busy = false;
        this._wantedApiMaxAge = null;
        this._openedByHover = false;
        this._pinned = false;
        this._suppressHoverOpen = false;
        this._hoverOpenId = 0;
        this._leaveWatchId = 0;

        const icon = Gio.icon_new_for_string(
            GLib.build_filenamev([extension.path, 'icons', 'claude-usage-symbolic.svg']));
        const box = new St.BoxLayout();
        box.add_child(new St.Icon({gicon: icon, style_class: 'system-status-icon'}));
        this._panelLabel = new St.Label({
            text: '…',
            style_class: 'claude-usage-panel-label',
            y_align: Clutter.ActorAlign.CENTER,
        });
        box.add_child(this._panelLabel);
        this.add_child(box);

        this.menu.box.add_style_class_name('claude-usage-menu');
        this._buildMenu(icon);
        this.menu.connect('open-state-changed', (_menu, open) => {
            if (open) {
                // A menu opened by click (or keyboard) stays until dismissed.
                this._pinned = !this._openedByHover;
                this._openedByHover = false;
                this._startLeaveWatch();
                this._render();
                this._refresh(API_MAX_AGE_ON_OPEN);
            } else {
                this._stopLeaveWatch();
                // Closed by a click on the icon: don't reopen until the pointer leaves it.
                this._suppressHoverOpen = this._pointerOverButton();
            }
        });
        this.connect('notify::hover', () => this._onHoverChanged());

        // While the menu is open it holds the grab, so a click on the icon
        // arrives here and PopupMenuManager would close the menu. If it was
        // opened by hovering, pin it instead. Connected before the manager's
        // handler (added in addToStatusArea), so EVENT_STOP pre-empts it.
        this.menu.actor.connect('captured-event', (_actor, event) => {
            const type = event.type();
            if ((type === Clutter.EventType.BUTTON_PRESS || type === Clutter.EventType.TOUCH_BEGIN) &&
                !this._pinned && this.contains(global.stage.get_event_actor(event))) {
                this._pinned = true;
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });

        this._timerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, REFRESH_INTERVAL, () => {
            this._refresh(API_MAX_AGE);
            return GLib.SOURCE_CONTINUE;
        });
        this._refresh(API_MAX_AGE);
    }

    // Hover opens the menu after a short delay, so sweeping across the panel
    // doesn't flash it; leaving both the icon and the menu closes it again.
    _onHoverChanged() {
        this._cancelHoverOpen();
        if (!this.hover) {
            this._suppressHoverOpen = false;
            return;
        }
        if (this.menu.isOpen || this._suppressHoverOpen)
            return;
        this._hoverOpenId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, HOVER_OPEN_DELAY, () => {
            this._hoverOpenId = 0;
            if (this.hover && !this.menu.isOpen) {
                this._openedByHover = true;
                this.menu.open();
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    _cancelHoverOpen() {
        if (this._hoverOpenId) {
            GLib.Source.remove(this._hoverOpenId);
            this._hoverOpenId = 0;
        }
    }

    _startLeaveWatch() {
        this._stopLeaveWatch();
        let outsideSince = 0;
        this._leaveWatchId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, HOVER_POLL, () => {
            if (this._pinned || this._pointerInside()) {
                outsideSince = 0;
                return GLib.SOURCE_CONTINUE;
            }
            const now = GLib.get_monotonic_time();
            outsideSince ||= now;
            if (now - outsideSince < HOVER_CLOSE_DELAY * 1000)
                return GLib.SOURCE_CONTINUE;
            this._leaveWatchId = 0;
            this.menu.close();
            return GLib.SOURCE_REMOVE;
        });
    }

    _stopLeaveWatch() {
        if (this._leaveWatchId) {
            GLib.Source.remove(this._leaveWatchId);
            this._leaveWatchId = 0;
        }
    }

    _pointerOverButton(extendDownTo = 0) {
        const [px, py] = global.get_pointer();
        const [bx, by] = this.get_transformed_position();
        const [bw, bh] = this.get_transformed_size();
        return px >= bx && px < bx + bw && py >= by && py < Math.max(by + bh, extendDownTo);
    }

    // Inside the icon, the menu, or the gap between them.
    _pointerInside() {
        const [px, py] = global.get_pointer();
        const [mx, my] = this.menu.actor.get_transformed_position();
        const [mw, mh] = this.menu.actor.get_transformed_size();
        const inMenu = px >= mx && px < mx + mw && py >= my && py < my + mh;
        return inMenu || this._pointerOverButton(my);
    }

    _buildMenu(icon) {
        this._statusItem = infoItem();
        this._statusItem.add_child(new St.Icon({icon_name: 'dialog-warning-symbolic', style_class: 'popup-menu-icon'}));
        this._statusLabel = makeLabel('', {styleClass: 'claude-usage-status-label', expand: true});
        this._statusLabel.clutter_text.line_wrap = true;
        this._statusLabel.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        this._statusItem.add_child(this._statusLabel);
        this.menu.addMenuItem(this._statusItem);

        const header = infoItem();
        header.add_child(new St.Icon({gicon: icon, style_class: 'popup-menu-icon'}));
        header.add_child(makeLabel('Claude', {styleClass: 'claude-usage-title', expand: true}));
        this._planLabel = makeLabel('', {styleClass: 'claude-usage-badge'});
        header.add_child(this._planLabel);
        this.menu.addMenuItem(header);

        this._limitsSection = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._limitsSection);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const tokensItem = infoItem();
        const tokensBox = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            style_class: 'claude-usage-limit',
        });
        tokensBox.add_child(makeLabel('ТОКЕНЫ CLAUDE CODE', {styleClass: 'claude-usage-section-title', dim: true}));
        this._tokensGrid = new St.Widget({layout_manager: new Clutter.GridLayout(), x_expand: true});
        tokensBox.add_child(this._tokensGrid);
        tokensItem.add_child(tokensBox);
        this.menu.addMenuItem(tokensItem);

        this._todayMenu = new PopupMenu.PopupSubMenuMenuItem('Подробно за сегодня');
        this.menu.addMenuItem(this._todayMenu);
        this._weekMenu = new PopupMenu.PopupSubMenuMenuItem('Подробно за неделю');
        this.menu.addMenuItem(this._weekMenu);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const openItem = new PopupMenu.PopupImageMenuItem('Открыть лимиты на claude.ai', 'web-browser-symbolic');
        openItem.connect('activate', () => this._openUsagePage());
        this.menu.addMenuItem(openItem);

        const footer = infoItem();
        this._updatedLabel = makeLabel('', {styleClass: 'claude-usage-small', dim: true, expand: true});
        footer.add_child(this._updatedLabel);
        const refreshButton = new St.Button({
            style_class: 'claude-usage-icon-button',
            can_focus: true,
            accessible_name: 'Обновить',
            child: new St.Icon({icon_name: 'view-refresh-symbolic', style_class: 'popup-menu-icon'}),
        });
        refreshButton.connect('clicked', () => this._refresh(0));
        footer.add_child(refreshButton);
        this.menu.addMenuItem(footer);

        this._render();
    }

    // Requests a helper run; while one is in flight, the strictest request is queued.
    _refresh(apiMaxAge) {
        this._wantedApiMaxAge = Math.min(this._wantedApiMaxAge ?? Infinity, apiMaxAge);
        if (!this._busy)
            this._runHelper();
    }

    async _runHelper() {
        this._busy = true;
        while (this._wantedApiMaxAge !== null) {
            const apiMaxAge = this._wantedApiMaxAge;
            this._wantedApiMaxAge = null;
            this._updatedLabel.text = 'Обновление…';
            try {
                const proc = Gio.Subprocess.new(
                    ['python3', this._helper, '--api-max-age', String(apiMaxAge)],
                    Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
                const [stdout, stderr] = await proc.communicate_utf8_async(null, this._cancellable);
                if (!proc.get_successful())
                    throw new Error(stderr.trim().split('\n').pop() || `код выхода ${proc.get_exit_status()}`);
                this._data = JSON.parse(stdout);
                this._helperError = null;
            } catch (e) {
                if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                    return;
                this._helperError = e.message;
                console.warn(`Claude Usage: ${e.message}`);
            }
            if (this._cancellable.is_cancelled())
                return;
            this._render();
        }
        this._busy = false;
    }

    _openUsagePage() {
        try {
            Gio.AppInfo.launch_default_for_uri(USAGE_PAGE, global.create_app_launch_context(0, -1));
        } catch (e) {
            Main.notifyError('Claude Usage', e.message);
        }
    }

    _render() {
        const data = this._data;
        const limits = data?.limits ?? {};
        const now = Date.now() / 1000;

        this._renderPanel(limits, now);
        this._renderStatus(limits, now);
        this._planLabel.text = data?.plan ?? '';
        this._planLabel.visible = Boolean(data?.plan);
        this._renderLimits(limits, now);
        this._renderTokens(data?.tokens);
        this._fillDetails(this._todayMenu, data?.tokens, 'today');
        this._fillDetails(this._weekMenu, data?.tokens, 'week');
        this._updatedLabel.text = data
            ? `Обновлено в ${clock(new Date(data.generated_at * 1000))}`
            : 'Загрузка…';
    }

    _renderPanel(limits, now) {
        const shown = ['session', 'weekly_all']
            .map(kind => limits.items?.find(item => item.kind === kind))
            .filter(Boolean);
        const percents = shown.map(item => currentPercent(item, now));
        const level = worstLevel(shown.map((item, i) => usageLevel(percents[i], item.severity)));
        if (shown.length)
            this._panelLabel.text = percents.map(p => `${p}%`).join(' · ');
        else
            this._panelLabel.text = this._data ? '—' : '…';
        this._panelLabel.style_class = `claude-usage-panel-label ${level}`.trim();
        this._panelLabel.opacity = limits.error || this._helperError ? DIM : 255;
    }

    _renderStatus(limits, now) {
        const messages = [];
        if (this._helperError)
            messages.push(`Сборщик данных упал: ${this._helperError}`);
        if (limits.error) {
            messages.push(ERRORS[limits.error] ??
                `Лимиты не обновились: ${limits.error.replace(/^network: /, 'нет связи — ')}`);
        }
        if (limits.fetched_at && now - limits.fetched_at > STALE_LIMITS)
            messages.push(`Лимиты по состоянию на ${formatMoment(limits.fetched_at)}`);
        this._statusLabel.text = messages.join('\n');
        this._statusItem.visible = messages.length > 0;
    }

    _renderLimits(limits, now) {
        const section = this._limitsSection;
        section.removeAll();
        for (const item of limits.items ?? []) {
            const percent = currentPercent(item, now);
            const lines = [resetText(item.resets_at, now)];
            if (item.kind === 'weekly_all' && limits.breakdown?.length) {
                lines.push(limits.breakdown
                    .map(row => `${SURFACES[row.key] ?? row.name} ${row.percent}%`).join(' · '));
            }
            section.addMenuItem(limitItem(limitTitle(item), `${percent}%`, percent / 100,
                usageLevel(percent, item.severity), lines));
        }
        const extra = limits.extra;
        if (extra) {
            section.addMenuItem(limitItem('Доп. кредиты', `${extra.percent}%`, extra.percent / 100,
                usageLevel(extra.percent),
                [`${formatMoney(extra.used, extra.currency)} из ${formatMoney(extra.limit, extra.currency)}`]));
        }
        if (!section.numMenuItems)
            section.addMenuItem(textItem(this._data ? 'Лимиты тарифа недоступны' : 'Загрузка…'));
    }

    _renderTokens(tokens) {
        this._tokensGrid.destroy_all_children();
        const grid = this._tokensGrid.layout_manager;
        const rows = [['', 'всего', 'выход', 'запросы']];
        const periods = [...tokens?.periods ?? []];
        if (tokens?.all_time)
            periods.push({...tokens.all_time, title: 'Всё время'});
        for (const p of periods)
            rows.push([p.title ?? periodTitle(p), formatTokens(p.total), formatTokens(p.output), formatCount(p.requests)]);

        rows.forEach((cells, row) => cells.forEach((text, col) => {
            const classes = ['claude-usage-cell'];
            if (col)
                classes.push('claude-usage-num');
            if (!row)
                classes.push('claude-usage-small');
            grid.attach(makeLabel(text, {
                styleClass: classes.join(' '),
                dim: row === 0,
                expand: col === 0,
                align: col ? Clutter.ActorAlign.END : Clutter.ActorAlign.START,
            }), col, row, 1, 1);
        }));
    }

    _fillDetails(submenuItem, tokens, key) {
        const menu = submenuItem.menu;
        menu.removeAll();
        const period = tokens?.periods?.find(p => p.key === key);
        const details = tokens?.details?.[key];
        if (!period || !details) {
            menu.addMenuItem(textItem('Нет данных'));
            return;
        }
        for (const [name, field] of [
            ['Вход', 'input'], ['Выход', 'output'], ['Запись в кэш', 'cache_write'], ['Чтение из кэша', 'cache_read'],
        ])
            menu.addMenuItem(valueItem(name, formatTokens(period[field])));
        for (const [title, groups] of [['Модели', details.models], ['Проекты', details.projects]]) {
            if (!groups.length)
                continue;
            menu.addMenuItem(headingItem(title));
            for (const group of groups)
                menu.addMenuItem(valueItem(group.name, formatTokens(group.total), `выход ${formatTokens(group.output)}`));
        }
    }

    destroy() {
        this._cancellable.cancel();
        this._cancelHoverOpen();
        this._stopLeaveWatch();
        if (this._timerId) {
            GLib.Source.remove(this._timerId);
            this._timerId = 0;
        }
        super.destroy();
    }
});

export default class ClaudeUsageExtension extends Extension {
    enable() {
        this._indicator = new UsageIndicator(this);
        Main.panel.addToStatusArea(this.uuid, this._indicator);
    }

    disable() {
        this._indicator?.destroy();
        this._indicator = null;
    }
}
