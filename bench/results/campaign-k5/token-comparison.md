# Skein vs opencode — token usage and cost (campaign K=5)

Source: `bench/runs/matrix/campaign-k5/summary.json` (cells) + fitted price model. Both agents use `~deepseek/deepseek-v4-flash-latest` (opencode `routerai/~deepseek/deepseek-v4-flash-latest`), reasoning `low`, K=5, nets on/off, no wall-clock timeout.

## Protocol

- commit: `059734f63f7bb99fc7fdbe13ba169d676d26fdd8`; node `v22.22.1`; finished: `2026-11-13T13:24:11.733Z`
- agents: `skein,opencode`; nets: `on,off`; repeat: 5; concurrency: 10; fix-ocaml-gc concurrency: `fix-ocaml-gc=3`
- runnable cells: 250; unsupported: 10 (`crack-7z-hash` / `net=off`)

## Price model

Fitted exactly from Skein's provider cost (R² = 1.0):

- fresh input: **17.80 ₽ / 1M tokens**
- cache read: **0.356 ₽ / 1M tokens**
- output: **71.20 ₽ / 1M tokens**

The same price model is applied to opencode (same model endpoint); opencode itself reports no cost, so its ruble figure is an **estimate**.

## Overall — solved only (123 runs per agent)

| agent | runs | solved | input | cache read | fresh input | output | reasoning | visible | total | cache % | turns | cost |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| skein | 123 | 123/123 | 31.38M | 26.88M | 4.50M | 1.24M | 812.7k | 430.8k | 32.62M | 85.7% | 2447 | 178.22₽ |
| opencode | 123 | 123/123 | 47.63M | 45.22M | 2.41M | 936.7k | 624.5k | 312.3k | 48.56M | 94.9% | 1800 | ~125.65₽ |

**Ratios (opencode / Skein):** input 1.52×, cache 1.68×, fresh 0.53×, output 0.75×, reasoning 0.77×, visible 0.72×, total 1.49×, turns 0.74×, cost 0.71×

## Overall — all runs (125 per agent; includes 4 failures)

| agent | runs | solved | input | cache read | fresh input | output | reasoning | visible | total | cache % | turns | cost |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| skein | 125 | 123/125 | 32.22M | 27.59M | 4.63M | 1.27M | 832.6k | 437.9k | 33.49M | 85.6% | 2518 | 182.72₽ |
| opencode | 125 | 123/125 | 54.16M | 51.51M | 2.65M | 1.03M | 695.2k | 329.9k | 55.19M | 95.1% | 1897 | ~138.44₽ |

## By network

### solved only

| agent | runs | solved | input | cache read | fresh input | output | reasoning | visible | total | cache % | turns | cost |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| skein | 63 | 63/63 | 18.04M | 15.66M | 2.37M | 664.7k | 430.7k | 233.9k | 18.70M | 86.8% | 1294 | 95.14₽ |
| skein | 60 | 60/60 | 13.35M | 11.22M | 2.13M | 578.8k | 382.0k | 196.8k | 13.92M | 84.1% | 1153 | 83.08₽ |
| opencode | 65 | 65/65 | 29.96M | 28.56M | 1.40M | 497.7k | 329.3k | 168.4k | 30.46M | 95.3% | 1039 | ~70.52₽ |
| opencode | 58 | 58/58 | 17.67M | 16.66M | 1.01M | 439.0k | 295.1k | 143.9k | 18.11M | 94.3% | 761 | ~55.13₽ |

### all runs

