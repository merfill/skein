# Handoff — текущее состояние

> Рабочий документ передачи. Английского зеркала нет. История изменений по датам удалена:
> она остаётся в git. Здесь — только текущее состояние и последняя выполненная работа.

## 2026-11-14 — черновик содержания сайта (`docs/ru/site-draft.md`)

### Что сделано

- **Зафиксирован черновик текста сайта** в `docs/ru/site-draft.md` (RU). Это не конспект, а
  черновик: акты 0–2 (обычный агент → отличие Skein → `fix-ocaml-gc`) — прозой; разделы 3–5
  (механика, оценка, установка) — пока конспект. Стиль и вёрстка **не утверждены**.
- **Решения по содержанию:**
  - читатель — разработчик, широкой аудитории не ждём;
  - сайт — первый источник наравне с `README.md`;
  - фокус — **внимание и управляемость, не цена**; кэш промпта нивелирует стоимость длинной
    ленты, сравнивать по деньгам мимо;
  - opencode — короткий baseline, без разбора внутренностей;
  - reasoning не показываем, лента только схематично (без полных дампов);
  - сквозной пример — `fix-ocaml-gc` (реальный прогон кампании: `skein-netoff-r5`, reward 1,
    28 ходов; на пике Patch ~116k символов, на переходе ~4.5k);
  - термины: «агент разработки», в технических местах «SWE-агент»; в английском — `coding
    agent`.
- **Структура:** Act 0 (классический цикл, лента, кэш, внимание/управляемость) → почему
  opencode → чем Skein отличается → `fix-ocaml-gc` по актам (Request/Patch/Transition/
  Verification/End, схемы ленты и таблицы действий) → механика/справочник → оценка и
  ограничения → установка.
- **В `roadmap.md` B0** добавлена ссылка на черновик.

### Открыто

- Стиль и вёрстка не утверждены; разделы 3–5 дописать до прозы.
- EN-зеркало ещё не сделано.
- Старая RU-страница `site/ru/index.html` всё ещё говорит «кодирующий агент» — поправить при
  переписывании.
- README сверить с новым акцентом (внимание/управляемость, а не цена).
- Деплой сайта и домен — по-прежнему за владельцем (см. раздел ниже).

## 2026-11-14 — домен `skein-swe.dev` и GitHub Pages (подготовлено, не задеплоено)

### Что сделано

- **Домен проверен:** `skein-swe.dev` свободен — DNS `NXDOMAIN`, RDAP реестра Google `404 not
  found`. `.dev` — HSTS-preloaded, сайт обязан работать по HTTPS (GitHub Pages даёт Let's
  Encrypt).
- **Добавлены деплой-артефакты:**
  - `site/CNAME` → `skein-swe.dev` (попадает в корень артефакта Pages);
  - `.github/workflows/pages.yml` — деплой `site/` на GitHub Pages (`configure-pages` →
    `upload-pages-artifact` → `deploy-pages`), триггеры: push в `main` при изменениях
    `site/**`/workflow и `workflow_dispatch`;
  - canonical, `hreflang` (en/ru/x-default), Open Graph и Twitter card с `https://skein-swe.dev/`
    на обеих страницах.
- **Проверено:** YAML валиден; локальный сервер отдаёт `/`, `/ru/`, `/style.css`, `/app.js`,
  `/CNAME` (200); canonical/OG/hreflang корректны для EN и RU.

### Что осталось владельцу (внешние действия)

1. Купить `skein-swe.dev` у регистратора (проверить, не премиум).
2. DNS: apex A `185.199.108.153/109.153/110.153/111.153`, AAAA
   `2606:50c0:8000::153/8001::153/8002::153/8003::153`, `www` CNAME → `merfill.github.io`,
   TXT `_github-pages-challenge-merfill` (токен из настроек Pages).
3. GitHub → Settings → Pages: Source = GitHub Actions, Custom domain = `skein-swe.dev`,
   Enforce HTTPS.
4. Push в `main` (или запустить workflow) — после этого сайт появится на домене.

### Открыто

- Деплой и push не делались; домен не куплен.
- После публикации добавить `https://skein-swe.dev` в README и в профиль репозитория.
- `site/CNAME`, `.github/workflows/pages.yml`, правки HTML не закоммичены.

## 2026-11-14 — README для внешнего читателя и OpenReview

### Что сделано

- **README переписан (EN)** под новичка и ревьюера артефакта: статус (`v0.1, source release`;
  npm/Docker ещё не опубликованы), оглавление, раздел «Why», ASCII-схема
  `utterance → session agent → unit → journal → project() → model`, определения
  (journal/projection/state/unit/session).
- **Исправлен устаревший список операций:** шесть (`respond`, `general`, `revision`, `task`,
  `plan`, `write_document`) вместо прежних `general`/`task`; добавлена таблица «запрос →
  операция».
- **Quickstart теперь рабочий:** checkout → `npm run build` → `npm pack` → глобальная установка
  тарбола → `auth login`/`doctor`/TUI. `npx skein-swe` помечен как «после первого npm-релиза».
  Добавлены env-настройка, Windows (bash обязателен) и Docker.
- **Research artifact без цифр** (по решению): ссылка на `bench/results/campaign-k5/`; raw-клетки
  не в git (`.gitignore: bench/runs/`), уходят в архив релиза. Ограничения (нет машинной проверки
  `Done when`, один провайдер/модель, повторное чтение workspace, `/bin/bash`) и design
  invariants — отдельными разделами. Добавлен BibTeX для Citation (OpenReview/DOI — после
  релиза).

### Проверено

- Все локальные пути из README существуют (`docs/**`, `bench/results/campaign-k5/`,
  `site/`); `bench/runs/matrix/campaign-k5/` существует локально, но gitignored — формулировка
  исправлена на «архивируется с релизом».
- Якоря оглавления соответствуют заголовкам.

### Открыто

- OpenReview/Zenodo/DOI — после релиза (сейчас плейсхолдеры).
- README не закоммичен.

## 2026-11-14 — минимальный сайт `site/` (локально, без деплоя)

### Что сделано

- **Статический сайт без сборщика:** `site/index.html` (EN), `site/ru/index.html` (RU),
  `site/style.css` (системные шрифты, светлая/тёмная тема, адаптив), `site/app.js` (кнопка
  «копировать» у code-блоков, без зависимостей и трекеров).
- **Содержание:** описание идеи, Install (Linux/macOS; Windows с обязательным `bash` —
  WSL2/Git Bash/MSYS2/Docker; Docker из исходников), Configure (`auth login`/env → `doctor` →
  TUI), ссылки. Ссылки на npm/Docker/DOI помечены «после релиза», чтобы не было битых URL.
- **README:** добавлен раздел Windows (тот же тезис: нужен `/bin/bash`; WSL2 рекомендуется).
- **Порядок в `roadmap.md`:** B0 сайт → B3 Docker → приёмка → B5 публикация → статьи; сайт
  добавлен в Must (§1) и в таблицу §7.

### Проверено

- Локальный `python3 -m http.server` в `site/`: `/`, `/ru/`, `/style.css`, `/app.js` — 200;
  относительные ссылки EN/RU корректны.
- Внешние ресурсы (шрифты/CDN) не используются.

### Открыто

- **Деплой не делался** (по решению владельца: сначала файлы локально). Для GitHub Pages нужен
  push в `main` + включённые Pages и workflow (или ветка `gh-pages`).
- Ссылки на npm/Docker/DOI — плейсхолдеры «после релиза».
- `site/`, правки `README.md`/`roadmap.md`/`handoff.md` не закоммичены.
- Windows/Git Bash: код жёстко зовёт `/bin/bash` (`src/tools/workspace.ts:367`); Git Bash
  заработает, только если `/bin/bash` резолвится из запускающей оболочки. WSL2/Docker —
  надёжные пути. Если нужен нативный Git Bash без WSL — отдельно решить про резолв shell.

## 2026-11-14 — v0.1 first-run приёмка (офлайн + Docker) — **сделано**

### Что сделано

