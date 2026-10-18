# Skein — каталог 13 задач и траектории opencode/Skein (2026-10-18)

> Рабочий документ. Русский, без EN-зеркала; не индексируется в `docs/README.md`.
> Это **основание** для `docs/states_ru.md`: 13 задач, их траектории в opencode и Skein,
> reasoning по состояниям и классы, на которые опирается целевой набор состояний.
>
> Данные: opencode — Harbor job `2026-09-26__11-50-39` (13 задач, одна модель); Skein — прогоны
> `bench/runs/sandbox-tasks/` до 2026-10-18 13:15. Траектории ниже — поведение **старого**
> набора четырёх состояний; `research`/`recovery`/`construction` реализованы после сбора данных.
> Документ описывает наблюдаемое поведение, а не текущую реализацию.

## 0. TL;DR

- 13 задач делятся на четыре класса: **Repair**, **Recovery**, **Construction/Translation**,
  **History/Hybrid**.
- Абстракция четырёх состояний подняла success (cobol 2/5→5/5, fix-code 3/5→5/5,
  password 4/5→5/5, db-wal 3/5→5/5, crack 0/5→3/3), но **перенесла исследование в Patch**:
  fix-ocaml — 93% reasoning в Patch, password — 83%, cobol — 65%, crack — 69%.
- Причина: `Localization` закрывается на «target named», не требует причины/метода. Patch
  вынужден заново выводить причину (fix-ocaml) или делать восстановление/перевод
  (password, cobol).
- Вторая причина: ручной перебор. Password Skein вручную собрал первую пару фрагментов и
  записал её без CRC; если бы пара была неверной, механизма перебора не было. Opencode CRC
  использовал, но ad hoc одной командой; при тысячах пар контекст бы распух.
- Предложение (детали — `docs/states_ru.md`): разделить эпистемические состояния по типу
  результата (**Localization** — указатель на артефакт; **Research** — описание ситуации и
  метод) и продуктивные — по цели (**Patch** — правка артефакта; **Recovery** — восстановление
  скрытых данных скриптом-перебором; **Construction** — новый артефакт/программа).
  Recovery/Construction включают acceptance в свой критерий; Patch идёт в Verification.

## 1. Метод и данные

### 1.1 Источники

- `~/.cache/harbor/tasks/*/<task>/instruction.md` — 13 инструкций.
- `~/dev/skein-plugin/pilot/harbor/jobs/2026-09-26__11-50-39/` — opencode baseline:
  `agent/opencode.txt` (step_finish/tool_use/reasoning), `result.json` (`agent_result`).
- `bench/runs/sandbox-tasks/` — Skein: `metrics.json` (`turns`, `totals`, `perTurn`),
  `contexts.ndjson` (state markers), `reasoning.ndjson`, `result.json` (events/stop).
- `docs/benches/best_bench_ru.md` — сводки батчей (для старых/новых сравнений).

### 1.2 Оговорки

- Opencode запускался в Harbor/Docker с сетью; Skein — в локальном sandbox. Это не
  контролируемый A/B по harness, но траектории и reasoning сопоставимы по модели и задачам.
- Skein-прогоны 2026-10-18 имеют разный бюджет: старый батч `06-*` — 24 хода, новые — 40.
- Для 6 задач (fix-git, git-leak, modernize, openssl, regex, custom-memory) последние доступные
  Skein-трассы — старый промт (`06-*`) или старая архитектура (10-08). Они помечены.
- `custom-memory-heap-crash` не перегонялся с текущим промтом; opencode тоже reward 0. Это
  единственная задача, по которой нет свежего вывода.
- Reasoning у opencode — `step_finish.tokens.reasoning`; fresh input = `n_input_tokens −
  n_cache_tokens`. У Skein — `totals.reasoningTokens`/`freshInput`.

### 1.3 Как считались состояния

`contexts.ndjson` каждого хода содержит маркеры `Start state X`/`Finish state X`; последний
маркер хода даёт состояние. `perTurn.reasoningTokens` суммируется по состояниям. `result.json`
даёт `move`/`stop`/`why` для последовательности. Для старых прогонов без островов состояния
не размечались (`request`).

