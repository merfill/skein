# fix-ocaml-gc — прогон 2026-10-05: правки дня и вскрытый дефект фокуса

> Английское зеркало — `docs/benches/fix_ocaml_gc_run_report_2026-10-05.md`.

Связанные: `docs/benches/fix_ocaml_gc_run_report_ru.md` (предыдущий прогон),
`docs/benches/fix_ocaml_gc_run_report_2026-10-04_ru.md` (разбор застревания на `locate`),
`docs/ir_semantics_ru.md` (§2.6 обход, §2.8 сводка вызовов, §8 проекция),
`docs/projection_ru.md`, `docs/tools_ru.md`.

Прогон: `bash bench/harbor/run.sh -d terminal-bench -i fix-ocaml-gc -k 1`.
Job: `~/.skein-bench/harbor/2026-10-05__21-34-49`, триал `fix-ocaml-gc__UciLYSJ`.
Прогон **прерван вручную на фазе verifier** → `reward` не получен.

---

## 1. Итог

| Метрика | Значение |
|---|---|
| ходы агента | 60 (≈9 мин, 21:35→21:43), `stopReason=max_turns` |
| input / output tokens | 714 272 / 8 240; cache read 367 360 |
| контекст | first 777, peak 32 541, last 6 612 |
| граф | createGoal 14, complete 6, **edits 1**, checks 5, goals 11, plans 11, alternatives 1, actions 32 |
| verifier | прерван на `make clean && ./configure && make -j4` (полная сборка OCaml в контейнере, таймаут задачи ×2) |
| reward | не получен (прерывание) |

Прогон **не завис**: агент закончил за 9 минут; долгой была фаза verifier (сборка
OCaml). Прерывание убило verifier до вердикта. Но даже при досчёте был бы **0**:
единственная правка неверна (§3).

## 2. Что изменено в движке и промте в этот день

Предыдущий разбор (`docs/benches/fix_ocaml_gc_run_report_2026-10-04_ru.md`) показал, что модель
теряет смысл ошибки и зацикливается. Внесено:

1. **stderr отдельно от stdout.** `workspace.run` (`src/tools/workspace.ts`) переведён на
   `spawnSync`; `CommandResult = {code, stdout, stderr}`. Потоки не склеиваются.
2. **Раздельное хранение и показ.** `src/tools/index.ts`: `run`/`check` кладут `output`
   и `error` отдельными полями; полное тело — за `outputRef`/`errorRef`; `resolveBody`
   отдаёт полное тело для `query`, inline-обрезок — для `shown`. `ResultView.error`,
   `lastResult`/`query`/`shown` показывают потоки раздельно (`src/ir/project.ts`).
3. **`calls.note` из stderr** по строгому правилу «последняя строка краха → ошибки →
   непустая» (больше не ловит `-fno-exceptions`).
4. **Промт запрещает склейку потоков** (`2>&1`, `&>`), `src/loop/propose.ts`.
5. **Видимость отказа на корне.** Область `calls` = поддерево выбранной интерпретации
   **∪ текущий путь** (`src/ir/project.ts`), поэтому `repeat_hypothesis` на запросе
   виден (инвариант 21).
6. **Согласованные тексты повторов** (`src/loop/classify.ts`): если тело уже в `shown` —
   «use the body there»; иначе — «query {id}». Это разрывает петлю `read → query → read`.
7. **Материализация при провале `edit`** (`src/tools/index.ts`): наблюдение-сбой несёт
   текущее содержимое файла, и оно пиннится в `shown` (`ExecOutcome.pin`,
   `src/loop/graph.ts`).
8. **Реакция на «неверный корень»** (промт): отказ «путь/цель не найдены» — это неверный
   рабочий каталог; пересоздать интерпретацию/цель с префиксом `cd <dir> &&`.

## 3. Траектория прогона

- **T1–T4:** модель сразу читает `HACKING.adoc`, не находит в корне, `list`, читает
  `ocaml/HACKING.adoc`. cwd-реакция **сработала**: дальнейшие check-команды —
  `cd ocaml && ./configure && make` и `cd ocaml && make -C testsuite one DIR=tests/basic`.
- **T5–T6:** `cd ocaml && ./configure && make` → сегфолт в `camlinternalFormatBasics.cmi`;
  воспроизведение закрыто.
