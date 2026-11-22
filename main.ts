// Driver: the program the harness runs, `node /bot/main.ts` on Node 22.
//
// It reads every case from the input directory, answers each one alone with
// run() from solve.js, and writes the answers in order to the output
// directory. Outside a container the two directories come from
// MAKEFUN_INPUT_DIR and MAKEFUN_OUTPUT_DIR instead of /input and /output.
//
// V8's incremental marking is switched off before solve.js is imported, so
// all of its work runs under that flag, as the house baseline's driver does.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';

setFlagsFromString('--no-incremental-marking');

type CaseInput = { id: string; input: unknown };
type Runner = (input: unknown) => unknown;

const loaded = (await import(new URL('./solve.js', import.meta.url).href)) as {
  run: Runner;
};
const run = loaded.run;

const inDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const raw = readFileSync(join(inDir, 'cases.json'), 'utf8');
const cases = JSON.parse(raw) as CaseInput[];
const answers: unknown[] = [];
for (let i = 0; i < cases.length; i += 1) answers.push(run(cases[i].input));
writeFileSync(join(outDir, 'answers.json'), JSON.stringify(answers));
