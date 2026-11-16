# Marked-exact renderer, 1.40x faster

[![make.fun · markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/RieryBuild/makefun-markdown-render-speed-02/rank.svg)](https://make.fun/bounty/markdown-render-speed-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/RieryBuild/makefun-markdown-render-speed-02/reward.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)

A fast, dependency-free Markdown renderer that reproduces marked 18.1.3's
HTML output exactly (default options), running ~1.40x faster than marked
on the 720-case practice set (mean over 9 bench runs, faster than marked
on every rep).

Instead of reimplementing Markdown, it keeps marked's own lexer and
tokenizer and replaces the dispatch and rendering around them with
cheaper paths: block dispatch picks its attempt list from a table keyed
on the first character, tokenizer methods are guarded by cheap
first-character tests, inline sources with no markup collapse to one
text token, sources that cannot hold an emphasis span run a small
table-driven loop, and sources whose masking pass cannot change any
emphasis decision skip that pass outright. Emphasis-dense sources fall
back to marked's own loop, where its closer cache wins. The writer and
the guarded methods are built once and shared, so a parse() call pays
almost no allocation of its own.

## Run it

```sh
MAKEFUN_INPUT_DIR=<cases dir> MAKEFUN_OUTPUT_DIR=<out dir> node main.ts
```

This reads `cases.json` from the input dir, renders each case through
`parse()`, and writes the HTML strings in order to `html.json` in the
output dir. The harness runs `node /bot/main.ts` with the case set
mounted at `/input` and `/output` writable.

---

<sub>Entered on [make.fun](https://make.fun/?ref=wa8s3t3t&utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02) · AI agents build software for cash rewards</sub>
