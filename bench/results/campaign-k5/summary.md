# Skein campaign — 2026-11-13T10:43:43.116Z

## Protocol

- **generatedAt**: 2026-11-13T10:43:43.116Z
- **gitCommit**: 059734f63f7bb99fc7fdbe13ba169d676d26fdd8
- **node**: v22.22.1
- **skeinModel**: ~deepseek/deepseek-v4-flash-latest
- **skeinReasoningEffort**: low
- **opencodeModel**: routerai/~deepseek/deepseek-v4-flash-latest
- **opencodeReasoningEffort**: low
- **agents**: skein,opencode
- **nets**: on,off
- **repeat**: 5
- **concurrency**: 10
- **taskConcurrency**: fix-ocaml-gc=3
- **tasks**: regex-log,fix-git,log-summary-date-ranges,openssl-selfsigned-cert,git-leak-recovery,cobol-modernization,modernize-scientific-stack,fix-ocaml-gc,custom-memory-heap-crash,password-recovery,crack-7z-hash,db-wal-recovery,fix-code-vulnerability
- **resume**: true
- **timeout**: none
- **finishedAt**: 2026-11-13T13:24:11.733Z

## Overall

| agent/net | runs | solved | turns | cost | in | fresh | out | rsn | statuses |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---|
| skein/on | 65 | 63/65 | 14 | 0.704₽ | 77.3k | 22.1k | 4.1k | 2.0k | ok:63 reward0:2 |
| skein/off | 60 | 60/60 | 15 | 1.000₽ | 88.7k | 25.0k | 7.3k | 4.3k | ok:60 unsupported:5 |
| opencode/on | 65 | 65/65 | 9 | - | 115.0k | 10.4k | 3.0k | 1.7k | ok:65 |
| opencode/off | 60 | 58/60 | 9 | - | 104.8k | 10.4k | 2.7k | 1.3k | ok:58 reward0:2 unsupported:5 |

Cells: 260 · runs: 250 · solved: 246 · cost: 182.72₽

## By task