## 2. Сводка

### 2.1 Шаги, reasoning, токены

Skein — репрезентативный успешный прогон на задачу; opencode — Harbor baseline.

| задача | класс | Skein шаги | Skein rea | Skein fresh | Skein ₽ | oc шаги | oc rea | oc fresh | oc cache |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| fix-ocaml-gc | Repair | 29 | 7 878 | 45 573 | 1.684 | 36 | 12 789 | 38 852 | 1 266 944 |
| fix-code-vulnerability | Repair | 20 | 1 659 | 20 693 | 0.687 | 8 | 830 | 12 661 | 84 480 |
| custom-memory-heap-crash | Repair | 23* | 36 475* | 90 592* | 7.015* | 17 | 6 750 | 11 112 | 294 912 |
| password-recovery | Recovery | 25 | 4 331 | 25 355 | 1.012 | 15 | 4 820 | 7 686 | 174 080 |
| db-wal-recovery | Recovery | 26 | 1 473 | 19 221 | 0.720 | 20 | 5 633 | 46 414 | 571 264 |
| crack-7z-hash | Recovery | 28 | 1 924 | 25 400 | 0.819 | 13 | 1 413 | 9 532 | 176 896 |
| fix-git | History | 19* | 919* | 13 984* | 0.467* | 9 | 643 | 9 463 | 82 560 |
| git-leak-recovery | Hybrid | 18* | 663* | 9 625* | 0.375* | 6 | 325 | 1 744 | 49 408 |
| log-summary-date-ranges | Construction | 19 | 1 484 | 17 702 | 0.658 | 6 | 240 | 6 913 | 68 992 |
| cobol-modernization | Construction | 30 | 7 704 | 38 757 | 1.713 | 32 | 24 652 | 12 728 | 903 808 |
| modernize-scientific-stack | Construction | 19* | 141* | 17 461* | 0.564* | 6 | 325 | 3 456 | 59 264 |
| openssl-selfsigned-cert | Construction | 19* | 712* | 9 959* | 0.422* | 14 | 954 | 3 132 | 130 304 |
| regex-log | Construction | 16* | 14 821* | 13 281* | 1.469* | 4 | 9 826 | 1 571 | 62 976 |

`*` — старый промт/архитектура; не прямое сравнение с новым.

Skein «шаги» — LLM-ходы, включая `move`/`stop`; у opencode — agentic steps. Протокол Skein
(обычно ~5–6 `move` + ~5–6 `stop`) — заметная часть ходов.

### 2.2 Reasoning по состояниям (Skein, успешные прогоны)

| задача | O | L | P | V | Finish | Ключевое |
|---|---:|---:|---:|---:|---:|---|
| fix-ocaml-gc | 162 | 255 | **7 362** | 93 | 0 | причина в Patch |
| fix-code-vulnerability | 98 | **890** | 595 | 76 | 0 | причина в L |
| password-recovery | 108 | 123 | **3 580** | 388 | 0 | восстановление в P |
| db-wal-recovery | 166 | 323 | **629** | 355 | 0 | decode в P; два P/V цикла |
| crack-7z-hash | 159 | 316 | **1 329** | 60 | 0 | solver в P |
| log-summary | 291 | 453 | 430 | 222 | 0 | CSV в P; пересчёт в V |
| cobol-modernization | 116 | 2 162 | **4 997** | 405 | 24 | перевод в P |
| fix-git* | 247 | 281 | 320 | 42 | 0 | merge в P |
| git-leak* | 471 | 13 | 125 | 54 | 0 | recover+purge в P |
| modernize* | 24 | 45 | 68 | 4 | 0 | новый скрипт в P |
| openssl* | 204 | 158 | 235 | 33 | 82 | новые файлы в P |
| regex* | 40 | **6 935** | **7 387** | 223 | 0 | дизайн в L, запись в P |

