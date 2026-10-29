# Skein — состояния работы: цели и критерии приёмки

> Черновик. Заводим и уточняем по ходу обсуждения. Сначала — общее понятие состояния, затем —
> конкретные состояния. Цель документа: так описать предмет, цель и критерий каждого состояния,
> чтобы они не смешивались друг с другом и не «перетекали» одно в другое.
>
> Реализовано в `src/ir/islands.ts`: восемь состояний (`orientation`, `localization`,
> `research`, `patch`, `recovery`, `construction`, `verification`, `end`). Документ описывает
> их цели, критерии и маршруты. Live/tape-валидация: первый полный путь на `password-recovery`
> пройден (v2); остальные классы — впереди. Общие формулировки живут в `islands.ts`, уточнения —
> в подсказках запроса и перехода (`src/loop/prompt/blocks.ts`).
>
> См. также: `docs/prompt_state_machine_concept_ru.md` (граф состояний; §2.8 — состояние есть
> утверждение, а не действие), `docs/ir_semantics_ru.md` (§4.1 — состояние есть его цель),
> `docs/system_prompt_ru.md`, `docs/benches/best_bench_ru.md`,
> `docs/plans/task_catalog_2026-10-18_ru.md` (13 задач, траектории opencode/Skein, reasoning по
> состояниям), `tests/sandbox/specs/fix-ocaml-gc.ts` (уменьшенная модель задачи).

## 1. Понятие состояния

Состояние работы — это состояние знания, а не шаг и не команда. Модель находится в состоянии
тогда, когда выполнено его условие; закрывает состояние она сама, своим `stop`.

У состояния различают три вещи:

1. **Предмет** — то, над чем состояние работает: артефакт, ситуация, изменение, проверка.
2. **Цель** — какое знание должно быть приобретено.
3. **Критерий** — наблюдаемое условие, по которому видно, что цель достигнута и состояние можно
   закрыть.

Правила, по которым формулируются цель и критерий:

- **`done` — утверждение, а не приказ.** «Файл и строки названы», а не «найди файл»: критерий
  описывает состояние знания. А `what` — наоборот, цель состояния: что оно делает.
- **Проверяемость.** Критерий должен устанавливаться по ленте или по рабочему дереву. Что
  нельзя проверить, то не критерий, а лозунг.
- **Свидетельство — из дерева.** Запрос — это предположение, которое состояние обязано
  проверить, а не источник фактов. Сказанное в запросе может быть устаревшим или неверным.
- **Конкретное — это результат.** Какой именно файл, строка или команда — добывается внутри
  состояния и появляется в его итоге, а не задаётся заранее.
- **Предположения запроса — не критерий.** Область, подсистема и файлы, названные в запросе, —
  это предположения о предмете работы («вероятно, но не факт»); их проверяют по дереву, и они не
  становятся ни целью, ни критерием.

### 1.1 Два типа результата: артефакт и ситуация

Главная ось деления — **что является результатом состояния**:

- **Артефакт** — конкретная вещь, на которую можно указать: файл, несколько файлов, запись,
  образ, функция, коммит. Результат — указатель на неё с координатами.
- **Ситуация** — положение дел, у которого нет одного артефакта-цели: удалённые/закодированные
  данные, поведение legacy-программы, спецификация, история. Результат — **описание ситуации и
  метод**, а не указатель.

Отсюда два эпистемических состояния:

- **Localization** — найти артефакт (для дефекта кода — ещё и причину/нарушенный инвариант).
- **Research** — описать ситуацию и установить метод.

И два «продуктивных» состояния для ситуаций:

- **Recovery** — восстановить скрытые данные из источника, написав и запустив процедуру поиска.
- **Construction** — создать новый артефакт/программу из спецификации или поведения source.

`Patch` остаётся правкой **существующего артефакта**. Он не работает с ситуацией.

### 1.2 Acceptance

Acceptance — это то, по чему видно, что задача решена. Он бывает двух видов:

- **операционный** — команда/тест/сборка проекта (`pytest`, `make`, `valgrind`);
- **декларативный** — объявленные условия: путь, формат, точное значение, provenance,
  поведение.