- **Офлайн-приёмка пакета.** `npm run build` → `npm pack` (4 файла, 120.3 kB) → установка тарбола
  в `/tmp` с изолированными `HOME`/`XDG_CONFIG_HOME`/`XDG_DATA_HOME`. Проверено: `--version`
  (`skein 0.1.0`), `--help`, `auth list` (ключей нет → подсказка), `doctor` без ключа
  (`not ready: API key is not set`, exit 1), `skein </dev/null` (не-TTY → понятная ошибка,
  exit 1).
- **Найден и исправлен баг first-run.** `skein auth login` без TTY печатал меню и **молча
  выходил с exit 0**, ничего не сохранив: readline на EOF не резолвит `question`, event loop
  опустошается. В `runAuthCommand` добавлен guard (stdin/stdout не TTY → сообщение «нужен
  интерактивный терминал; задай ключ через env» + exit 1) — как уже было в `ensureProvider`.
  `runAuthLogin` и тесты не менялись.
- **Live в Docker** (образ `skein:0.1.0` из HEAD; провайдер/модель из `.env`):
  - `doctor` — 608 моделей, `chat: ok in 1087ms`;
  - `--plain` маленькая задача — маршрут `revision v1`, `write` + `wc -c`/`od -c`, `hello.txt`
    = `hi` (2 байта), 3 хода;
  - TUI стартует: status bar (workspace, `deepseek-v4-flash`, ctx, `.skein/session.log`, mouse),
    живёт до таймаута.
- **Gotcha Docker:** `--env-file` не снимает кавычки — `SKEIN_MODEL='...'` уходил в API как
  `''...''` (400 «Model not found»). Для приёмки использован `source .env` + `-e VAR`. Заметка
  добавлена в чеклист.
- **Доки:** §1.1 «First-run acceptance» в `docs/en/testing.md` и `docs/ru/testing.md` — офлайн-
  команды, live-чеклист, предупреждение про кавычки `--env-file`.

### Проверено

- `npm run typecheck` — чистый.
- `SKEIN_LIVE=false npx vitest run --exclude 'tests/sandbox/**'` — **652 passed / 40 skipped**.
- `tests/providers_auth.test.ts` + `tests/providers_config.test.ts` — 17 passed (guard не задел
  визард).
- `docker build -t skein:0.1.0 .` — успешно.

### Открыто

- `npx skein-swe` проверяется только после `npm publish`; публикация не делалась.
- Тег `v0.1.0` + Zenodo DOI — за владельцем (нужен аккаунт/токен).
- Интерактивный `auth login` с живым ключом не гонялся (покрыт scripted-io тестами); в Docker
  основной путь — env.
- Рабочее дерево: `src/providers/cli.ts`, `docs/{en,ru}/testing.md`, этот handoff — не
  закоммичены.

## 2026-11-13 — сессионный сценарий: обзор → identify → report → fix → test → doc (K=1)

### Что сделано

- **`tests/sandbox/session-scenario.ts`** — сессионный прогон на репозитории
  `fix-code-vulnerability` (bottle): один репозиторий, шесть пользовательских реплик в одной
  сессии. Skein идёт реальным `runSessionTurn` (без форса операции), opencode — `opencode run`
  + `--continue` в том же контейнере. Verifier — родной `test.sh`. Артефакты на прогон:
  `turns.json`, `turn-N.json` (operation/reasoning/answer/usage), `units.json`, `session.json`,
  `document.md`, `diff.txt`, `run.json`; сводки `summary.md/json`.
- **Шесть реплик, каждая — одна цель:** обзор → identify (CWE) → создать `report.jsonl` →
  fix → `pytest` → документ по изменению.
- **`opencode.ts`:** `messages?: string[]` (несколько реплик через `--continue`), `bin?`,
  `afterAgent?` для захвата файлов до verifier; одиночный task-путь не изменился.
- **Описания сессии:** `write_document` — «long-form prose document (Markdown, multiple
  sections), not data/config/report files»; `revision` — «create or edit files such as
  configs, JSON/YAML, reports and lockfiles» в дополнение к командам. Живая матрица 5×:
  report → `revision` 5/5, document → `document` 5/5, tests/commit → `revision`, overview/
  explain → `general`, fix → `task` 5/5, plan → `plan` 4/5.
- **«Сырой» бенч-`instruction.md` как реплика не работает:** это план из 6 шагов (1–3 анализ),
  роутер честно берёт `general` 5/5 — даже первой репликой и при трёх вариантах базового
  промпта про «цель». Разбиение на однозначные реплики решает это.

### Проверено (K=1, оба агента, сеть off)

- `bench/runs/session-scenario/pilot6b-k1/`: **Skein reward=1**, маршруты
  `general/general/revision/task/revision/document`; **opencode reward=1**.

| | Skein | opencode |
|---|---:|---:|
| шаги/ходы | 63 | 24 |
| input всего | 342.8k | 672.1k |
| fresh input | 113.7k | 35.8k |
| cache | 229.1k (67%) | 636.3k (95%) |
| output | 22.6k | 8.4k |
| cost | 3.71₽ | ~1.46₽ (оценка) |

Skein byAgent: session 6/11.3k, general 16/99.9k, revision 6/20.1k, task 20/92.5k,
document 21/119.1k (output 11.8k). opencode: 24 steps, tools 27 (bash 23, glob 1, write 2,
edit 1).

### Почему Skein дороже и в 2.6× больше шагов

- **Каждый юнит заново читает workspace.** Outline несёт только короткий (240 симв.) итог
  прошлой единицы, не прочитанное содержимое: overview (9 ходов) → identify снова читает (7)
  → fix снова читает (20) → document снова собирает факты (21). У opencode один растущий
  транскрипт, факты переиспользуются, повторного чтения нет.
- **Отсюда кэш:** у opencode префикс растёт и кэшируется (95%), у Skein контексты единиц
  разные (67%) → больше fresh input.
- **Документ:** 33 KB / 265 строк и 11.8k output против 4 KB у opencode; секционная запись —
  21 ход. Это выбор полноты, но он дорогой.
- **Вывод:** изоляция контекста меняет «размывание» на «повторную работу». На короткой
  сессии это проигрыш по деньгам; выигрыш мог бы быть в качестве/дрейфе на длинной.

### Открыто

- **Тест как сравнение неудачен:** одна задача вручную разложена на 6 единиц, и повторное
  чтение — артефакт разбиения, а не свойство контекстной модели. Честный замер — одна цель на
  реплику (или длинная сессия с разными задачами), а не разрезанный план.
- K=3 не запускался (по решению владельца: хватит замеров).
- `report.jsonl` — бухгалтерия бенчмарка, не цель пользователя; в сценарии это отдельная
  реплика, которая идёт в `revision`.
- Рабочее дерево не закоммичено: новые `tests/sandbox/session-scenario.ts`, правки
  `tests/sandbox/opencode.ts`, `src/session/session_agent_prompts.ts`.

## 2026-11-13 — B4: кампания K=5 (`campaign.ts`)

### Что сделано

- **`tests/sandbox/campaign.ts`** — обёртка над `matrix.ts` на все 13 задач. Одна задача за раз,
  поэтому `--concurrency` — это **общий** лимит одновременно запущенных клеток (5 = 5
  контейнеров, не 5 на задачу). `net on|off` — обычные значения сетки; каждая клетка в своём
  процессе, `off`-proxy изолирован. Wall-clock таймаут не передаётся.
- **Флаги:** `--tasks`, `--agents`, `--nets`, `--repeat` (5), `--concurrency` (5),
  `--task-concurrency task=n` (per-task override: `fix-ocaml-gc=3`, т.к. verifier пересобирает
  OCaml и CPU-heavy), `--out`, `--resume`, `--only-failed`, `--dry`. `--max-steps` =
  `task.maxTurns` (60 для `fix-ocaml-gc`) для паритета с Skein. Preflight: `SKEIN_LIVE=true`,
  Docker, opencode-бинарь, кэш задач.
- **Сводки:** `manifest.json` (commit, node, модели, K, сети, concurrency, timeout=none),
  `summary.json`, `summary.md`, `summary.csv`; при обрыве читается `manifest.json` задачи.
