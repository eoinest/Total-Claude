/**
 * A source scanner small enough to read in one sitting, for checks that must not be greps.
 *
 * Two of this project's instrument failures were verification-by-grep:
 *
 *   - the `waitForFunction(fn, { timeout: N })` argument-position bug was declared fixed on the
 *     strength of a single-line grep, which sees 3 of the 19 call sites because the rest span
 *     several lines;
 *   - the determinism rule was priced as "grep `src/sim` for `Math.random()`", which counts a
 *     comment that says *"never use `Math.random()`"* as a violation.
 *
 * Both need the same two primitives: know where the comments and strings are, and match
 * parentheses. Neither needs a parser. This is those two primitives and nothing else.
 *
 * It is a lexer, not a parser. It knows about line comments, block comments, the three string
 * quotes, template substitutions, and regex literals. It does not know about types, scope,
 * imports or control flow, and every check built on it inherits that ceiling. Say so in the
 * check's own output rather than letting the reader assume otherwise.
 */

/**
 * Blank out comments and string/template bodies, preserving every byte offset and newline so
 * that an index into the result is an index into the original.
 *
 * Returns `{ code, mask }` where `code` is the blanked source and `mask` is a Uint8Array of
 * the same length: 0 = code, 1 = comment, 2 = string or template body, 3 = regex literal.
 * Template *substitutions* (`${...}`) are left as code, because that is where the interesting
 * expressions hide.
 */
export const scan = (src) => {
  const n = src.length;
  const out = src.split('');
  const mask = new Uint8Array(n);
  // Template nesting: each open template pushes a frame; `${` inside one pushes a brace depth.
  const tmpl = [];
  let i = 0;
  // Last significant code character, used to tell a regex literal from a division.
  let prev = '';

  const blank = (from, to, kind) => {
    for (let k = from; k < to; k++) {
      mask[k] = kind;
      if (out[k] !== '\n') out[k] = ' ';
    }
  };

  while (i < n) {
    const c = src[i];
    const c2 = src[i + 1];

    if (c === '/' && c2 === '/') {
      let j = i;
      while (j < n && src[j] !== '\n') j++;
      blank(i, j, 1);
      i = j;
      continue;
    }
    if (c === '/' && c2 === '*') {
      let j = i + 2;
      while (j < n && !(src[j] === '*' && src[j + 1] === '/')) j++;
      j = Math.min(n, j + 2);
      blank(i, j, 1);
      i = j;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n) {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === c || src[j] === '\n') break;
        j++;
      }
      blank(i + 1, j, 2);
      i = Math.min(n, j + 1);
      prev = c;
      continue;
    }
    if (c === '`') {
      tmpl.push(0);
      i++;
      // Body runs to the next unescaped ` or ${
      let j = i;
      while (j < n) {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === '`' || (src[j] === '$' && src[j + 1] === '{')) break;
        j++;
      }
      blank(i, j, 2);
      i = j;
      if (src[i] === '`') { tmpl.pop(); i++; prev = '`'; }
      else { i += 2; }             // step over `${`, leaving the substitution as code
      continue;
    }
    if (c === '}' && tmpl.length && tmpl[tmpl.length - 1] === 0) {
      // Close of a `${...}`: back into template body.
      i++;
      let j = i;
      while (j < n) {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === '`' || (src[j] === '$' && src[j + 1] === '{')) break;
        j++;
      }
      blank(i, j, 2);
      i = j;
      if (src[i] === '`') { tmpl.pop(); i++; prev = '`'; }
      else { i += 2; }
      continue;
    }
    if (c === '{' && tmpl.length) { tmpl[tmpl.length - 1]++; i++; prev = c; continue; }
    if (c === '}' && tmpl.length && tmpl[tmpl.length - 1] > 0) {
      tmpl[tmpl.length - 1]--; i++; prev = c; continue;
    }
    if (c === '/' && regexAllowedAfter(prev)) {
      let j = i + 1, cls = false, ok = false;
      while (j < n) {
        const d = src[j];
        if (d === '\\') { j += 2; continue; }
        if (d === '\n') break;
        if (cls) { if (d === ']') cls = false; }
        else if (d === '[') cls = true;
        else if (d === '/') { ok = true; break; }
        j++;
      }
      if (ok) {
        blank(i + 1, j, 3);
        i = j + 1;
        while (i < n && /[a-z]/.test(src[i])) i++;   // flags
        prev = '/';
        continue;
      }
    }
    if (!/\s/.test(c)) prev = c;
    i++;
  }
  return { code: out.join(''), mask };
};

/**
 * Can a `/` at this point start a regex literal? True after an operator, an opening bracket or
 * a comma; false after a value. Wrong in a handful of exotic cases (`return/re/`, a `)` closing
 * an `if`), all of which merely mis-blank a division and none of which occur in this tree.
 */
const regexAllowedAfter = (prev) =>
  prev === '' || '([{,;:=!&|?+-*%~^<>'.includes(prev);

/** 1-based line number of a byte offset. */
export const lineOf = (src, idx) => {
  let line = 1;
  for (let k = 0; k < idx && k < src.length; k++) if (src[k] === '\n') line++;
  return line;
};

/**
 * Every call to `.<method>(`, with its arguments split at top-level commas.
 *
 * This is the part a grep cannot do. Depth is tracked over `()`, `[]` and `{}` in the
 * comment- and string-blanked source, so a call whose arguments span ten lines, contain
 * object literals, arrow functions and nested calls, still yields the right argument list.
 *
 * Returns `[{ index, line, args: [{ text, code, index, commaIndex, line }], text }]`, where an
 * argument's `index` is its first non-space character and `commaIndex` is the separator before
 * it. An unterminated call (which means the file does not parse) is skipped, not guessed at.
 */
export const findCalls = (src, method) => {
  const { code } = scan(src);
  const needle = `.${method}(`;
  const calls = [];
  let at = 0;
  for (;;) {
    const hit = code.indexOf(needle, at);
    if (hit < 0) break;
    at = hit + needle.length;
    // Guard against `.waitForFunctionish(` — require a non-identifier char before the dot's
    // method name end, which `needle` already pins, and a word boundary before the dot.
    const open = hit + needle.length - 1;
    let d = 0, j = open;
    const argStarts = [];
    let close = -1;
    for (; j < code.length; j++) {
      const ch = code[j];
      if (ch === '(' || ch === '[' || ch === '{') { d++; if (d === 1) argStarts.push(j + 1); }
      else if (ch === ')' || ch === ']' || ch === '}') { d--; if (d === 0) { close = j; break; } }
      else if (ch === ',' && d === 1) argStarts.push(j + 1);
    }
    if (close < 0) continue;
    const bounds = [];
    for (let k = 0; k < argStarts.length; k++) {
      const s = argStarts[k];
      const e = k + 1 < argStarts.length ? argStarts[k + 1] - 1 : close;
      bounds.push([s, e]);
    }
    // `index` is the first non-space character of the argument, not the character after the
    // separating comma — a fixer that rewrites an argument needs the former.
    const args = bounds
      .map(([s, e]) => {
        const raw = code.slice(s, e);
        const lead = raw.length - raw.trimStart().length;
        return { text: src.slice(s, e).trim(), code: raw.trim(), index: s + lead, commaIndex: s - 1 };
      })
      .filter((a, k, arr) => !(arr.length === 1 && a.code === ''));   // `foo()` has no args
    for (const a of args) a.line = lineOf(src, a.index);
    calls.push({
      index: hit,
      line: lineOf(src, hit),
      args,
      text: src.slice(hit, close + 1),
    });
  }
  return calls;
};