`*` — старый промт. Главный сигнал: в repair (`fix-ocaml`) и в ситуациях (`password`, `cobol`,
`crack`) почти вся работа уходит в Patch; в `fix-code` — наоборот, L несёт причину, и Patch
маленький. Это и есть разница между «найти артефакт + причину» и «сделать всю работу в Patch».

### 2.3 Классы и маршруты

| класс | задачи | маршрут |
|---|---|---|
| Repair | fix-ocaml-gc, fix-code-vulnerability, custom-memory-heap-crash | `O → L → P → V` |
| Recovery | password-recovery, db-wal-recovery, crack-7z-hash | `O → R → Recovery → Finish` |
| Construction | regex-log, openssl, log-summary, cobol, modernize | `O → R → Construction → Finish` |
| History | fix-git | `O → L → P → V` (Research опционально) |
| Hybrid | git-leak-recovery | `O → R → Recovery → P → V → Finish` |

`O` — Orientation, `L` — Localization, `R` — Research, `P` — Patch, `V` — Verification.

## 3. Каталог задач

### 3.1 fix-ocaml-gc — Repair

- **Запрос:** изменения в OCaml GC (RLE free space) сломали bootstrap; починить; сборка по
  `HACKING.adoc`; `make -C testsuite one DIR=tests/basic`.
- **Материал/приёмка:** `/app/ocaml`, без git; сборка `./configure && make`; приёмка — testsuite
  (40 тестов).
- **Opencode (36 шагов, rea 12 789):** git нет; читает `runtime/`, затем **идёт в upstream**:
  находит PR #13616, сравнивает `shared_heap.c`, видит одну строку `p += Whsize_hd(hd)` вместо
  `p += wh`; edit; configure/make; testsuite. Сеть — легитимный oracle в этом прогоне.
- **Skein (08-59-14, 29 ходов, rea 7 878, 1.684₽):**
  `O(6/162) → L(6/255) → P(8/7362) → V(7/93) → Finish`.
  L называет `pool_sweep` (543–676) и исключает siblings, но **не выводит причину**.
  P читает 4 файла, разбирает `Whsize_hd` vs `wh`, приходит к двойному шагу, делает edit.
  V: `make -C testsuite one DIR=tests/basic` — 40 passed.
- **Наблюдение:** L сделала указатель, P — диагностику. Это ровно потерянная причина: старый
  Localization ставил диагноз, текущий — нет. Если L снова требует причину, P становится
  маленьким, как в fix-code.

### 3.2 fix-code-vulnerability — Repair

- **Запрос:** найти CWE-уязвимость в `bottle.py`, написать `report.jsonl`, починить, `pytest`.
- **Материал/приёмка:** `/app`, git-репозиторий, `bottle.py`, `test/`; приёмка — `pytest -rA` +
  внешняя проверка отчёта.
- **Opencode (8 шагов, rea 830):** `git diff` показывает удалённые проверки CRLF/NUL в
  `_hkey`/`_hval`; восстанавливает, пишет отчёт, `pytest` — 367 passed.
- **Skein (13-10-24, 20 ходов, rea 1 659, 0.687₽):**
  `O(4/98) → L(4/890) → P(7/595) → V(3/76)`.
  L: `_hkey`/`_hval` потеряли `ValueError`; siblings исключены. P: восстановление + отчёт.
  V: `pytest -rA` — 367 passed.
- **Наблюдение:** правильная форма repair: причина в L, Patch маленький. Старый false pass
  (`report.jsonl` отсутствовал) закрыт проверкой отчёта в V.

### 3.3 custom-memory-heap-crash — Repair

- **Запрос:** программа падает в RELEASE, но не в DEBUG; править только `/app/user.cpp`; две
  версии libstdc++; без утечек по valgrind.
- **Материал/приёмка:** `/app/main.cpp`, `user.cpp`, `user.h`, `/build/` (исходники
  libstdc++), gcc-custom; приёмка — compile/run + valgrind.
- **Opencode (17 шагов, rea 6 750, reward 0):** читает `main/user/user.h`, патчи libstdc++,
  собирает release/debug, gdb; гипотеза о static facet destruction и custom heap; пишет
  `user.cpp`; valgrind без definite leaks. Verifier всё равно 0 — задача осталась нерешённой.
