// Fast drop-in for makefun-site 1.0.0 (site-generator-speed-01-run-20261122).
//
// A from-scratch reimplementation of makefun-site's build, written for speed:
// index-based line scanning instead of split/regex per line, run-sliced inline
// rendering instead of per-character escaping, and a per-case slug cache. The
// semantics follow the reference program (vendor/makefun-site) exactly; where
// the README and the code differ, the code wins, as the rules state.
//
// No dependencies, no I/O, no clock, no randomness. Pure: run(input) depends
// on its input alone, and nothing is kept from one case to the next.

const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** The report file every build writes. */
export const REPORT_FILE = 'build-report.txt';

/** The top-level directories the generator writes itself. */
const RESERVED = ['posts', 'tags', 'page'];

// ------------------------------------------------------------------ text

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const HAS_SPECIAL = /[&<>"']/;

/** `text` with & < > " and ' escaped. Fast path when nothing needs escaping. */
function escapeHtml(text) {
  if (!HAS_SPECIAL.test(text)) return text;
  return text.replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

const SLUG_MAX = 64;
const MARKS = /\p{M}/gu;
const ASCII_ONLY = /^[\x00-\x7f]*$/;

/**
 * The slug of `text`: NFKD, combining marks dropped, A-Z lowered, every run
 * of characters other than a-z and 0-9 one "-", none at either end, at most 64
 * characters (a "-" left at the cut dropped), "untitled" when nothing is left.
 * `cache` is the calling case's slug cache.
 */
function slugify(text, cache) {
  const hit = cache.get(text);
  if (hit !== undefined) return hit;
  const plain = ASCII_ONLY.test(text) ? text : text.normalize('NFKD').replace(MARKS, '');
  let out = '';
  let gap = false;
  for (let i = 0; i < plain.length; i++) {
    const c = plain.charCodeAt(i);
    let keep = -1;
    if (c >= 65 && c <= 90) keep = c + 32;
    else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) keep = c;
    if (keep === -1) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += String.fromCharCode(keep);
  }
  if (out.length > SLUG_MAX) out = out.slice(0, SLUG_MAX).replace(/-+$/, '');
  else out = out.replace(/-+$/, '');
  if (out === '') out = 'untitled';
  cache.set(text, out);
  return out;
}

/** `slug` made unique against `taken` (and added to it). */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** A YYYY-MM-DD date in words, from the string alone. */
function longDate(date) {
  const y = date.slice(0, 4);
  const m = Number(date.slice(5, 7));
  const d = Number(date.slice(8, 10));
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

/** The words of a body: its runs of characters other than whitespace.
 * Counted by hand, no array: a /\S+/g match allocates one string per word. */
function wordsOf(text) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    const ws = c === 32 || (c >= 9 && c <= 13) || c === 0x00a0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff;
    if (ws) inWord = false;
    else if (!inWord) {
      inWord = true;
      n++;
    }
  }
  return n;
}