Для `Patch` acceptance обычно внешний (тесты/сборка проекта), поэтому после него идёт
**Verification**. Для `Recovery` и `Construction` acceptance — та же source-проверка, которой
состояние уже пользуется, поэтому проверка входит **в критерий самого состояния**: оно идёт в
`End` при успехе и в `Research` при провале метода.

**Source-проверка** (в коде критерий — `matches what the material contains`) — сверка результата
с тем, что содержит материал: checksum, hash, container metadata, structural invariant или known
records. Это **не** declared form и **не** «кандидат буквально есть в байтах». Конкретную
проверку называет `Research`; `Recovery` её применяет.

Внешний verifier (Harbor/harness) — финальный судья, но он **не является состоянием Skein** и
модели обычно не виден. Внутри состояния модель делает сильнейшую доступную проверку и честно
называет её границы.

## 2. Конкретные состояния

> **Orientation result vs probe.** Orientation устанавливает входы и acceptance и даёт карту
> workspace (`root`, repo, entries/paths). Эта карта показывается в **Localization** и
> **Research** как `Orientation result`; другие состояния получают `Probe` (environment/tools)
> отдельным заголовком. Probe — сессионный факт; Orientation result — результат предыдущего
> состояния, не environment-бриф. Закрытые состояния и request-ход этих блоков не несут.

### 2.1 Orientation

- **Предмет:** материал и способ судить успех.
- **Цель:** назвать, где проект и что в нём есть, и какая приёмка объявлена в запросе.
- **`what`:** `name the workspace root, its top-level entries, the repository status, and the acceptance the request declares`
- **`done`:** `the material is known — what exists (files, records, images, a repository) — and
  how success is judged (an in-workspace command, an external verifier, or declared
  constraints); whether it is under version control is noted when relevant`
- **Предположения запроса:** область, подсистема, файлы — проверить по фактам, не принимать на
  веру.
- **Workspace map:** `root`, repo-статус (none или branch/head/dirty), top-level entries
  (для маленьких материалов — paths), число файлов. В Orientation не показываются
  environment, расширения, конфиги, команды сборки и build state: это не её цель.
- **Границы:** не ищет дефект, не воспроизводит сбой, не описывает ситуацию глубоко, не
  сверяется с upstream и не разбирает историю версий глубже VCS-статуса из probe. Сбой,
  замеченный по ходу, — в итог, не задерживаясь. Не пересказывает, не интерпретирует
  и не решает задачу; запрос — только источник acceptance. Не создаёт и не меняет файлы.
- **Переход:**
  - → **Localization**, когда запрос — найти ошибку в существующем коде или файлах;
  - → **Construction**, когда запрос полностью задаёт новый артефакт — его можно писать сразу;
  - иначе → **Research**.
- **Пример (fix-ocaml-gc):** корень `ocaml/`; сборка `./configure && make`, приёмка
  `make -C testsuite one DIR=tests/basic`; VCS — из material map → контроля версий нет.
- **Пример (password-recovery):** `/app` — tmpfs с `varsea`; VCS/сборки нет; успех — файл
  `/app/recovered_passwords.txt`.

### 2.2 Localization

- **Вход:** `Orientation result` — карта workspace (root/repo/entries/paths).
- **Предмет:** цель в существующем материале.
- **Цель:** найти цель.
- **`what`:** `find the target in the material`
- **`done`:** `the target is named — the file, record, image, or function — and a suspected
  cause is named — one exact expression, step, or encoding that conflicts with the source's own
  comment/invariant or with the sibling that performs the same operation`
- **Предположения запроса:** проявление и область — лиды, проверить чтением/осмотром. Файл,
  названный в `Finish state` предыдущего состояния, целью не становится: координаты добываются сами.
- **Границы:** не применяет правку (Patch), не воспроизводит сбой (Verification), не описывает
  ситуацию/метод (Research), не сверяется с upstream/эталоном. Сравнение с сиблингами — способ
  найти расхождение. Причину назвать как **предполагаемую** (unverified), **одну**: конкретное
  неверное выражение и конвенцию/инвариант сиблингов, который оно нарушает. Не доказывать её,
  точную правку не выводить — это работа Patch.