| agent | runs | solved | input | cache read | fresh input | output | reasoning | visible | total | cache % | turns | cost |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| skein | 65 | 63/65 | 18.87M | 16.37M | 2.50M | 691.7k | 450.6k | 241.1k | 19.57M | 86.7% | 1365 | 99.64₽ |
| skein | 60 | 60/60 | 13.35M | 11.22M | 2.13M | 578.8k | 382.0k | 196.8k | 13.92M | 84.1% | 1153 | 83.08₽ |
| opencode | 65 | 65/65 | 29.96M | 28.56M | 1.40M | 497.7k | 329.3k | 168.4k | 30.46M | 95.3% | 1039 | ~70.52₽ |
| opencode | 60 | 58/60 | 24.20M | 22.95M | 1.25M | 527.4k | 365.9k | 161.5k | 24.73M | 94.8% | 858 | ~67.92₽ |

## Median per run (all runs, agent/net)

| agent/net | runs | solved | median turns | median input | median fresh | median output | median reasoning | median cost |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| skein/on | 65 | 63/65 | 14 | 77.3k | 22.1k | 4.1k | 2.0k | 0.70₽ |
| skein/off | 60 | 60/60 | 15 | 88.7k | 25.0k | 7.3k | 4.3k | 1.00₽ |
| opencode/on | 65 | 65/65 | 9 | 115.0k | 10.4k | 3.0k | 1.7k | ~0.47₽ |
| opencode/off | 60 | 58/60 | 9 | 104.8k | 10.4k | 2.7k | 1.3k | ~0.44₽ |

## Per task — solved only (totals)

| task | Skein solved | opencode solved | Skein in / fresh / out / rsn / cache | opencode in / fresh / out / rsn / cache |
|---|---:|---:|---|---|
| cobol-modernization | 10/10 | 10/10 | 8.69M / 687.5k / 303.9k / 196.2k / 8.00M | 10.44M / 454.9k / 315.2k / 220.3k / 9.99M |
| crack-7z-hash | 5/5 | 5/5 | 898.9k / 180.1k / 26.1k / 13.9k / 718.7k | 2.72M / 107.7k / 29.9k / 17.4k / 2.62M |
| custom-memory-heap-crash | 10/10 | 10/10 | 5.82M / 743.7k / 191.5k / 129.5k / 5.07M | 4.93M / 264.1k / 104.1k / 68.0k / 4.67M |
| db-wal-recovery | 10/10 | 8/8 | 810.7k / 233.5k / 60.1k / 34.6k / 577.3k | 2.42M / 150.9k / 34.5k / 21.3k / 2.27M |
| fix-code-vulnerability | 10/10 | 10/10 | 1.79M / 351.0k / 56.4k / 32.4k / 1.44M | 1.48M / 113.9k / 24.6k / 12.5k / 1.36M |
| fix-git | 9/9 | 10/10 | 585.4k / 179.5k / 29.5k / 14.5k / 405.9k | 781.8k / 40.9k / 13.5k / 4.8k / 740.9k |
| fix-ocaml-gc | 9/9 | 10/10 | 6.15M / 698.1k / 124.2k / 88.8k / 5.45M | 17.96M / 675.9k / 139.2k / 92.7k / 17.29M |
| git-leak-recovery | 10/10 | 10/10 | 842.2k / 232.0k / 55.1k / 32.7k / 610.2k | 570.3k / 29.5k / 15.5k / 6.7k / 540.8k |
| log-summary-date-ranges | 10/10 | 10/10 | 494.3k / 165.8k / 27.6k / 7.1k / 328.6k | 737.8k / 128.1k / 10.4k / 3.3k / 609.8k |
| modernize-scientific-stack | 10/10 | 10/10 | 461.7k / 158.4k / 28.8k / 7.4k / 303.2k | 632.8k / 48.4k / 17.7k / 5.8k / 584.4k |
| openssl-selfsigned-cert | 10/10 | 10/10 | 493.4k / 179.2k / 30.8k / 8.0k / 314.2k | 747.6k / 33.4k / 21.1k / 7.2k / 714.1k |
| password-recovery | 10/10 | 10/10 | 3.41M / 462.2k / 145.9k / 112.1k / 2.94M | 2.97M / 225.8k / 76.8k / 52.9k / 2.75M |
| regex-log | 10/10 | 10/10 | 944.9k / 230.4k / 163.5k / 135.5k / 714.5k | 1.23M / 134.5k / 134.3k / 111.4k / 1.09M |

