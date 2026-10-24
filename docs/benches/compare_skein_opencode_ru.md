# Skein vs opencode — матрица задач

> Английское зеркало — `docs/benches/compare_skein_opencode.md`. Рабочий отчёт, а не
> спецификация: по разделу на задачу, добавляется по мере прогонов матрицы.

## 1. Методика

Оба агента запускаются в **одном и том же образе задачи**, с одной и той же приёмкой
**`tests/test.sh`** после агента (семантика Harbor, reward из `/logs/verifier/reward.txt`),
на одной модели и с одинаковым reasoning effort. Отличие задумано только в агенте.

- харнесс: `tests/sandbox/matrix.ts <task>` (одна задача на запуск);
- модель: `routerai/~deepseek/deepseek-v4-flash-latest`, reasoning `low` (temperature у Skein
  0.1; opencode использует свои дефолты);
- ячейки: `{skein, opencode} × {net on, off} × repeat 1..3`, concurrency 6, wall-clock
  timeout 1200 s на ячейку; `--net off` снимает сеть только с **агента** — у verifier она
  остаётся, чтобы `test.sh` мог поставить рантайм;
- бюджет ходов: `task.maxTurns` (Skein); opencode ограничен тем же wall-clock и
  `maxSeconds`;
- у задачи, которой нужна сеть агенту (crack-7z-hash), нет ячеек `off`: они помечаются
  `unsupported` и не запускаются.

### Метрики

Из `metrics.json` каждой ячейки (медиана по K=3; всё — на один прогон):

| метрика | смысл |
|---|---|
| reward | `1` = родной verifier задачи прошёл |
| turns / steps | ходы движка Skein; шаги агента opencode — **разные единицы** |
| in | все входные токены, включая чтения из кеша |
| fresh | `in − cacheRead`: что модель реально перечитала (честная ось входа) |
| out | выходные токены, включая reasoning |
| reason | reasoning-токены (внутри `out`) |
| wall | полный wall-clock ячейки: агент + verifier |
| ₽ | Skein: `cost` от провайдера; opencode: расчёт (см. ниже) |

Медианы считаются по всем попыткам, где записан reward, **включая `reward0`** (стоимость
неудачной попытки); `solved` учитывает только `reward=1`.

### Как считается стоимость opencode

`costRub` у Skein — это `usage.cost` самого провайдера. В `metrics.json` opencode стоимости
нет, но сырой `reasoning.ndjson` её сохраняет (`usage.cost`); фактическая стоимость агента для
`regex-log` — 1.524 / 0.934 / 2.216₽ на on и 0.675 / 0.785 / 1.216₽ на off (с title-вызовом),
то есть оценка по токенам ниже с ней совпадает (1.521 vs 1.521 для on r1). Оценка всё ещё
нужна, когда записаны только токены: она использует **те же ставки за токен**, подобранные
МНК по **Skein-ячейкам той же задачи** (одна модель, провайдер и маршрут в одно время):

```
cost ≈ fresh·a + cacheRead·b + out·c       (₽ за токен; out включает reasoning)
```

Для `regex-log` (6 Skein-ячеек) подгонка даёт `a = 17.289`, `b = 0.340`, `c = 69.103` ₽/1M и
воспроизводит все шесть значений `costRub` Skein с точностью < 0.001 ₽. Прежние ставки из
handoff (17.77 / 0.36 / 71.09) отличаются на ~3%; по возможности пересчитывать на каждой
задаче. В таблицах оценка помечена `≈`.

## 2. Статус

> **Версия промта.** Skein-ячейки в §3–§4 измерены 2026-10-24 **до** переписывания
> Orientation (`what`/`instruction`/`hint`); opencode не затронут. С новым Orientation:
> `regex-log` K=3 — 15 ходов / 1.532₽ медиана (3/3), `openssl` K=1 — 17 / 0.722₽ (reward=1).
> См. `docs/plans/handoff_2026-10-24_session12_orientation_matrix_ru.md`.

