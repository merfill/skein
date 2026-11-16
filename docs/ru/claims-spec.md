# Claims: удостоверение гипотез и долг закрытия

**Статус:** черновик для вычитки и обсуждения. Не реализовано. RU-only (как `handoff.md`),
английского зеркала нет. Термины «докса», «логос», «Арбитр», `cited`/`H`, `proven_under(H)` —
из Ankyra (см. §12).

Документ отвечает на три вопроса:

1. Как сделать так, чтобы модель не была **своим Арбитром** (сама объявляла критерий и сама же
   его подтверждала).
2. Можно ли **отказаться от состояний** (`Research`/`Patch`/`Verification`/…) и что при этом
   придётся сохранить.
3. Как это проверять и чем мерить.

Сквозной пример — `skein doctor` 401 (§6); второй, короткий — `fix-git` (§7).

---

## 1. Идея за одну страницу

Skein — кодинг-агент: LLM предлагает, движок записывает и проецирует, журнал — источник истины.
В терминах Ankyra:

| Роль | В Skein |
|---|---|
| **докса** (источник предложений) | языковая модель |
| **логос** (проверка) | движок: протокол, структурные проверки, исполнитель |
| **Арбитр** (цель, критерий, момент завершения) | пользовательский запрос и внешний верификатор |
| **журнал/протокол** | IR, проекция, отказы, факты исполнителя |

Проблема, которую видно в текущем устройстве: `done` объявляет модель, `stop` пишет модель, и
критерий она же трактует. Это докса, которая сама себе Арбитр. Ankyra запрещает это по
построению: обоснованность ответа не превышает обоснованности посылок (`ankyra:90`),
`proven_under(H)` — это ответ с названными допущениями, а не отказ (`ankyra:146`), а вопрос
никогда не является источником (`doxa:862`).

Предлагаются два механизма, оба — **структурные**, без разбора естественного языка.

### 1.1. Удостоверение (claims)

Модель не «делает ходы», а открывает **претензию** (`claim`) — единицу работы с явным
ожиданием, — и закрывает её вердиктом на фактах исполнителя:

```ts
claim_open(kind: "investigate" | "change" | "verify", label, suppose, expects) -> { id: "C<n>" }
claim_close(id, verdict: "confirmed" | "refuted" | "done" | "dropped", grounds) -> { ok }
```

- `suppose` — что предполагаю (investigate), что меняю (change), что проверяю (verify).
- `expects` — что увижу, если это верно/получилось/прошло. **Объявляется до проверки.**
- `grounds` — идентификаторы фактов исполнителя (наблюдений) и/или предыдущих claims.
- Движок `suppose`/`expects` **не разбирает** — только хранит, валидирует структуру и рендерит.

### 1.2. Закрытие (критерий)

Критерий завершения юнита — не «придуманное моделью предложение без источника», а объект с
классификацией:

- **cited** — критерий прослеживается до дословной цитаты из запроса. Проверяется механически:
  `quote` — подстрока текста запроса. Источник — Арбитр-пользователь.
- **hypothesis (H)** — критерий придуман моделью. Тогда закрытие — `under(H)`, а не чистое.

Три звена закрытия:

1. **что должно быть верно** — критерий (cited или H);
2. **что наблюдалось** — факт исполнителя (наблюдение с `witness`);
3. **«наблюдённое удовлетворяет критерию»** — суждение модели; по умолчанию H, кроме
   механически проверяемых случаев (критерий «exit 0», факт — код возврата).

Правило: **ответ не сильнее посылок**. Юнит, закрытый на модельном критерии или на
непроверенной acceptance, получает `under(H)` и перечень долгов — но **не блокируется**.

### 1.3. Что здесь не так

- `under(H)` — **пометка, не отказ**. Stop происходит всегда; записывается с долгом.
- Это **не верификация**: движок не сравнивает `expects` с фактом. Эффект — в салиентности и
  в честной записи, а не в принуждении.
- Цитата проверяет **привязку**, не **релевантность**: «сделай, чтобы работало» цитируется, но
  не задаёт acceptance. Это граница, которую может закрыть только Арбитр.

---

## 2. Можно ли отказаться от состояний

Короткий ответ: **от фиксированного графа — да; от четырёх функций состояния — нет.** Вопрос в
том, кто их несёт: остров или claim.

### 2.1. Что состояние делает сейчас