## Per task — all runs (totals; failures included)

| task | Skein solved | opencode solved | Skein in / fresh / out / rsn / cache | opencode in / fresh / out / rsn / cache |
|---|---:|---:|---|---|
| cobol-modernization | 10/10 | 10/10 | 8.69M / 687.5k / 303.9k / 196.2k / 8.00M | 10.44M / 454.9k / 315.2k / 220.3k / 9.99M |
| crack-7z-hash | 5/5 | 5/5 | 898.9k / 180.1k / 26.1k / 13.9k / 718.7k | 2.72M / 107.7k / 29.9k / 17.4k / 2.62M |
| custom-memory-heap-crash | 10/10 | 10/10 | 5.82M / 743.7k / 191.5k / 129.5k / 5.07M | 4.93M / 264.1k / 104.1k / 68.0k / 4.67M |
| db-wal-recovery | 10/10 | 8/10 | 810.7k / 233.5k / 60.1k / 34.6k / 577.3k | 8.95M / 389.8k / 122.9k / 92.1k / 8.56M |
| fix-code-vulnerability | 10/10 | 10/10 | 1.79M / 351.0k / 56.4k / 32.4k / 1.44M | 1.48M / 113.9k / 24.6k / 12.5k / 1.36M |
| fix-git | 9/10 | 10/10 | 605.1k / 189.7k / 31.8k / 15.9k / 415.4k | 781.8k / 40.9k / 13.5k / 4.8k / 740.9k |
| fix-ocaml-gc | 9/10 | 10/10 | 6.97M / 817.9k / 148.9k / 107.3k / 6.15M | 17.96M / 675.9k / 139.2k / 92.7k / 17.29M |
| git-leak-recovery | 10/10 | 10/10 | 842.2k / 232.0k / 55.1k / 32.7k / 610.2k | 570.3k / 29.5k / 15.5k / 6.7k / 540.8k |
| log-summary-date-ranges | 10/10 | 10/10 | 494.3k / 165.8k / 27.6k / 7.1k / 328.6k | 737.8k / 128.1k / 10.4k / 3.3k / 609.8k |
| modernize-scientific-stack | 10/10 | 10/10 | 461.7k / 158.4k / 28.8k / 7.4k / 303.2k | 632.8k / 48.4k / 17.7k / 5.8k / 584.4k |
| openssl-selfsigned-cert | 10/10 | 10/10 | 493.4k / 179.2k / 30.8k / 8.0k / 314.2k | 747.6k / 33.4k / 21.1k / 7.2k / 714.1k |
| password-recovery | 10/10 | 10/10 | 3.41M / 462.2k / 145.9k / 112.1k / 2.94M | 2.97M / 225.8k / 76.8k / 52.9k / 2.75M |
| regex-log | 10/10 | 10/10 | 944.9k / 230.4k / 163.5k / 135.5k / 714.5k | 1.23M / 134.5k / 134.3k / 111.4k / 1.09M |

## Failures

- Skein: `fix-git` / `net=on` / r4 — premature stop (found the dangling commit, did not merge); `fix-ocaml-gc` / `net=on` / r5 — `max_turns` (65).
- opencode: `db-wal-recovery` / `net=off` / r2 and r4 — `reward=0`.

## Method notes

- `input` = prompt tokens as reported (includes cache read).
- `fresh input` = input − cache read; this is what the provider prices as fresh prompt.
- `output` includes hidden reasoning; `visible` = output − reasoning.
- `total` = input + output.
- Totals include every run unless the section says "solved only". Failed runs can dominate a task (e.g. the two failed opencode `db-wal-recovery` runs).
- Skein cost is the provider-reported ruble cost; opencode cost is estimated with the fitted price model.
- `crack-7z-hash` / `net=off` is unsupported (10 cells) and excluded from runnable totals.

