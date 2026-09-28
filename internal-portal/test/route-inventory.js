'use strict';

/**
 * Fail-closed route registration inventory.
 *
 * The previous extractor was a single regex — `/app\.(get|post|...)\(\s*'([^']+)'/g`
 * — which silently ignored double-quoted paths, backtick paths, `router.*`,
 * `app.route(...).get(...)` chains, array registrations, and any path held in a
 * variable. Because the same incomplete set fed duplicate detection, route
 * coverage, and the OpenAPI comparison, one unparsed registration could vanish
 * from all three gates at once.
 *
 * This module is a character-level JavaScript scanner. It walks the source,
 * tracking string / template / regex / comment state, and only matches a
 * registration when it is certain the match is code and not text. Anything it
 * cannot resolve is reported in `unresolved` and callers fail closed on it.
 *
 * No parser dependency is available in this repo (no acorn/espree/@babel), and
 * package/lock are out of scope, so the scanner is hand-written. It is
 * deliberately conservative: it would rather report an unresolved registration
 * (loud failure) than skip one (silent hole).
 */

const fs = require('node:fs');
const path = require('node:path');

const ROUTE_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'all', 'head', 'options']);
const PORTAL_ROOT = path.join(__dirname, '..');
const APP_FILE = path.join(PORTAL_ROOT, 'src', 'app.js');
const ENTERPRISE_FILE = path.join(PORTAL_ROOT, 'src', 'enterprise-routes.js');
const SOURCE_FILES = [APP_FILE, ENTERPRISE_FILE];

/** Tracks source position so we can report 1-indexed line numbers. */
function makeLocator(source) {
  const lineStarts = [0];
  for (let i = 0; i < source.length; i += 1) if (source[i] === '\n') lineStarts.push(i + 1);
  return (index) => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= index) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
}

/**
 * Walk the source once, yielding only positions that are real code.
 * Returns an array of "code" booleans is too large; instead we classify spans.
 */
function scanTokens(source) {
  // Produces a list of { start, end, type } for string/template literals and
  // comments, so the caller can skip them when matching identifiers.
  const spans = [];
  let i = 0;
  const n = source.length;
  // Track the last significant code char to disambiguate `/` as regex vs divide.
  let lastSignificant = '';

  while (i < n) {
    const ch = source[i];
    const next = source[i + 1];

    if (ch === '/' && next === '/') {
      const start = i;
      while (i < n && source[i] !== '\n') i += 1;
      spans.push({ start, end: i, type: 'comment' });
      continue;
    }
    if (ch === '/' && next === '*') {
      const start = i;
      i += 2;
      while (i < n && !(source[i] === '*' && source[i + 1] === '/')) i += 1;
      i = Math.min(n, i + 2);
      spans.push({ start, end: i, type: 'comment' });
      continue;
    }
    if (ch === '"' || ch === "'") {
      const start = i;
      const quote = ch;
      i += 1;
      while (i < n) {
        if (source[i] === '\\') { i += 2; continue; }
        if (source[i] === quote) { i += 1; break; }
        i += 1;
      }
      spans.push({ start, end: i, type: 'string' });
      lastSignificant = 'literal';
      continue;
    }
    if (ch === '`') {
      const start = i;
      i += 1;
      let depth = 0;
      while (i < n) {
        if (source[i] === '\\') { i += 2; continue; }
        if (source[i] === '`' && depth === 0) { i += 1; break; }
        if (source[i] === '$' && source[i + 1] === '{') { depth += 1; i += 2; continue; }
        if (source[i] === '}' && depth > 0) { depth -= 1; i += 1; continue; }
        i += 1;
      }
      spans.push({ start, end: i, type: 'template' });
      lastSignificant = 'literal';
      continue;
    }
    if (ch === '/' && canStartRegex(lastSignificant)) {
      // Regex literal - skip so its body is not scanned as code.
      const start = i;
      i += 1;
      let inClass = false;
      while (i < n) {
        if (source[i] === '\\') { i += 2; continue; }
        if (source[i] === '[') inClass = true;
        else if (source[i] === ']') inClass = false;
        else if (source[i] === '/' && !inClass) { i += 1; break; }
        else if (source[i] === '\n') break;
        i += 1;
      }
      while (i < n && /[a-z]/.test(source[i])) i += 1;
      spans.push({ start, end: i, type: 'regex' });
      lastSignificant = 'literal';
      continue;
    }
    if (!/\s/.test(ch)) lastSignificant = ch;
    i += 1;
  }
  return spans;
}