| Функция | Где в коде | Зачем |
|---|---|---|
| единица немонотонной проекции | `src/ir/project.ts:278` | закрытая единица элидирует turns, остаётся маркер |
| поверхность инструментов | `applies` острова, `src/ir/islands.ts` | Verification не получает write; End — ничего |
| критерий и инструкция | `criterion`/`instruction` | «что значит done» и «как здесь работать» |
| якорь в working prompt | Goal/Done/Plan | гасит дрейф к запросу (AGENTS.md) |
| карта переходов | `next`/`when` | Research → Patch → Verification; нельзя «прыгнуть» |
| учёт стоимости | `state-cost` | по-состоянийная цена в кампании |

### 2.2. Три варианта

- **S0 (сейчас):** фиксированные острова и переходы.
- **S1 (цель этого документа):** состояний нет; есть claims с `kind`; переходы свободные;
  поверхность и инструкция — по `kind`; проекционная единица — claim; критерий — cited/H.
- **S2 (research):** `W: Σ → O` выбирает оператор динамически, как в doxa:634–639. Требует
  внешнего Арбитра на каждом шаге; в кодинг-агенте его нет (есть скрытый верификатор).

A и B из обсуждения: **A** — это S0 плюс классификация критерия; политика Арбитра
зафиксирована и авторена (`ISLANDS`/`next` — стоячее решение `W`). **B** — это S2: `W`
выбирается динамически.

### 2.3. Чем заменяются функции в S1

| Функция | В S1 |
|---|---|
| единица проекции | claim: открыт — turns видны; закрыт — одна строка, `recall` по id |
| поверхность | `investigate`/`verify`: read/grep/list/bash/webfetch, без write; `change`: полная |
| критерий | ожидание claim (`expects`) + acceptance юнита (cited/H) |
| якорь | active claim: suppose/expects; acceptance юнита — отдельной строкой |
| «Research до Patch» | **change не закрывается (`done`) без grounds и мутации** |
| «Verification до End» | **долг acceptance**: без факта-проверки юнит закрывается `under(H)` |
| стоимость | по `kind` claim |

Ключевая мысль: графовые ограничения заменяются **структурными предусловиями**:
`change` не закрывается без grounds и мутации, а `verify` без факта не снимает долг. Это слабее
графа (модель может заземлить change в слабом claim), поэтому S1 — эксперимент, а не данность.

### 2.4. Что теряется

- нет карты переходов и `when`: модель может чередовать investig/change;
- нет фазы «Verification не меняет артефакт» как жёсткого surface (bash всё равно может писать);
- по-состоянийная стоимость кампании становится по-claim;
- инвариант «состояние закрывается только текстом» меняется: claim закрывается структурным
  вердиктом; юнит по-прежнему закрывается текстом (+ долг).

### 2.5. Рекомендация

1. Сначала — **классификация критерия на S0** (§3–§5). Она не требует S1, дешевле и отвечает на
   главный вопрос (докса-как-Арбитр).
2. Затем — **S1 как A/B** против S0 на `fix-git`/`fix-ocaml-gc` (§9).
3. S2 — только в тексте, как концептуальная граница.

---

## 3. Модель данных (S1)

Всё выводится из журнала; никакого изменяемого `Map` на юните (иначе ломается детерминизм
`project`). Узлы/события + fold; `active`/`under`/`stale`/`debt` — производные.

```ts
type ClaimKind = "investigate" | "change" | "verify";
type Verdict = "confirmed" | "refuted" | "done" | "dropped";

interface Claim {
  id: string;              // C<n>, уникален в юните
  kind: ClaimKind;
  label: string;           // короткое имя для ленты
  suppose: string;         // что предполагаю / меняю / проверяю
  expects: string;         // что увижу, если верно/получилось/прошло
  verdict?: Verdict;
  grounds?: string[];      // id фактов (observation) и/или claims
  under?: string[];        // выводимые H (см. §4.4)
  stale?: boolean;         // выводится из witness/currentVersion
}

interface Criterion {
  text: string;            // формулировка
  quote?: string;          // дословная цитата из запроса
  class: "cited" | "hypothesis"; // cited, если quote — подстрока запроса
}

interface UnitClosure {
  criterion: Criterion;    // acceptance юнита (из запроса)
  checkedBy?: string;      // id факта-проверки
  under: string[];         // H, на которых стоит ответ
  debt: string[];          // «acceptance не проверена», «claim C4 открыт», …
}
```

