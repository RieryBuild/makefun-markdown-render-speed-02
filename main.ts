// Driver for the markdown-render-speed-02 entry: reads every case from
// /input/cases.json, renders each one alone with parse(), and writes the
// HTML strings in the cases' order to /output/html.json.
//
// Outside a container, MAKEFUN_INPUT_DIR / MAKEFUN_OUTPUT_DIR stand in for
// /input and /output (the kit's baseline driver does the same).
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const cases = JSON.parse(readFileSync(join(INPUT_DIR, 'cases.json'), 'utf8')) as { id: string; markdown: string }[];
// Preallocate the output array and fill it by index: the driver holds the
// full result set either way, and a fixed-size array avoids the push growth.
const html: string[] = new Array(cases.length);
for (let i = 0; i < cases.length; i++) html[i] = parse(cases[i].markdown);
writeFileSync(join(OUTPUT_DIR, 'html.json'), JSON.stringify(html));
