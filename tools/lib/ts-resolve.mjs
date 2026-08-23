/**
 * Let a Node script import the tree's own TypeScript modules by their real specifiers.
 *
 * `src/` is written for Vite, so every relative import is extensionless — `./ways`, not
 * `./ways.ts`. Node's ESM resolver will not guess, so a plain
 * `node --experimental-strip-types tools/scratch/foo.mjs` that imports anything under `src/`
 * fails on the first hop. This hook appends `.ts` (then `/index.ts`) when the bare specifier
 * does not resolve, and does nothing else.
 *
 * **Why it is worth having.** The alternative, and the repository's habit until now, is for an
 * offline tool to *re-implement* what it grades: `tools/scratch/free-land.mjs` carries its own
 * copy of `districtMask`, and `probe-fabric`'s own header names that as the shape of check
 * this project's most expensive failures take — an instrument that can agree with a stale copy
 * of the thing it is checking. With this, a scratch tool imports the shipped module and grades
 * *it*.
 *
 * It is a development convenience, not a build step: nothing in `src/` or in the shipped
 * bundle knows it exists, and `vite` still owns the real resolution.
 *
 *   node --experimental-strip-types --import ./tools/lib/ts-resolve.mjs tools/scratch/foo.mjs
 */
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';

const source = `
export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (err) {
    if (!specifier.startsWith('.') && !specifier.startsWith('/')) throw err;
    for (const suffix of ['.ts', '/index.ts', '.js']) {
      try {
        return await nextResolve(specifier + suffix, context);
      } catch { /* try the next one */ }
    }
    throw err;
  }
}
`;

register(`data:text/javascript,${encodeURIComponent(source)}`, pathToFileURL('./'));