- `criterion` объявляется при создании запроса или первого claim: `quote` предлагает модель,
  движок проверяет подстроку в тексте запроса (нормализация пробелов — решение, §10). Нет цитаты
  или не найдена — `hypothesis`.
- `claim_close` без `grounds` для `confirmed|refuted|done` — отказ `bad_grounds`.
- `dropped` освобождает слот, но **не снимает H**: claim остаётся в журнале и в долге, если
  relevant.
- `grounds` — только observation-результаты (включая упавший прогон) и предыдущие claims.
  Engine-отказы (`no_active_claim`, `repeated_action`, `stale_base`) и transition-rejection —
  не grounds.

---

## 4. Правила движка

### 4.1. Жёсткие

| Событие | Проверка | Отказ |
|---|---|---|
| `claim_open` | нет активного claim | `claim_active` |
| `claim_open` | `expects` непуст | `claim_no_expects` |
| побочный вызов (`bash`, `webfetch`, `write`, `edit`, `apply_patch`) | есть активный claim | `no_active_claim` |
| `write`/`edit`/`apply_patch` | активный claim `kind=change` | `not_a_change_claim` |
| `claim_close` | claim открыт; grounds непусты для confirmed/refuted/done; grounds из whitelist | `bad_grounds` |
| `claim_close(change, done)` | пока claim активен, записана хотя бы одна мутация (`mutates`) | `change_without_mutation` |

Чтения (`read`, `grep`, `list`, `recall`, `search`) **свободны**: они и есть сбор grounds.
`bash` — побочный (может писать), поэтому под гейтом; в `investigate` это допустимо (read-only
команды), но требует объявленного `expects`.

### 4.2. Мягкие (пометки)

| Событие | Пометка |
|---|---|
| `stop` при открытом/`dropped` claim | `under(H)` + перечень |
| `stop` при criterion = hypothesis | `under(H)` + «acceptance не заземлена» |
| `stop` при cited, но нет `checkedBy` | `under(H)` + «acceptance не проверена» |
| `stop` при cited + `checkedBy` | чистая acceptance; `under` — только H причин |

Stop **никогда не отклоняется**.

### 4.3. Staleness

`grounds`-наблюдения несут `witness` (`ref`, `version`). При мутации файла `reconcile` пишет
`mutate`; claim, чьи grounds свидетели изменившегося ref, становится `stale`. Вердикт
сохраняется, но grounds не показываются как активные; change, заземлённый в stale-claim,
помечается «требует перезамера». Второй механизм инвалидации не заводится — используется
существующий (`src/loop/observe.ts`, `currentVersion`).

### 4.4. Наследование H

- `investigate(confirmed)`: суждение «факты подтверждают suppose» — H самого claim.
- `change`: наследует H всех claim-grounds (например, `C3 under {H2}`).
- `verify`: если критерий литерален (например, «exit 0») и факт — соответствующий код, новый H
  не добавляется; иначе H.
- `under(unit)` = объединение H по пути до закрытия + H критерия, если он hypothesis.

### 4.5. Батч

Один ход может нести несколько вызовов. Правило: `claim_open`/`claim_close` действуют **со
следующего хода**; вызовы в том же батче оцениваются против состояния до батча. Это
детерминированно и объясняет отказ. Альтернатива — fold по порядку внутри батча; решение §10.

---

## 5. Проекция и промпты

- **Стабильный префикс:** `BASE_PROMPT` + запрос (с acceptance-клаузой и цитатой). Запрос уже
  ведущий `user`-ход; ничего нового в префикс не добавляется.
- **Хвост (не префикс):** активный claim, закрытые одной строкой, долг.
- **Working prompt:** `Goal` — суть активного claim (что устанавливаем/меняем/проверяем);
  `Done when` — его `expects`; acceptance юнита — отдельной строкой с пометкой `cited`/`H`;
  «запрос — ссылка, не цель хода».
- **Закрытый claim:** turns элидируются, остаётся маркер и `recall` по id.
- **Finish:** `Finish work — request addressed (under H2; acceptance cited, checked by F7)`.

Пример хвоста:

```
ACTIVE   C2 investigate auth-header
  suppose: R requires x-api-key instead of Authorization
  expect:  curl x-api-key → 200; curl Authorization → 401
GROUNDED F2 curl 200/401 · F3 client.ts:44 'Authorization'
CLOSED   C1 key-resolution — refuted (F1)
ACCEPT   cited "skein doctor exits 0" — not checked yet
UNDER    H2 (the provider's header rule)
```

