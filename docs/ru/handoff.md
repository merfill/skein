# Handoff — текущее состояние

> Рабочий документ передачи. Английского зеркала нет. История изменений по датам удалена:
> она остаётся в git. Здесь — только текущее состояние и последняя выполненная работа.

## 2026-11-15 — препринт на Zenodo (EN), RU-версия синхронизирована

### Что сделано

- **EN-препринт опубликован на Zenodo** 2026-11-15: DOI `10.5281/zenodo.24253692`,
  <https://zenodo.org/records/24253692>. Тип — Preprint, лицензия CC BY 4.0, файл — `skein.pdf`.
  Автор — Vladimir Lapshin (Independent researcher, `mefrill@yandex.ru`).
- **EN-версия** `paper/en/skein.tex` / `.pdf` (16 стр.), **RU** `paper/ru/skein.tex` / `.pdf`
  (17 стр.). Сборка — `paper/build.sh` / `paper/build-en.sh`; обе чистые (0 overfull / missing /
  undefined). RU синхронизирована с EN: `Terminal-Bench`, API-вызовы (2447/1923), 66.2/87.1,
  23/121, «один граф состояний», «как её проверить».
- **Вошло после ревью:** OpenHands/CrewAI; replay 125/125 на реальных журналах (`result.json`,
  поле `events`); `read` 9/170; первый ход состояния 66.2% vs 87.1% (эффект входа ≈0.4 п.п. из
  9.2 п.п. разрыва доли кэша); чувствительность к тарифу (break-even 5.5×, паритет при доле
  кэша 95.2%); Construction = `cobol` + `regex` (72% стоимости состояния); USD по условному
  курсу 80 руб./долл.; CC BY 4.0; email и аффилиация; статус Preprint.
- **Харнесс:** `readReward` теперь принимает не только 0/1, но и дробный reward (LHTB);
  `typecheck` и офлайн-тесты чистые.
- **LHTB-пилот** (2048, great-expectations-audit) остался smoke-test'ом: один `task`/состояние,
  архитектуру не проверяет; в статью не вошёл. Файлы `tests/sandbox/tasks/lhtb-*` и правки
  `campaign/matrix/registry/sandbox-run/opencode-run` оставлены некоммиченными по решению
  владельца.

### Проверено

- EN 16 стр., RU 17 стр.; 0 overfull / missing / undefined.
- `npm run typecheck`; `SKEIN_LIVE=false npx vitest run --exclude 'tests/sandbox/**'` —
  652 passed / 40 skipped.
- Zenodo: title, автор, CC BY 4.0, Preprint, 2026-11-15.

### Открыто

- ORCID у автора нет; affiliation в метаданных Zenodo не заполнена (`None`).
- На Zenodo один файл (EN PDF); RU PDF — в репозитории, не на Zenodo.
- Related identifiers (GitHub, сайт, npm, Docker) в Zenodo не заполнены.
- DOI добавлен в README; в PDF и на сайте — при следующей версии.
- LHTB-пилот не включён; следующая фаза — журнал/Ankyra/checkpoints/observer (раздел 9).

## 2026-11-15 — сайт опубликован на `skein-swe.dev` (Cloudflare DNS + GitHub Pages)

### Что сделано

- **Сайт переписан и закоммичен.** EN/RU-страницы `site/` пересобраны в длинную прозу по
  `docs/ru/site-draft.md` (быстрый старт с RouterAI, введение, обычный агент, отличие, сквозной
  `fix-ocaml-gc`, механика, оценка, установка/Windows/Docker, ссылки); `style.css` — раскладка с
  липким сайдбаром-оглавлением, `app.js` — подсветка активного пункта TOC. README переведён на
  npm/Docker Hub и получил ссылку на сайт. Коммиты: `36c9937` (сайт+draft), `1b558fa` (README),
  `38575f4` (CLI TTY-guard).
- **Домен и DNS.** Домен куплен на reg.ru, NS переведены на Cloudflare
  (`ainsley/sage.ns.cloudflare.com`). В зоне: apex `A`/`AAAA` на GitHub Pages
  (`185.199.108–111.153`, `2606:50c0:8000::/8001::/8002::/8003::153`), `www` CNAME →
  `merfill.github.io`. Записи — DNS only (серая туча), чтобы GitHub выпустил сертификат.
- **Хостинг.** GitHub Pages включён (Source = GitHub Actions), custom domain =
  `skein-swe.dev`. Workflow **Deploy site** (`pages.yml`) прошёл с 4-го запуска; Let's Encrypt
  выпустил сертификат на apex и `www`.
- **Заминка с корнем.** После привязки домена `/index.html` и `/ru/` отдавались, а `/` висел на
  закэшированном в CDN 404 «Site not found» (деплой был до привязки домена). Помог повторный
  запуск workflow уже с доменом: новый деплой переопубликовал сайт и сбросил кэш.
- **Вёрстка и текст утверждены владельцем** (2026-11-15): стиль принят, EN/RU вычитаны.
- **Сайт добавлен в профиль репозитория** (About → Website) владельцем 2026-11-15.

### Проверено

- `https://skein-swe.dev/` → 200, «Skein — a terminal coding agent»; `/ru/` → 200,
  «Skein — терминальный агент разработки»; `style.css`/`app.js` → 200.
- `www.skein-swe.dev` → 301 на apex; сертификат Let's Encrypt валиден для apex и `www`.

### Открыто

- Локальный DNS-кэш у части резолверов ещё отдаёт старую парковку reg.ru; после сброса кэша
  предупреждения HSTS уходят.
- Пункты «домен не куплен / Pages не включён» этой записью закрыты.
- TXT `_github-pages-challenge-merfill` не понадобился — домен не был занят другим сайтом.

