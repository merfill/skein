# Skein — сквозной пример: состояния и динамическая лента

> Английское зеркало — `docs/en/walkthrough.md`.
>
> Источник истины — `ir.md`; лента — `projection.md`; состояния — `states.md`; инструменты —
> `tools.md`. Этот документ показывает один запрос от начала до конца.

## 1. Идея

Обычный агент кодирования часто трактует ленту сообщений как память: каждое действие и результат
дописываются, а модель восстанавливает текущую цель и нужные свидетельства из этого накопления.

Skein хранит память в журнале, который только пополняется. Лента — **проекция** журнала,
пересобираемая на каждом ходу. Журнал монотонен; лента — нет: закрытое состояние оставляет на
ленте короткий след, а его данные остаются в журнале и доступны по id.

**Состояние** — рамка работы, а не шаг и не команда. Модель называет его через `move`; вид
состояния задаёт цель, условие завершения (`Done when`), инструкцию (`Plan`) и поверхность
инструментов. Модель работает в состоянии обычными ReAct-ходами. Когда она отвечает текстом,
исполнитель записывает этот ответ как `stop` состояния; состояние закрывается, и выбирается
следующее. Исполнитель не решает, когда состояние завершено.

Запрос — справочный контекст, а не цель: он объясняет, почему задача существует, но цель
открытого состояния — единственная активная цель хода.

## 2. Как собирается лента

Лента начинается с базового промпта (`B1` — роль, `B2` — принципы) и ограничений. Затем идут
запрос и текущее состояние:

```
system   BASE_PROMPT
system   Constraint (k1): never touch paths matching ...
user     <запрос>
system   <краткая справка запроса: координаты + окружение>      ← только на свежем запросе
user     <инструкция запроса: выбрать стартовое состояние>
system   Start state Patch
system   <краткая справка состояния: координаты + часть окружения>
assistant  <вызов инструмента> + рассуждение
tool       <результат>
...
user     Goal: <цель состояния>
         Your earlier guess (may be wrong): <what>
         Done when: "<условие состояния>". When it holds, reply with the result as text only.
         Plan:
         <инструкция состояния>
         The original user request is context for this state, not its goal.
```

Запрос — первый ход `user`, после базового промпта и ограничений, на каждом ходу. Рабочий промпт
пересобирается каждый ход и не хранится. Открытое состояние несёт свою краткую справку и ходы;
закрытое оставляет только:

```
system   Start state Patch
system   Finish state Patch — <why>
system   Artifacts: src/parse.py          ← если состояние использовало write или edit
```

Краткая справка, рабочий промпт и ходы уходят с ленты. Данные остаются в журнале.

После закрытия состояния добавляется промпт перехода ходом `system`:

```
system   The engine recorded this state's result on the `Finish state Patch — …` line above.

         Choose exactly one next state:
         - Verification — the change is applied, and the edited lines read back.
         - Research — the work turns out to be a situation, not a defect to locate and fix.

         Call `move` alone with `what` = the object or situation the next state works on
         (≤20 words), not the task; leave `done` out, and do not do that state's work on this turn.
```

Следующие состояния отображаются из `next[].when`, а не из описаний их работы. На переходе
предложен только `move`. Свежий запрос предлагает `move` и `decline`; открытое состояние —
инструменты действия плюс `recall` и `search`; терминальное состояние не предлагает ничего, потому
что закрывается текстом.

## 3. Сквозной пример

### 3.1 Задача

`/app` — небольшой проект на Python: `src/parse.py`, `Makefile`, `tests/`. Изменение сломало
разбор, поэтому `make test` падает. Запрос:

> «Я сломал сборку; сделай так, чтобы `make test` проходил.»

Ограничение `k1`: не трогать тесты.

### 3.2 Запрос

До первого состояния на ленте базовый промпт, ограничение, запрос, краткая справка запроса и
инструкция запроса:

```
system   # Role ... ## How you work ... ## General instructions ...
system   Constraint (k1): never touch paths matching tests/**
user     «Я сломал сборку; сделай так, чтобы `make test` проходил.»
system   Workspace root: /app / Workspace repository: ... / environment
user     Choose exactly one of three values:
         - Patch when the task is to find an error in the existing code and fix it by editing an existing file.
         - Construction when the task is to write new file(s) explicitly.
         - Research in all other cases.
         The original user request is context for this choice, not the goal.
```

Задача — дефект в существующем файле, поэтому модель стартует в Patch.

### 3.3 Patch

Модель вызывает `move { state: "patch", what: "the parse loop that breaks on the last token" }`.
Лента открывает Patch:

```
system   Start state Patch
system   Workspace root: /app / Workspace repository: ... / environment
assistant [a1] grep { pattern: "def parse" } + рассуждение
tool       [o1] src/parse.py:63 ...
assistant [a2] read { filePath: "src/parse.py", offset: 40, limit: 50 } + рассуждение
tool       [o2] ... строки 40-89 ...
assistant [a3] edit { filePath: "src/parse.py", oldString: "...", newString: "..." } + рассуждение
tool       [m] mutated src/parse.py
user     Goal: find the defect in the existing artifact and make the change it needs.
         Your earlier guess (may be wrong): the parse loop that breaks on the last token
         Done when: "the plan is complete: the error is found and fixed". When it holds,
         reply with the result as text only — no tool call.
         Plan:
         1. Find the file with the coordinates and the cause of the error.
         2. Fix the error and stop with a report about it.
         The original user request is context for this state, not its goal.
```

Условие выполнено: цель названа с координатами, причина названа, изменение внесено. Модель
отвечает текстом; исполнитель записывает это как `stop` состояния:

