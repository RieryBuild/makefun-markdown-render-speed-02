// main.ts — the program the harness runs for this entry.
//
// The harness runs `node /bot/main.ts` on Node 22 with the case set
// mounted at /input and /output writable. This file loads the cases,
// renders each one through parse(), and stores the resulting HTML
// strings in order in html.json. When the entry runs outside a
// container, MAKEFUN_INPUT_DIR and MAKEFUN_OUTPUT_DIR take the place
// of /input and /output — the same two variables the kit's baseline
// driver reads.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

type CaseDoc = { id: string; markdown: string };

// Read the case list, render every case on its own, and persist the
// HTML strings as a JSON array in the cases' order.
function main(): void {
  const inDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
  const outDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
  const docs = JSON.parse(
    readFileSync(join(inDir, 'cases.json'), 'utf8'),
  ) as CaseDoc[];
  const html: string[] = [];
  for (const doc of docs) {
    html.push(parse(doc.markdown));
  }
  writeFileSync(join(outDir, 'html.json'), JSON.stringify(html));
}

main();
