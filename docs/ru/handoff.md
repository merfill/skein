# Handoff — текущее состояние

> Рабочий документ передачи. Английского зеркала нет. История изменений по датам удалена:
> она остаётся в git. Здесь — только текущее состояние и последняя выполненная работа.

## 2026-11-16 — `inquiry`: корень-цель, структурированные инструменты, Docker K=3 (k3d)

### Что сделано

- **Идея.** Единица работает гипотезами. Корень — цель запроса: результат, который должен
  быть верен, когда работа сделана; модель открывает его первой, работает внутри и
  закрывает последней, когда закрыты открытые под ним гипотезы. Гипотеза — утверждение
  (`suppose`) с двумя ожиданиями (`if_true`/`if_false`); вердикт опирается на наблюдения,
  записанные после открытия. Движок не разбирает смысл; он проверяет структуру и пишет
  отказы.
- **Спецификация.** `docs/ru/inquiry.md` (RU-only, контракт): идея, журнал, инструменты,
  правила, проекция, пример `fix-git`, ручной запуск, ограничения, Ankyra-приложение.
- **Промт (B1).** Первый абзац: «You work by hypotheses: you put a hypothesis forward and
  close it when its outcome is observed. This uses the `open_hypothesis` and
  `close_hypothesis` tools. A hypothesis is a claim together with what you expect to see if
  you are right and if you are wrong.» Отдельный абзац: «At the start of the work, call
  `open_hypothesis` to formulate the user's request as the root hypothesis: the result that
  must hold when the work is done, with the observation that shows it. Work inside the root,
  and close it last, once the hypotheses you opened under it are closed.» Вычитанный абзац
  «Develop the active hypothesis: …» сохранён дословно (без перечисления инструментов).
  Отрицательные формулировки убраны.
- **Инструменты.** Описания — структурированные списки. `open_hypothesis`: `kind` —
  `change` (запрос просит результат в рабочем дереве) или `probe` (запрос просит ответ);
  `label`, `suppose`, `if_true`, `if_false`. `close_hypothesis`: закрывает активную и
  только её; `id` — C-номер; `verdict` — для пробы/правки; `grounds` — номера из `[obs:N]`.
- **Grounds числами.** `close_hypothesis.grounds` — `number[]`; `toProposal` превращает
  `N` (и на всякий случай `"N"`/`"obs:N"`) в `obs:N`; `modelCall` показывает модели `N`.
  IR и проверки остаются строковыми `obs:N`.
- **Терминология.** IR переименован под `hypothesis`: узлы `hypothesis`/`hypothesis_verdict`,
  ребро `hypothesis`, операторы `open_hypothesis`/`close_hypothesis`, типы
  `HypothesisPayload`/`HypothesisVerdictPayload`, поле `hypothesisId`, помощники
  `hypothesis*`/`activeHypothesis*`. Старых `claim*` в коде нет; `docs/ru/inquiry.md`
  синхронизирован.
- **Проекция.** Успешные `open_hypothesis`/`close_hypothesis` всегда рендерятся в ленте
  (`[C1] opened change: …`, `C1 done (obs:42, obs:46)`); добавлены result-рёбра
  open→узел гипотезы, close→узел вердикта. При `OPEN: none` лента не схлопывается до
  одних отказов. Закрытая ветка по-прежнему сворачивается в `CLOSED`; детали — `recall`.
- **Реализация.**
  - IR: `src/ir/types.ts`, `src/ir/graph.ts` — узлы, рёбра, дерево, путь активных.
  - `src/llm/inquiry.ts` — поверхность `inquiry`, структурированные описания.
  - `src/llm/{schemas,tools}.ts` — операторы `open_hypothesis`/`close_hypothesis`, маппинг
    числа↔`obs:N`.
  - `src/tools/index.ts` — исполнение, гейты, grounds только наблюдения, `children_open`,
    `bad_grounds` с валидными номерами и `recall`, `bad_verdict`, `not_open`,
    `bad_expectation`.
  - `src/inquiry.ts` — промт, цикл, проекция, остановка с `unresolved`.
  - `bench/inquiry.ts` — ручной запуск (`npm run inquiry`), `--dry`, `--tree`, `--save`.
  - `tests/sandbox/harness.ts` + `tests/sandbox/inquiry-task.ts` — Docker-раннер
    (`npm run inquiry:docker`), K параллельно, network off, maxTurns 60, `--save`.
  - `tests/inquiry_unit.test.ts` — 9 офлайн-тестов (добавлен тест на видимый open/close).