- **Skein (10-08, старая архитектура, 23 хода, rea 36 475, 7.015₽, reward 0):** разметки
  состояний нет; огромный reasoning.
- **Наблюдение:** нет свежего прогона с текущим промтом. По семантике это repair:
  `O → L (user.cpp / static destruction cause) → P → V (compile/valgrind)`. Нужен live-прогон,
  иначе вывод о состояниях для этой задачи — предположение.

### 3.4 password-recovery — Recovery

- **Запрос:** восстановить пароль удалённого `launchcode.txt`; формат `PASSWORD=`,
  23 символа, `8XD…W54`, uppercase/цифры; писать кандидатов в
  `/app/recovered_passwords.txt`.
- **Материал/приёмка:** `/app/varsea`, 4 MiB образ `ae3f4c.dat`; внешний verifier проверяет
  файл и точный пароль; объявленные ограничения — в запросе.
- **Opencode (15 шагов, rea 4 820):** находит `PASSWORD=8XDP5Q2RT9Z` на ~1 MiB, decoy `8XD` на
  ~2.5 MiB, хвост `K7VB3BV4WW54` на ~3 MiB; берёт CRC из ZIP central directory
  (`0xb0725dc4`), собирает кандидата, CRC совпадает, пишет файл. Скрипт — ad hoc one-liner.
- **Skein (09-07-40, 25 ходов, rea 4 331, 1.012₽):**
  `O(4/108) → L(4/123) → P(12/3580) → V(3/388)`.
  L находит образ; P вручную собирает первую пару фрагментов
  `8XDP5Q2RT9Z + K7VB3BV4WW54`, пишет файл; **CRC не считает**.
  V проверяет только формат (`cat`, `awk`, `grep`); grep-паттерн ошибочен (16 средних вместо
  17), модель это замечает и всё равно закрывает: «my own stricter check, not a declared
  constraint».
- **Наблюдение:** P делает research + recovery; V слабая. Если первая пара неверна, у Skein нет
  механизма перебора. Нужен Research (ситуация/метод/source-проверка) + Recovery (скрипт перебирает
  пары, CRC, формат, negative control, пишет все совпадения) + acceptance внутри Recovery.

### 3.5 db-wal-recovery — Recovery

- **Запрос:** WAL повреждён/зашифрован; починить, чтобы SQLite читал все 11 записей; записать
  `/app/recovered.json` с записями, sorted by id.
- **Материал/приёмка:** `main.db` 8192 B, `main.db-wal` 16512 B; sqlite3/python; внешний
  verifier проверяет JSON.
- **Opencode (20 шагов, rea 5 633):** `sqlite3` удаляет WAL; находит **opencode snapshot**
  (`snapshot/global/...`, `core.worktree=/`), восстанавливает WAL из git-объекта, XOR 0x42,
  SQLite читает 11 записей, пишет JSON. Это ключевая находка про snapshot.
- **Skein (12-35-41, 26 ходов, rea 1 473, 0.720₽):**
  `O(5/166) → L(3/323) → P(9/629) → V(7/355)`, два P/V цикла:
  P декодирует WAL; V видит, что `recovered.json` отсутствует; второй P пишет JSON; V сверяет
  с БД. Checkpoint позволяет пережить удаление WAL.
- **Наблюдение:** L нашла WAL и даже XOR; P сделал decode; V поймала отсутствующий deliverable.
  Семантика — Research (WAL/кодировка/метод) + Recovery (decode/extract + acceptance). Если
  правится сам WAL как deliverable — это Patch; здесь deliverable — JSON.

### 3.6 crack-7z-hash — Recovery

- **Запрос:** создать `/app/solution.txt` со словом из `secret_file.txt` в `secrets.7z`.
- **Материал/приёмка:** `secrets.7z` 215 B, John the Ripper в `/app/john`; сеть нужна для
  p7zip; внешний verifier проверяет слово.
- **Opencode (13 шагов, rea 1 413):** ставит p7zip и `libcompress-raw-lzma-perl`, `7z2john`,
  `john` с wordlist → пароль 1998, распаковывает `honeybear`, пишет `solution.txt`.