- `opencode.ts` экспортирует `DEFAULT_MODEL`, чтобы протокол писал реальную модель.
- **Docs:** `docs/en/testing.md` §4.1, `roadmap.md` B4.

### Проверено

- `npm run typecheck` — чистый.
- `--dry` (бесплатно): **13 задач, 260 клеток, 250 runnable** (у `crack-7z-hash` `net=off`
  `unsupported`); у `fix-ocaml-gc` `--max-steps 60`, у остальных 80.
- Пилот `regex-log` (K=1, on): Skein 1/1 (8 ходов, 1.54₽), opencode 1/1 (17 ходов).
- **Кампания завершена** (`finishedAt` 2026-11-13T13:24:11Z; out `bench/runs/matrix/campaign-k5/`):
  протокол `--repeat 5 --concurrency 10 --task-concurrency fix-ocaml-gc=3`, оба net, без
  timeout. **250 runnable клеток, 246 solved (98.4%)**; 10 `unsupported` (`crack-7z-hash`
  off). По группам: Skein/on **63/65**, Skein/off **60/60**, opencode/on **65/65**,
  opencode/off **58/60**. Skein cost **182.72₽** (opencode стоимость не отдаёт; счёт
  провайдера выше). Сводки: `summary.md` / `summary.json` / `summary.csv`.

### Токены и стоимость (для статьи)

Полный разбор: `bench/results/campaign-k5/token-comparison.md` (+ `.csv`); сырые клетки —
`bench/runs/matrix/campaign-k5/`. Solved-only (по 123 прогона, все solved):

| | Skein | opencode | opencode/Skein |
|---|---:|---:|---:|
| input | 31.38M | 47.63M | 1.52× |
| cache read | 26.88M | 45.22M | 1.68× |
| fresh input | 4.50M | 2.41M | 0.53× |
| output | 1.24M | 936.7k | 0.75× |
| reasoning | 812.7k | 624.5k | 0.77× |
| total (in+out) | 32.62M | 48.56M | 1.49× |
| cache hit | 85.7% | 94.9% | — |
| turns | 2447 | 1800 | 0.74× |
| cost | 178.22₽ | ~125.65₽ (оценка) | 0.71× |

Цены, точно подогнанные по фактическому счёту Skein (R²=1.0): fresh input **17.80₽/1M**,
cache read **0.356₽/1M**, output **71.20₽/1M**. opencode cost не отдаёт — оценка по тем же
ценам (тот же endpoint). Вывод: opencode тратит в 1.49× больше токенов, но почти всё кэш
(94.9%), поэтому по деньгам дешевле; Skein компактнее, но больше fresh input/output.
All-runs (с провалами): Skein 33.49M/182.72₽, opencode 55.19M/~138.44₽.

По состояниям (все 125 Skein-прогонов, `state-cost.md`): Construction **35.5%** денег
(64.86₽), Patch **26.1%** (47.67₽), Research **23.8%** (43.49₽), Verification **8.6%**
(15.71₽), End 6.0%. Patch+Verification = 34.7% денег, но **36.8% ходов** (925). То есть по
ходам Patch+Verification действительно больше всех, а по деньгам Construction ≈
Patch+Verification; Verification дешёвая. Дорогие задачи: `cobol` (Construction 32.7₽),
`custom-memory` (Patch 21.3 + Verif 6.5), `fix-ocaml` (Patch 18.5 + Verif 5.8),
`password` (Research 19.1), `regex` (Construction 14.0). Против opencode по деньгам хуже
всего: `custom-memory` +14.9₽, `password` +9.2₽, `fix-code` +6.5₽, `git-leak` +6.5₽;
дешевле только `fix-ocaml` (0.83×). Причина — больше fresh input и output/reasoning;
opencode берёт кэшем.

### Наблюдения (кампания)

- **`fix-git`, Skein `net=on`, повтор r4 — `reward=0` (19/20 solved).** Не сбой харнесса:
  агент нашёл висячий коммит `650dba4` («Move to Stanford»), но **не влил** его в `master` —
  остановился на диагнозе (`stopReason=request_addressed`, 6 ходов). Verifier упал на
  `test_about_file` и `test_layout_file` (файлы не в нужном состоянии). В остальных 4 повторах
  on и всех 5 off агент делал мерж.
- Причина — premature stop: состояние Research закрылось текстом, хотя условие перехода в End
  («required result exists and matches the request») не выполнено. Воспроизводимость под
  вопросом (вариантивность провайдера); сейчас **ничего не меняем**.
- Кандидат на потом (не применён): проверка в `transitionInstruction` — перед End сверять
  исходный запрос («если просят изменение, изменение должно быть сделано; диагноз — не
  результат») + A/B на `fix-git` K=10. Оценивать отдельно, не в середине кампании.
- **`fix-ocaml-gc`, Skein on r5 — `reward=0` (19/20):** `stopReason=max_turns` (65 ходов);
  verifier нашёл `/app/ocaml/tests.txt` без «40 tests passed» (только make enter/leave).
  Бюджетный промах, не сбой харнесса.
- **`db-wal-recovery`, opencode off r2/r4 — `reward=0` (18/20):** 40/57 шагов,
  56/92 bash-вызова, огромный input (2.3M/4.2M, в основном cache). Причину ещё не разбирали.

### Открыто

- Кампания завершена; разобрать `db-wal-recovery`/opencode off r2/r4 (причину провала) и,
  при желании, `fix-ocaml-gc` r5 (бюджет ходов).
- Старые opencode-результаты — K=1 (Harbor), в кампанию не входят: выбран свежий K=5.
- Отдельный вопрос честности: verifier крутится в контейнере агента (скрипты `/tests`
  перекладываются после агента, но системные бинарники агент мог изменить). Не усиливали.
- Дальше по плану (`roadmap.md`): first-run `doctor`/TUI на чистой машине, Docker
  live-приёмка, тег `v0.1.0` + Zenodo, отчёт/статья. Провалы кампании — материал для статьи,
  не блокеры.
- Рабочее дерево не закоммичено.

## 2026-11-13 — дистрибутив v0.1: npm-пакет и Docker

### Что сделано

- **Пакет.** `package.json`: `name: skein-swe` (npm-имя `skein` занято), `version: 0.1.0`,
  `private` снят, `bin: { skein: dist/cli.js }`, `files: [dist, README, LICENSE]`,
  `license: MIT` (LICENSE уже был), repository/keywords/description. Сборка — `esbuild`
  (`npm run build`), зависимости внешние (`--packages=external`), shebang в баннере.
- **Найден и исправлен баг установленного бинаря.** `src/cli.ts` сравнивал
  `import.meta.url` с `pathToFileURL(process.argv[1])`; при запуске через симлинк
  `node_modules/.bin/skein` пути различались, и CLI молча ничего не делал. Теперь
  `process.argv[1]` резолвится через `realpathSync`.
- **`readVersion` работает в обоих layout.** Пробует `../../package.json` (src) и
  `../package.json` (dist), поэтому `skein --version` корректен и в dev, и в пакете.
- **Docker.** `Dockerfile` (multi-stage: `node:22-slim`, `npm ci` → build → prune; runtime —
  non-root `node`, `git`/`bash`/`curl`/`procps`, `/workspace`), `.dockerignore`.
  Ориентир — провайдеры (BYOK); compose с Ollama и автозагрузкой модели убраны по решению
  (локальные рантаймы остаются через `--base-url`, но без встроенной/скачиваемой модели).
- **README.** Установка через `npx skein-swe` / `npm i -g skein-swe`, бинарь `skein`,
  Docker (с провайдером через env), source-checkout; команды обновлены.

### Проверено

- `npm run typecheck` — чистый.
- `SKEIN_LIVE=false npx vitest run --exclude 'tests/sandbox/**'` — **652 passed / 40 skipped**.
- `npm run build` → `dist/cli.js` (526 KB); `node dist/cli.js --version/--help`.
- `npm pack` — 4 файла (LICENSE, README, dist/cli.js, package.json); установка тарбола в
  `/tmp/skein-install` → `node_modules/.bin/skein --version/--help/auth list` работает.