```
system   Start state Patch
system   Finish state Patch — line 63 drops the last token; the loop boundary is off by one.
system   Artifacts: src/parse.py
```

### 3.4 Verification

Промпт перехода предлагает End или Verification. Модель переходит в Verification:

```
system   The engine recorded this state's result on the `Finish state Patch — …` line above.
         Choose exactly one next state:
         - Verification — the change is applied, and the edited lines read back.
         - Research — the work turns out to be a situation, not a defect to locate and fix.
         Call `move` alone with `what` = the object or situation the next state works on ...
```

```
system   Start state Verification
system   <факты окружения>
user     Goal: check the changed artifact against the goal's acceptance.
         Done when: "the acceptance holds: the acceptance command passes, or every declared
         constraint holds, and the result is derived from the source material, not synthesized".
         Plan:
         Run the acceptance command if the workspace has one; otherwise check the declared
         constraints, and read the output itself — a zero exit status is not proof ...
assistant [a4] bash { command: "make test" } + рассуждение
tool       [o4] exit 1 — IndexError: list index out of range
```

Изменение сдвинуло границу цикла; на последней итерации код читает `tokens[i + 1]` за концом
списка. Проверка провалилась. Модель закрывает Verification с буквальным провалом:

```
system   Start state Verification
system   Finish state Verification — make test: exit 1 — IndexError: list index out of range
```

Промпт перехода теперь предлагает End или Patch. Модель выбирает Patch: цель была верной, но
изменение или причина, на которую оно опиралось, — нет. На переходе `Verification → Patch`
исполнитель испускает `revert` и возвращает файлы к состоянию до правки, обновляя версии:

```
system   Start state Patch
system   <координаты и окружение до правки>
...
assistant [a5] edit { filePath: "src/parse.py", oldString: "...", newString: "..." } + рассуждение
tool       [m] mutated src/parse.py
...
system   Finish state Patch — the boundary check was missing; the change now keeps the last token.
system   Artifacts: src/parse.py
```

Вторая Verification запускает ту же команду:

```
system   Start state Verification
system   <факты окружения>
assistant [a6] bash { command: "make test" } + рассуждение
tool       [o6] exit 0
```

Модель закрывает Verification с успешным результатом:

```
system   Finish state Verification — make test: exit 0
```

Отдельного блока «previous failed attempt» нет: провал остаётся в строках `Finish` закрытых
состояний.

### 3.5 End

Промпт перехода предлагает End. Модель переходит в End:

```
system   Start state End
system   This is End.

         The work is done; complete the request. Reply with the final report as text only,
         with no tool calls.

         Read the tape — the request, the states the task passed, what each of them did,
         the files it changed, and how the result was checked — and write the report from
         those records in GitHub-flavored Markdown: what was done and where, how it was
         verified, and what is still open.
```

У End нет ходов и инструментов. Модель отвечает отчётом текстом; исполнитель записывает этот
ответ как терминальный `stop`, и запуск завершается с `request_addressed`:

```
system   Finish state End — <отчёт>
```

## 4. Что остаётся в IR

Лента показала работу; журнал её сохранил. Модель работы — плоская последовательность состояний, у
каждого плоский список ходов:

```
request
├─ move patch          ходы: a1 grep, a2 read, a3 edit
├─ move verification   ходы: a4 bash (exit 1)
│  └─ revert           файлы v2 → v1 на переходе в Patch
├─ move patch          ходы: a5 edit
├─ move verification   ходы: a6 bash (exit 0)
└─ move end            ходов нет; текстовый ответ закрывает его
```

Ходы состояния — его упорядоченные действия, каждое с наблюдением или изменением файла.
Состояние никогда не является ходом, а ход — состоянием.

Данные закрытого состояния по-прежнему адресуемы. Например, наблюдение из первого Patch можно
прочитать, пока открыто более позднее состояние:

```
recall { id: "o2" }        → тело окна чтения, как обычный ход открытого состояния
search { id: "o4", pattern: "IndexError" }  → совпавшие строки упавшего запуска
```

Оба вызова создают действие и наблюдение в ходах открытого состояния, поэтому результат остаётся
на ленте, пока состояние открыто, и уходит вместе с ним при закрытии.

## 5. Заметки

- **`what` — догадка.** Цель состояния — `island.what`; `what` — необязательная заметка модели о
  конкретном предмете. Поле `done`, сохранённое для совместимости, не предлагается и не
  отображается.
- **Условие завершения задаёт вид состояния.** Модель видит его как `Done when`; поле `done` она
  не передаёт.
- **`stop` — запись, а не инструмент.** Текстовый ответ закрывает состояние; исполнитель пишет
  связь `stop`.
- **Лента не монотонна.** Закрытое состояние оставляет `Start` и `Finish` (плюс `Artifacts:`,
  если использовались `write` или `edit`); его краткая справка, рабочий промпт и ходы уходят с
  ленты.
- **Рассуждение хранится.** Рассуждение хода едет как часть рассуждения сообщения `assistant`;
  видимый текст, закрывающий состояние, становится `why` его строки `Finish`.
- **Проверки условия нет.** Исполнитель записывает закрытие; он не оценивает ответ модели.
- **Поверхность инструментов следует за состоянием.** Запрос: `move`/`decline`; открытое
  состояние: инструменты действия плюс `recall`/`search`; переход: `move`; End: ничего.
- **Провал Verification возвращает в Patch.** Исполнитель откатывает последний Patch, когда
  делается переход из провалившейся Verification; провал остаётся в строках `Finish` закрытых
  состояний.