function canStartRegex(lastSignificant) {
  if (lastSignificant === '') return true;
  if ('(,=:[!&|?{};+-*%<>~^'.includes(lastSignificant)) return true;
  return false;
}

function isInSpan(spans, index) {
  let lo = 0;
  let hi = spans.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (spans[mid].end <= index) lo = mid + 1;
    else if (spans[mid].start > index) hi = mid - 1;
    else return spans[mid];
  }
  return null;
}

/** Read a string/template literal starting at `start`; return its static value. */
function readLiteral(source, start, end) {
  const raw = source.slice(start, end);
  const first = raw[0];
  if (first === '`') {
    // A template with ${...} is dynamic; a plain template is static.
    if (raw.includes('${')) return { value: null, dynamic: true };
    return { value: raw.slice(1, -1), dynamic: false };
  }
  if (raw.includes('\\')) return { value: null, dynamic: true };
  return { value: raw.slice(1, -1), dynamic: false };
}

/** Split top-level arguments of a call whose `(` is at openIdx. */
function splitArgs(source, openIdx) {
  const spans = scanTokens(source.slice(openIdx));
  const args = [];
  let depth = 0;
  let current = { start: openIdx + 1, end: openIdx + 1 };
  for (let i = openIdx; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    else if (ch === ')' || ch === ']' || ch === '}') {
      depth -= 1;
      if (depth === 0) { current.end = i; args.push(current); break; }
    } else if (ch === ',' && depth === 1) {
      current.end = i; args.push(current);
      current = { start: i + 1, end: i + 1 };
    }
  }
  void spans;
  return args;
}

/**
 * Extract every Express route registration from one file.
 * Returns { routes, unresolved }.
 */