- `docker build -t skein:0.1.0 .` — успешно; `docker run --rm skein:0.1.0
  --version/--help/auth list` — работает (config в `/home/node`).

### Открыто

- Полный прогон в Docker на маленькой задаче с реальным провайдером не делался.
- `skein doctor`/TUI на чистой машине с реальным ключом не проверялись.
- npm publish не делался; тег `v0.1.0` и Zenodo-архив — позже.
- Лицензия: сейчас MIT; Apache-2.0 — только по решению.
- Рабочее дерево не закоммичено.

## 2026-11-13 — A1: retry `abandoned`-пункта плана

### Что сделано

- **Пункт плана повторяется, а не убивает план.** `executePlan` при `abandoned`-последней
  попытке открывает новый unit с тем же `planItem`; лимит — `1 + planItemRetries`
  (`SKEIN_PLAN_ITEM_RETRIES`, дефолт 1; `0` — старое поведение). Исчерпали — `plan_finished
  aborted`, как раньше.
- **Статус пункта — по последней попытке.** `unitOfPlanItem` теперь возвращает последний unit
  пункта (через `unitsInOrder`), а не первый. Добавлен `planItemAttempts`.
- **Retry виден агенту сессии.** `renderPlanState(session, plan, retry?)` печатает пункт как
  `retrying` и строку «Retrying item N (attempt k of M): the previous attempt was abandoned;
  open it again».
- **Настройка прокинута:** `Settings.planItemRetries` → `SessionTurnDeps.planItemRetries` (CLI,
  live-harness `session-plan`), `.env.example`.
- **Тесты:** retry → completed; retry-бюджет исчерпан → aborted; старый тест закреплён
  `planItemRetries: 0`; проверка retry-строки в план-блоке.
- **Доки:** `sessions.md` §8 EN/RU, `roadmap.md` (A1 сделано).
- **Live-harness:** `session-plan` теперь подключает `revision`/`document` депсы (как CLI) —
  раньше `revision`-операции молча отбрасывались, и план крутился на одном пункте. Добавлен
  `--fail-first-item`: первая попытка первого пункта принудительно уходит в `no_decision`
  (инъекция в реальную операцию `task`/`general`/`revision`, без форсирования маршрута).

### Проверено

- `npm run typecheck` — чистый.
- `SKEIN_LIVE=false npx vitest run --exclude 'tests/sandbox/**'` — **652 passed / 40 skipped**
  (+2 теста).
- **Live virtual `fix-ocaml-gc` с `--fail-first-item`, до фикса harness:**
  план done 3/3, **reward=0**: `revision`-пункты 2/3 отбрасывались (не было депсов), план
  крутился на них; retry пункта 1 выбрал `general` и «ответил» вместо фикса. Cost 6.64.
- **Live virtual `fix-ocaml-gc` с `--fail-first-item`, после фикса:** план done 3/3, **reward=1**.
  Пункт 1: `task r1 no_decision` (инъекция) → `task r2 request_addressed` (retry); пункты 2/3 —
  `revision v1/v2`. 55 calls, in 241396 / out 17480 / rsn 8841, cost 4.50; byAgent: session 4,
  plan 4, task 18, revision 29.

### Открыто

- `skip` пункта и явное «вернуть решение агенту сессии» — не делались (A1 — только retry).
- `plan_finished` не несёт причину (`retries_exhausted` и т.п.) — отдельное изменение схемы.
- **Найдено live:** retry может выбрать `general` и закрыть пункт ответом, не выполнив work order;
  план при этом `done`, хотя задача не решена. Это тот самый «done-условие не проверяется»
  (см. 2026-11-12) — кандидат в A-фазу/отчёт.
- `executePlan` не отличает «dispatch ничего не открыл» (нет депса/отказ) от «пункт ещё pending»:
  при отсутствии депса возможен цикл. Починено в harness через депсы; общий guard не добавлен.
- Рабочее дерево не закоммичено.

## 2026-11-13 — метеринг всей сессии в harness; токены пунктов в PlanPanel

### Что сделано

- **`tests/sandbox/session-plan.ts` метрит всю сессию.** `memoryTelemetry()` проброшен в
  `sessionAgent`/`task`/`general`/`planner` (+ верхний `telemetry`), поэтому `model_call` пишут
  все циклы. `run.json.usage` — `usageTotals` по всем агентам плюс разбивка `byAgent`
  (`session/plan/task/general/revision/document`); `TurnMeter` и комментарий «task only» убраны;
  в финальный лог добавлены `in/out/rsn/cost`.
- **`usageOf` несёт cost.** Если провайдер отдаёт `usage.raw.cost`, он попадает в `Usage.cost`
  (поле и `usageTotals.cost` уже были, но нигде не заполнялись).
- **PlanPanel: ходы и токены пункта.** `PlanItemView` получил `turns/tokensIn/tokensOut`;
  `buildPlanView` агрегирует их по юнитам пункта через `unitStats`; `planItemRow` печатает
  `· Nt in/out` после заголовка (у ещё не открытых пунктов — пусто).

### Проверено

- `npm run typecheck` — чистый.
- `SKEIN_LIVE=false npx vitest run --exclude 'tests/sandbox/**'` — **650 passed / 40 skipped**.
- `tests/tui_view_model.test.ts`: пункт плана показывает `turns/tokensIn/tokensOut` своего юнита.
- **Live virtual `fix-ocaml-gc`** (20 turns): план done 3/3, reward=1. `usage`: 74 calls,
  in 307701 / out 19303 / rsn 5664 / cache 188416 / cost 7.13; `byAgent` — session 34,
  plan 5, task 18, general 17 (cost заполняется провайдером). Раньше task-only показал бы
  18 calls / 73931 in.

### Открыто

- Реальный Docker-прогон harness'а не делался (только virtual).
- Working tree не закоммичен.

## 2026-11-13 — session-агент: промпты в одном файле, память убрана

### Что сделано

- **Промпты session-агента сведены в один файл.** `SESSION_AGENT_BASE_PROMPT`, описания шести
  операций, `request`-описания, repair/invalid — в `src/session/session_agent_prompts.ts`;
  `src/llm/session_agent.ts` и `src/session/session_agent.ts` импортируют оттуда. Тексты перенесены
  байт-в-байт (сверено с HEAD).
- **У session-агента больше нет памяти.** Удалены тулы `unit`/`state`/`turns`/`body`/`search`,
  `SessionTools`/`createSessionTools`/`defaultSessionTools`, `executeTool`, `toolCalls` в
  `SessionReply`, `tools` в deps, `surveyLimit`/`surveys` и `SESSION_FORCED_DECISION_MESSAGE`.
  Агент сессии — только `respond` + операции `general/revision/write_document/task/plan`, один
  вызов модели на реплику (цикл и `maxTurns` у сессии убраны).
- **Удалён `src/session/session_memory.ts`** и его тест (после удаления тулов не использовался).
  `session_outline.ts` (L0) остаётся — он нужен `sessionOutline` и TUI.
- **Тесты**: memory-тесты удалены/переписаны; `session_scenario` проверяет ответ из L0-трейса;
  `session_pause` — паузу до применения операции; из моков убраны `tools`/`toolCalls`.
- **Доки EN/RU**: `sessions.md` §2/§3/§4, `concepts.md`, `projection.md`, `ir.md`, `README.md` —
  след сессии описан как сводка L0 без инструментов истории.
- **Формулировки операций разнесены по типу работы:** `task` — только код (фича/дефект/рефакторинг/
  поиск причины); `revision` — выполнить команду или операцию (тесты, сборка, пример/демо, git,
  зависимости/lock) и не-кодовые правки; `general` — вопрос/объяснение по рабочей области без
  изменений. Слово «mutable» из описаний убрано; `request` у `revision` — «команда/операция и
  done condition».

### Проверено

- `npm run typecheck` — чистый.
- `SKEIN_LIVE=false npx vitest run --exclude 'tests/sandbox/**'` — **650 passed / 40 skipped**.
- **Live route matrix** (10 реплик × 5): «запусти пример с z3 и покажи вывод» → `revision` 5/5,
  «прогони тесты» → `revision` 5/5, `task`/`document` — 5/5, «объясни engine/clause.py» → `general`
  5/5. «что изменено в рабочей копии?» — `revision` 2 / `general` 3: обе приемлемы (read-only-запрос).

