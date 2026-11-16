# Marked-exact renderer, 1.27x faster

[![make.fun · markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/RieryBuild/makefun-markdown-render-speed-02/rank.svg)](https://make.fun/bounty/markdown-render-speed-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/RieryBuild/makefun-markdown-render-speed-02/reward.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)

A fast, dependency-free Markdown renderer that reproduces marked 18.1.3's
HTML output exactly (default options), running ~1.27x faster than marked
on the 720-case practice set.

Instead of reimplementing Markdown, it keeps marked's own lexer and
tokenizer and replaces the dispatch and rendering around them with
cheaper paths: block dispatch switches on the first character,
inline sources with no markup collapse to one text token, sources
that cannot hold an emphasis span run a small switch loop, and
sources whose masking pass cannot change any emphasis decision skip
that pass outright. Emphasis-dense sources fall back to marked's own
loop, where its closer cache wins.

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