function scanRouteRegistrations(file) {
  const source = fs.readFileSync(file, 'utf8');
  const spans = scanTokens(source);
  const lineAt = makeLocator(source);
  const routes = [];
  const unresolved = [];
  const rel = path.relative(PORTAL_ROOT, file).split(path.sep).join('/');

  const n = source.length;
  const IDENT = /[A-Za-z0-9_$]/;
  // Skip whitespace AND comments between tokens. `app.get /* gap */ ('/x', h)`
  // is valid JavaScript; skipping only whitespace silently dropped it, which
  // disproved the module's fail-closed guarantee and could hide a duplicate.
  const skipWs = (idx) => {
    let p2 = idx;
    for (;;) {
      while (p2 < n && /\s/.test(source[p2])) p2 += 1;
      if (source[p2] === '/' && source[p2 + 1] === '/') { while (p2 < n && source[p2] !== '\n') p2 += 1; continue; }
      if (source[p2] === '/' && source[p2 + 1] === '*') {
        const end = source.indexOf('*/', p2 + 2);
        if (end === -1) return n;
        p2 = end + 2;
        continue;
      }
      return p2;
    }
  };

  // Read a member-access tail starting at `idx` (which must point at the first
  // character after the receiver identifier). Returns:
  //   { kind, verb, callIdx, consumed }  on a recognised call shape
  //   null                                when this is not a route-like call
  // Covers every form a route registration can take:
  //   recv.verb(            recv ?. verb(          recv ['verb'](
  //   recv.verb ?.(         recv ['verb'] ?.(      recv [dyn](
  //   recv ?. ['verb'] ?.(  recv [ 'verb' ] .(     recv [dyn] ?.
  // A computed member with a static verb is fully knowable, so it is inventoried.
  // A computed member with a dynamic key, or any optional form, is NOT knowable
  // and is reported `unresolved` — never skipped.
  function readMemberCall(idx, receiverName) {
    let p = idx;
    let optionalChain = false;
    if (source[p] === '?' && source[p + 1] === '.') { optionalChain = true; p = skipWs(p + 2); }
    // Dot form: `.verb` (or `?.verb`, already handled above).
    if (source[p] === '.') p = skipWs(p + 1);
    let verb = null;
    let computed = false;
    if (source[p] === '[') {
      computed = true;
      const close = matchBracket(source, p, '[', ']', spans);
      if (close === -1) return null;
      const inner = source.slice(p + 1, close).trim();
      const lit = literalAt(source, inner, spans);
      if (lit && !lit.dynamic && ROUTE_METHODS.has(lit.value)) verb = lit.value;
      p = skipWs(close + 1);
    } else if (IDENT.test(source[p] || '')) {
      let k = p;
      while (k < n && IDENT.test(source[k])) k += 1;
      const name = source.slice(p, k);
      if (!ROUTE_METHODS.has(name)) return null;
      verb = name;
      p = skipWs(k);
    } else {
      return null;
    }
    // optional call marker:  ?.(
    if (source[p] === '?' && source[p + 1] === '.') { optionalChain = true; p = skipWs(p + 2); }
    else if (source[p] === '.') { p = skipWs(p + 1); if (source[p] === '?' && source[p + 1] === '.') { optionalChain = true; p = skipWs(p + 2); } }
    if (source[p] !== '(') return null;
    void optionalChain;
    return { verb, computed, callIdx: p };
  }

  /** Find the index of the bracket matching the opener at `open`, or -1. */
  function matchBracket(src, open, o, c, spanList) {
    let depth = 0;
    for (let i = open; i < src.length; i += 1) {
      if (spanList && isInSpan(spanList, i)) { i = spanList.find((x) => x.start === i).end - 1; continue; }
      if (src[i] === o) depth += 1;
      else if (src[i] === c) { depth -= 1; if (depth === 0) return i; }
    }
    return -1;
  }

  let i = 0;
  while (i < n) {
    const span = isInSpan(spans, i);
    if (span) { i = span.end; continue; }
    const ch = source[i];
    if (IDENT.test(ch) && (i === 0 || !/[A-Za-z0-9_$]/.test(source[i - 1]))) {
      let j = i;
      while (j < n && IDENT.test(source[j])) j += 1;
      const receiverName = source.slice(i, j);
      if (isInSpan(spans, j)) { i = j; continue; }
      const call = readMemberCall(j, receiverName);
      if (!call) { i = Math.max(j, i + 1); continue; }
      const { verb, computed, callIdx } = call;
      const chain = receiverName;
      const snippet = source.slice(callIdx, Math.min(source.length, callIdx + 70)).split('\n')[0].trim();

      // A computed member whose verb we could not resolve statically: we know a
      // call happens here but not which route it registers. Fail closed.
      if (computed && !verb) {
        unresolved.push({ file: rel, line: lineAt(callIdx), receiver: chain, verb: null, reason: 'computed-member-verb-unresolved', snippet });
        i = callIdx + 1;
        continue;
      }

      const args = splitArgs(source, callIdx);
      const first = args[0];
      if (!first) {
        unresolved.push({ file: rel, line: lineAt(callIdx), receiver: chain, verb, reason: 'no-arguments', snippet });
        i = callIdx + 1;
        continue;
      }
      const trimmed = source.slice(first.start, first.end).trim();
      if (trimmed.startsWith('[')) {
        const inner = trimmed.replace(/^\[/, '').replace(/\]$/, '');
        const parts = inner.split(',').map((x) => x.trim()).filter(Boolean);
        for (const part of parts) {
          const lit = literalAt(source, part, spans);
          if (lit && !lit.dynamic) routes.push({ method: verb.toUpperCase(), path: lit.value, file: rel, line: lineAt(callIdx), receiver: chain });
          else unresolved.push({ file: rel, line: lineAt(callIdx), receiver: chain, verb, reason: 'dynamic-array-entry', snippet });
        }
        i = callIdx + 1;
        continue;
      }
      if (/^[A-Za-z_$][A-Za-z0-9_$.]*$/.test(trimmed)) {
        unresolved.push({ file: rel, line: lineAt(callIdx), receiver: chain, verb, reason: `path-in-variable:${trimmed}`, snippet });
        i = callIdx + 1;
        continue;
      }
      const lit = literalAt(source, trimmed, spans);
      if (lit && !lit.dynamic) routes.push({ method: verb.toUpperCase(), path: lit.value, file: rel, line: lineAt(callIdx), receiver: chain });
      else unresolved.push({ file: rel, line: lineAt(callIdx), receiver: chain, verb, reason: lit ? 'dynamic-template' : 'unparsed-argument', snippet });
      i = callIdx + 1;
      continue;
    }
    i += 1;
  }
  return { routes, unresolved };
}