- **Skein (13-14-51, 28 ходов, rea 1 924, 0.819₽):**
  `O(4/159) → L(4/316) → P(13/1329) → V(5/60)`.
  L называет архив и tooling; P ставит/запускает john, извлекает; V сравнивает.
- **Наблюдение:** P — solver; первые 5 прогонов упали `llm_error` из-за snapshot на
  root-owned файлах; best-effort фикс дал 3/3 завершившихся (2 abort). Нужен Research
  (архив/хэш/метод) + Recovery (john + extract + acceptance).

### 3.7 fix-git — History

- **Запрос:** найти потерянные изменения и влить в `master`.
- **Материал/приёмка:** `/app/personal-site` (git), dangling commit; внешний verifier сравнивает
  файлы сайта.
- **Opencode (9 шагов, rea 643):** `git reflog` → dangling `143acb6` «Move to Stanford»; merge,
  конфликт `about.md`, разрешает в пользу входящих изменений, commit.
- **Skein (06-23-59, старый промт, 19 ходов, rea 919, 0.467₽):**
  `O(4/247) → L(4/281) → P(6/320) → V(3/42)`.
  L находит dangling commit; P merge + конфликт; V проверяет.
- **Наблюдение:** артефакт — репозиторий/коммит; текущая схема L→P→V уже подходит. Research
  нужен, только если метод merge/конфликта неочевиден.

### 3.8 git-leak-recovery — Hybrid

- **Запрос:** восстановить секрет из истории, записать `/app/secret.txt`, вычистить секрет из
  репозитория, не трогая остальные файлы/сообщения.
- **Материал/приёмка:** `/app/repo` (git), unreachable blob; внешний verifier.
- **Opencode (6 шагов, rea 325):** `git reflog`/`fsck`, находит `secret[...]`, пишет
  `secret.txt`, `reflog expire + gc --prune=now`, сканирует объекты.
- **Skein (06-25-14, старый промт, 18 ходов, rea 663, 0.375₽):**
  `O(4/471) → L(4/13) → P(5/125) → V(3/54)`.
  L находит blob/commit; P пишет секрет **и** делает purge; V сканирует.
- **Наблюдение:** две разные операции в одном Patch. Нужно разделить: Recovery извлекает
  секрет, Patch делает purge, Verification проверяет оба.

### 3.9 log-summary-date-ranges — Construction

- **Запрос:** посчитать ERROR/WARNING/INFO по диапазонам дат, написать `/app/summary.csv`;
  reference date 2025-08-12.
- **Материал/приёмка:** `/app/logs`, 164 файла; внешний verifier проверяет CSV.
- **Opencode (6 шагов, rea 240):** `awk` по логам, считает bracketed severity, пишет CSV,
  сверяет matched lines (DEBUG игнорируется).
- **Skein (12-56-49, 19 ходов, rea 1 484, 0.658₽):**
  `O(4/291) → L(3/453) → P(6/430) → V(4/222)`.
  L описывает логи/формат; P пишет CSV; V независимо пересчитывает все 15 строк.
- **Наблюдение:** это construction/data aggregation, а не «поиск цели + патч». V здесь —
  пересчёт по тому же источнику; его можно включить в Construction (acceptance внутри
  состояния). Старый fail (`06-26-26-152`) закрылся за 6 шагов без наблюдения артефакта.

### 3.10 cobol-modernization — Construction/Translation

- **Запрос:** переписать `program.cbl` на Python; `.DAT` после `program.py` должны быть
  идентичны COBOL-прогону.
- **Материал/приёмка:** `/app/src/program.cbl`, `INPUT.DAT`, `data/*.DAT`, GnuCOBOL; внешний
  differential verifier.
- **Opencode (32 шага, rea 24 652):** читает COBOL, разбирает fixed records, компилирует и
  запускает COBOL, исследует partial-read/buffer behavior, пишет `program.py`, строит
  differential harness, доводит edge cases; восстанавливает данные.
