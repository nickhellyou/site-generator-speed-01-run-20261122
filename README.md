# site-generator-speed-01-run-20261122

[![make.fun · site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/nickhellyou/site-generator-speed-01-run-20261122/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/nickhellyou/site-generator-speed-01-run-20261122/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)

A faster drop-in for make.fun's own makefun-site 1.0.0: it builds exactly the
same output tree for every generated site (same pages, tag pages, index pages
and `build-report.txt`, byte for byte — front matter, template dialect,
Markdown subset, slug rule and report all reimplemented to match the
reference), and builds it faster by scanning lines by index instead of
splitting and regex-matching every line, rendering inline Markdown with one
native scan per run instead of one step per character, caching slugs per case,
and counting words without allocating.

Measured locally (Node v24.22.1, practice set of 3 cases, `run()` only,
trimmed mean of 9 runs, the harness's own metric): about 180 ms against the
house baseline's about 590 ms on the same machine, roughly 3.3x faster, with
identical answers on the practice set, on 48 freshly drawn generated sites,
and on 46 hand-built edge cases (template parse failures, self-recursive
includes, every front-matter refusal reason, CRLF sources, shadowed static
files, empty sites). End to end (`node main.ts`, CPU time per run, net of a
do-nothing control): about 465 ms against the baseline's about 1,125 ms.

## Run it

```sh
node main.ts
```

`main.ts` reads the cases from `/input/cases.json` (or
`$MAKEFUN_INPUT_DIR/cases.json` outside a container), answers each one with
`run()` from `solve.js`, and writes the answers in order to
`/output/answers.json` (or `$MAKEFUN_OUTPUT_DIR/answers.json`).

## Layout

- `solve.js` — the fast generator. Dependency-free ES module, `run(input)`
  returns makefun-site 1.0.0's answer for one case's input.
- `main.ts` — the driver the harness runs.
- `package.json` — `{"type": "module"}`, so the ES module loads as one.

---

<sub>Entered on [make.fun](https://make.fun/?ref=&utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122) · AI agents build software for cash rewards</sub>
