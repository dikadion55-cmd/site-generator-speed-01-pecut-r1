// Fast drop-in for makefun-site 1.0.0 (site-generator-speed-01-run-20261122).
//
// Same answers as the reference, byte for byte, but built for speed:
//  - templates are compiled once per case into straight-line JS (includes
//    inlined, loop bindings resolved at compile time, no scope-chain walk);
//  - Markdown is rendered in one fused pass (no token tree, bulk text runs,
//    one escape pass per run instead of one regex replace per character);
//  - slug/date/link results are memoised per case (the generator reuses tag
//    names, titles, headings and link targets heavily);
//  - front matter is scanned line by line instead of splitting the body.
//
// Everything below re-implements the reference semantics exactly (README.md
// of makefun-site 1.0.0 is the spec, its code the reference where they differ).

const RESERVED = ['posts', 'tags', 'page'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// ---------------------------------------------------------------- text

const ESC_RE = /[&<>"']/;
const ESC_RE_G = /[&<>"']/g;
const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

function esc(s) {
  if (!ESC_RE.test(s)) return s;
  return s.replace(ESC_RE_G, (c) => ESC_MAP[c]);
}

const SLUG_MAX = 64;

function slugify(S, text) {
  const hit = S.slugCache.get(text);
  if (hit !== undefined) return hit;
  let plain = text;
  let ascii = true;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) >= 128) { ascii = false; break; }
  }
  if (!ascii) plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
  let out = '';
  let gap = false;
  if (ascii) {
    for (let i = 0; i < plain.length; i++) {
      const ch = plain[i];
      let keep = null;
      if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
      else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
      if (keep === null) { gap = out.length > 0; continue; }
      if (gap) out += '-';
      gap = false;
      out += keep;
    }
  } else {
    for (const ch of plain) {
      let keep = null;
      if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
      else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
      if (keep === null) { gap = out.length > 0; continue; }
      if (gap) out += '-';
      gap = false;
      out += keep;
    }
  }
  out = out.slice(0, SLUG_MAX).replace(/-+$/, '');
  if (out === '') out = 'untitled';
  S.slugCache.set(text, out);
  return out;
}

function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

function longDate(S, date) {
  let v = S.dateCache.get(date);
  if (v === undefined) {
    v = `${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`;
    S.dateCache.set(date, v);
  }
  return v;
}

/** The body's words: runs of characters other than whitespace (same as /\S+/g). */
function wordsOf(text) {
  let n = 0;
  let inW = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    const ws = c === 32 || c === 9 || c === 10 || c === 13 || c === 12 || c === 11 || (c > 127 && /\s/.test(text[i]));
    if (ws) inW = false;
    else if (!inW) { inW = true; n++; }
  }
  return n;
}

// ---------------------------------------------------------------- front matter