### Открыто

- Многоходовый REPL-пробник маршрутизации не запускался (только одиночные реплики).
- Working tree не закоммичен; `src/session/session_agent_prompts.ts` — новый файл.
- Sandbox/live-сценарии (`tests/sandbox/**`) не запускались.

## 2026-11-12 — revision: описанные мутации, task — только кодирование

### Что сделано

- **Роутинг сессии выровнен с назначением `revision`.** Причина — лог в `~/dev/ankyra`: сессия
  выбрала `task`, потому что его описание обещало «run side-effecting commands»; внутри `task`
  запрос ушёл в `Research` («all other cases»), сделал dry-run коммита на копии и пошёл искать
  дефект. `revision` сессия рассмотрела и отвергла: «covers edits to existing files; commit and
  push are commands».
- **Описания тулов.** `revision` — «Use it for any mutable operation the request describes on the
  existing workspace, except coding…»; `task` — «Write new code, fix a defect, or find a cause».
  Из `task` убран «run side-effecting commands»; cross-reference на `revision`/`write_document`
  из него убран.
- **`REVISION_BASE_PROMPT`.** «You make the change or run the operation…», команды включая
  side-effecting.
- **Доки EN/RU.** `sessions.md` §1/§3/§10 и `concepts.md` (таблица и абзац) — `revision` описан
  как мутабельная операция, кроме кодирования.
- **Не трогали:** `decline` и request-промпт task'а. `decline` — до-сессионный артефакт; роутинг
  остаётся работой агента сессии.

### Проверено

- `npm run typecheck` — чистый.
- `SKEIN_LIVE=false npx vitest run --exclude 'tests/sandbox/**'` — **657 passed / 40 skipped**.
- Живой probe (5 прогонов, только выбор операции): коммит/пуш → `revision` 5/5; зависимость/lock →
  `revision` 5/5; баг/новый файл → `task` 5/5; документ → `document` 5/5; read-only вопрос →
  `general` 5/5; «прогони тесты» → `revision` 4/5, `task` 1/5.
- **E2E `revision`** на временном репо с bare-remote: 5 ходов, `git add/commit/push`; коммит
  `f498a53` в `origin/main`, дерево чистое, код не менялся.

### Открыто

- «прогони тесты» иногда (1/5) уходит в `task`; наблюдать.
- Пробники `.route-matrix.ts`, `.revision-e2e.ts` — untracked, в коммит не входят.

## 2026-11-12 — session prompts: write_document, verbatim, gather 10+3

### Что сделано

- **Краткость и язык отчётов.** End/B2/general/revision: положительная формулировка «коротко и по
  возможности, детали — только если просили»; язык — «Answer in the same language the user asked
  in». Document: H1 из `title`, скоуп «только по теме/запросу».
- **TUI: document-юнит в панели.** `view_model` не знал `document` (фильтр, requestAnchored,
  агент) — добавлен; регрессионный тест.
- **Document: `start_document`, две фазы, гейт.** `submit_plan` → `start_document`; gather —
  read-only + `webfetch`; write — без инструментов, ответ с tool-разметкой/пустой отбрасывается
  (ретрай, затем `invalid_section`); сбор ограничен 10 шагами, затем предупреждение + 3, затем
  принудительный `start_document` (`toolChoice: "required"`); в описании `start_document` —
  «plan the structure around the request: include only information directly related to it».
- **Session agent: убран workspace system message** (и мёртвые поля/`workspaceIntro`). Модель
  больше не получает «The general agent reads it… route reading/analysis to general».
- **Тул `document` → `write_document`** (model-facing; внутренний `SessionOperation.kind` остался
  `document`). Обновлены `task` (choose `write_document`), repair-сообщение, тесты.
- **Базовый промпт** теперь: роль, «Ask when unclear», язык, «Pass the user's request verbatim;
  if it refers to earlier messages, assemble it from them; add nothing else», «The operations read
  the workspace themselves; you do not need to gather facts first». Описания тулов сокращены
  (general/revision/task/document/plan), без «inspects/reads workspace» и без ТЗ.

### Проверено

- `npm run typecheck` — чистый.
- `SKEIN_LIVE=false npx vitest run --exclude 'tests/sandbox/**'` — **657 passed / 40 skipped**.
- Live (копии ankyra): 5/5 `write_document` на «напиши документ о решателе z3»; rewrite →
  `revision`; «составь план» → `plan`; `write_document` создал `docs/z3.md` (8 секций, 285 строк,
  H1, 0 DSML, без Logic-LM); 10+3+forced `start_document` убрал `no_outline`.

### Открыто

- Длина переформулировки всё ещё гуляет (модель иногда добавляет аспекты); `respond` на
  неоднозначный «как проверить решатель?» просит уточнение вместо `general`.
- Heavy/live sandbox не запускались.

## 2026-11-12 — acceptance плана убран

### Что сделано

- **Убран отдельный plan-acceptance.** План закрывается `done`, когда закрыт последний пункт:
  `completed` пункта = его единица завершилась; отдельного `general`-судьи и `VERDICT: PASS`
  больше нет. Удалены `PlanAcceptance`/`runPlanAcceptance`/`lastStopText` (`src/session/driver.ts`),
  рендер в `src/session/view.ts` и TUI-блок/поле лога в `src/tui/app.tsx`; тест в
  `tests/plan.test.ts` заменён на «план done по последнему пункту, без general-единицы».
  Причина: судья был второй моделью поверх самоотчёта, слабее информирован (не видел правок
  пункта), шёл с `generalMaxTurns=9` на весь план и в e2e дал false negative при 7/7 completed
  (`aborted`), заново привязывая сырой request как цель.
- **Проверка принадлежит пункту.** `task` уже верифицируется островом Verification; `done`-заметка
  пункта уходит агенту сессии в `renderPlanState` и входит в work order единицы. Кросс-пунктовая
  проверка (полный тест-сьют) — явный пункт плана, а не скрытый финальный проход.
- **Добиты хвосты удаления `kind`.** Из `SESSION_BASE_PROMPT` убрана фраза про `(coding)`-метку
  (`src/session/session_agent.ts`); описание тула `plan` — «executable work orders»
  (`src/llm/session_agent.ts`); из доков убрано «пункт `document` открывается напрямую»
  (`sessions.md` §11, `projection.md`, EN/RU); из тестовых фикстур (`tui_app`, `tui_view_model`,
  `budget_pause`) убрано поле `kind` у пунктов плана.
- **Паузное меню.** Для `document`/`revision` cancel без «& roll back» (`session/view.ts`,
  `tui/panels.tsx`): снимка/отката у них нет.
- Доки EN/RU `sessions.md` §8: явно сказано, что отдельного acceptance-прохода нет.

### Проверено

- `npm run typecheck` — чистый.
- `SKEIN_LIVE=false npx vitest run --exclude 'tests/sandbox/**'` — **655 passed / 40 skipped**
  (минус два acceptance-теста, плюс один «done по последнему пункту»).

### Открыто

- Временные скрипты (`.z3-e2e.ts`, `.route-probe.ts`, `.plan-probe.ts`, `.print-plan.ts`) оставлены
  в корне по решению владельца — могут понадобиться для перепрогона; в коммит не входят.
- Live-перепрогон z3-e2e не делался: по решению владельца не требуется.
- ankyra: изменения от e2e владелец проверит и закоммитит сам из TUI (см. ниже, 2026-11-11).
- **Осознанный остаток:** `done`-условие пункта движком не проверяется (у `task` остров
  Verification читает request; у `general`/`revision`/`document` слота критерия нет). Обсуждение
  отложено.

## 2026-11-11 — `revision`, план без `kind`, планировщик read-only

### Что сделано

- **Новая единица `revision`** (session-level, request-anchored, как `general`/`document`):
  выполняет изменение, уже описанное в запросе — правит существующие файлы и запускает нужные
  команды (добавить зависимость, обновить lock, поставить пакет). Одно состояние на `request`,
  без `move`/островов, закрытие — текстовым ответом. Изменяющая: нет read-only снимка и отката.