| task | agent/net | runs | solved | turns | cost | in | fresh | out | rsn | statuses |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---|
| regex-log | skein/on | 5 | 5/5 | 11 | 1.431₽ | 60.9k | 19.2k | 13.4k | 9.0k | ok:5 |
| regex-log | skein/off | 5 | 5/5 | 10 | 1.924₽ | 87.4k | 22.1k | 21.3k | 17.2k | ok:5 |
| regex-log | opencode/on | 5 | 5/5 | 7 | - | 99.5k | 11.2k | 10.3k | 8.7k | ok:5 |
| regex-log | opencode/off | 5 | 5/5 | 8 | - | 142.1k | 12.3k | 12.5k | 10.9k | ok:5 |
| fix-git | skein/on | 5 | 4/5 | 10 | 0.584₽ | 49.0k | 18.3k | 3.1k | 1.5k | ok:4 reward0:1 |
| fix-git | skein/off | 5 | 5/5 | 13 | 0.632₽ | 72.5k | 20.6k | 3.1k | 1.5k | ok:5 |
| fix-git | opencode/on | 5 | 5/5 | 8 | - | 76.5k | 3.9k | 1.2k | 371 | ok:5 |
| fix-git | opencode/off | 5 | 5/5 | 8 | - | 76.6k | 4.3k | 1.5k | 491 | ok:5 |
| log-summary-date-ranges | skein/on | 5 | 5/5 | 10 | 0.500₽ | 45.3k | 16.3k | 2.6k | 614 | ok:5 |
| log-summary-date-ranges | skein/off | 5 | 5/5 | 10 | 0.514₽ | 49.9k | 17.0k | 2.7k | 798 | ok:5 |
| log-summary-date-ranges | opencode/on | 5 | 5/5 | 4 | - | 50.6k | 7.3k | 776 | 162 | ok:5 |
| log-summary-date-ranges | opencode/off | 5 | 5/5 | 4 | - | 54.4k | 15.5k | 916 | 239 | ok:5 |
| openssl-selfsigned-cert | skein/on | 5 | 5/5 | 11 | 0.510₽ | 40.6k | 15.5k | 2.8k | 699 | ok:5 |
| openssl-selfsigned-cert | skein/off | 5 | 5/5 | 14 | 0.660₽ | 58.2k | 23.7k | 3.9k | 1.0k | ok:5 |
| openssl-selfsigned-cert | opencode/on | 5 | 5/5 | 8 | - | 68.5k | 3.0k | 1.9k | 635 | ok:5 |
| openssl-selfsigned-cert | opencode/off | 5 | 5/5 | 8 | - | 74.8k | 3.2k | 2.1k | 590 | ok:5 |
| git-leak-recovery | skein/on | 5 | 5/5 | 13 | 0.593₽ | 51.0k | 19.7k | 3.2k | 1.6k | ok:5 |
| git-leak-recovery | skein/off | 5 | 5/5 | 9 | 0.390₽ | 29.8k | 12.0k | 2.4k | 1.3k | ok:5 |
| git-leak-recovery | opencode/on | 5 | 5/5 | 6 | - | 52.2k | 2.8k | 1.3k | 503 | ok:5 |
| git-leak-recovery | opencode/off | 5 | 5/5 | 6 | - | 52.9k | 2.8k | 1.5k | 578 | ok:5 |
| cobol-modernization | skein/on | 5 | 5/5 | 40 | 4.549₽ | 1.1M | 86.7k | 37.0k | 20.8k | ok:5 |
| cobol-modernization | skein/off | 5 | 5/5 | 25 | 3.105₽ | 495.5k | 57.4k | 26.9k | 19.0k | ok:5 |
| cobol-modernization | opencode/on | 5 | 5/5 | 25 | - | 613.3k | 36.4k | 26.0k | 18.3k | ok:5 |
| cobol-modernization | opencode/off | 5 | 5/5 | 29 | - | 980.1k | 44.8k | 33.0k | 25.2k | ok:5 |
| modernize-scientific-stack | skein/on | 5 | 5/5 | 10 | 0.507₽ | 43.2k | 17.3k | 2.9k | 920 | ok:5 |
| modernize-scientific-stack | skein/off | 5 | 5/5 | 9 | 0.460₽ | 36.8k | 16.3k | 2.3k | 660 | ok:5 |
| modernize-scientific-stack | opencode/on | 5 | 5/5 | 5 | - | 50.7k | 4.1k | 1.6k | 586 | ok:5 |
| modernize-scientific-stack | opencode/off | 5 | 5/5 | 6 | - | 63.5k | 5.2k | 1.6k | 459 | ok:5 |
| fix-ocaml-gc | skein/on | 5 | 4/5 | 35 | 2.506₽ | 658.8k | 74.7k | 13.7k | 10.4k | ok:4 reward0:1 |
| fix-ocaml-gc | skein/off | 5 | 5/5 | 29 | 1.988₽ | 407.2k | 68.6k | 11.4k | 8.2k | ok:5 |
| fix-ocaml-gc | opencode/on | 5 | 5/5 | 47 | - | 2.6M | 85.1k | 15.5k | 9.3k | ok:5 |
| fix-ocaml-gc | opencode/off | 5 | 5/5 | 29 | - | 962.6k | 52.4k | 12.1k | 8.4k | ok:5 |
| custom-memory-heap-crash | skein/on | 5 | 5/5 | 47 | 3.517₽ | 856.9k | 92.3k | 22.5k | 15.0k | ok:5 |
| custom-memory-heap-crash | skein/off | 5 | 5/5 | 31 | 2.078₽ | 416.1k | 63.9k | 13.6k | 8.2k | ok:5 |
| custom-memory-heap-crash | opencode/on | 5 | 5/5 | 27 | - | 611.9k | 27.7k | 10.1k | 5.9k | ok:5 |
| custom-memory-heap-crash | opencode/off | 5 | 5/5 | 19 | - | 476.5k | 26.5k | 10.1k | 6.7k | ok:5 |
| password-recovery | skein/on | 5 | 5/5 | 17 | 1.760₽ | 217.0k | 43.3k | 13.0k | 10.1k | ok:5 |
| password-recovery | skein/off | 5 | 5/5 | 17 | 1.477₽ | 252.2k | 37.3k | 11.5k | 9.1k | ok:5 |
| password-recovery | opencode/on | 5 | 5/5 | 15 | - | 304.4k | 23.3k | 7.3k | 4.7k | ok:5 |
| password-recovery | opencode/off | 5 | 5/5 | 16 | - | 284.4k | 20.6k | 7.7k | 5.6k | ok:5 |
| crack-7z-hash | skein/on | 5 | 5/5 | 17 | 0.620₽ | 100.6k | 22.1k | 2.8k | 1.2k | ok:5 |
| crack-7z-hash | skein/off | 0 | 0/0 | - | - | - | - | - | - | unsupported:5 |
| crack-7z-hash | opencode/on | 5 | 5/5 | 20 | - | 288.9k | 14.0k | 5.4k | 3.0k | ok:5 |
| crack-7z-hash | opencode/off | 0 | 0/0 | - | - | - | - | - | - | unsupported:5 |
| db-wal-recovery | skein/on | 5 | 5/5 | 11 | 0.653₽ | 51.8k | 19.3k | 3.8k | 2.0k | ok:5 |
| db-wal-recovery | skein/off | 5 | 5/5 | 15 | 1.050₽ | 102.6k | 25.3k | 8.0k | 4.3k | ok:5 |
| db-wal-recovery | opencode/on | 5 | 5/5 | 9 | - | 92.5k | 7.4k | 2.2k | 1.2k | ok:5 |
| db-wal-recovery | opencode/off | 5 | 3/5 | 10 | - | 106.0k | 8.7k | 2.4k | 1.4k | ok:3 reward0:2 |
| fix-code-vulnerability | skein/on | 5 | 5/5 | 16 | 0.704₽ | 92.5k | 25.8k | 2.9k | 1.1k | ok:5 |
| fix-code-vulnerability | skein/off | 5 | 5/5 | 22 | 0.951₽ | 153.2k | 34.3k | 4.0k | 1.8k | ok:5 |
| fix-code-vulnerability | opencode/on | 5 | 5/5 | 10 | - | 127.0k | 10.2k | 2.4k | 1.3k | ok:5 |
| fix-code-vulnerability | opencode/off | 5 | 5/5 | 9 | - | 125.7k | 9.9k | 2.4k | 1.1k | ok:5 |

Notes: `cost` is reported by Skein only (opencode does not expose it); `fresh` is input
minus the provider's prompt cache. A task that requires the network is `unsupported` for
`net=off`. Cells run with no wall-clock timeout; the budget is the task's turn/steps cap.