| задача | прогон матрицы | результат |
|---|---|---|
| regex-log | 2026-10-24 | 12/12 reward=1, см. §3 |
| openssl-selfsigned-cert | 2026-10-24 | 11/12 reward=1 (один промах opencode `off`), см. §4 |
| fix-git | 2026-10-24 | см. `task_benchmarks_ru.md` §10 |
| log-summary-date-ranges | 2026-10-24 | см. `task_benchmarks_ru.md` §7 |
| git-leak-recovery | 2026-10-24 | см. `task_benchmarks_ru.md` §11 |
| cobol-modernization | 2026-10-24 (K=1) | см. `task_benchmarks_ru.md` §16 |
| modernize-scientific-stack | 2026-10-24 | см. `task_benchmarks_ru.md` §5 |
| fix-ocaml-gc | 2026-10-24 (net off) | см. `task_benchmarks_ru.md` §4 |
| custom-memory-heap-crash | 2026-10-24 | см. `task_benchmarks_ru.md` §12 |
| password-recovery | 2026-10-24 (K=1) | см. `task_benchmarks_ru.md` §13 |
| crack-7z-hash | 2026-10-24 (K=1, `net on`) | см. `task_benchmarks_ru.md` §15 |
| db-wal-recovery | 2026-10-24 (K=1) | см. `task_benchmarks_ru.md` §14 |
| fix-code-vulnerability | 2026-10-24 | см. `task_benchmarks_ru.md` §9 |

## 3. regex-log (2026-10-24)

`run`: `bench/runs/matrix/2026-10-24T11-36-31-regex-log/`

### 3.1 По ячейкам

| ячейка | reward | turns/steps | in | fresh | out | reason | wall | ₽ |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| skein on r1 | 1 | 13 | 66.4k | 28.6k | 14.2k | 11.2k | 127 s | 1.485 |
| skein on r2 | 1 | 13 | 79.1k | 25.3k | 12.1k | 8.0k | 100 s | 1.292 |
| skein on r3 | 1 | 18 | 147.9k | 31.3k | 16.7k | 12.7k | 148 s | 1.731 |
| skein off r1 | 1 | 14 | 69.9k | 23.2k | 9.1k | 6.5k | 111 s | 1.047 |
| skein off r2 | 1 | 13 | 80.9k | 25.4k | 17.7k | 15.2k | 141 s | 1.679 |
| skein off r3 | 1 | 19 | 132.9k | 40.0k | 25.1k | 21.2k | 187 s | 2.457 |
| opencode on r1 | 1 | 7 | 123.3k | 14.5k | 17.8k | 16.0k | 158 s | ≈1.521 |
| opencode on r2 | 1 | 8 | 110.1k | 11.5k | 10.0k | 7.5k | 112 s | ≈0.925 |
| opencode on r3 | 1 | 15 | 317.8k | 30.3k | 23.0k | 19.1k | 202 s | ≈2.213 |
| opencode off r1 | 1 | 6 | 74.3k | 8.0k | 7.4k | 6.1k | 104 s | ≈0.671 |
| opencode off r2 | 1 | 6 | 74.5k | 6.7k | 9.3k | 8.1k | 93 s | ≈0.781 |
| opencode off r3 | 1 | 9 | 138.3k | 15.3k | 13.1k | 10.3k | 127 s | ≈1.211 |

### 3.2 Медианы

| агент / сеть | turns/steps | in | fresh | out | reason | wall | ₽ |
|---|---:|---:|---:|---:|---:|---:|---:|
| skein / on | 13 | 79.1k | 28.6k | 14.2k | 11.2k | 127 s | 1.485 |
| skein / off | 14 | 80.9k | 25.4k | 17.7k | 15.2k | 141 s | 1.679 |
| opencode / on | 8 | 123.3k | 14.5k | 17.8k | 16.0k | 158 s | ≈1.521 |
| opencode / off | 6 | 74.5k | 8.0k | 9.3k | 8.1k | 104 s | ≈0.781 |

Итог за шесть прогонов на агента: Skein **9.69 ₽**, opencode **≈7.32 ₽**; вся матрица ≈17.0 ₽.

### 3.3 Наблюдения

- 12/12 ячеек `reward=1`; таймаутов и `max_turns` нет.
- **turns vs steps:** Skein закрывается за 13–14 ходов движка; opencode — за 6–8 шагов. Это
  разные единицы (один ход Skein = один ход доксы; один шаг opencode = итерация агента).
- **Fresh input:** opencode читает заметно меньше (8.0–14.5k против 23–31k). Его общий `in`
  раздут кешем (r3: 317.8k всего при 30.3k fresh), поэтому сравнивать надо `fresh`, а не `in`.
- **Reasoning/output:** на `off` opencode тратит меньше и того, и другого (reason 8.1k против
  15.2k); на `on` они сопоставимы, у opencode `out` чуть выше.
- **Стоимость:** на `on` агенты практически равны (Skein 1.485 против opencode ≈1.521); на
  `off` opencode дешевле ~2.1× (≈0.781 против 1.679). У Skein `off` дороже собственного `on`
  на ~13%.
- **Оговорка:** K=3, одна задача, один маршрут провайдера; стоимость шумная. Обобщать рано.

## 4. openssl-selfsigned-cert (2026-10-24)

`run`: `bench/runs/matrix/2026-10-24T12-09-14-openssl-selfsigned-cert/`