- **Skein (13-08-41, 30 ходов, rea 7 704, 1.713₽):**
  `O(5/116) → L(7/2162) → P(10/4997) → V(6/405)`.
  L читает `PROCEDURE DIVISION`/record layouts; P пишет `program.py` 4805 B; V — differential
  на копиях.
- **Наблюдение:** P — comprehension + translation, а не «правка». L только указывает source.
  Нужен Research (семантика source/форматы/метод) + Construction (программа + differential
  harness/acceptance).

### 3.11 modernize-scientific-stack — Construction/Translation

- **Запрос:** переписать legacy Python 2.7 climate script на Python 3; создать
  `/app/analyze_climate_modern.py` и dependency file.
- **Материал/приёмка:** `/app/climate_analyzer/analyze_climate.py`, CSV, `config.ini`;
  внешний прогон.
- **Opencode (6 шагов, rea 325):** читает legacy/config/CSV, пишет modern script +
  `requirements.txt`, исправляет pandas `mean(dtype=...)`, запускает.
- **Skein (06-26-41, старый промт, 19 ходов, rea 141, 0.564₽):**
  `O(4/24) → L(4/45) → P(6/68) → V(3/4)`.
  L находит Py2-конструкции/файлы; P пишет новый скрипт; V запускает.
- **Наблюдение:** reasoning низкий, но семантика — construction/translation. P не правит
  legacy, а создаёт новый артефакт. Нужен Research + Construction.

### 3.12 openssl-selfsigned-cert — Construction

- **Запрос:** создать self-signed cert/key/PEM/verification и `check_cert.py` в `/app/ssl`.
- **Материал/приёмка:** пустой `/app`; openssl/python; внешний verifier.
- **Opencode (14 шагов, rea 954):** `genrsa`, `req -x509`, PEM, `verification.txt`,
  `check_cert.py`, `openssl verify`.
- **Skein (06-27-38, старый промт, 19 ходов, rea 712, 0.422₽):**
  `O(5/204) → L(3/158) → P(6/235) → V(3/33)`.
  L фиксирует пустой workspace; P создаёт файлы; V проверяет.
- **Наблюдение:** Patch сам пишет «No defect exists; the deliverables are new files» — это
  construction, не правка. Нужен Research (команды/поля/acceptance) + Construction.

### 3.13 regex-log — Construction/Synthesis

- **Запрос:** regex, который в строках с IPv4 находит последнюю дату `YYYY-MM-DD`; границы
  non-alnum; февраль до 29; писать `/app/regex.txt`; Python `re.findall(..., MULTILINE)`.
- **Материал/приёмка:** пустой `/app`; внешний verifier применяет regex.
- **Opencode (4 шага, rea 9 826):** проектирует regex, пишет `regex.txt`, пишет тест-харнесс,
  исправляет одно неверное ожидание.
- **Skein (06-29-13, старый промт, 16 ходов, rea 14 821, 1.469₽):**
  `O(5/40) → L(3/6935) → P(3/7387) → V(3/223)`.
  L reasoning прямо говорит: «the current state says "find the failure in the code" — that's
  a generic prompt. Actually there is no code; the task is just to write the regex». Дизайн
  regex идёт в L, запись — в P.
- **Наблюдение:** сильнейший пример Construction: артефакта-цели нет, есть спека и синтез.
  Текущие L/P вынуждают модель переинтерпретировать состояния. Нужен Research (требования/
  стратегия/оракул) + Construction (regex + harness/acceptance).

## 4. Поперечный анализ

### 4.1 Localization была слишком общей

В текущем промте критерий — «target named». Для кода этого мало: причина остаётся Patch. Факты:

- fix-ocaml: L 255, P 7 362 (93%);
- password: L 123, P 3 580 (83%);
- cobol: L 2 162, P 4 997 (65%);
- crack: L 316, P 1 329 (69%);
- regex: L 6 935 + P 7 387 — работа размазана между двумя состояниями с неверными именами.

В fix-code L 890, P 595 — там причина в L, и Patch маленький. Это подтверждает: если L требует
причину, Patch не переисследует.