- **Реализация `revision`.** `src/llm/revision.ts` (`REVISION_BASE_PROMPT`, положительный;
  proposer с полным набором инструментов вкл. side-effecting `bash` и `webfetch`);
  `src/session/revision.ts` — обёртка над `runGeneralAgent`, который параметризован
  (`unitType`/`agent`/`basePrompt`/`stateLabel`/`finalInstruction`), так что раннер один.
- **Маршрутизация агента сессии.** Новая операция `revision`: «изменение задано — `revision`;
  причину/способ искать или новый код — `task`; крупный prose — `document`; только чтение —
  `general`». Wiring: `types`/`operations`/`session.unitCompleted`, `progress`/`telemetry`,
  `driver` (`nextRevisionId`=`v1`, `dispatch`, `resume`, `cancel` без откатов, `executePlan`),
  `cli` deps; рендер/TUI (`session_outline`, `view`, `view_model`, `app`, `trace_lines`, `repl`).
- **`kind` убран из пунктов плана.** Планировщик больше не помечает операцию: `PlanItemKind`
  удалён, пункт — work order (`title`/`detail`/`done`). `executePlan` на каждый пункт зовёт
  агента сессии (видит план и результаты прошлых пунктов и сам выбирает операцию); `document`
  не открывается напрямую по `kind`. Причина: метка `(coding)` перевешивала маршрут (docs/config
  уходил в `task`/Patch; live e2e: 53 хода, budget). Риппл: `ir/types`, `session/planner`,
  `llm/planner` (схема `submit_plan`), `session/plan`/`view`/`driver`, `tui/view_model`, тесты и
  доки EN/RU.
- **Планировщик строго read-only.** `PLANNER_TOOL_NAMES` без `shell` (`src/llm/planner.ts`);
  `modelPlannerAgent` фильтрует вызовы вне поверхности (один repair, затем drop); в `runPlanner`
  — барьер `PLANNER_READONLY = {read,grep,list,recall,search}`. Причина: провайдер отдавал
  `bash`/`edit` вне поверхности, планировщик их исполнял (`bash sed -n` кусками вместо `read` с
  8K; 17 `bash` в одном прогоне) и мог мутировать дерево. Теперь только read/grep/list; доки
  `sessions.md` §8 EN/RU обновлены, тест `plan.test` проверяет, что off-surface вызов не
  исполняется.

### Проверено

- `npm run typecheck` — чистый.
- `SKEIN_LIVE=false npx vitest run --exclude 'tests/sandbox/**'` — **656 passed / 40 skipped**
  (включая `revision_unit`).
- **Пробник планировщика** (z3-запрос): только `read/grep/list` (нет `bash`/`shell`/`edit`),
  план сдан за 18 ходов.
- **Live e2e в `~/dev/ankyra`** («напиши план для добавления решателя z3»): план из 7 пунктов;
  исполнение — item 1 → `revision v1`, 2 → task r1, 3 → `revision v2`, 4 → `revision v3`,
  5 → `revision v4`, 6 → task r2, 7 → task r3. Docs/config/verify-доки ушли в `revision`,
  код/тесты — в `task`; **все 7 пунктов completed**. План `aborted (7/7)` только из-за acceptance.

### Открыто

- **ankyra: рабочее дерево содержит реальные изменения от e2e** — новые
  `src/ankyra/engine/backends.py`, `src/ankyra/engine/smt/prove.py`, `tests/test_engine_smt.py`,
  `tests/test_engine_backends.py`; изменены `verify.py`, `settings.py`, `pyproject.toml`,
  `uv.lock`, `.env.example`, `AGENTS.md`, `README.md`, `ARCHITECTURE.md`,
  `docs/l2_plan(.ru).md`, `docs/logic_layer(.ru).md`, `docs/quality_findings(.ru).md`. Item 7
  сам сообщил 671 passed (без z3) / 681 (с `--extra smt`), но прогон не проверялся вручную —
  владелец решит keep/revert и закоммитит из TUI.
- Чекпойнт/откат для `revision` намеренно не делался.

## 2026-11-11 — `general`/`plan` без `move`; агенты в документации

### Что сделано

- **`move` убран из `general`/`plan`.** Обе единицы теперь request-anchored, как `document`:
  `request → turns`, `plan`/`stop` — рёбра от request. `seedGeneral`/`seedPlanner` создают
  `request`+`turns`; история и `messagesOf` читают request как якорь; `recordPlan` вешает `plan`
  и `stop` на request. `executeAction("stop")` замыкает request-якорь, `unitCompleted` для
  `general/plan/document` читает `stopOf(request)`. `session_outline.generalEnding` и
  `tui/view_model` тоже читают request; общая единица в TUI рендерится одной синтетической
  request-стадией (сохраняет ходы и токены), `plan` в общий TaskView не входит — у него PlanPanel.
- **Документация EN/RU синхронизирована.** `sessions.md` («сессии и агенты»): `document` в §1,
  пять операций, §9 «Агент общей задачи», §10 «Агент записи документа», observer §11; план —
  `kind general|task|document`, `document`-пункт открывается напрямую. `concepts.md`: шесть
  агентов и единиц, включая planner/document, пять операций. `ir.md`: тип «документ», пять
  операций, §1.4 «Документ», observer §1.5; убрана legacy «Чтение». `projection.md`: пункт
  `document` в блоке плана. Индексные README EN/RU.
- **Снят вопрос про отдельную TaskView-панель `document`:** не нужна.
- **Request-anchored единицы видны в памяти.** `unit`/`state`/`turns` трактуют
  `general`/`plan`/`document` как одно состояние с id единицы: `unitOutline` печатает якорь,
  `stateDetail` принимает request-якорь, описания инструментов session-агента обновлены; тест в
  `general_unit.test.ts`.
- **`general-live`**: убрана строгая проверка `## `-заголовка — ответ модели не переписываем.
- **Доки-скоуп.** `testing.md`/`system_prompt.md`/`tools.md`/`states.md` явно ограничивают себя
  агентом задачи и ссылаются на request-anchored единицы; `sessions.md` §2/§9/§10 называет их
  одним состоянием на request.

### Проверено

- `npm run typecheck` — чистый.
- `SKEIN_LIVE=false npx vitest run --exclude 'tests/sandbox/**'` — **654 passed / 40 skipped**
  (включая обновлённый `tests/general_unit.test.ts` с памятью request-anchored единиц).
- **Live `general-live`** (синтетический проект): маршрут `general`, 6 ходов, `done`, `stop=answered`,
  `completed`, без `move`; `stop`/`turns` на request. Единственный FAIL харнесса —
  ответ модели без `## `-заголовка (проверка стиля, не якоря).
- **Live `session-live`**: `routes=["general","respond","task"]`, `general` completed, task
  отработал — OK.
- **Live план `log-summary-date-ranges`** (Docker, 40 turns): plan 1/1, **reward=1**,
  acceptance pass, 9 ходов task — request-anchored план и закрытие по `stop` работают.
- **Live документ, полный путь** (временный скрипт вне репо, ~63 с): агент сессии сам выбрал
  `document`; 8 ходов, `done/summarized`, 5/5 секций, 21.3 KB; без `move`, `turns`+`stop` на
  request, `completed`, заголовки совпадают с outline — OK.

### Открыто

- Роутинг `document` — нужна серия live-прогонов (см. ниже, 2026-11-10).
- Новые правки (память request-anchored единиц, `general-live`, скоуп-заметки в доках) не
  закоммичены.
- Дальше — функциональные дыры плана (retry `abandoned`, отмена, rework, бюджет) и live-проверка
  авто-выбора `plan` агентом сессии.

## 2026-11-10 — юнит `document` (запись большого файла секциями)

### Что сделано

- **Новый юнит `document`.** Одна цель, без `move`/островов: лента висит на `request`
  (`turns`-контейнер и `stop` — рёбра прямо от request). Фазы: (1) `submit_plan` с `{path, items}`
  (read-only инспекция допустима), (2) по одному ходу на пункт — модель отдаёт **markdown-тело**
  секции, экзекутор дописывает `## <title>` в файл, (3) финальное summary из плана и файла.
  Число секций известно из JSON — остановку решает экзекутор, не модель.