- **Переход:**
  - → **Patch**, когда цель названа, сиблинги исключены и названа предполагаемая причина
    (unverified);
  - → **Research**, когда выяснилось, что работа — ситуация, а не дефект кода для локализации
    (коррекция неверной стартовой классификации; допустима после честного `stop`, когда цель
    так и не названа). Обычного выхода в Research нет: если нужен метод/ситуация, штатный
    маршрут — `O → R`, а не продолжение Localization.
- **Пример (fix-ocaml-gc):** `runtime/shared_heap.c`, `pool_sweep`, строка ~650; предполагаемая
  причина — общий advance после free-ветки идёт по `Whsize_hd` вместо `wh`; exact change — Patch.
- **Пример (fix-code-vulnerability):** `bottle.py`, `_hkey`/`_hval`; предполагаемая причина —
  потеряны проверки CRLF/NUL; exact change — Patch.

### 2.3 Research

- **Вход:** `Orientation result` + `Probe` (interpreters/tools).
- **Предмет:** ситуация, у которой нет одного артефакта-цели.
- **Цель:** объяснить ситуацию и установить метод.
- **`what`:** `investigate the situation and establish the method`
- **`done`:** `the situation is explained — what happened, what the source does, or what must be
  built — and the method is named: the steps that will produce the result. The work itself
  belongs to the productive state`
- **Предположения запроса:** проявление, формат, инструменты — лиды; проверить по материалу.
- **Границы:** не ищет дефект в коде (его может не быть), не применяет правку (Patch), не
  восстанавливает и не строит deliverable (Recovery/Construction). Может осматривать артефакты,
  но результат — описание ситуации и метод, а не указатель. Метод — план, а не его исполнение:
  парсер/крекер/deliverable не строятся здесь. Источник определяется по содержанию, а не по
  внешнему виду; открывается только на копии в `/tmp`, если инструмент может его изменить.
- **Probe (environment subset):** `interpreters`, `tools` (core/crypto/data/archive/net/pkg),
  `missing` — то, чем можно писать probe. Карта материала (root/VCS/build) сюда не
  дублируется: она уже в `Finish state`-строке Orientation.
- **Переход:**
  - → **Recovery**, когда нужно восстановить скрытые/закодированные/удалённые данные;
  - → **Construction**, когда нужно создать новый артефакт/программу;
  - → **Localization**, когда выяснилось, что ситуация — это дефект кода для локализации
    (коррекция неверной стартовой классификации).
- **Пример (password-recovery):** файл удалён; в 4 MiB образе фрагментированный ZIP: local
  header на ~1 MiB, хвост данных на ~3 MiB; кандидат проверяется по CRC32; пароль — 23 символа,
  `8XD…W54`, uppercase/цифры.
- **Пример (db-wal-recovery):** WAL XOR-нут на `0x42`; после декодирования — валидный WAL с 4
  фреймами; проверка — SQLite `integrity_check` и конкретные записи.
- **Пример (crack-7z-hash):** 7z; хэш через `7z2john`; `john` с wordlist; проверка — распаковка
  архива.
- **Пример (regex-log):** кода нет; нужно синтезировать регулярку; стратегия — line-start
  lookahead + greedy prefix + один capture.
- **Пример (cobol-modernization):** семантика `PROCEDURE DIVISION` и формат записей; метод —
  дифференциальный прогон COBOL vs Python.
- **Пример (fix-git):** потерянный коммит в reflog/dangling objects; метод — merge и разрешение
  конфликта.

### 2.4 Patch

- **Вход:** `Workspace` — карта материала (root/repo/entries/paths).
- **Предмет:** существующий артефакт.
- **Цель:** внести полное изменение — найденный артефакт и остальные файлы, которые нужны задаче.
- **`what`:** `make the named change to the artifact`
- **`done`:** `the change is complete — the located artifact and every other file the task needs
  are created or updated — and the result has the declared form`
- **Границы:** изменение не ограничивается одним файлом: обязательный файл не откладывается до
  Verification. Не ищет артефакт (Localization), не описывает ситуацию/метод (Research), не
  восстанавливает скрытые данные (Recovery), не строит новый артефакт (Construction). Не
  повторяет откатанную попытку; не фабрикует значения.
