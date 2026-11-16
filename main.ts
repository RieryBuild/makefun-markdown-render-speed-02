// main.ts — the program the harness runs for this entry.
//
// The harness runs `node /bot/main.ts` on Node 22 with the case set
// mounted at /input and /output writable. This file loads the cases,
// renders each one through parse(), and stores the resulting HTML
// strings in order in html.json. When the entry runs outside a
// container, MAKEFUN_INPUT_DIR and MAKEFUN_OUTPUT_DIR take the place
// of /input and /output — the same two variables the kit's baseline
// driver reads.
//
// Nothing here is timed by the competition except through parse():
// the driver is deliberately plain — read the whole case list once,
// render every case on its own in the cases' order, write one JSON
// array — so the measured speed is the renderer's, not the driver's.
// Only Node builtins are used; there is no install step and no
// dependency beyond parse.js and the vendored marked copy it reads.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

// One case from cases.json: an id the harness uses to match outputs,
// and the markdown to render.
type CaseDoc = { id: string; markdown: string };

// The two directories the driver reads from and writes to. Inside
// the harness container they are /input and /output; outside it the
// MAKEFUN_* variables stand in, defaulting to the same paths so a
// bare `node main.ts` behaves like the container run.
const INPUT_DIR: string = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR: string = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// Read and parse the case list. The file is a JSON array of
// {id, markdown} objects; the parse here is the driver's only
// JSON.parse, and it happens once up front so no case's render time
// includes it. A file that is not an array is a hard failure —
// silently rendering nothing would score zero cases instead of
// surfacing the broken input.
function readCases(): CaseDoc[] {
  const raw: string = readFileSync(join(INPUT_DIR, 'cases.json'), 'utf8');
  const docs: unknown = JSON.parse(raw);
  if (!Array.isArray(docs)) throw new Error('cases.json is not an array');
  return docs as CaseDoc[];
}

// Render every case on its own through parse() and collect the HTML
// strings in the cases' order. Each case is rendered alone — no
// state is shared between calls, exactly as the harness scores it —
// and the result array is indexed, not pushed, so the output order
// can never drift from the input order.
function renderAll(docs: CaseDoc[]): string[] {
  const html: string[] = new Array<string>(docs.length);
  for (let i = 0; i < docs.length; i += 1) {
    html[i] = parse(docs[i].markdown);
  }
  return html;
}

// Persist the rendered HTML as one JSON array in the output dir.
// The harness reads html.json and matches entries to cases by
// position, so the array keeps the cases' order exactly. The output
// directory is created if it does not exist yet, so a fresh mount
// never fails the write.
function saveHtml(html: string[]): void {
  mkdirSync(OUTPUT_DIR, { recursive: true });
  writeFileSync(join(OUTPUT_DIR, 'html.json'), JSON.stringify(html));
}

// The whole run, in order: load the cases, render them, write the
// output. No arguments are read and no other I/O happens — the
// harness owns the directories, this file only moves data through
// them.
function run(): void {
  const docs: CaseDoc[] = readCases();
  const html: string[] = renderAll(docs);
  saveHtml(html);
}

run();