Декларативный acceptance: `test_outputs.py` задачи проверяет файлы ключа/сертификата/PEM,
subject (`O=DevOps Team`, `CN=dev-internal.company.local`), срок действия, combined PEM и
то, что `verification.txt` содержит subject, даты в формате OpenSSL и SHA-256 fingerprint
через двоеточия.

Подгонка ставок по 6 Skein-ячейкам этой задачи: `a = 17.275`, `b = 0.346`, `c = 69.102`
₽/1M (воспроизводит все шесть `costRub` < 0.001 ₽; тот же маршрут, что у regex-log).

### 4.1 По ячейкам

| ячейка | reward | turns/steps | in | fresh | out | reason | wall | ₽ |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| skein on r1 | 1 | 20 | 110.4k | 28.4k | 5.1k | 1.3k | 98 s | 0.870 |
| skein on r2 | 1 | 19 | 86.5k | 26.3k | 4.2k | 1.6k | 73 s | 0.762 |
| skein on r3 | 1 | 12 | 48.1k | 17.5k | 2.9k | 0.7k | 56 s | 0.513 |
| skein off r1 | 1 | 16 | 76.8k | 25.5k | 4.6k | 0.8k | 90 s | 0.777 |
| skein off r2 | 1 | 16 | 73.7k | 18.9k | 3.9k | 0.9k | 69 s | 0.611 |
| skein off r3 | 1 | 15 | 69.2k | 21.1k | 3.8k | 0.7k | 64 s | 0.641 |
| opencode on r1 | 1 | 7 | 62.1k | 3.7k | 2.1k | 0.9k | 61 s | ≈0.231 |
| opencode on r2 | 1 | 9 | 79.0k | 3.1k | 2.0k | 0.8k | 78 s | ≈0.215 |
| opencode on r3 | 1 | 8 | 68.9k | 2.9k | 1.4k | 0.3k | 74 s | ≈0.171 |
| opencode off r1 | 1 | 7 | 58.7k | 2.2k | 1.4k | 0.4k | 50 s | ≈0.152 |
| opencode off r2 | **0** | 8 | 70.9k | 3.1k | 1.9k | 0.6k | 55 s | ≈0.205 |
| opencode off r3 | 1 | 6 | 54.0k | 3.6k | 2.5k | 1.3k | 58 s | ≈0.253 |

### 4.2 Медианы

| агент / сеть | turns/steps | in | fresh | out | reason | wall | ₽ |
|---|---:|---:|---:|---:|---:|---:|---:|
| skein / on | 19 | 86.5k | 26.3k | 4.2k | 1.6k | 73 s | 0.762 |
| skein / off | 16 | 73.7k | 21.1k | 3.9k | 0.9k | 69 s | 0.641 |
| opencode / on | 8 | 68.9k | 3.1k | 2.0k | 0.8k | 74 s | ≈0.215 |
| opencode / off | 7 | 58.7k | 3.1k | 1.9k | 0.6k | 55 s | ≈0.205 |

Итог: Skein **4.17 ₽**, opencode **≈1.23 ₽**; вся матрица ≈5.40 ₽ (включая один reward0).

### 4.3 Наблюдения

- 11/12 `reward=1`. Промах — реальная ошибка агента, а не харнесса: `opencode off r2`
  записал SHA-256 fingerprint **без двоеточий** (`tr -d ':'`), а verifier требует пары
  hex через двоеточие — остальные пять проверок прошли.
- **Fresh input:** opencode ~3k против 19–28k у Skein (в 7–9 раз меньше); output и reasoning
  тоже в 2–3 раза меньше. Задача — Construction из спецификации, и opencode идёт почти сразу
  к артефакту.
- **Стоимость:** по одним ставкам opencode здесь дешевле в ~3–3.7 раза (медиана ≈0.21 против
  0.64–0.76 ₽) — в отличие от regex-log, где на `on` был паритет.
- **Ходы:** Skein 12–20 против 6–9 у opencode; у Skein медиана `on` выше `off` (19 против 16),
  но это шум при K=3 (r3 понадобилось 12 ходов).
- **Оговорка:** K=3; декларативный acceptance строг к формату, поэтому одна описка стоит
  всего reward.

## 5. Как добавить задачу

```sh
npx tsx tests/sandbox/matrix.ts <task> --agents skein,opencode --nets on,off \
  --repeat 3 --concurrency 6 --timeout 1200
```

Затем добавить раздел `§N. <task>` с таблицами по ячейкам и медианами, пересчитать ставки по
Skein-ячейкам этой задачи и обновить §2. Убитая ячейка оставляет `.timeout`; повтор —
тем же вызовом с `--resume`.