- **Переход:** → **Verification**, когда всё изменение, включая остальные нужные файлы,
  применено и форма проверена.
- **Пример (fix-ocaml-gc):** `p += Whsize_hd(hd)` → `p += wh` в `pool_sweep`.
- **Пример (fix-git):** merge потерянного коммита в `master` с разрешением конфликта.
- **Пример (git-leak-recovery):** purge секрета из объектов/reflog после Recovery.

### 2.5 Recovery

- **Предмет:** ситуация со скрытыми/закодированными/удалёнными данными.
- **Цель:** восстановить данные из материала и записать требуемый output.
- **`what`:** `recover the required output from the material`
- **`done`:** `the required output exists in its declared form, is derived from the material, and
  matches what the material contains`
- **Метод:** **source-проверка** — сверка с тем, что содержит материал: checksum/hash,
  header/metadata, known record или собственный валидатор формата (archive test, database
  integrity check). Использовать её, чтобы сузить задачу до одного кандидата. Создавать и менять
  файлы можно — output, scratch-копии; read-only только сам материал. **Не перебирать кандидатов
  вручную в диалоге.** Формы кандидата недостаточно: результат должен совпадать с содержанием
  материала. Если методу нужен отсутствующий в PATH инструмент — **починить окружение**
  (пакетный менеджер/сеть), а не переписывать стандартный инструмент: отсутствие в PATH не
  доказывает, что поставить его нельзя.
- **Probe (environment subset):** `root`, `interpreters`, `tools`, `missing` — язык поиска и
  инструменты проверки. Карта материала не дублируется.
- **Границы:** материал — свидетельство, а не объект правки; не синтезировать значения; если
  deliverable — изменённый артефакт, это Patch. Поиск держится вне ленты: модель видит компактный
  результат, а не тысячи кандидатов. Кандидат, проходящий форму, но не совпадающий с материалом,
  отвергается.
- **Переход:**
  - → **End**, когда output записан и совпадает с тем, что содержит материал;
  - → **Research**, когда метод не сработал или результат не совпал с материалом (нет
    кандидатов, все отвергнуты);
  - остаться/повторить, когда ошибка исполнения (путь, формат, выбор кандидата);
- **Пример (password-recovery):** ZIP-структура и central directory/CRC сужают до одного
  кандидата (`PASSWORD=8XDP5Q2RT9ZK7VB3BV4WW54`).
- **Пример (db-wal-recovery):** скрипт перебирает декодирования/фреймы, проверяет SQLite
  integrity, извлекает записи и пишет `recovered.json`.
- **Пример (crack-7z-hash):** скрипт запускает `john` и извлекает `secret_file.txt`, затем
  пишет `solution.txt`.

### 2.6 Construction

- **Предмет:** новый артефакт/программа.
- **Цель:** создать артефакт из спецификации или поведения материала.
- **`what`:** `build the new artifact from the specification or the material's behaviour`
- **`done`:** `the artifact exists, is derived from the specification or the material's behaviour,
  and the acceptance check passes`
- **Метод:** написать артефакт и приёмочную проверку (тест-харнесс, дифференциальный прогон,
  `openssl verify`), прогнать, при провале — исправить или вернуться в Research.
- **Границы:** не правит исходный артефакт (Patch); материал — спецификация поведения, а не
  объект изменения; не подменяет проверку «файл создан».
- **Переход:**
  - → **End**, когда артефакт создан и проверка прошла;
  - → **Research**, когда метод/спека не сходятся;
  - остаться/повторить при ошибке исполнения.
- **Пример (regex-log):** `regex.txt` + харнесс на positive/negative строках.
- **Пример (cobol-modernization):** `program.py` + дифференциальный прогон против COBOL.
- **Пример (openssl-selfsigned-cert):** ключ/сертификат/PEM + `openssl verify` и проверка полей.
- **Пример (log-summary-date-ranges):** `summary.csv` + независимый пересчёт по логам.
- **Пример (modernize-scientific-stack):** новый скрипт + прогон на sample data.

