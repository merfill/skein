# Where the tokens/money go (Skein states)

Per-turn `inputTokens`/`outputTokens`/`reasoningTokens`/`cost` from each cell's `metrics.json`, assigned to the state of the last `move` at or before that turn (the move turn counts for the new state). All 125 Skein runs, nets on+off.

## By state (all runs)

| state | cells | turns | turns % | input | fresh | cache | output | reasoning | cost | cost % |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| construction | 56 | 760 | 30.2% | 11.49M | 1.35M | 10.14M | 522.7k | 335.2k | 64.86₽ | 35.5% |
| patch | 30 | 634 | 25.2% | 11.65M | 1.26M | 10.39M | 303.6k | 219.5k | 47.67₽ | 26.1% |
| research | 47 | 585 | 23.2% | 6.76M | 1.15M | 5.61M | 295.9k | 202.1k | 43.49₽ | 23.8% |
| verification | 30 | 291 | 11.6% | 1.91M | 526.9k | 1.38M | 82.0k | 43.3k | 15.71₽ | 8.6% |
| end | 124 | 248 | 9.8% | 412.4k | 350.1k | 62.3k | 66.4k | 32.5k | 10.98₽ | 6.0% |

**Totals:** 182.72₽, 2518 turns. Patch+Verification = 63.38₽ (34.7%), Construction = 64.86₽ (35.5%), Research = 43.49₽ (23.8%).

## Cost by task and state

| task | total | top states |
|---|---:|---|
| cobol-modernization | 36.73₽ | construction 32.7₽ · research 3.1₽ · end 0.9₽ |
| custom-memory-heap-crash | 28.68₽ | patch 21.3₽ · verification 6.5₽ · end 0.9₽ |
| fix-ocaml-gc | 27.35₽ | patch 18.5₽ · verification 5.8₽ · research 2.4₽ · end 0.6₽ |
| password-recovery | 19.66₽ | research 19.1₽ · end 0.6₽ |
| regex-log | 15.99₽ | construction 14.0₽ · end 2.0₽ |
| fix-code-vulnerability | 10.78₽ | patch 4.7₽ · research 3.1₽ · verification 2.2₽ · end 0.7₽ |
| db-wal-recovery | 8.64₽ | research 5.5₽ · construction 1.7₽ · end 0.9₽ · patch 0.4₽ · verification 0.2₽ |
| git-leak-recovery | 8.27₽ | research 2.9₽ · patch 2.7₽ · verification 1.0₽ · construction 0.9₽ · end 0.7₽ |
| fix-git | 5.79₽ | research 4.9₽ · end 0.9₽ |
| openssl-selfsigned-cert | 5.50₽ | construction 4.2₽ · end 0.8₽ · research 0.5₽ |
| crack-7z-hash | 5.32₽ | construction 3.8₽ · research 1.2₽ · end 0.3₽ |
| log-summary-date-ranges | 5.03₽ | construction 3.8₽ · end 0.8₽ · research 0.4₽ |
| modernize-scientific-stack | 4.98₽ | construction 3.7₽ · end 0.9₽ · research 0.3₽ |

## Skein vs opencode cost per task (solved-only)

| task | Skein | opencode (est.) | diff | Skein/opencode |
|---|---:|---:|---:|---:|
| cobol-modernization | 36.73₽ | 34.09₽ | +2.64₽ | 1.08× |
| crack-7z-hash | 5.32₽ | 4.98₽ | +0.34₽ | 1.07× |
| custom-memory-heap-crash | 28.68₽ | 13.78₽ | +14.90₽ | 2.08× |
| db-wal-recovery | 8.64₽ | 5.95₽ | +2.69₽ | 1.45× |
| fix-code-vulnerability | 10.78₽ | 4.26₽ | +6.52₽ | 2.53× |
| fix-git | 5.44₽ | 1.95₽ | +3.49₽ | 2.79× |
| fix-ocaml-gc | 23.21₽ | 28.09₽ | -4.88₽ | 0.83× |
| git-leak-recovery | 8.27₽ | 1.82₽ | +6.45₽ | 4.54× |
| log-summary-date-ranges | 5.03₽ | 3.24₽ | +1.80₽ | 1.55× |
| modernize-scientific-stack | 4.98₽ | 2.33₽ | +2.65₽ | 2.14× |
| openssl-selfsigned-cert | 5.50₽ | 2.35₽ | +3.14₽ | 2.34× |
| password-recovery | 19.66₽ | 10.46₽ | +9.20₽ | 1.88× |
| regex-log | 15.99₽ | 12.35₽ | +3.65₽ | 1.30× |

Caveats: opencode has no state labels, so state attribution is Skein-only. opencode cost is estimated with the fitted Skein price model. The state labels are model-chosen, not the task type; a task can switch states. The move turn is assigned to the new state.
