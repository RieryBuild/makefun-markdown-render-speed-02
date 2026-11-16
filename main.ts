// Driver for the markdown-render-speed-02 entry.
//
// The harness executes `node /bot/main.ts` on Node 22, with the
// practice or scored set mounted at /input and a writable /output.
// The driver loads every case from cases.json, renders each one on
// its own through parse(), and stores the resulting HTML strings —
// in the cases' order — in html.json. When the entry runs outside a
// container, MAKEFUN_INPUT_DIR and MAKEFUN_OUTPUT_DIR take the place
// of /input and /output (the kit's own baseline driver reads the same
// two variables).
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

type CaseDoc = { id: string; markdown: string };

// Where the harness mounts its data; overridable for local runs.
function inputDir(): string {
  return process.env.MAKEFUN_INPUT_DIR ?? '/input';
}

function outputDir(): string {
  return process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
}

// Read and decode the case list from a directory.
function loadCases(dir: string): CaseDoc[] {
  const raw = readFileSync(join(dir, 'cases.json'), 'utf8');
  return JSON.parse(raw) as CaseDoc[];
}

// Render every case on its own and gather the HTML strings in the
// cases' order.
function renderCases(docs: CaseDoc[]): string[] {
  const out: string[] = [];
  for (const doc of docs) {
    out.push(parse(doc.markdown));
  }
  return out;
}

// Persist the rendered HTML strings as a JSON array.
function writeResults(dir: string, html: string[]): void {
  writeFileSync(join(dir, 'html.json'), JSON.stringify(html));
}

function main(): void {
  const docs = loadCases(inputDir());
  const html = renderCases(docs);
  writeResults(outputDir(), html);
}

main();