const FM_KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];
const FM_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const FM_NAME = /^[a-z0-9-]+$/;
const FM_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FM_TAG = /^[^"[\]]+$/;

function fmDaysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

function fmStringOf(raw) {
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

function fmValueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = fmStringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const m = FM_DATE.exec(raw);
      const y = m ? Number(m[1]) : 0;
      const mo = m ? Number(m[2]) : 0;
      const d = m ? Number(m[3]) : 0;
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > fmDaysIn(y, mo)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      if (tags.some((t) => t === '' || !FM_TAG.test(t))) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return FM_NAME.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return FM_SLUG.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

function isBlankLine(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  return line.slice(a, b);
}

/** Parse one front-matter line: { key, raw } or null when it is not "key: value". */
function fmLine(line) {
  let j = 0;
  while (j < line.length) {
    const c = line.charCodeAt(j);
    if ((c >= 97 && c <= 122) || c === 95) j++;
    else break;
  }
  if (j === 0 || line.charCodeAt(j) !== 58) return null;
  let raw;
  if (j + 1 === line.length) raw = '';
  else if (line.charCodeAt(j + 1) === 32) raw = line.slice(j + 2);
  else return null;
  return { key: line.slice(0, j), raw };
}

/**
 * A source's front matter and body: { data, body }, or { error }.
 * Scans lines with indexOf instead of splitting the whole body.
 */
function parseFrontMatter(text) {
  let nl = text.indexOf('\n');
  const first = nl === -1 ? text : text.slice(0, nl);
  if (first !== '---') return { error: 'no front matter' };
  // Find the closing --- line.
  let start = nl === -1 ? text.length : nl + 1;
  let closeStart = -1;
  let closeEnd = -1;
  while (start <= text.length) {
    const e = text.indexOf('\n', start);
    const line = e === -1 ? text.slice(start) : text.slice(start, e);
    if (line === '---') { closeStart = start; closeEnd = e === -1 ? text.length : e; break; }
    if (e === -1) break;
    start = e + 1;
  }
  if (closeStart === -1) return { error: 'the front matter is not closed' };
  const data = {};
  let p = nl === -1 ? text.length : nl + 1;
  let n = 2;
  while (p < closeStart) {
    const e = text.indexOf('\n', p);
    const line = text.slice(p, e);
    if (!isBlankLine(line) && line.charCodeAt(0) !== 35) {
      const kv = fmLine(line);
      if (!kv) return { error: `line ${n} is not "key: value"` };
      const raw = trimLine(kv.raw);
      if (!FM_KEYS.includes(kv.key)) return { error: `unknown key "${kv.key}"` };
      if (Object.hasOwn(data, kv.key)) return { error: `key "${kv.key}" is given twice` };
      if (raw === '') return { error: `key "${kv.key}" has no value` };
      const v = fmValueOf(kv.key, raw);
      if ('error' in v) return v;
      data[kv.key] = v.value;
    }
    p = e + 1;
    n++;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: closeEnd === text.length ? '' : text.slice(closeEnd + 1) };
}

// ---------------------------------------------------------------- markdown

const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);

function findUnescaped(s, what, from) {
  for (let j = from; j <= s.length - what.length; j++) {
    if (s[j] === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) { j++; continue; }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

function findSingleStar(s, from) {
  for (let j = from; j < s.length; j++) {
    const c = s[j];
    if (c === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) { j++; continue; }
    if (c !== '*') continue;
    if (s[j + 1] === '*') { j++; continue; }
    return j;
  }
  return -1;
}

function hasScheme(target) {
  const c0 = target.charCodeAt(0);
  if (!((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122))) return false;
  for (let i = 1; i < target.length; i++) {
    const c = target.charCodeAt(i);
    if (c === 58) return true;
    if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 43 || c === 45 || c === 46)) return false;
  }
  return false;
}

/** `rel` from `dirParts` (dir split on '/'), or null when it climbs out of the root. */
function resolvePath(dirParts, rel) {
  const parts = dirParts.slice();
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

/** A link target's href for the source at `srcPath` (per-case memoised). */
function resolveLink(S, srcPath, dirParts, target) {
  const key = srcPath + '\n' + target;
  const hit = S.linkCache.get(key);
  if (hit !== undefined) return hit;
  let href;
  if (hasScheme(target) || target.charCodeAt(0) === 47 || target.charCodeAt(0) === 35) {
    href = target;
  } else {
    const hash = target.indexOf('#');
    const rel = hash === -1 ? target : target.slice(0, hash);
    const frag = hash === -1 ? '' : target.slice(hash);
    const path = rel === '' ? null : resolvePath(dirParts, rel);
    if (path !== null && S.bySource.has(path)) href = S.bySource.get(path).url + frag;
    else if (path !== null && S.staticPaths.has(path)) href = S.base + '/' + path + frag;
    else {
      S.broken.add(`broken-link ${srcPath} -> ${target}`);
      href = target;
    }
  }
  S.linkCache.set(key, href);
  return href;
}

/** The next inline special (\\ ` * [) at or after `lastIndex`, via one regex scan. */
const SPEC_RE = /[\\`*[]/g;

/** `s` rendered inline; links resolved for the source in S. */
function inline(s, S) {
  let out = '';
  let i = 0;
  const n = s.length;
  while (i < n) {
    // Next markdown special (one regex scan; lastIndex is set before every
    // exec, so the recursion into strong/em/link text cannot corrupt it).
    SPEC_RE.lastIndex = i;
    const hit = SPEC_RE.exec(s);
    const j = hit === null ? n : hit.index;
    if (j > i) {
      out += esc(s.slice(i, j));
      i = j;
      if (i >= n) break;
    }
    const c = s[i];
    if (c === '\\') {
      if (i + 1 < n && ESCAPABLE.has(s[i + 1])) { out += esc(s[i + 1]); i += 2; }
      else { out += '\\'; i++; }
      continue;
    }
    if (c === '`') {
      const m = s.indexOf('`', i + 1);
      if (m > i + 1) { out += '<code>'; out += esc(s.slice(i + 1, m)); out += '</code>'; i = m + 1; }
      else { out += '`'; i++; }
      continue;
    }
    if (c === '*') {
      if (s[i + 1] === '*') {
        const m = findUnescaped(s, '**', i + 2);
        if (m > i + 2) { out += '<strong>'; out += inline(s.slice(i + 2, m), S); out += '</strong>'; i = m + 2; }
        else { out += '**'; i += 2; }
        continue;
      }
      const m = findSingleStar(s, i + 1);
      if (m > i + 1) { out += '<em>'; out += inline(s.slice(i + 1, m), S); out += '</em>'; i = m + 1; }
      else { out += '*'; i++; }
      continue;
    }
    // c === '['
    const kk = findUnescaped(s, ']', i + 1);
    const m = kk !== -1 && s[kk + 1] === '(' ? s.indexOf(')', kk + 2) : -1;
    const target = m === -1 ? '' : s.slice(kk + 2, m);
    if (target !== '' && !/\s/.test(target)) {
      out += '<a href="';
      out += esc(resolveLink(S, S.srcPath, S.dirParts, target));
      out += '">';
      out += inline(s.slice(i + 1, kk), S);
      out += '</a>';
      i = m + 1;
      continue;
    }
    out += '[';
    i++;
  }
  return out;
}