/** `rel` from the directory `dir` of a source, or null when it climbs out. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  const segs = rel.split('/');
  for (let k = 0; k < segs.length; k++) {
    const seg = segs[k];
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

const dirOf = (path) => {
  const i = path.lastIndexOf('/');
  return i === -1 ? '' : path.slice(0, i);
};

// ------------------------------------------------------------------ front matter

const KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const NAME_RE = /^[a-z0-9-]+$/;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TAG_RE = /^[^"[\]]+$/;

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A string value: "..." with \" and \\ its only escapes, or bare. */
function stringOf(raw) {
  if (raw.charCodeAt(0) === 34) {
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** One key's value, or why it is refused. */
function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const m = DATE_RE.exec(raw);
      const y = m ? Number(m[1]) : 0;
      const mo = m ? Number(m[2]) : 0;
      const d = m ? Number(m[3]) : 0;
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',');
      for (let i = 0; i < tags.length; i++) tags[i] = tags[i].trim();
      for (let i = 0; i < tags.length; i++) {
        if (tags[i] === '' || !TAG_RE.test(tags[i])) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      }
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return NAME_RE.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return SLUG_RE.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

function isSpaceTab(c) {
  return c === 32 || c === 9;
}

/**
 * A source's front matter and body: { data, body }, or { error }.
 * `text` has "\n" line ends. Scans lines by index; only the front matter
 * (a few lines) is ever sliced per line, the body is one slice.
 */
function parseFrontMatter(text) {
  // First line must be exactly '---'.
  let nl = text.indexOf('\n');
  const firstEnd = nl === -1 ? text.length : nl;
  if (text.slice(0, firstEnd) !== '---') return { error: 'no front matter' };
  let pos = firstEnd + (nl === -1 ? 0 : 1);
  if (nl === -1) return { error: 'the front matter is not closed' };
  const data = {};
  let lineNo = 1; // the opening '---' is line 1
  for (;;) {
    nl = text.indexOf('\n', pos);
    const end = nl === -1 ? text.length : nl;
    const line = text.slice(pos, end);
    lineNo++;
    if (line === '---') {
      const body = nl === -1 ? '' : text.slice(nl + 1);
      if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
      return { data, body };
    }
    // Blank (spaces/tabs only) or a comment: skipped.
    let blank = true;
    for (let i = 0; i < line.length; i++) {
      if (!isSpaceTab(line.charCodeAt(i))) { blank = false; break; }
    }
    if (!blank && line.charCodeAt(0) !== 35) {
      // Must be "key: value": a key of a-z and _, a colon, one space, the value.
      let k = 0;
      while (k < line.length) {
        const c = line.charCodeAt(k);
        if ((c >= 97 && c <= 122) || c === 95) k++;
        else break;
      }
      if (k === 0 || line.charCodeAt(k) !== 58) return { error: `line ${lineNo} is not "key: value"` };
      const key = line.slice(0, k);
      let raw;
      if (k + 1 === line.length) raw = '';
      else if (line.charCodeAt(k + 1) === 32) raw = line.slice(k + 2);
      else return { error: `line ${lineNo} is not "key: value"` };
      // Trailing spaces and tabs dropped.
      let r = raw.length;
      while (r > 0 && isSpaceTab(raw.charCodeAt(r - 1))) r--;
      if (r < raw.length) raw = raw.slice(0, r);
      if (!KEYS.includes(key)) return { error: `unknown key "${key}"` };
      if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
      if (raw === '') return { error: `key "${key}" has no value` };
      const v = valueOf(key, raw);
      if ('error' in v) return v;
      data[key] = v.value;
    }
    if (nl === -1) return { error: 'the front matter is not closed' };
    pos = nl + 1;
  }
}

// ------------------------------------------------------------------ Markdown

const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);
const WHITE_RE = /\s/;