### 4.2 Patch стал «состоянием на всё»

Patch сейчас означает «make the change the goal names». Под это подпадают:
- правка кода (fix-ocaml, fix-code);
- восстановление пароля (password);
- декодирование WAL (db-wal);
- крэк архива (crack);
- перевод COBOL→Python (cobol);
- создание сертификата (openssl).

Это слишком широко. Patch не может работать с ситуацией, у которой нет артефакта-цели.
Нужны Research (ситуация/метод) и Recovery/Construction (действие по ситуации/создание).

### 4.3 Ручной перебор не масштабируется

Password Skein: модель вручную собрала первую пару фрагментов и записала её; CRC не считала;
V проверила только формат. Если бы пара была неверной, механизма перебора не было. Opencode
использовал CRC, но ad hoc. При тысячах кандидатов диалоговый перебор переполняет контекст и
теряет начало. Recovery должен писать скрипт: перебор + source-проверка + компактный вывод +
negative control. Скрипт держит поиск вне ленты; модель видит «найдено 1 совпадение, CRC ok».

### 4.4 Acceptance и fake pass

- db-wal (старый): синтезировал WAL/значения; форма соблюдена, provenance — нет.
- log-summary `06-26-26-152`: закрылся за 6 шагов, артефакт объявлен готовым без наблюдения.
- fix-code `06-23-57`: `pytest` прошёл, `report.jsonl` отсутствовал — false pass.

Поэтому acceptance должен быть явным. Для Recovery/Construction он входит в критерий
состояния (source/spec check + negative control). Для Patch — в Verification (тесты/сборка).
«Скрипт сработал / файлы написаны» — не acceptance.

### 4.5 Opencode vs Skein

Opencode выигрывает шагами на construction/recovery:
- regex 4 vs 16, log 6 vs 19, password 15 vs 25, crack 13 vs 28, git-leak 6 vs 18.
- На repair Skein конкурентоспособен: fix-ocaml 29 vs 36 шагов и 7.9k vs 12.8k reasoning;
  fix-code 20 vs 8 шагов, но 1.7k vs 0.8k.
- Opencode несёт огромный cached context (fix-ocaml 1.27M cache, cobol 0.90M), Skein — меньше
  по total input, но больше fresh на некоторых задачах.
- Протокол Skein (~12 `move`/`stop` из 20–30 ходов) — часть цены; Construction/Recovery с
  acceptance внутри состояния должны сократить лишние переходы.

### 4.6 Старый vs новый промт (направленно, не A/B)

| задача | old rewards | old rea | new rewards | new rea |
|---|---:|---:|---:|---:|
| fix-ocaml | 5/5 | 47 325 | 4/5 | 57 808 |
| password | 4/5 | 25 463 | 5/5 | 35 908 |
| db-wal | 3/5 | 28 620 | 5/5 | 24 260 |
| log-summary | 4/5 | 4 765 | 5/5 | 7 819 |
| cobol | 2/5 | 21 581 | 5/5 | 55 369 |
| fix-code | 3/5 | 4 520 | 5/5 | 4 403 |
| crack | 0/5 | 24 769 | 3/3 | 6 631 |

Success вырос, но reasoning в cobol/log/password/fix-ocaml вырос; db-wal улучшился за счёт
checkpoint. Разные бюджеты (24 vs 40) и промты — это не контролируемое сравнение, но
направление совпадает с наблюдением: абстракция перенесла работу в Patch.

## 5. Mapping на целевые состояния