/** If `text` is a quoted literal present in source, return its value. */
function literalAt(source, text, spans) {
  const first = text[0];
  if (first !== '"' && first !== "'" && first !== '`') return null;
  const start = source.indexOf(text);
  if (start === -1) return { value: null, dynamic: true };
  const span = spans.find((s) => s.start === start && s.end === start + text.length);
  if (!span) return { value: null, dynamic: true };
  return readLiteral(source, start, span.end);
}

// ---- app.route('/x').get(...) chain expansion --------------------------------

function expandRouteChains(file) {
  const source = fs.readFileSync(file, 'utf8');
  const spans = scanTokens(source);
  const lineAt = makeLocator(source);
  const rel = path.relative(PORTAL_ROOT, file).split(path.sep).join('/');
  const extra = [];
  const unresolved = [];
  const re = /\.route\s*\(/g;
  let m;
  while ((m = re.exec(source)) !== null) {
    if (isInSpan(spans, m.index)) continue;
    const openIdx = m.index + m[0].length - 1;
    const args = splitArgs(source, openIdx);
    if (!args.length) continue;
    const lit = literalAt(source, args[0].start === undefined ? '' : source.slice(args[0].start, args[0].end).trim(), spans);
    // Walk the chain for `.get(`, `.post(` etc.
    let k = openIdx;
    let depth = 0;
    for (let i = openIdx; i < Math.min(source.length, openIdx + 400); i += 1) {
      if (source[i] === '(') depth += 1;
      else if (source[i] === ')') { depth -= 1; if (depth === 0) { k = i; break; } }
    }
    const tail = source.slice(k + 1, Math.min(source.length, k + 400));
    const chainRe = /\.((?:get|post|put|patch|delete|all|head|options))\s*\(/g;
    let cm;
    let any = false;
    while ((cm = chainRe.exec(tail)) !== null) {
      any = true;
      if (lit && !lit.dynamic) {
        extra.push({ method: cm[1].toUpperCase(), path: lit.value, file: rel, line: lineAt(k + 1 + cm.index), receiver: 'route-chain' });
      } else {
        unresolved.push({ file: rel, line: lineAt(m.index), receiver: 'app.route', verb: cm[1], reason: 'dynamic-route-path', snippet: tail.slice(0, 60).trim() });
      }
    }
    if (!any) unresolved.push({ file: rel, line: lineAt(m.index), receiver: 'app.route', verb: 'route', reason: 'route-chain-without-verb', snippet: tail.slice(0, 60).trim() });
  }
  return { routes: extra, unresolved };
}

function inventoryFor(files = SOURCE_FILES) {
  const list = Array.isArray(files) ? files : [files];
  const routes = [];
  const unresolved = [];
  for (const file of list) {
    const direct = scanRouteRegistrations(file);
    routes.push(...direct.routes);
    unresolved.push(...direct.unresolved);
    const chains = expandRouteChains(file);
    routes.push(...chains.routes);
    unresolved.push(...chains.unresolved);
  }
  return { routes, unresolved };
}

function normalisePath(p) {
  return p.length > 1 ? String(p).replace(/\/+$/, '') : String(p);
}

function keyOf(route) {
  return `${route.method} ${normalisePath(route.path)}`;
}

module.exports = {
  inventoryFor,
  scanRouteRegistrations,
  normalisePath,
  keyOf,
  ROUTE_METHODS,
  SOURCE_FILES,
  APP_FILE,
  ENTERPRISE_FILE,
  PORTAL_ROOT,
};