- **Без тула `write_item`/append.** Тело секции — обычный text-reply; большой JSON-аргумент
  инструмента не эмитится, поэтому обрезка по `maxTokens` не превращается в `Unterminated
  string in JSON`. Обрезка секции (`finishReason=length`) → continuation-запрос (bounded).
- **Интеграция.** `PlanItemKind += "document"` (планировщик помечает пункт и называет путь);
  `executePlan` открывает юнит напрямую, без переинтерпретации session-агентом; добавлена
  прямая операция сессии `document`. `PausedState`/resume/cancel, progress/telemetry, outline.
- **Wiring.** `src/session/document.ts` (runner), `src/llm/document.ts` (outline- и text-агенты),
  `src/cli.ts` (deps). Тест `tests/document_unit.test.ts`.
- **Роутинг.** Первый live-прогон ушёл в `document`, второй на тот же запрос — в `general`
  (модель решает сама). Промпт session-агента и описания операций усилены: файл как deliverable
  → `document`, `general` файлов не создаёт, `task` — для кода/мелких правок.

### Проверено

- `npm run typecheck` — чистый.
- `SKEIN_LIVE=false npx vitest run --exclude 'tests/sandbox/**'` — зелёный (включая
  `document_unit`: outline→секции→summary, continuation, plan-item, прямая операция, resume).
- **Live (deepseek-v4-flash, `/tmp/opencode/doc-live`).** Запрос «Создай большой Markdown-документ
  `docs/guide.md` по `spec.md`» → операция `document`: outline из 4 секций (Introduction,
  Overview, API, Example), 10 вызовов, файл 18.4 KB / 275 строк, заголовки чистые (`##` секции от
  экзекутора, `###` подразделы от модели). Токены: input 44 369 (cache 18 560 → fresh 25 809),
  output 10 695, reasoning 2 462. До фикса модели писала собственные `#`/`##` внутри тела —
  заголовок дублировался (`## Example` + `# Example`); в промпте секций теперь запрещены `#`/`##`.

### Открыто

- Роутинг `document` — модельный; после усиления промпта один live-прогон попал верно, но нужна
  серия прогонов (или явная эвристика «есть путь к файлу»), чтобы оценить стабильность.

## 2026-11-10 — план в TUI, бюджет, единый лимит, диффы, планировщик

### Что сделано

- **TUI: план в правой панели.** `PlanPanel` (building/ready/executing) с пунктами,
  прогрессом и активным пунктом; текущая задача — юнит активного пункта (`unit.planItem`);
  меню плана — командами `/execute` / `/rework` / `/plan` (без модального перехвата клавиш),
  подсказки в футере. Отчёты пунктов и acceptance рендерятся отдельными Markdown-блоками.
- **Бюджет ходов.** На пределе task-юнита — пауза `budget` (не обрыв): `[c]ontinue +N`
  (`SKEIN_BUDGET_EXTEND`, дефолт 10) и `[f]inish & report` (финальный отчёт). Headless
  (`runAgent` без `budgetPause`) сохраняет жёсткий `max_turns`. `plannerMaxTurns` 12→24;
  в `.env` задачи — `SKEIN_MAX_TURNS=48` (дефолт в коде 80, .env не коммитится).
- **Acceptance плана.** Перед `plan_finished done` read-only general-юнит проверяет исходный
  запрос и `done` каждого пункта, требует финальную строку `VERDICT: PASS`; FAIL/нет вердикта →
  план `aborted` с отчётом (`PlanExecutionResult.acceptance`, видно в TUI/REPL).
- **Единый inline-бюджет 8K** (`INLINE_LIMIT`): инспекция (`read`, `grep`, `list`, `recall`,
  `search`) — голова, команды (`bash`) — хвост; `read` 32K→8K, `recall` 64K→8K (листание
  `offset`/`start-end`). Убрана повторная обрезка до 2K в `planner.ts`/`general.ts`. Доки EN/RU
  (`projection.md`, `tools.md`) обновлены.
- **Диффы.** `edit`/`write`/`apply_patch` несут whole-file `before`/`after`
  (`ExecOutcome.diffs` → `tool_finished.diffs`); TUI рисует opencode-style unified diff (путь,
  номера старых/новых строк, цвета, контекст, `…`), мутации авто-разворачиваются. Остальные
  инструменты — тизер первых 5 строк + разворот по клику.
- **Планировщик.** Промпт: реализация обязана быть `coding`-пунктами, `general` — только
  read-only; запрет «собери факты, чтобы потом написать» без шага записи; язык плана = язык
  запроса. Финальный `submit_plan` запускается всегда при отсутствии плана; при обрезании по
  лимиту — ретрай с **выключенным reasoning** (тот же `maxTokens`), не bump.
- **TUI perf.** `traceLines`/`buildTuiView` мемоизированы; ввод/перемещение курсора больше не
  пересчитывают трейс и view.

### Проверено

- `npm run typecheck` — чистый.
- `SKEIN_LIVE=false npx vitest run --exclude 'tests/sandbox/**'` — **649 passed / 40 skipped**.
- Новые тесты: `tests/budget_pause.test.ts`, `tests/planner_model.test.ts`; обновлены
  `plan.test.ts`, `tui_app.test.tsx`, `tui_view_model.test.ts`, `tui_trace.test.ts`,
  `general_unit.test.ts`, `ops/apply.test.ts`, `budget_grace.test.ts`.

### Открыто

- Тяжёлые Docker/live прогоны не запускались (нужен go-ahead): live plan-исполнение,
  бюджет-пауза, planning с reasoning-off, acceptance.
- `abandoned`-пункт (`llm_error`, `no_decision`, `max_turns` старого пути) всё ещё останавливает
  план как `aborted`; retry/skip/возврат решения агенту сессии не сделаны. Бюджет-лимит теперь
  пауза, но остальные `abandoned` — нет.
- Отмена плана, rework с фидбеком/версиями, политика pause/leave/suspend пункта, общий бюджет
  плана, полный метеринг (planner/session/general) в `tests/sandbox/session-plan.ts`.
- Acceptance — model-verdict: free-text `done` не проверяется машинно; FAIL/отсутствие вердикта
  трактуется как abort. Стоит решить, нужен ли строгий формат / `toolChoice`.
- `.deep-memory/`, `.opencode/` — untracked, не наши, не коммитятся.

## 2026-11-08 — режим планирования (`plan` unit)

### Что сделано

- Новая единица `plan` — read-only разработка плана: `shell` разрешён, изменения при выходе
  откатываются (`rollback`, reason `plan-read-only`). Агент и цикл — `src/session/planner.ts`,
  провайдер — `src/llm/planner.ts`; терминальный инструмент `submit_plan`.
- IR: виды узлов `plan`/`plan_item`, связи `plan`/`plan_item`; пункт несёт `title`, `detail`,
  `kind` (`general|task`), `done`, `order`. Markdown плана — рендер узлов.
- Операция сессии `plan`; событие `plan_started`/`plan_finished`; связь `open_unit.planItem`.
  Режим, курсор и статусы пунктов выводятся из журналов (`src/session/plan.ts`).
- Драйвер: `executePlan` идёт по пунктам по порядку; на каждый пункт агент сессии вызывается
  заново и выбирает `task`/`general`, переформулируя наряд. Пункт — обычная единица с
  `planItem`; `completed` закрывает пункт, `abandoned` останавливает план (`plan_finished`
  `aborted`), после последнего — `plan_finished` `done (n/N)`.
- UI: план показывается Markdown-ом, меню `[e]xecute/[r]ework/[q]uit` в REPL и TUI; `rework`
  возвращает в диалог (новую `plan`-единицу открывает агент сессии); пауза пункта продолжает
  план после resume.
- Планировщик: если упёрся в `plannerMaxTurns`, делается финальный вызов только с `submit_plan`
  (иначе на большом дереве он читает все ходы и не успевает сдать план). Пункт ограничен
  `title ≤ 200`, `detail ≤ 4000`, `done ≤ 1000`, пунктов ≤ 12.