Кэш: хвост меняется каждый ход — это нормально; префикс (base+request) стабилен.

---

## 6. Сквозной пример: `skein doctor` 401

**Запрос:** «`skein doctor` returns 401 for provider R even though the API key is valid.
Acceptance: skein doctor exits 0.»

**Критерий:**

```
text  = "skein doctor exits 0"
quote = "skein doctor exits 0"   # подстрока запроса
class = cited
```

(Если бы acceptance-клаузы не было — `class = hypothesis`, и юнит закрылся бы `under(H)`.)

| Модель | Движок / журнал |
|---|---|
| `claim_open(investigate, "key-resolution", "key is not read from auth.json", "with explicit env, doctor passes")` | C1 открыт |
| `bash("SKEIN_API_KEY=… skein doctor")` | F1: exit 1, 401 |
| `claim_close(C1, refuted, [F1])` | C1 refuted; слот свободен |
| `claim_open(investigate, "auth-header", "R requires x-api-key, not Authorization", "curl x-api-key→200; curl Authorization→401")` | C2 открыт |
| `bash(curl ×2)` | F2: 200 / 401 |
| `grep("Authorization", "src/providers/client.ts")` | F3: L44 |
| `claim_close(C2, confirmed, [F2,F3])` | C2 confirmed; `under {H2}` |
| `claim_open(change, "fix-header", "replace Authorization with x-api-key", "client.ts reads back with x-api-key")` | C3 открыт |
| `edit("src/providers/client.ts", …)` | F4: mutation (witness) |
| `read("src/providers/client.ts")` | F5: L44 = x-api-key |
| `claim_close(C3, done, [C2,F5])` | C3 done; мутация F4 записана движком; `under {H2}` |
| `claim_open(verify, "coverage", "repo tests cover the provider header", "grep finds x-api-key in tests/")` | C4 открыт |
| `grep("x-api-key", "tests/")` | F6: no matches |
| `claim_close(C4, refuted, [F6])` | C4 refuted — тесты не про заголовок |
| `claim_open(verify, "direct-probe", "doctor now passes", "skein doctor exits 0")` | C5 открыт |
| `bash("skein doctor")` | F7: exit 0 |
| `claim_close(C5, confirmed, [F7])` | C5 confirmed |
| `stop("причина — имя заголовка; doctor проходит")` | acceptance cited + checked by F7; `under {H2}`; долгов нет |

**Ключевой ход** — C4. Без требования `expects` модель прогнала бы `npm test`, увидела зелёный
и закрыла юнит; C4 заставляет заявить «тесты покрывают заголовок» **до** прогона, и один `grep`
опровергает это за копейки.

**Итог:** acceptance чистая (cited + факт), но ответ `under(H2)` — причина остаётся
предположением модели, подкреплённым F2/F3, а не выведенным из запроса. Это и есть «ответ не
сильнее посылок», а не отказ.

Хвост перед `stop`:

```
ACTIVE   C5 verify direct-probe — confirmed (F7)
CLOSED   C1 refuted · C2 confirmed (H2) · C3 change done (H2) · C4 refuted
ACCEPT   cited "skein doctor exits 0" — checked by F7
UNDER    H2 (the provider's header rule)
```

---

## 7. Второй пример: `fix-git` (кратко)

Задача: файл пропал из репозитория; висячий коммит его возвращает. `fix-git` в кампании дал
`reward=0`: агент нашёл коммит `650dba4`, но не влил его и остановился на диагнозе.

В claims:

- `C1 investigate "dangling-commit"` → F1 (`git show --stat 650dba4`) → **confirmed**;
- дальше модель **не открывает** `C2 change "merge"` и пишет `stop`.

Юнит закрывается `under(H)` с долгом «acceptance не проверена» (или, если acceptance цитируется
как «Fix the repository», долг «нет факта-проверки»). Бенчмарочный верификатор падает.

Важно: механизм **помечает** долг, но **не принуждает** к мержу. Если репозиторные тесты
проходят без мержа, агент закроется `cited` и всё равно провалит скрытый верификатор. Поэтому
«ловит fix-git» — условно; измеримая гипотеза — **долг/`under(H)` предсказывает `reward=0`**
(§9).

---

## 8. Что меняется в инвариантах