- **T7–T13:** локализация в `ocaml/runtime/shared_heap.c`; на T13 диагноз верный:
  «merge branch advances p by `wh*Wosize_hd(hd)` then again by `Whsize_hd(hd)`,
  double-counting».
- **T14–T17:** создана fix-цель; **T17 — единственная правка**, и она неверна:
  ```
  find:    ... } else { release_to_global_pool = 0; }  p += Whsize_hd(hd);
  replace: ... } else { release_to_global_pool = 0;  p += Whsize_hd(hd); }
  ```
  То есть `p += Whsize_hd(hd);` перенесена внутрь `else` (live-ветки), а надо было на
  строке 650 заменить `Whsize_hd(hd)` на `wh` (`p += wh;`). Диагноз верный, правка — нет.
- **T18–T19:** проверки fix-цели и корня: timeout (`inconclusive`) и fail.
- **T20–T31: петля `unknown_revision` ×12** (см. §4).
- **T33–T44:** борьба с `Text file busy` при копировании `boot/ocamlrun` (stale-процесс).
- **T45–T59:** повторный заход reproduce→locate, снова `Text file busy`; бюджет исчерпан.

Итог: задача не решена; блокер — **неверная правка**, а не петли.

## 4. Вскрытый дефект: фокус под опровергнутым предком

На T20–T31 фокус застрял на 12 ходов:

```
path        = r1:open > w:goal:2:REFUTED > w:goal:370:open > w:goal:375:open
applicable  = [create_goal, apply]        // return НЕ предлагается
checkReady  = true
```

Модель хочет пересоздать интерпретацию у корня (`create_goal` c `revises:[w:goal:2]`),
но движок оценивает текущую точку как `w:goal:375` (не refuted) → отказ
`unknown_revision` — 12 раз подряд. Отказ **виден** в `calls` (R6 работает), но
допустимого хода нет: `revises` легален только в refuted-точке, а `return` не предложен.

**Причина.** `focusEvents` (`src/ir/traversal.ts`) всплывает, только когда **верхушка**
закрыта. Если же refuted предок (`w:goal:2`), а верхушка — открытый потомок
(`w:goal:375`), стек не обрезается, и потомки опровергнутой интерпретации остаются
фокусом. Инвариант 17 говорит «закрытая цель не остаётся фокусом»; следует расширить:
**и её потомки**.

**Предлагаемый фикс (не внесён).** В `focusEvents`: если текущий узел открыт, но среди
его предков (ветка без корня-запроса) есть закрытый — сделать `return`. Тогда ветка
обрезается до `r1`, `applicable=[create_goal]`, и модель может предложить исправленную
интерпретацию. Общее исправление, с офлайн-тестом на `focusEvents`.

## 5. Тесты (состояние на 2026-10-05)

- Offline: `npm run typecheck` чист; `SKEIN_LIVE=false npx vitest run` — **127 passed**
  (добавлены `tests/tools.test.ts`, `tests/prompt.test.ts`, кейсы в `tests/ir.test.ts`,
  `tests/loop.test.ts`).
- Live:
  - `tests/live/scenarios.test.ts` — 16/16;
  - `tests/gate.test.ts` — 4/4;
  - `tests/live/fix_ocaml_step.test.ts` — 3/3 (`build-failure`, `wrong-cwd`,
    `refuted-and-refusal`) на сохранённых контекстах fix-ocaml-gc;
  - `wrong-cwd` подтверждает реакцию: модель выдаёт
    `create_goal { done_when: "cd ocaml && make -C testsuite one DIR=tests/basic" }`.

## 6. Что дальше

1. **Фикс `focusEvents`** (обрезать ветку под закрытым предком) + офлайн-тест — убирает
   12 холостых ходов; на reward не влияет.
2. **Правка vs диагноз.** Главный блокер — качество правки: модель называет верный
   инвариант, но выбирает не ту строку. Это про рассуждение о коде, не про движок;
   тема для отдельного разбора (например, требование прочитать точное место и
   проверить арифметику перед `edit`).
3. **Verifier долгий** (полная сборка OCaml). Для получения `reward` прогон нужно
   доводить до конца (до ~1–2 ч) либо заранее договориться о приёмке.