### 2.7 Verification

- **Предмет:** изменённый артефакт после Patch.
- **Цель:** проверить его против acceptance задачи/проекта.
- **`what`:** `check the changed artifact against the goal's acceptance`
- **`done`:** `the acceptance command passes, or every declared condition holds and the result is
  derived from the source, not synthesized`
- **Границы:** не пишет acceptance и не строит проверку; исполняет готовую (проектную или
  внешнюю). Если acceptance внешний/скрытый, модель делает сильнейшую доступную проверку и
  честно называет границы. Проверка, читающая только свой output, — не acceptance.
- **Переход:**
  - → **End**, когда acceptance держится;
  - → **Patch**, когда изменение неверно, а объект тот же;
  - → **Localization**, когда объект/координаты в сомнении.
- **Пример (fix-ocaml-gc):** `make -C testsuite one DIR=tests/basic` → 40 passed.
- **Пример (fix-code-vulnerability):** `pytest -rA` + `report.jsonl`.
- **Пример (custom-memory-heap-crash):** release/debug + valgrind без утечек.

### 2.8 End

- **Предмет:** запрос.
- **Цель:** завершить работу.
- **Критерий:** запрос завершён; проверка уже сделана в закрытом состоянии — в End не
  перепроверять, инструментов нет; когда критерий держится — `stop`.
- **Переход:** терминальное состояние.

## 3. Маршруты

| класс | маршрут |
|---|---|
| **Repair** (fix-ocaml-gc, fix-code-vulnerability, custom-memory-heap-crash) | `O → L → P → V → End` |
| **Recovery** (password-recovery, db-wal-recovery, crack-7z-hash) | `O → R → Recovery → End` |
| **Construction** (regex-log, openssl-selfsigned-cert, log-summary, cobol, modernize) | `O → Construction → End` (spec-only) / `O → R → Construction → End` (когда источник надо понять) |
| **History** (fix-git) | `O → L → P → V → End` |
| **Hybrid** (git-leak-recovery) | `O → R → Recovery → P → V → End` |

`O` — Orientation, `L` — Localization, `R` — Research, `P` — Patch, `V` — Verification.

Рёбра `L ⇄ R` — **коррекционные**, не штатные: они нужны, когда стартовая классификация
`O → L`/`O → R` неверна (Localization выясняет, что работа — ситуация; Research — что это
дефект кода). Штатные маршруты выше их не содержат.

Пояснения:

- **Localization не обязательна для recovery**: Research сам назовёт артефакты, опишет ситуацию
  и выберет нужный. Маршрут — `O → R → Recovery → End`.
- **db-wal**: WAL — артефакт, но его проблема — ситуация (кодировка/фреймы), поэтому Research +
  Recovery; декодирование WAL входит в Recovery как инструментальная операция. Прогон
  2026-10-29 (K=3, `--turns 32`) показал, что маршрут не единственный: 2/3 решили через
  `O → L → P → V` (Patch декодирует WAL и пишет `recovered.json`, Verification принимает),
  1/3 — через `O → R → Recovery`; все три `reward=1`.
- **git-leak**: Recovery извлекает секрет; Patch делает purge; Verification проверяет и то, и
  другое. Это две разные операции, поэтому оба состояния.
- **fix-git**: потерянный коммит — артефакт; Localization находит его, Patch делает merge,
  Verification проверяет. Research нужен, только если метод merge/конфликта неочевиден.

## 4. Циклы и ошибки

- **Recovery/Construction:** acceptance не прошёл:
  - ошибка метода/source-проверки → **Research** с описанием ошибки;
  - ошибка исполнения (путь, формат, кандидат) → остаться в состоянии, исправить и повторить;
  - не тот объект/источник → **Localization**/Research.
- **Patch:** Verification не прошёл:
  - изменение неверно, объект тот же → **Patch**;
  - объект/координаты в сомнении → **Localization**.
- **Неверная стартовая классификация (`O → L` или `O → R`):**
  - Localization обнаружила ситуацию, а не дефект кода → **Research**;
  - Research обнаружил дефект кода → **Localization**;
  это коррекция рода работы, а не обычный выход: условие — «работа оказалась другого рода»,
  а не «пока не уверен».