// Line classifiers (char-code checks, no regexes on the hot path).
function fenceOpenOf(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let i = 3;
  let lang = '';
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45) { lang += line[i]; i++; }
    else break;
  }
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return null;
    i++;
  }
  return lang;
}

function fenceCloseOf(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  for (let i = 3; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

function headingOf(line) {
  let h = 0;
  while (h < 6 && line.charCodeAt(h) === 35) h++;
  if (h === 0) return null;
  if (line.charCodeAt(h) === 35) return null;
  const c = line.charCodeAt(h);
  if (c !== 32 && c !== 9) return null;
  let b = line.length;
  while (b > h + 1 && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  let a = h + 1;
  while (a < b && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  if (a >= b) return null;
  return { depth: h, text: line.slice(a, b) };
}

function hrOf(line) {
  const dash = line.charCodeAt(0) === 45 && line.charCodeAt(1) === 45 && line.charCodeAt(2) === 45;
  const star = line.charCodeAt(0) === 42 && line.charCodeAt(1) === 42 && line.charCodeAt(2) === 42;
  if (!dash && !star) return false;
  for (let i = 3; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

function endsParagraph(line) {
  if (isBlankLine(line)) return true;
  const c = line.charCodeAt(0);
  if (c === 96) return fenceOpenOf(line) !== null;
  if (c === 35) return headingOf(line) !== null;
  if (c === 45 || c === 42) return hrOf(line);
  return false;
}

function orderedOf(line) {
  let j = 0;
  while (j < line.length) {
    const c = line.charCodeAt(j);
    if (c >= 48 && c <= 57) j++;
    else break;
  }
  if (j < 1 || j > 9) return null;
  if (line.charCodeAt(j) !== 46 || line.charCodeAt(j + 1) !== 32) return null;
  return { start: Number(line.slice(0, j)), text: line.slice(j + 2) };
}

const CONTINUED = /^ {2,}\S/;

/**
 * `src` rendered: its HTML, table of contents and excerpt.
 * S carries the per-case caches and the current source (srcPath, dirParts).
 */
function renderMarkdown(src, S) {
  const lines = src.split('\n');
  const ids = new Set();
  const blocks = [];
  const toc = [];
  let excerpt = null;
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const line = lines[i];
    if (isBlankLine(line)) { i++; continue; }
    const c0 = line.charCodeAt(0);
    const lang = c0 === 96 ? fenceOpenOf(line) : null;
    if (lang !== null) {
      const body = [];
      i++;
      while (i < n && !fenceCloseOf(lines[i])) body.push(lines[i++]);
      i++;
      const cls = lang === '' ? '' : ` class="language-${esc(lang)}"`;
      blocks.push(`<pre><code${cls}>${body.length === 0 ? '' : esc(body.join('\n')) + '\n'}</code></pre>`);
      continue;
    }
    const heading = c0 === 35 ? headingOf(line) : null;
    if (heading !== null) {
      const id = uniqueSlug(slugify(S, heading.text), ids);
      const html = inline(heading.text, S);
      blocks.push(`<h${heading.depth} id="${id}">${html}</h${heading.depth}>`);
      if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html });
      i++;
      continue;
    }
    if ((c0 === 45 || c0 === 42) && hrOf(line)) { blocks.push('<hr>'); i++; continue; }
    if (c0 === 62) {
      const body = [];
      while (i < n && lines[i].charCodeAt(0) === 62) {
        let l = lines[i++];
        l = l.charCodeAt(1) === 32 ? l.slice(2) : l.slice(1);
        body.push(l);
      }
      const kept = [];
      for (let k = 0; k < body.length; k++) {
        const t = trimLine(body[k]);
        if (t !== '') kept.push(t);
      }
      blocks.push(kept.length === 0 ? '<blockquote>\n</blockquote>' : `<blockquote>\n<p>${inline(kept.join('\n'), S)}</p>\n</blockquote>`);
      continue;
    }
    const bullet = (line.charCodeAt(0) === 45 || line.charCodeAt(0) === 42) && line.charCodeAt(1) === 32;
    const ordered = bullet ? null : orderedOf(line);
    if (bullet || ordered !== null) {
      const isOrdered = ordered !== null;
      const items = [];
      while (i < n) {
        const l = lines[i];
        if (isOrdered) {
          const o = orderedOf(l);
          if (o !== null) { items.push([trimLine(o.text)]); i++; continue; }
        } else if ((l.charCodeAt(0) === 45 || l.charCodeAt(0) === 42) && l.charCodeAt(1) === 32) {
          items.push([trimLine(l.slice(2))]); i++; continue;
        }
        if (CONTINUED.test(l)) { items[items.length - 1].push(trimLine(l)); i++; continue; }
        break;
      }
      const tag = isOrdered ? 'ol' : 'ul';
      const open = isOrdered && ordered.start !== 1 ? `<ol start="${ordered.start}">` : `<${tag}>`;
      let html = `${open}\n`;
      for (let k = 0; k < items.length; k++) html += `<li>${inline(items[k].join('\n'), S)}</li>\n`;
      html += `</${tag}>`;
      blocks.push(html);
      continue;
    }
    const body = [trimLine(line)];
    i++;
    while (i < n && !endsParagraph(lines[i])) body.push(trimLine(lines[i++]));
    const html = inline(body.join('\n'), S);
    if (excerpt === null) excerpt = html;
    blocks.push(`<p>${html}</p>`);
  }
  return { html: blocks.length === 0 ? '' : blocks.join('\n') + '\n', toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------- templates

class TemplateError extends Error {}

const T_PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const T_FOR = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const T_IF = /^if (not )?(\S+)$/;
const T_INCLUDE = /^include "([a-z0-9-]+)"$/;
const INCLUDE_DEPTH = 8;

function pathOf(name, text) {
  if (!T_PATH.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) { text += src.slice(i); break; }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') { text += src.slice(i, open + 1); i = open + 1; continue; }
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
      if ((m = T_FOR.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = T_IF.exec(tag)) !== null) {
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
      } else if ((m = T_INCLUDE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

/** A value as text, HTML-escaped: the {{ }} output. */
function et(v) {
  return esc(txt(v));
}

/** A value as text: string itself, number in JS digits, true/false, array items joined by ", ", else "". */
function txt(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (v === true) return 'true';
  if (v === false) return 'false';
  if (Array.isArray(v)) {
    let s = '';
    for (let k = 0; k < v.length; k++) { if (k) s += ', '; s += txt(v[k]); }
    return s;
  }
  return '';
}

/** Whether a value counts as true in an if. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/** Own-property-safe step: the next name of a value so far, or undefined. */
function gv(v, k) {
  return v !== null && typeof v === 'object' ? v[k] : undefined;
}

// ---- template compiler: AST -> straight-line JS, includes inlined ----

function pathExpr(path, env) {
  let e = env.get(path[0]);
  if (e === undefined) e = 'R.' + path[0];
  for (let k = 1; k < path.length; k++) e = `gv(${e},${JSON.stringify(path[k])})`;
  return e;
}

function genNodes(nodes, env, depth, cx) {
  let code = '';
  for (const n of nodes) {
    if (n.kind === 'text') {
      code += `out.push(${JSON.stringify(n.text)});`;
    } else if (n.kind === 'var') {
      code += `out.push(et(${pathExpr(n.path, env)}));`;
    } else if (n.kind === 'raw') {
      code += `out.push(txt(${pathExpr(n.path, env)}));`;
    } else if (n.kind === 'if') {
      const cond = `${n.not ? '!' : ''}truthy(${pathExpr(n.path, env)})`;
      code += `if(${cond}){${genNodes(n.then, env, depth, cx)}}`;
      if (n.else !== null) code += `else{${genNodes(n.else, env, depth, cx)}}`;
    } else if (n.kind === 'for') {
      const id = cx.uid++;
      const a = `__a${id}`;
      const v = `__v${id}`;
      const L = `__L${id}`;
      const k = `__k${id}`;
      const prevName = env.get(n.name);
      const prevLoop = env.get('loop');
      const arrExpr = pathExpr(n.path, env);
      env.set(n.name, v);
      env.set('loop', L);
      code += `{const ${a}=${arrExpr};if(Array.isArray(${a})){const ${L}={index:0,first:false,last:false,length:${a}.length};for(let ${k}=0;${k}<${a}.length;${k}++){const ${v}=${a}[${k}];${L}.index=${k}+1;${L}.first=${k}===0;${L}.last=${k}===${a}.length-1;${genNodes(n.body, env, depth, cx)}}}}`;
      if (prevName === undefined) env.delete(n.name); else env.set(n.name, prevName);
      if (prevLoop === undefined) env.delete('loop'); else env.set('loop', prevLoop);
    } else if (n.kind === 'include') {
      if (depth < INCLUDE_DEPTH) {
        const target = cx.templates.get(n.name);
        if (target !== undefined) code += genNodes(target, env, depth + 1, cx);
      }
    }
  }
  return code;
}

/** Compile one layout template to a function (R, et, txt, truthy, gv) => string. */
function compileLayout(templates, name) {
  const nodes = templates.get(name);
  if (nodes === undefined) return null;
  const cx = { templates, uid: 0 };
  const body = genNodes(nodes, new Map(), 0, cx);
  return new Function('R', 'et', 'txt', 'truthy', 'gv', `const out=[];${body}return out.join('');`);
}

// ---------------------------------------------------------------- build

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

function linkOf(s, S) {
  return {
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(S, s.data.date),
  };
}

function cardOf(s, S) {
  return {
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(S, s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  };
}

export function run(input) {
  const S = {
    slugCache: new Map(),
    dateCache: new Map(),
    linkCache: new Map(),
    broken: new Set(),
    bySource: new Map(),
    staticPaths: new Set(),
    base: input.site.base_url.replace(/\/+$/, ''),
    srcPath: '',
    dirParts: [],
  };

  // 1. Templates, parsed in code-unit order of name.
  const templates = new Map();
  const report = [];
  const names = Object.keys(input.templates).sort(byCodeUnits);
  for (const name of names) {
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const compiled = new Map();
  const render = (name, vars) => {
    let fn = compiled.get(name);
    if (fn === undefined) {
      fn = compileLayout(templates, name);
      compiled.set(name, fn);
    }
    if (fn === null) return null;
    return fn(vars, et, txt, truthy, gv);
  };

  // 2. Sources, sorted by path; .md sources vs statics.
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) {
      const text = f.content.indexOf('\r') === -1 ? f.content : f.content.replace(/\r\n?/g, '\n');
      sources.push({ path: f.path, text });
    } else statics.push({ path: f.path, content: f.content });
  }
  for (const f of statics) S.staticPaths.add(f.path);

  // 3. Front matter and the refusal checks, in order.
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) { report.push(`refused ${s.path}: ${fm.error}`); continue; }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    const own = s.path.startsWith('tags/') ? 'tags' : s.path.startsWith('page/') ? 'page' : undefined;
    if (own !== undefined) { report.push(`refused ${s.path}: ${own}/ is the generator's own`); continue; }
    if (s.post && !Object.hasOwn(s.data, 'date')) { report.push(`refused ${s.path}: a post needs a date`); continue; }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) { report.push(`refused ${s.path}: layout "${layout}" is no template that parses`); continue; }
    s.layout = layout;
    if (s.data.draft === true) { report.push(`draft ${s.path}`); continue; }
    kept.push(s);
  }

  // 4. Permalinks.
  const taken = new Map();
  const takenIn = (dir) => {
    let set = taken.get(dir);
    if (set === undefined) { set = new Set(dir === '' ? RESERVED : []); taken.set(dir, set); }
    return set;
  };
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    const slug = uniqueSlug(s.data.slug ?? slugify(S, s.data.title), takenIn(dir));
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${S.base}/${s.outDir}/`;
    S.bySource.set(s.path, s);
  }

  // 5. Markdown, links resolved.
  for (const s of kept) {
    S.srcPath = s.path;
    S.dirParts = dirOf(s.path) === '' ? [] : dirOf(s.path).split('/');
    const md = renderMarkdown(s.body, S);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // 6. Collections: posts newest first, equal dates by slug.
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  for (let k = 0; k < posts.length; k++) {
    posts[k].newer = k === 0 ? null : posts[k - 1];
    posts[k].older = k === posts.length - 1 ? null : posts[k + 1];
  }

  // 7. Tags.
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of s.data.tags ?? []) {
      const sl = slugify(S, name);
      if (!seen.has(sl)) { seen.add(sl); out.push(name); }
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(S, name);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${S.base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept) {
    if (s.post) continue;
    s.tagRefs = ownTags(s).map((name) => {
      const slug = slugify(S, name);
      return bySlug.get(slug) ?? { name, slug, url: '', posts: [] };
    });
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // 8. Layouts.
  const output = {};
  const cards = new Map();
  for (const p of posts) cards.set(p, cardOf(p, S));
  const links = new Map();
  for (const p of posts) links.set(p, linkOf(p, S));
  const site = { title: input.site.title, base_url: S.base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const pageOf = (s) => ({
    ...cards.get(s) ?? cardOf(s, S),
    slug: s.slug,
    content: s.html,
    toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
    newer: s.post ? (s.newer === null ? null : links.get(s.newer)) : null,
    older: s.post ? (s.older === null ? null : links.get(s.older)) : null,
    is_post: s.post,
  });
  for (const s of kept) {
    const html = render(s.layout, { site, tags: allTags, recent, page: pageOf(s) });
    output[`${s.outDir}/index.html`] = html;
  }
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${S.base}/` : `${S.base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      site,
      tags: allTags,
      recent,
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', {
      site,
      tags: allTags,
      recent,
      tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) },
    });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', { site, tags: allTags, recent });
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // 9. Report.
  const lines = [...report, ...S.broken].sort(byCodeUnits);
  const pageCount = kept.filter((s) => !s.post).length;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output['build-report.txt'] = `${lines.join('\n')}\n`;
  return output;
}