| задача | класс | маршрут | что делает ключевое состояние |
|---|---|---|---|
| fix-ocaml-gc | Repair | `O→L→P→V` | L: сайт + причина; P: одна строка |
| fix-code-vulnerability | Repair | `O→L→P→V` | L: `_hkey/_hval` + причина; P: restore |
| custom-memory-heap-crash | Repair | `O→L→P→V` | L: `user.cpp`/static destruction; P: fix; V: compile/valgrind |
| password-recovery | Recovery | `O→R→Recovery→Finish` | R: fragmentation/CRC/method; Recovery: script enumerate+check |
| db-wal-recovery | Recovery | `O→R→Recovery→Finish` | R: XOR/WAL/frames; Recovery: decode/extract JSON |
| crack-7z-hash | Recovery | `O→R→Recovery→Finish` | R: 7z/hash/john; Recovery: crack/extract |
| fix-git | History | `O→L→P→V` | L: dangling commit; P: merge |
| git-leak-recovery | Hybrid | `O→R→Recovery→P→V` | R: secret/purge method; Recovery: secret; P: purge |
| log-summary-date-ranges | Construction | `O→R→Construction→Finish` | R: log schema/ranges; Construction: CSV+recompute |
| cobol-modernization | Construction | `O→R→Construction→Finish` | R: source semantics/differential; Construction: Python+harness |
| modernize-scientific-stack | Construction | `O→R→Construction→Finish` | R: Py2→Py3 method; Construction: script+deps |
| openssl-selfsigned-cert | Construction | `O→R→Construction→Finish` | R: commands/fields; Construction: artifacts+verify |
| regex-log | Construction | `O→R→Construction→Finish` | R: strategy/source-check; Construction: regex+harness |

## 6. Выводы и следующие шаги

1. **Состояния реализованы** в `docs/states_ru.md` / `src/ir/islands.ts`: Localization (артефакт
   + причина), Research (ситуация + метод), Patch (правка артефакта), Recovery (скрытые данные),
   Construction (новый артефакт), Verification (для Patch/внешней приёмки), Finish.
2. **Recovery/Construction включают acceptance** в свой критерий; идут в Finish или Research.
   Отдельный Verification после них не нужен; для Patch он остаётся.
3. **Скрипт-перебор** — общий метод Recovery: enumerate + source check + compact output +
   negative control; не ручной перебор в диалоге.
4. **Валидация:** tape A/B на записанных прогонах (fix-ocaml t13/t14; password P; db-wal P;
   regex L; cobol P) + live 5×40. Метрики: reasoning по состояниям, turns, reward, fake-pass.
5. **custom-memory** и 6 задач на старом промте — перегнать с новым набором, прежде чем
   утверждать, что все 13 работают.
6. **Полный каталог** — этот документ; при изменении состояний обновлять §5.

## 7. Приложение: run dirs

- Opencode: `~/dev/skein-plugin/pilot/harbor/jobs/2026-09-26__11-50-39/<task>__*`.
- fix-ocaml: `bench/runs/sandbox-tasks/2026-10-18T08-59-14-909Z-fix-ocaml-gc`.
- password: `bench/runs/sandbox-tasks/2026-10-18T09-07-40-731Z-password-recovery`.
- db-wal: `bench/runs/sandbox-tasks/2026-10-18T12-35-41-566Z-db-wal-recovery`.
- log-summary: `bench/runs/sandbox-tasks/2026-10-18T12-56-49-838Z-log-summary-date-ranges`.
- cobol: `bench/runs/sandbox-tasks/2026-10-18T13-08-41-696Z-cobol-modernization`.
- fix-code: `bench/runs/sandbox-tasks/2026-10-18T13-10-24-215Z-fix-code-vulnerability`.
- crack: `bench/runs/sandbox-tasks/2026-10-18T13-14-51-864Z-crack-7z-hash`.
- fix-git*: `bench/runs/sandbox-tasks/2026-10-18T06-23-59-326Z-fix-git`.
- git-leak*: `bench/runs/sandbox-tasks/2026-10-18T06-25-14-883Z-git-leak-recovery`.
- modernize*: `bench/runs/sandbox-tasks/2026-10-18T06-26-41-815Z-modernize-scientific-stack`.
- openssl*: `bench/runs/sandbox-tasks/2026-10-18T06-27-38-992Z-openssl-selfsigned-cert`.
- regex*: `bench/runs/sandbox-tasks/2026-10-18T06-29-13-996Z-regex-log`.
- custom-memory*: `bench/runs/sandbox-tasks/2026-10-08T18-36-49-406Z-custom-memory-heap-crash`.

`*` — старый промт/архитектура.