- Ошибка едет на ленте в `Finish`-строках закрытых `Patch`/`Verification` (`why` упавшего
  состояния); отдельного блока `Previous failed attempt` текущая реализация не рендерит.
  Несколько попыток допустимо; гейта нет — модель решает.
- Если независимой source-проверки нет, состояние не закрывается «на веру»: честный стоп с указанием,
  что проверено и что нет.

## 5. Acceptance instrument

Когда задача не поставляет acceptance-команду, `Recovery`/`Construction` **сами** пишут и
запускают проверку как часть своей работы:

- Recovery — source-derived: checksum/hash/container metadata/structural invariant/known records;
- Construction — spec/source-derived: тест-харнесс, дифференциальный прогон, `openssl verify`.

Для `Patch` acceptance — отдельная процедура проекта (сборка/тесты), поэтому после него идёт
`Verification`.

Инструмент проверки **не является новым состоянием** и не является источником истины:
его автор — докса, source-проверка — из source/spec, внешний verifier — финальный. Скрипт обязан быть
независим от output, читать источник и deliverable, иметь negative control. Если такой
source-проверки нет, проверка не выдумывается.

## 6. Почему так (основания)

- **Localization была слишком общей.** В текущем промте она закрывается на «target named»;
  причину и метод заново выводит Patch. По прогонам 2026-10-18:
  - `fix-ocaml-gc`: Localization 255 reasoning, Patch 7362 из 7878 (93%);
  - `password-recovery`: Localization 123, Patch 3580 из 4331 (83%);
  - `cobol-modernization`: Localization 2162, Patch 4997 из 7704 (65%);
  - `crack-7z-hash`: Patch 1329 из 1924 (69%).
- **Модель сама замечает несоответствие.** В regex-прогоне: «there is no code; the task is just
  to write the regex. The state goals are generic». В openssl Patch: «No defect exists; the
  deliverables are new files». Это и есть ситуации, которым нужен Research/Construction.
- **Ручной перебор не масштабируется.** В password Skein вручную собрал первую пару фрагментов
  и записал её; проверки CRC не было. Если бы пара была неверной, механизма перебора не было
  бы. Recovery со скриптом перебирает кандидатов, проверяет source-проверкой и возвращает компактный
  результат; тысячи пар не попадают в контекст.
- **Fake pass — реальный риск.** db-wal синтезировал значения; log-summary объявил артефакт
  готовым без наблюдения; fix-code получил false pass при отсутствующем `report.jsonl`. Поэтому
  acceptance должен быть явным: для Recovery/Construction — в критерии состояния, для Patch —
  в Verification. «Скрипт сработал / файлы написаны» — не acceptance.

## 7. Открытые вопросы

1. **Реализация:** `research`, `recovery`, `construction` добавлены в `ISLAND_IDS`; обновлены
   `applies`/`next`, базовый промт, transition-инструкции и описания инструментов. Тесты —
   `348 passed`. Осталось: tape/live-валидация.
2. **Граница Construction/Recovery:** log-summary — Construction (видимые данные), db-wal —
   Recovery (скрытые). Проверить на живых прогонах, нет ли смешения.
3. **fix-git:** нужен ли Research для merge/конфликта или достаточно Localization + Patch.
4. **Можно ли фолдить Verification в Patch**, когда проект уже даёт тесты? Пока нет: это
   отдельная процедура; но вопрос открыт.
5. **Скрипт-перебор:** общий шаблон (перебор + source-проверка + компактный вывод + negative control)
   вынести в подсказку Recovery/Construction, не в код движка.
6. **Внешний verifier:** остаётся вне состояний; при отсутствии независимой проверки — честный
   стоп.
7. **Валидация:** tape A/B на записанных прогонах + live 5×40. `password-recovery` полный путь
   пройден (v2, 36 turns/14.3k reasoning/3.33₽); fix-ocaml, db-wal, regex, cobol — впереди.
8. **Полный каталог 13 задач и траектории opencode/Skein** —
   `docs/plans/task_catalog_2026-10-18_ru.md`; здесь только выводы.
