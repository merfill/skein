# fix-ocaml-gc — прогон 2026-10-06: решено (reward 1.0)

> Английский оригинал — `docs/fix_ocaml_gc_run_report_2026-10-06.md`.

Связанные: `docs/fix_ocaml_gc_run_report_2026-10-05_ru.md` (дефект фокуса),
`docs/plans/engine_fixes_found_ru.md` (план, который его закрыл),
`docs/plans/fix_ocaml_gc_investigation_ru.md` (журнал прогонов),
`docs/fix_ocaml_gc_ideal_ru.md` (эталон формы), `docs/tools_ru.md`,
`docs/ir_semantics_ru.md`.

Прогон: `harbor run --config /tmp/opencode/accept.yaml -y` — Flash +
reasoning `high`, `maxTurns 60`, `override_cpus: 4` / `override_memory_mb: 6144`.
Две попытки, обе 2026-10-06:

| Job | триал | когда | движок | reward |
|---|---|---|---|---|
| `~/.skein-bench/harbor/2026-10-06__10-57-47` | `fix-ocaml-gc__Lr6THZi` | утро | с `need` | **1.0** |
| `~/.skein-bench/harbor/2026-10-06__14-53-22` | `fix-ocaml-gc__a48xRKy` | день | после удаления `need` (P4) + P5/P6 | **1.0** |

Обе закончились на `max_turns`, но верификатор подтвердил фикс в каждом:
`make -C testsuite one DIR=tests/basic` → **`40 tests passed`**.

---

## 1. Итог

| Метрика | 10-57-47 | 14-53-22 |
|---|---|---|
| reward | **1.0** (`40 tests passed`) | **1.0** (`40 tests passed`) |
| ходы агента | 60, `stopReason=max_turns` | 60, `stopReason=max_turns` |
| стена (агент / верификатор) | ~26 мин / ~9 мин | ~34 мин / ~5 мин |
| input / output tokens | 1 141 150 / 342 242 | 1 232 482 / 411 240 |
| cache read | 639 232 (56.0%) | 660 608 (53.6%) |
| контекст first / peak / last | 777 / 37 587 / 23 564 | 777 / 41 277 / 29 467 |
| граф | createGoal 7, complete 6, **edits 1**, checks 2, goals 8, plans 8, alternatives 1, actions 41 | createGoal 7, complete 8, **edits 1**, checks 2, goals 10, plans 10, alternatives 10, actions 36 |
| ход правки | 29 | 53 |

Стена всей задачи — ~36 мин (07:57Z→08:33Z) и ~39 мин (11:53Z→12:32Z);
`override_cpus: 4` сократил `make -j4` верификатора с прежних ~2 ч до <10 мин (P3.1).

## 2. Что изменилось с 2026-10-05

Прогон 2026-10-05 сделал одну неверную правку за 60 ходов и потерял бюджет в петле
`unknown_revision`. Исправления (детали: `docs/plans/engine_fixes_found_ru.md`):

- **P0** — reasoning включён (дефолт `reasoningEffort="high"`, `maxTokens=8192`):
  решающий фактор (F1). С выключенным reasoning модель строку 650 не трогала.
- **S1–S3** — фокус обрезается под закрытым предком; closing move действует только
  на узел в фокусе; повторная проверка после `inconclusive` разрешена.
- **P1** — диагностика падения: `signal`/`core`/`backtrace` доходят до проекции
  (`src/tools/crash.ts`).
- **P2** — проекция удерживает потерянное: ноты `complete`, diff правки
  `-find +replace`, результаты **всех уровней ветки**.
- **P3.1/P3.3** — контейнеру 4 CPU / 6 GB, а `run {background}` + `{job}` позволяют
  агенту собрать и подтвердить фикс, не блокируя ход.
- **P4** — `need` удалён: докса больше не формирует контекст; рабочее множество
  принадлежит движку (уровни ветки) плюс `query {id}` (TTL).
- **P5/P6** — отказ называет ход по фокусу (`focusHint`), промт удерживает фокус.

## 3. Траектория

Оба прогона называют дефект в `pool_sweep` (сдвиг курсора использует
`Whsize_hd(hd)` вместо `wh`) и делают эталонную однострочную правку:

```
find:    ... } release_to_global_pool = 0; }  p += Whsize_hd(hd);  } while (p + wh <= end);
replace: ... } release_to_global_pool = 0; }  p += wh;              } while (p + wh <= end);
```

- **10-57-47** (с `need`): правка на ходу 29; дальше бюджет ушёл в перечитывания /
  опрос; 6 из 8 отказов были `need` с id без тела.
- **14-53-22** (после P4/P5/P6): `locate` закрыт на ходу 45, правка на ходу 53,
  затем **фоновый** bootstrap-build (`job-2`, P3.3) и его опрос (ходы 56–57) перед
  чеком fix-цели (ходы 58–59). Удаление `need` не сломало live-путь.

В обоих правка внесена к моменту `max_turns`; затем верификатор пересобирает начисто
и проходит. Остаток бюджета уходит на долгую сборку, а не на неверные ходы — форма
траектории теперь соответствует `docs/fix_ocaml_gc_ideal_ru.md`.

## 4. Проверка

- Офлайн: `npm run typecheck`; `SKEIN_LIVE=false npx vitest run` —
  **141 passed / 22 skipped**.
- Live-сценарии (reasoning вкл): `two-outputs` и `retrieve-at-scale` проходят;
  `retrieve-at-scale` достаёт большое тело через `query obs:41`.
- Приёмка: два прогона выше; читать
  `~/.skein-bench/harbor/<ts>/<trial>/verifier/{reward.txt,test-stdout.txt}`.

## 5. Что дальше

1. Сократить холостые ходы до правки (локализация — 45 ходов в 14-53-22), чтобы
   прогон останавливался *до* `max_turns` и успевал самопроверку в бюджете.
2. Верификатор всё ещё ~5–9 мин; оставить `override_cpus: 4`.
3. `P3.2` (быстрый прокси-reward) остаётся отложенным — инфраструктура на
   внутренностях Harbor, не работа над движком.