/** The first index from `from` where `s` holds `what` outside an escape, or -1. */
function findUnescaped(s, what, from) {
  for (let j = from; j <= s.length - what.length; j++) {
    if (s[j] === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

/** The first single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from) {
  for (let j = from; j < s.length; j++) {
    const c = s[j];
    if (c === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (c !== '*') continue;
    if (s[j + 1] === '*') {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

/**
 * `s` rendered inline; `env.link(target)` is a link's href.
 * Plain runs are found by one native regex scan and copied by slice; only
 * markup and the five HTML-escaped characters are handled one by one. The
 * scan regex is shared, but every call sets lastIndex before each exec and
 * after each handled character, so the recursive calls for nested markup
 * cannot disturb the caller's scan.
 */
const SPECIAL_RE = /[\\`*\[&<>"']/g;

function inlineStr(s, env, out) {
  const n = s.length;
  const re = SPECIAL_RE;
  re.lastIndex = 0;
  let i = 0;
  let m;
  while ((m = re.exec(s)) !== null) {
    const j = m.index;
    if (j > i) out.push(s.slice(i, j));
    const code = s.charCodeAt(j);
    if (code === 92) { // backslash
      if (j + 1 < n && ESCAPABLE.has(s[j + 1])) {
        out.push(s[j + 1]);
        i = j + 2;
      } else {
        out.push('\\');
        i = j + 1;
      }
      re.lastIndex = i;
      continue;
    }
    if (code === 96) { // backtick: code span
      const k = s.indexOf('`', j + 1);
      if (k > j + 1) {
        out.push('<code>', escapeHtml(s.slice(j + 1, k)), '</code>');
        i = k + 1;
      } else {
        out.push('`');
        i = j + 1;
      }
      re.lastIndex = i;
      continue;
    }
    if (code === 42) { // star: strong or emphasis
      if (s.charCodeAt(j + 1) === 42) {
        const k = findUnescaped(s, '**', j + 2);
        if (k > j + 2) {
          out.push('<strong>');
          inlineStr(s.slice(j + 2, k), env, out);
          out.push('</strong>');
          i = k + 2;
        } else {
          out.push('**');
          i = j + 2;
        }
      } else {
        const k = findSingleStar(s, j + 1);
        if (k > j + 1) {
          out.push('<em>');
          inlineStr(s.slice(j + 1, k), env, out);
          out.push('</em>');
          i = k + 1;
        } else {
          out.push('*');
          i = j + 1;
        }
      }
      re.lastIndex = i;
      continue;
    }
    if (code === 91) { // link
      const k = findUnescaped(s, ']', j + 1);
      const t = k !== -1 && s.charCodeAt(k + 1) === 40 ? s.indexOf(')', k + 2) : -1;
      const target = t === -1 ? '' : s.slice(k + 2, t);
      if (target !== '' && !WHITE_RE.test(target)) {
        out.push('<a href="', escapeHtml(env.link(target)), '">');
        inlineStr(s.slice(j + 1, k), env, out);
        out.push('</a>');
        i = t + 1;
      } else {
        out.push('[');
        i = j + 1;
      }
      re.lastIndex = i;
      continue;
    }
    // One of & < > " '.
    out.push(ESCAPES[s[j]]);
    i = j + 1;
    re.lastIndex = i;
  }
  if (i < n) out.push(s.slice(i));
}

function inline(s, env) {
  const out = [];
  inlineStr(s, env, out);
  return out.join('');
}

// Line helpers over (src, start, end) without slicing the line.
function isBlankLine(src, start, end) {
  for (let i = start; i < end; i++) {
    const c = src.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

function isLangChar(c) {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45;
}

/** A fence-open's language, or null when the line is not a fence-open. */
function fenceLang(src, start, end) {
  if (end - start < 3 || src.charCodeAt(start) !== 96 || src.charCodeAt(start + 1) !== 96 || src.charCodeAt(start + 2) !== 96) return null;
  let j = start + 3;
  while (j < end && isLangChar(src.charCodeAt(j))) j++;
  const langEnd = j;
  while (j < end && isSpaceTab(src.charCodeAt(j))) j++;
  return j === end ? src.slice(start + 3, langEnd) : null;
}

/** Whether the line is a fence-close: three backticks, spaces/tabs only after. */
function isFenceClose(src, start, end) {
  if (end - start < 3 || src.charCodeAt(start) !== 96 || src.charCodeAt(start + 1) !== 96 || src.charCodeAt(start + 2) !== 96) return false;
  let j = start + 3;
  while (j < end && isSpaceTab(src.charCodeAt(j))) j++;
  return j === end;
}

/** A heading line's { depth, textStart, textEnd }, or null. */
function headingInfo(src, start, end) {
  let k = start;
  while (k < end && src.charCodeAt(k) === 35) k++;
  const depth = k - start;
  if (depth < 1 || depth > 6) return null;
  if (k >= end || !isSpaceTab(src.charCodeAt(k))) return null;
  let t = k;
  while (t < end && isSpaceTab(src.charCodeAt(t))) t++;
  let e = end;
  while (e > t && isSpaceTab(src.charCodeAt(e - 1))) e--;
  if (e === t) return null;
  return { depth, textStart: t, textEnd: e };
}

/** Whether the line is a thematic break: --- or ***, spaces/tabs only after. */
function isHr(src, start, end) {
  if (end - start < 3) return false;
  const a = src.charCodeAt(start);
  if (a !== 45 && a !== 42) return false;
  if (src.charCodeAt(start + 1) !== a || src.charCodeAt(start + 2) !== a) return false;
  let j = start + 3;
  while (j < end && isSpaceTab(src.charCodeAt(j))) j++;
  return j === end;
}

/** Whether the line continues a list item: two or more spaces, then a non-space. */
function isContinued(src, start, end) {
  if (end - start < 3) return false;
  if (src.charCodeAt(start) !== 32 || src.charCodeAt(start + 1) !== 32) return false;
  let j = start + 2;
  while (j < end && src.charCodeAt(j) === 32) j++;
  return j < end && !/\s/.test(src[j]);
}

/** Whether `line` ends a paragraph: blank, a fence, a heading or a break. */
function endsParagraph(src, start, end) {
  return isBlankLine(src, start, end) || fenceLang(src, start, end) !== null || headingInfo(src, start, end) !== null || isHr(src, start, end);
}

/** A line trimmed of spaces and tabs at both ends. */
function trimLine(src, start, end) {
  let a = start;
  let b = end;
  while (a < b && isSpaceTab(src.charCodeAt(a))) a++;
  while (b > a && isSpaceTab(src.charCodeAt(b - 1))) b--;
  return src.slice(a, b);
}

/**
 * `src` rendered: its HTML, its table of contents (level 2 and 3 headings)
 * and its excerpt (the first paragraph's inline HTML, or "").
 * Lines are scanned by index; no line array is ever built. The page's HTML
 * is accumulated in one array and joined once; inline rendering writes
 * straight into it, except the first paragraph, whose HTML the excerpt needs
 * as a string of its own.
 */
function renderMarkdown(src, env, slugCache) {
  const ids = new Set();
  const out = [];
  const toc = [];
  let excerpt = null;
  const n = src.length;
  let pos = 0;
  let start, end, after, nl;
  while (pos < n) {
    start = pos;
    nl = src.indexOf('\n', pos);
    end = nl === -1 ? n : nl;
    after = nl === -1 ? n : nl + 1;
    if (isBlankLine(src, start, end)) {
      pos = after;
      continue;
    }
    const lang = fenceLang(src, start, end);
    if (lang !== null) {
      out.push(`<pre><code${lang === '' ? '' : ` class="language-${escapeHtml(lang)}"`}>`);
      pos = after;
      while (pos < n) {
        start = pos;
        nl = src.indexOf('\n', pos);
        end = nl === -1 ? n : nl;
        after = nl === -1 ? n : nl + 1;
        if (isFenceClose(src, start, end)) {
          pos = after;
          break;
        }
        out.push(escapeHtml(src.slice(start, end)), '\n');
        pos = after;
      }
      out.push('</code></pre>\n');
      continue;
    }
    const h = headingInfo(src, start, end);
    if (h !== null) {
      const text = src.slice(h.textStart, h.textEnd);
      const id = uniqueSlug(slugify(text, slugCache), ids);
      const html = inline(text, env);
      out.push(`<h${h.depth} id="${id}">`, html, `</h${h.depth}>\n`);
      if (h.depth === 2 || h.depth === 3) toc.push({ level: h.depth, id, html });
      pos = after;
      continue;
    }
    if (isHr(src, start, end)) {
      out.push('<hr>\n');
      pos = after;
      continue;
    }
    if (src.charCodeAt(start) === 62) { // blockquote
      const lines = [];
      while (pos < n) {
        start = pos;
        nl = src.indexOf('\n', pos);
        end = nl === -1 ? n : nl;
        after = nl === -1 ? n : nl + 1;
        if (src.charCodeAt(start) !== 62) break;
        let s = start + 1;
        if (s < end && src.charCodeAt(s) === 32) s++;
        const t = trimLine(src, s, end);
        if (t !== '') lines.push(t);
        pos = after;
      }
      if (lines.length === 0) out.push('<blockquote>\n</blockquote>\n');
      else {
        out.push('<blockquote>\n<p>');
        inlineStr(lines.join('\n'), env, out);
        out.push('</p>\n</blockquote>\n');
      }
      continue;
    }
    // List: '- ' / '* ' bullet, or digits + '. ' ordered.
    const ch0 = src.charCodeAt(start);
    let ordered = false;
    let startNum = 1;
    let isList = false;
    if ((ch0 === 45 || ch0 === 42) && start + 1 < end && src.charCodeAt(start + 1) === 32) {
      isList = true;
    } else if (ch0 >= 48 && ch0 <= 57) {
      let d = start;
      while (d < end && src.charCodeAt(d) >= 48 && src.charCodeAt(d) <= 57) d++;
      if (d - start >= 1 && d - start <= 9 && d + 1 < end && src.charCodeAt(d) === 46 && src.charCodeAt(d + 1) === 32) {
        isList = true;
        ordered = true;
        startNum = Number(src.slice(start, d));
      }
    }
    if (isList) {
      const items = [];
      while (pos < n) {
        start = pos;
        nl = src.indexOf('\n', pos);
        end = nl === -1 ? n : nl;
        after = nl === -1 ? n : nl + 1;
        const c0 = src.charCodeAt(start);
        let itemStart = -1;
        if (!ordered && (c0 === 45 || c0 === 42) && start + 1 < end && src.charCodeAt(start + 1) === 32) itemStart = start + 2;
        else if (ordered && c0 >= 48 && c0 <= 57) {
          let d = start;
          while (d < end && src.charCodeAt(d) >= 48 && src.charCodeAt(d) <= 57) d++;
          if (d - start >= 1 && d - start <= 9 && d + 1 < end && src.charCodeAt(d) === 46 && src.charCodeAt(d + 1) === 32) itemStart = d + 2;
        }
        if (itemStart !== -1) {
          items.push([trimLine(src, itemStart, end)]);
          pos = after;
        } else if (isContinued(src, start, end)) {
          // A continuation: two or more spaces, then a non-space.
          items[items.length - 1].push(trimLine(src, start, end));
          pos = after;
        } else break;
      }
      const tag = ordered ? 'ol' : 'ul';
      out.push(ordered && startNum !== 1 ? `<ol start="${startNum}">` : `<${tag}>`, '\n');
      for (let k = 0; k < items.length; k++) {
        out.push('<li>');
        inlineStr(items[k].join('\n'), env, out);
        out.push('</li>\n');
      }
      out.push(`</${tag}>\n`);
      continue;
    }
    // Paragraph: lines up to a blank line, a fence, a heading or a break.
    const parts = [trimLine(src, start, end)];
    pos = after;
    while (pos < n) {
      start = pos;
      nl = src.indexOf('\n', pos);
      end = nl === -1 ? n : nl;
      after = nl === -1 ? n : nl + 1;
      if (endsParagraph(src, start, end)) break;
      parts.push(trimLine(src, start, end));
      pos = after;
    }
    const text = parts.join('\n');
    if (excerpt === null) {
      const html = inline(text, env);
      excerpt = html;
      out.push('<p>', html, '</p>\n');
    } else {
      out.push('<p>');
      inlineStr(text, env, out);
      out.push('</p>\n');
    }
  }
  return { html: out.join(''), toc, excerpt: excerpt ?? '' };
}

// ------------------------------------------------------------------ templates

/** The deepest an include nests: one past it renders nothing. */
const INCLUDE_DEPTH = 8;

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR_RE.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF_RE.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE_RE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

/** The value at `path` in the scope chain. */
function lookup(scope, path) {
  let s = scope;
  while (s !== null && !Object.hasOwn(s.vars, path[0])) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** A value as text. */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/** `nodes` rendered in `scope` into `out`. */
function renderNodes(nodes, scope, ctx, depth, out) {
  for (let ni = 0; ni < nodes.length; ni++) {
    const n = nodes[ni];
    switch (n.kind) {
      case 'text':
        out.push(n.text);
        break;
      case 'var':
        out.push(escapeHtml(textOf(lookup(scope, n.path))));
        break;
      case 'raw':
        out.push(textOf(lookup(scope, n.path)));
        break;
      case 'if': {
        const v = truthy(lookup(scope, n.path));
        const branch = v !== n.not ? n.then : n.else;
        if (branch !== null) renderNodes(branch, scope, ctx, depth, out);
        break;
      }
      case 'for': {
        const xs = lookup(scope, n.path);
        if (!Array.isArray(xs)) break;
        for (let k = 0; k < xs.length; k++) {
          const vars = { [n.name]: xs[k], loop: { index: k + 1, first: k === 0, last: k === xs.length - 1, length: xs.length } };
          renderNodes(n.body, { vars, parent: scope }, ctx, depth, out);
        }
        break;
      }
      case 'include': {
        const t = ctx.templates.get(n.name);
        if (t !== undefined && depth < INCLUDE_DEPTH) renderNodes(t, scope, ctx, depth + 1, out);
        break;
      }
    }
  }
}

// ------------------------------------------------------------------ the build

/** A page's link record as templates read it. */
function linkOf(s, slugCache) {
  if (s === null) return null;
  return { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) };
}

/** One site's output tree: path -> text. */
export function run(input) {
  const slugCache = new Map();
  const templates = new Map();
  const report = [];
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const base = input.site.base_url.replace(/\/+$/, '');

  // 1. Sources, in code-unit order of their paths, line ends made "\n".
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  let sources = [];
  const statics = [];
  for (let fi = 0; fi < files.length; fi++) {
    const f = files[fi];
    if (f.path.endsWith('.md')) {
      let text = f.content;
      if (text.indexOf('\r') !== -1) text = text.replace(/\r\n?/g, '\n');
      sources.push({ path: f.path, text });
    } else statics.push({ path: f.path, content: f.content });
  }

  // 2. Front matter, reserved directories, post dates, layouts, drafts.
  const kept = [];
  for (let si = 0; si < sources.length; si++) {
    const s = sources[si];
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    let own;
    if (s.path.startsWith('tags/')) own = 'tags';
    else if (s.path.startsWith('page/')) own = 'page';
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }
  sources = kept;

  // 3. Permalinks: slugs made unique in their directory, in source order.
  const taken = new Map();
  const bySource = new Map();
  for (let si = 0; si < sources.length; si++) {
    const s = sources[si];
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    s.slug = uniqueSlug(s.data.slug ?? slugify(s.data.title, slugCache), set);
    s.outDir = dir === '' ? s.slug : `${dir}/${s.slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // 4. Markdown, links resolved to the pages and static files they name.
  const staticPaths = new Set();
  for (let fi = 0; fi < statics.length; fi++) staticPaths.add(statics[fi].path);
  const broken = new Set();
  for (let si = 0; si < sources.length; si++) {
    const s = sources[si];
    const dir = dirOf(s.path);
    const env = {
      link: (target) => {
        if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(target) || target.startsWith('/') || target.startsWith('#')) return target;
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        const path = rel === '' ? null : resolvePath(dir, rel);
        if (path !== null && bySource.has(path)) return `${bySource.get(path).url}${frag}`;
        if (path !== null && staticPaths.has(path)) return `${base}/${path}${frag}`;
        broken.add(`broken-link ${s.path} -> ${target}`);
        return target;
      },
    };
    const md = renderMarkdown(s.body, env, slugCache);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // 5. Collections: posts, newest first, then by slug; newer/older neighbours.
  const posts = [];
  for (let si = 0; si < sources.length; si++) if (sources[si].post) posts.push(sources[si]);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  for (let k = 0; k < posts.length; k++) {
    posts[k].newer = k === 0 ? null : posts[k - 1];
    posts[k].older = k === posts.length - 1 ? null : posts[k + 1];
  }

  // 6. Tags, grouped by slug, ordered by count then slug.
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    const tags = s.data.tags ?? [];
    for (let i = 0; i < tags.length; i++) {
      const name = tags[i];
      const slug = slugify(name, slugCache);
      if (!seen.has(slug)) {
        seen.add(slug);
        out.push(name);
      }
    }
    return out;
  };
  for (let pi = 0; pi < posts.length; pi++) {
    const p = posts[pi];
    p.tagRefs = [];
    const names = ownTags(p);
    for (let i = 0; i < names.length; i++) {
      const name = names[i];
      const slug = slugify(name, slugCache);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (let si = 0; si < sources.length; si++) {
    const s = sources[si];
    if (s.post) continue;
    const names = ownTags(s);
    s.tagRefs = [];
    for (let i = 0; i < names.length; i++) {
      const name = names[i];
      const slug = slugify(name, slugCache);
      s.tagRefs.push(bySlug.get(slug) ?? { name, slug, url: '', posts: [] });
    }
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // Cards, once per post.
  const cardOf = (s) => ({
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil((s._words ??= wordsOf(s.body)) / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  });
  const cards = new Map();
  for (let pi = 0; pi < posts.length; pi++) cards.set(posts[pi], cardOf(posts[pi]));

  // 7. Layouts: pages, index pages, tag pages, then the static files.
  const output = {};
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const ctx = { templates, escape: escapeHtml };
  // The base scope every render sees (site, tags, recent); each render adds
  // its own vars as the child scope, which the lookup checks first — the
  // same as spreading them into one object, without the copy per render.
  const baseScope = { vars: { site, tags: allTags, recent }, parent: null };
  const render = (name, vars) => {
    const nodes = templates.get(name);
    if (nodes === undefined) return null;
    const out = [];
    renderNodes(nodes, { vars, parent: baseScope }, ctx, 0, out);
    return out.join('');
  };
  const pageOf = (s) => {
    // A post's card is the one built once above; a page's is built once here
    // and kept on the source, so the word count and tag records are not
    // recomputed for every render.
    const card = s.post ? cards.get(s) : (s._card ??= cardOf(s));
    return {
      ...card,
      slug: s.slug,
      content: s.html,
      toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
      newer: linkOf(s.newer ?? null, slugCache),
      older: linkOf(s.older ?? null, slugCache),
      is_post: s.post,
    };
  };
  for (let si = 0; si < sources.length; si++) {
    const s = sources[si];
    output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s) });
  }
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (let ti = 0; ti < tags.length; ti++) {
    const t = tags[ti];
    const html = render('tag', { tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) } });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (let fi = 0; fi < statics.length; fi++) {
    const f = statics[fi];
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // 8. The report.
  const lines = [...report, ...broken].sort(byCodeUnits);
  let pageCount = 0;
  for (let si = 0; si < sources.length; si++) if (!sources[si].post) pageCount++;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output[REPORT_FILE] = `${lines.join('\n')}\n`;
  return output;
}