- **Проверки.** Docker `fix-git` K=3 на базах:

  | база | solved | turns | open | cost |
  |---|---:|---:|---:|---:|
  | k3: мутации + B1 («OPEN», отрицательная) | 3/3 | 140 | 17 | 5.71₽ |
  | k3b: без мутаций + B1 отрицательная | 2/3 | 154 | 18 | 5.16₽ |
  | k3c: без мутаций + B1 положительная + `open_hypothesis` | 3/3 | 104 | 2 | 3.61₽ |
  | **k3d: корень-цель + структурированные инструменты + grounds числами + видимый close** | **3/3** | **63** | **0** | **1.58₽** |

  k3d по прогонам: r1 18/0/0.38₽, r2 18/0/0.39₽, r3 27/0/0.81₽. Все три: первый вызов —
  `open_hypothesis kind=change`; корень закрыт `done`; `OPEN: none`; финалы честные
  (master содержит правки, дерево чистое). Артефакты: `/tmp/skein-inquiry-docker-k3d`
  (`events.ndjson`, `result.json`, `tree.txt`, `task.txt`, `check.out.txt`).
- **Сравнение.** Opencode `fix-git` (K=5): 10/10, 8.3 хода, 78.2k in / 4.1k fresh /
  1.35k out, ~0.20₽. Skein `task`: 9/10, 12.6 хода, 65.0k / 19.9k / 3.3k, 0.60₽.
  Inquiry k3d: 21 ход, 116.4k / 14.8k fresh / 3.3k out, 0.53₽ — 3/3; ~2.5× opencode по
  цене, ниже Skein task по fresh и цене, 0.6× ходов и 0.44× цены k3c.

### Проверено

- `npm run typecheck` — чисто.
- `SKEIN_LIVE=false npx vitest run --exclude 'tests/sandbox/**'` — **661 passed / 40 skipped**;
  `tests/inquiry_unit.test.ts` — 9/9.
- `npm run inquiry -- "..." --dir /tmp --dry` — B1/B2 собираются; `OPEN: none`.
- Docker k3d — **3/3**, verifier 2/2 passed в каждом прогоне, unresolved 0.

### Открыто

- **id гипотезы при close.** r1: `id=6` → `not_open`, потом `C1`; r3: `id=6`,
  `id=w:hypothesis:6` → `not_open`, потом `C1`. Модель читает число из брекета вместо
  `C1` из `OPEN`; 1–2 хода на прогон. Следующий шаг — брекет claim-инструментов `[C1]`
  (и/или принимать `C1`/число).
- **`recall` с голым числом.** r2: `recall 66`; r3: `recall 11`, `40`, `88`, `92` →
  «nothing to recall». r3 из-за этого 27 ходов. Следующий шаг — числовой `recall` (как
  grounds) или нормализация `N` → `obs:N`.
- **bash сразу после закрытия корня** → `no_open`, затем открывается проверочная проба:
  1–2 хода в каждом прогоне.
- **Проверочные пробы новыми корнями.** После закрытия C1 модель открывает C2/C3/C4
  как новые корни, а не детей; «корень закрывается последним» буквально не выполнено,
  но цель закрыта и unresolved=0.
- **Настоящий бенчмарк.** K=3 на `fix-git`; полной кампании K=5 (13 задач) нет.
  k3d ~2.5× opencode по цене; для статьи нужен честный A/B.
- **EN-зеркало** `docs/ru/inquiry.md` не сделано.
- **Workdir.** r2 ходил через `cd /app/personal-site`; r1/r3 — относительные пути.
  Лишних read/ходов в k3d нет.
- **Рабочее дерево:** посторонние незакоммиченные `tests/sandbox/{campaign,matrix,
  opencode-run,sandbox-run,tasks/registry}.ts`, LHTB-задачи и dotfiles не трогались.
- Старый черновик `docs/ru/claims-spec.md` остаётся отдельным слоем; в inquiry не входит.

### Где смотреть / команды

- Спецификация: `docs/ru/inquiry.md`; handoff — здесь.
- Локальный прогон: `npm run inquiry -- "<текст>" --dir <repo> --max-turns 40
  [--tree] [--save <dir>] [--dry]`.
- Docker `fix-git` K=3: `SKEIN_INQUIRY_SAVE=<dir> npm run inquiry:docker`
  (Docker, образ `alexgshaw/fix-git:20251031`, кэш задачи, ключ провайдера;
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