- Stop по-прежнему закрывается текстом модели и **никогда не отклоняется**; `under(H)` — запись.
- Новые жёсткие правила: одна активная claim; побочный вызов требует claim; grounds из
  whitelist; change требует мутации.
- `project` остаётся детерминированным: claims — из журнала, не из изменяемого состояния.
- Stale-факт не показывается как активный; вердикт не отменяется.
- Запрос — ссылка; acceptance — критерий **юнита**, не цели состояния (AGENTS.md).
- Меняется инвариант «состояние закрывается только текстом» **в S1**: claim закрывается
  структурным вердиктом; юнит — текстом + долгом. В S0 он сохраняется.

Доки к обновлению при реализации: `AGENTS.md`, `ir.md`, `ir_operations.md` (матрица покрытия,
`tests/coverage.test.ts`), `projection.md`, `states.md` (или новый `claims.md`), `tools.md`,
`testing.md`.

---

## 9. Замер

Гипотезы:

1. `under(H)`/долг на закрытии юнита **предсказывает** `reward=0`; чистый cited+checked —
   предсказывает `reward=1`. Если нет — механизм шум.
2. `expects`-до-прогона увеличивает число `refuted` claims (negative knowledge) и снижает
   долю тихих неверных stop.
3. S1 не хуже S0 по solved при сопоставимых turns/cost; иначе граф был несущей конструкцией.

Протокол: `bench/turn.ts --rebuild` (бесплатный рендер) → A/B S0/S1 на `fix-git` (premature
stop) и `fix-ocaml-gc` (бюджет), K=10; метрики — turns, cost, cache hit, solved, доля
`under(H)`, доля `refuted`. Живые/sandbox-прогоны — только с явного разрешения владельца
(AGENTS.md).

---

## 10. Открытые решения

1. Имя: `claim` vs `hypothesis` vs `segment`; `kind` — `investigate|change|verify`?
2. Проверка цитаты: нормализация пробелов/бэктиков; минимальная длина; можно ли цитировать
   вопрос, а не acceptance.
3. Релевантность цитаты: движок не проверяет; оставляем как границу или вводим
   `acceptance: true`-декларацию?
4. Гейт: `bash` в `investigate` — под гейтом (да, побочный); `webfetch` — да.
5. Батч: следующий ход vs fold по порядку.
6. `dropped` vs `abandoned`: рендер и участие в долге.
7. Наследование: change всегда `under` H своих grounds, даже если мутация проверена?
8. S1 сейчас или после критерия? (Рекомендация — после.)
9. Скоуп: только `task`; `revision` — cited-критерий; `general`/`document` не трогаем?
10. Скрытый верификатор: как честно описать разрыв «acceptance запроса ≠ верификатор бенчмарка».

---

## 11. Не-цели

- Семантическая проверка вердиктов и `expects` (никакого разбора языка).
- Вторая модель-судья.
- Принудительный запрет stop (только пометка).
- Решатель Ankyra внутри Skein.
- Изменения `general`/`document` в этой спеке.

---

## 12. Ссылки

Ankyra (`~/dev/ankyra/docs/ankyra_paper_ru.tex`):

- 90 — обоснованность ответа не превышает посылок;
- 118 — «вопрос никогда не утверждается как факт»;
- 138–146 — `cited` / `hypothesis` / `proven` / `proven_under(H)`; ответ называет допущения;
- 158 — проверка завершения по решающему вердикту.

Doxa (`~/dev/ankyra/docs/doxa_and_logos_ru.tex`):

- 361–365 — асимметрия: докса поставляет содержание, логос/среда решают судьбу;
- 380–385 — `Σ = ⟨F, J, Π⟩`, оператор `o: Σ × X → Σ`;
- 587–588 — проверки заземления цитат;
- 621–639 — Арбитр, `W: Σ → O`, внешняя инстанция (иначе регресс);
- 711–717 — рассуждение как последовательность расширений;
- 848–865 — автоматический (тест-раннер) и пользовательский Арбитр; гарантии честности.

Skein:

- `AGENTS.md` — инварианты, anchor-урок, проекция;
- `src/ir/islands.ts` — `ISLANDS`, `applies`, `next`;
- `src/ir/project.ts:278` — закрытое состояние = Start + Finish;
- `src/ir/graph.ts:26,60` — `State.branch` (стек обхода) и `currentVersion`;
- `src/loop/observe.ts` — witness и `reconcile`/`mutate`;
- `src/tools/index.ts:522` — `stale_base`.