- Новый live-harness `tests/sandbox/session-plan.ts` (session-level): принудительный `plan`,
  `executePlan`, реальные агент сессии/планировщик/task/general, затем собственный verifier
  задачи; `--virtual` для дешёвого прогона спеки, `--turns`/`--net`/`--dir`.
- General-юнит, исполняющий пункт плана, получает отдельный бюджет
  `planGeneralMaxTurns` (`SKEIN_PLAN_GENERAL_MAX_TURNS`, дефолт 30) вместо обычного
  `generalMaxTurns` (9/10). Обычные general-вызовы не меняются; resume пункта тоже берёт
  план-бюджет.
- Доки RU/EN: `sessions.md`, `ir.md`, `projection.md`, `testing.md`.

### Проверено

- `npm run typecheck` — чистый.
- `SKEIN_LIVE=false npx vitest run --exclude 'tests/sandbox/**'` — **632 passed / 40 skipped**
  (включая 8 тестов `tests/plan.test.ts`: план-единица, авто-исполнение, abandoned-пункт,
  restore шелла, меню REPL, rework, план-блок в контексте, форсированный финальный `submit_plan`,
  увеличенный бюджет general-пункта).
- Live, виртуальный `fix-ocaml-gc`: план построен и исполнен; первый task-юнит завершился
  `llm_error` → план `aborted`, но правка легла и verifier дал reward=1.
- Live Docker `fix-ocaml-gc` (60 turns): **plan done 4/4, reward=1** (2 general → аудит → task
  фикс → general testsuite).
- Live Docker `custom-memory-heap-crash` (80 turns): **plan done 3/3, reward=1** (general → task →
  general verification). Трассы — `bench/runs/session-plan/`.

### Открыто

**Функциональные дыры (по приоритету):**

- `abandoned`-пункт (`llm_error`, `max_turns`, `no_decision`) останавливает план как `aborted`
  и навсегда блокирует план. Нужен retry пункта (новый unit с тем же `planItem`, статус по
  последней попытке), skip или возврат решения агенту сессии. Виртуальный `fix-ocaml-gc` это
  показал: reward=1, но план `aborted`.
- Живая проверка, что агент сессии **сам выбирает `plan`**: в harness первая операция
  форсируется, реальный route-choice не проверен. Это первое, что надо прогнать.
- Отмена плана (отложена): отмена текущего пункта, `plan_finished.aborted`, судьба уже
  сделанных пунктов и rollback.
- Rework UX: `[r]ework` лишь возвращает в диалог; нет явной «переработки с фидбеком» и
  понятия активной версии плана (старый план остаётся `started` без `finished`).
- Pause/leave/suspend посреди плана: resume пункта продолжает план, но `suspended`-пункт
  (leave) блокирует план без `PausedState` — меню пропадает. Нужна политика.

**Контроль и UX:**

- Бюджет плана целиком (суммарные ходы/пункты), а не только per-unit.
- Финальный отчёт по плану после `plan_finished` (сейчас только итоги юнитов).
- TUI: план-оверлей/прогресс в панели, явный режим `plan`, нормальный prompt для rework.
- У общего юнита вне плана остаётся `generalMaxTurns=9`; пункт плана получает
  `planGeneralMaxTurns=30`. Живой перепрогон с новым бюджетом не делался (деньги/время);
  офлайн-тест на override есть.

**Тесты и наблюдаемость:**

- Полный метеринг в `tests/sandbox/session-plan.ts`: сейчас считаются только task-юниты;
  planner/session/general не входят в токены/стоимость.
- Офлайн-кейсы: TUI-меню плана, pause/resume пункта, blocked/reply/no_decision, resume с
  план-бюджетом general, unit-тест `operationOf("plan")`.

**Процесс:**

- Рабочее дерево не закоммичено; в нём же прежние изменения (удалён `langgraph/graph.ts`,
  untracked `.deep-memory/`, `.opencode/`).
- `docs/en|ru/ir_operations.md` намеренно не расширялись: план — session-level артефакт, а не
  оператор задачи; coverage-реестр не менялся.

## 2026-11-08 — ревизия документации и чистка legacy

### Документация

- Концепции переписаны вокруг двух главных идей: **немонотонный контекст** и **состояния и
  переходы**. Убраны докса/логос, `acceptance`-идеология и старые термины.
- `ir.md` разделён на два документа:
  - `ir.md` — концептуальная модель: журнал, состояния, переходы, записи, контекст, инварианты;
  - `ir_operations.md` — справочник: поверхность модели, операторы, таблицы инструментов, отказы,
    реализация и матрица покрытия. Coverage-гейт читает `docs/en/ir_operations.md`.
- `projection.md` переписан под текущую ленту: запрос, краткая справка, `Start`, ходы, рабочий
  промпт, `Finish` + `Artifacts:`, `recall`/`search` как обычные ходы.
- `sessions.md` заменил `session_concepts.md`: сессия как контейнер единиц работы, следы, операции
  `respond`/`general`/`task`, изоляция, переформулировка, пауза/возврат/отмена, наблюдатель.
- `states.md` приведён к `src/ir/islands.ts`: текущие `what`, `Done when`, инструкции, переходы,
  поверхность инструментов.
- `system_prompt.md` очищен от фаз и старых блоков; описаны текущие `B1`/`B2` и ситуации
  `request`/`working`/`transition`/`terminal`.
- `testing.md` объединил `state_testing.md`; убраны Harbor и дублирующий раздел, исправлен дефолт
  `--turns` (80, у `fix-ocaml-gc` — 60).
- `tools.md` переписан как контракт модельных имён и параметров; `stop` больше не инструмент.
- `walkthrough.md` переписан под текущую проекцию; сквозной пример Patch → Verification (провал) →
  revert → Patch → Verification (успех) → End.
- `README.md`, `docs/README.md`, `docs/en|ru/README.md` и `AGENTS.md` осовременены; ссылки на
  удалённые документы убраны.

### Код

- Операция сессии `start` переименована в `task` (код, промпт, TUI, тесты, доки).
- `doxa`/`logos` заменены на `model`/`executor` в комментариях и provenance-значениях.
- Удалён legacy reading-юнит: `src/session/reading.ts`, тип `"reading"`, `readFile`-проброс через
  `session_agent`/`session_memory`, обработка в `session.ts`/`session_outline.ts` и тесты.
- `session_workspace.ts` урезан до production-части: `generalFactsText` и
  `projectInstructionsText`.
- Удалены неиспользуемые экспорты: `stackOf`, `isFinished`, `probeBrief`, `workspaceBrief`,
  `noopTelemetry`, `contextTimeline`, `noopProgress`.
- Удалён shim `tests/sandbox/checkpoint.ts`; импорты переведены на `src/tools/checkpoint`.
- Удалены мёртвые bench-инструменты: `bench/minimal.ts`, `bench/reasoning-breakdown.ts`,
  `bench/opencode-prompts/`.
- Удалены Harbor и LangGraph: `bench/harbor/`, `langgraph/`, `langgraph.json`,
  `bench/agents_compare.ts`, скрипт `bench:compare`. Текущий runner — `tests/sandbox/**`.
- Удалён `fixtures/synthetic/` (ссылок не было).
- В тестах и комментариях `tests/sandbox/**` заменены упоминания Harbor на benchmark/task cache.

### Проверено

- `npm run typecheck` — чистый.
- `SKEIN_LIVE=false npx vitest run --exclude 'tests/sandbox/**'` — **624 passed / 40 skipped**.
- Виртуальная песочница — **10 passed**.
- `tests/coverage.test.ts` — 2/2, все 95 ID сохранены.

### Открыто

- Тяжёлые Docker/live прогоны не запускались: нужен явный go-ahead владельца.
- В `src/ir/islands.ts` и цитатах критериев остаётся слово `acceptance` — это фактический текст
  текущих критериев; отдельно решить, переименовывать ли его.
- `bench/step_compare.ts` оставлен как офлайн-анализ метрик, но не документирован.
- Рабочее дерево не закоммичено; коммит не делался.
- Исторические записи handoff удалены из файла и остаются в git.
