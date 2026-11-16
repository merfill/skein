# Handoff — текущее состояние

> Рабочий документ передачи. Английского зеркала нет. История изменений по датам удалена:
> она остаётся в git. Здесь — только текущее состояние и последняя выполненная работа.

## 2026-11-16 — единица `inquiry`: гипотезы, спецификация, реализация, Docker K=3

### Что сделано

- **Идея.** Новая единица кодирования работает не состояниями, а гипотезами. Модель
  открывает гипотезу (`suppose` + `if_true`/`if_false`), действует под ней, закрывает
  вердиктом и основаниями (только наблюдения, записанные после открытия). Открытые
  гипотезы образуют один путь; дети условны относительно родителя и не поднимаются
  наверх. Запрос — ссылка; активная гипотеза — цель. Движок не разбирает смысл и не
  судит вердикт; он проверяет структуру и пишет отказы.
- **Спецификация.** `docs/ru/inquiry.md` (RU-only, контракт реализации): идея,
  журнал, инструменты, правила, проекция (CLOSED/OPEN, `[ACTIVE]`), сквозной
  `fix-git`, ручной запуск, ограничения, Ankyra-приложение. B1/B2 адаптированы под
  гипотезы; конструкция дерева в промпт не вынесена.
- **Положительная B1.** Итоговая формулировка:
  «Develop the active hypothesis: run the checks and actions the work needs, and close
  it when the outcome is observed. Open a new hypothesis only when you consider it
  different from the hypotheses already shown in OPEN and CLOSED and justified as new
  work; if an open hypothesis already asks the question, develop that one. A bash
  action runs under the active hypothesis; a file write takes a change hypothesis. A
  text reply ends the work when the result is observed or you cannot continue.»
  Отрицательная версия («не открывай дубль», «не останавливайся») сначала дала
  регрессию: в Docker-прогоне k3b модель нашла висячий коммит и не сделала merge
  (`reward=0`, «I did not run the merge»). Положительная B1 эту регрессию сняла.
- **Терминология.** Модельная сторона — `hypothesis`: инструменты
  `open_hypothesis`/`close_hypothesis`, описания и лейблы; внутри IR остались
  `claim`/`claim_verdict` и операторы `claim_open`/`claim_close`. В Appendix B
  зафиксировано разделение.
- **Мутации убраны из inquiry.** Движок не может достоверно отслеживать изменения
  файлов (r1: `git merge` сделал работу, а `CHANGES 0` и `no_mutation` соврали).
  Удалены `CHANGES`, `no_mutation`, `mutation under probe`, мутации как grounds и
  `(stale)`. `change` закрывается `done` по наблюдению эффекта (`read`, `git status`,
  тест). Инструментная защита `stale_base`/`repeated_action` оставлена.
- **Реализация.**
  - IR: узлы `claim`/`claim_verdict`, рёбра `claim`/`verdict`; помощники дерева и
    пути в `src/ir/graph.ts`.
  - `src/llm/inquiry.ts` — поверхность `inquiry` (extra-tools), описания.
  - `src/llm/{schemas,tools}.ts` — действия `claim_open`/`claim_close` и маппинг
    модельных `open_hypothesis`/`close_hypothesis`.
  - `src/tools/index.ts` — исполнение, правила (гейты, grounds только наблюдения,
    `children_open` с активной и путём, `bad_grounds` с валидными id и `recall`,
    `bad_verdict`, `not_open`, `bad_expectation`).
  - `src/inquiry.ts` — промпт, цикл, проекция, остановка с `unresolved`.
  - `bench/inquiry.ts` — ручной запуск (`npm run inquiry`), `--dry`, `--tree`,
    `--save`.
  - `tests/sandbox/harness.ts` + `tests/sandbox/inquiry-task.ts` — Docker-раннер
    (`npm run inquiry:docker`), K=3 параллельно, network off, maxTurns 60, `--save`.
  - `tests/inquiry_unit.test.ts` — 8 офлайн-тестов.
