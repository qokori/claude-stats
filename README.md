# claude-stats

Расширение GNOME Shell «Claude Usage»: лимиты тарифа Claude и расход токенов Claude Code в верхней панели.

## Что показывает

В панели: иконка и загрузка лимитов «сессия · неделя» в процентах, например `12% · 40%`.
При 75% цифры становятся оранжевыми, при 90% — красными.

Меню открывается наведением, а по клику закрепляется. В нём:

- **Тариф** (Pro, Max 5×, Max 20×) и **лимиты** с прогресс-барами и временем сброса: сессия за 5 часов, неделя
  по всем моделям, недельные лимиты по отдельным моделям, разбивка недели по Claude Code, чатам и Cowork,
  доп. кредиты (если включены).
- **Токены Claude Code** за текущую сессию, сегодня, неделю, 30 дней и всё время: всего, выход, число запросов.
- **Подробно за сегодня / за неделю**: вход, выход, запись и чтение кэша, топ-5 моделей и проектов.
- Ссылка на страницу лимитов на claude.ai и кнопка обновления.

Если данные не удалось получить (токен истёк, нет сети, API просит подождать), вверху меню появится предупреждение.

## Требования

- GNOME Shell 48, 49 или 50.
- `python3` (только стандартная библиотека).
- [Claude Code](https://docs.claude.com/en/docs/claude-code), вход через подписку claude.ai (`claude`, затем
  `/login`). Без входа лимиты тарифа не показываются, но статистика токенов по локальным логам работает.

## Установка

Имя папки должно совпадать с `uuid` из `metadata.json`, поэтому клонируйте сразу в неё:

```bash
gh repo clone qokori/claude-stats ~/.local/share/gnome-shell/extensions/claude-usage@neorcage
```

или без `gh`:

```bash
git clone https://github.com/qokori/claude-stats.git ~/.local/share/gnome-shell/extensions/claude-usage@neorcage
```

Выйдите из сеанса и войдите снова: GNOME Shell находит новые расширения только при запуске. Затем включите расширение:

```bash
gnome-extensions enable claude-usage@neorcage
```

или в приложении «Расширения».

## Обновление

```bash
git -C ~/.local/share/gnome-shell/extensions/claude-usage@neorcage pull
```

Изменения в `usage_helper.py` подхватываются при следующем обновлении данных, в течение минуты. Изменения в
`extension.js` и `stylesheet.css` вступают в силу после повторного входа в сеанс.

## Удаление

```bash
gnome-extensions disable claude-usage@neorcage
rm -rf ~/.local/share/gnome-shell/extensions/claude-usage@neorcage ~/.cache/claude-usage-indicator
```

## Как это работает

- `extension.js` рисует индикатор и меню. Раз в минуту он запускает `usage_helper.py` отдельным процессом, чтобы
  разбор логов не подвешивал оболочку.
- `usage_helper.py` собирает данные и печатает один JSON:
  - **лимиты** запрашиваются из того же эндпоинта, что использует команда `/usage` в Claude Code
    (`api.anthropic.com/api/oauth/usage`), не чаще раза в 3 минуты. При открытии меню они перезапрашиваются, если
    старше минуты, а кнопка обновления перезапрашивает их сразу. Эндпоинт не документирован и может измениться;
  - **тариф** берётся из `~/.claude.json`, который Claude Code сам держит актуальным;
  - **токены** считаются по логам Claude Code `~/.claude/projects/**/*.jsonl`. Файлы читаются инкрементально,
    повторы одного ответа отбрасываются. Claude Code удаляет логи старше 30 дней, поэтому итоги по прошедшим дням
    сохраняются в кэше, и «Всё время» не обнуляется.
- Кэш лежит в `~/.cache/claude-usage-indicator/cache.json`.
- Переменная `CLAUDE_CONFIG_DIR` учитывается, если Claude Code настроен на другую папку.

### Токен и приватность

Access-токен читается из `~/.claude/.credentials.json` и отправляется только на `api.anthropic.com`. Сам токен
расширение не обновляет, чтобы не конфликтовать с Claude Code. Если он истёк, запустите `claude`, и данные
обновятся. Логи разбираются локально и никуда не отправляются.

## Отладка

Запустить сборщик вручную и посмотреть, что он отдаёт:

```bash
python3 ~/.local/share/gnome-shell/extensions/claude-usage@neorcage/usage_helper.py --pretty
```

Логи расширения:

```bash
journalctl -f -o cat /usr/bin/gnome-shell | grep "Claude Usage"
```