- **Проверки.** Локальная репродукция `fix-git`: R1 20 ходов/2 open/0.54₽, R2
  40/20/2.41₽, R3 34/1/1.20₽ (задача решена, дерево почти чистое). Docker `fix-git`
  K=3 на трёх базах:

  | база | solved | turns | open | cost |
  |---|---:|---:|---:|---:|
  | k3: мутации + B1 («OPEN», отрицательная) | 3/3 | 140 | 17 | 5.71₽ |
  | k3b: без мутаций + B1 отрицательная | 2/3 | 154 | 18 | 5.16₽ |
  | **k3c: без мутаций + B1 положительная + `open_hypothesis`** | **3/3** | **104** | **2** | **3.61₽** |

  k3c по прогонам: r3 16/1/0.53₽, r1 42/1/1.18₽, r2 46/0/1.90₽. Артефакты:
  `/tmp/skein-inquiry-docker-k3c` (`events.ndjson`, `result.json`, `tree.txt`,
  `task.txt`, `check.out.txt`).
- **Сравнение.** Opencode `fix-git` (K=5): 10/10, 8.3 хода, 78.2k in / 4.1k fresh /
  1.35k out, ~0.20₽. Skein `task`: 9/10, 12.6 хода, 65.0k / 19.9k / 3.3k, 0.60₽.
  Inquiry k3c: 34.7 хода, 194.3k / 34.9k / 7.5k, 1.20₽ — 3/3, но 6.2× opencode и
  2.0× Skein task по цене.

### Проверено

- `npm run typecheck` — чисто.
- `SKEIN_LIVE=false npx vitest run --exclude 'tests/sandbox/**'` — **660 passed /
  40 skipped**; `tests/inquiry_unit.test.ts` — 8/8.
- `npm run inquiry -- "..." --dir /tmp --dry` — B1/B2 собираются; `OPEN: none`.
- Docker k3c — **3/3**, verifier 2/2 passed в каждом прогоне.

### Открыто

- **Повторяющиеся гипотезы.** k3c: 2 открытых на 3 прогона (было 17/18); остаётся
  корневой долг (open 1 в r1/r3), r2 — чисто. Следующий шаг — структурировать
  сообщение об открытии (модель видит имя гипотезы и не повторяет); метки и
  лексическое совпадение владелец не принимает. Запасной путь — продублировать
  правило в описании `open_hypothesis`.
- **Финальный self-report r1** (k3c): verifier прошёл, но финал модели утверждает,
  что master «broken»; дерево содержит закрытую `change`. Отдельная проблема
  самоотчёта, не механизма.
- **Workdir.** В Docker-прогоне модель сначала читала `/workspace`, получила
  `read failed`, сделала `pwd` → `/app/personal-site`. B2 говорит «workspace root —
  текущая директория»; лишний read/ход. Возможно, усилить строку о `pwd`/относительных
  путях.
- **Настоящий бенчмарк.** Inquiry прогонялся K=3 на `fix-git`; полной кампании K=5
  (13 задач) нет. Reward зелёный, но цена 6× opencode; для статьи нужен честный
  A/B и разбор, когда изоляция гипотез окупается.
- **EN-зеркало** `docs/ru/inquiry.md` не сделано (RU-only, как handoff).
- **Рабочее дерево:** посторонние незакоммиченные `tests/sandbox/{campaign,matrix,
  opencode-run,sandbox-run,tasks/registry}.ts`, LHTB-задачи и dotfiles не трогались.
- Старый черновик `docs/ru/claims-spec.md` (cited/H, состояния) остаётся отдельным
  слоем; в inquiry не входит.

### Где смотреть / команды

- Спецификация: `docs/ru/inquiry.md`; handoff — здесь.
- Локальный прогон: `npm run inquiry -- "<текст>" --dir <repo> --max-turns 40
  [--tree] [--save <dir>] [--dry]`.
- Docker `fix-git` K=3: `SKEIN_INQUIRY_SAVE=<dir> npm run inquiry:docker`
  (нужны Docker, образ `alexgshaw/fix-git:20251031`, кэш задачи, ключ провайдера;
  тяжёлый live-прогон — только с разрешения владельца).

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

