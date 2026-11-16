// parse.js — a quick, byte-exact stand-in for marked 18.1.3.
//
// What this file promises: calling parse(md) returns exactly the
// string marked.parse(md) returns when marked runs with its stock
// settings (GFM on, hard breaks off, pedantic off, synchronous).
// It is faster, not different. The reference for "exact" is the
// marked copy vendored at vendor/marked/marked.esm.js, which the kit
// ships unmodified (MIT). If marked and the CommonMark/GFM specs
// disagree somewhere, marked's output is the target — never the
// spec's.
//
// How it gets faster while staying inside marked's own code:
//
//   - Lexing is still marked's Lexer/Tokenizer subclasses. Only the
//     expensive corners are shortcut: block dispatch runs through an
//     if-chain guarded by a first-character kind mask (a tokeniser
//     that cannot match the current first character is never tried),
//     and the two regex-heavy block patterns (table, setext heading)
//     first pass a cheap necessary-condition scan.
//   - Inline sources with nothing inline in them collapse to a single
//     text token with no masking pass and no dispatch. Sources that
//     cannot contain an emphasis or deletion span (fewer than two of
//     each of '*', '_' and '~') run a small if/else dispatch loop
//     instead of marked's try-everything loop. Every other inline
//     tokeniser first looks at the one character it could start with,
//     turning nine hopeless regex attempts per text position into nine
//     single-character tests.
//   - The list tokeniser walks lines by index instead of splitting,
//     and decides the six per-line block starts with one first-
//     character dispatch.
//   - Rendering is a switch on the token type (one small function for
//     blocks, one for inline, one for plain text) instead of building
//     marked's Parser/Renderer objects per call. Same HTML, same
//     escaping, same href cleaning as marked's Renderer.
//   - lex() skips the whole-input CR normalisation when the input has
//     no CR at all, which is the usual case.
//
// Only marked's DEFAULT options are supported. blockTokens and
// inlineTokens hand back to marked for pedantic mode or registered
// extensions; the guards, list(), lex() and the switch renderer do
// not promise anything outside the defaults. Do not reuse this module
// anywhere else.
//
// Every parse() call is independent: no state survives between calls,
// nothing is cached from one case to the next, nothing is written to
// /tmp.
import { Lexer, Tokenizer, defaults } from './vendor/marked/marked.esm.js';

// ---------------------------------------------------------------------------
// HTML escaping and href cleaning — marked's Renderer behaviour.
// ---------------------------------------------------------------------------
const ENTITIES = {};
ENTITIES['&'] = '&amp;';
ENTITIES['<'] = '&lt;';
ENTITIES['>'] = '&gt;';
ENTITIES['"'] = '&quot;';
ENTITIES["'"] = '&#39;';
const lookupEntity = (ch) => ENTITIES[ch];

const ANY_CHAR = /[&<>"']/;
const ANY_CHAR_ALL = /[&<>"']/g;
const NO_AMP_CHAR = /[<>"']/;
const NO_AMP_CHAR_ALL = /[<>"']/g;
const KEEP_CHAR = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/;
const KEEP_CHAR_ALL = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;

// marked's escape(): with `encode`, every & < > " ' becomes an entity;
// without it, an & that already opens an entity reference stays put.
// A string without '&' cannot hold an entity reference, so its
// no-encode test only needs the [<>"'] scan. Pick the test/replace
// pair first, then apply it once.
function escapeHtml(str, encode) {
  let test;
  let global;
  if (encode) {
    test = ANY_CHAR;
    global = ANY_CHAR_ALL;
  } else if (str.indexOf('&') < 0) {
    test = NO_AMP_CHAR;
    global = NO_AMP_CHAR_ALL;
  } else {
    test = KEEP_CHAR;
    global = KEEP_CHAR_ALL;
  }
  return test.test(str) ? str.replace(global, lookupEntity) : str;
}

// marked's href cleaning: encodeURI, with %25 restored to %, or null
// when the URI refuses to encode.
function sanitizeHref(href) {
  try {
    return encodeURI(href).replace(/%25/g, '%');
  } catch {
    return null;
  }
}

const LEADING_WORD = /^\S*/;
const FINAL_NEWLINE = /\n$/;

// ---------------------------------------------------------------------------
// Small string helpers for the lexer and tokeniser.
// ---------------------------------------------------------------------------

// The first line of `s` (up to the first \n, otherwise the whole
// string), located by index instead of by splitting.
function firstLineOf(s) {
  const cut = s.indexOf('\n');
  return cut < 0 ? s : s.slice(0, cut);
}

// How many spaces lead `s`. Tabs do not count: the block patterns
// only allow spaces ahead of a marker.
function countLeadingSpaces(s) {
  let n = 0;
  while (n < s.length && s.charCodeAt(n) === 32) n += 1;
  return n;
}

// Expand the tabs in `s` to spaces, counting columns from `col`
// (marked's tab helper, default column 0). A string with no tab is
// already expanded, so return it untouched instead of rebuilding it
// character by character — the usual case is leading spaces.
function expandTabs(s, col = 0) {
  if (s.indexOf('\t') < 0) return s;
  let out = '';
  let at = col;
  for (let i = 0; i < s.length; i += 1) {
    if (s.charCodeAt(i) === 9) {
      const n = 4 - (at % 4);
      out += ' '.repeat(n);
      at += n;
    } else {
      out += s[i];
      at += 1;
    }
  }
  return out;
}

// Expand the tabs in the leading whitespace of `line` (marked's
// leadingSpaceTab replace). A leading run holding no tab replaces to
// itself, so skip the replace outright in that case.
function expandLeadingTabs(line, rules, col) {
  const lead = /^[\t ]*/.exec(line)[0];
  if (lead.indexOf('\t') < 0) return line;
  return line.replace(rules.other.leadingSpaceTab, (m) => expandTabs(m, col));
}

// Anything that can open an inline token other than plain text: the
// inline stop characters, an autolink or url trigger, or a hard break.
// One regex scan; when it misses, the text holds no inline construct
// at all and is a single text token.
const INLINE_STARTERS = /[\\<!\[`*_~@]|:\/\/|www\.|mailto:|xmpp:| {2}\n/;
function isPlainText(src) {
  return !INLINE_STARTERS.test(src);
}

// A bare http/https word is the one place inlineText stops inside an
// otherwise plain source (its regex has a protocol lookahead with no
// word boundary), so a plain source holding one still goes through
// inlineText.
const HTTP_WORD = /http/i;

// Whether an emphasis or deletion span could form in `src`: each of
// '*', '_' and '~' needs two occurrences, an opener plus a matching
// closer of the same character. Native indexOf scans find the first
// two occurrences directly.
function noEmphasisPossible(src) {
  for (const d of ['*', '_', '~']) {
    const first = src.indexOf(d);
    if (first >= 0 && src.indexOf(d, first + 1) >= 0) return false;
  }
  return true;
}

// Whether the second line of `src` holds a '-'. A table's delimiter
// row sits on the second line and every cell holds at least one '-',
// so without one the table regex cannot match. Slice out just the
// second line and search that (an indexOf for '-' from there would
// run to the end of the document when the line holds no dash).
function hyphenOnSecondLine(src) {
  const first = src.indexOf('\n');
  if (first < 0) return false;
  let stop = src.indexOf('\n', first + 1);
  if (stop < 0) stop = src.length;
  return src.slice(first + 1, stop).indexOf('-') >= 0;
}

// Whether `s` ends with a double blank line: \n, optional spaces or
// tabs, \n, optional spaces or tabs (marked's doubleBlankLine regex,
// matched at the tail instead of scanned backwards with a loop).
const DOUBLE_BLANK_TAIL = /\n[ \t]*\n[ \t]*$/;
function endsWithDoubleBlank(s) {
  return DOUBLE_BLANK_TAIL.test(s);
}

// Whether a setext underline line (0-3 spaces, then '=' or '-') shows
// up inside the current paragraph run — the run stops at the first
// blank line or at the end of the input. The lheading regex needs such
// a line, so without one it cannot match. Walk forward from newline
// to newline by index; a whitespace-only line ends the run, an
// underline line proves the pattern could match.
function setextUnderlineAhead(src) {
  let at = src.indexOf('\n');
  while (at >= 0) {
    let i = at + 1;
    let spaces = 0;
    for (; i < src.length; i += 1) {
      const code = src.charCodeAt(i);
      if (code !== 32 && code !== 9) break;
      spaces += 1;
    }
    if (i >= src.length || src.charCodeAt(i) === 10) return false; // blank line: run ends
    if (spaces <= 3) {
      const c = src.charCodeAt(i);
      if (c === 61 || c === 45) return true; // = or -
    }
    at = src.indexOf('\n', i);
  }
  return false;
}

// Local-part characters of an email address as marked's url regex
// sees them: letters, digits, dot, underscore, plus, hyphen. Built
// once as a lookup table over the ASCII range.
const EMAIL_LOCAL = new Uint8Array(128);
for (const ch of 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._+-') {
  EMAIL_LOCAL[ch.charCodeAt(0)] = 1;
}

// Whether `src` could match marked's url regex at all. The regex has
// three alternatives: a scheme prefix (mailto:, xmpp:, http(s)://,
// ftp://, www.) or an email (a run of local-part characters followed
// by '@'). Anything else fails it — most inline positions included.
// The case rules are marked's own: http/https and ftp match in any
// case, while www., mailto: and xmpp: are lowercase-only (WWW.example
// .com and MAILTO: render as plain text in marked too).
function couldBeUrl(src) {
  if (src.startsWith('www.') || src.startsWith('mailto:') || src.startsWith('xmpp:')) return true;
  if (src.slice(0, 4).toLowerCase() === 'http') {
    if (src.slice(4, 7) === '://' || src.slice(4, 8) === 's://') return true;
  }
  if (src.slice(0, 3).toLowerCase() === 'ftp' && src.slice(3, 6) === '://') return true;
  // Email: a run of local-part characters followed by '@', scanned
  // through the lookup table above.
  let i = 0;
  while (i < src.length) {
    const code = src.charCodeAt(i);
    if (code >= 128 || EMAIL_LOCAL[code] === 0) break;
    i += 1;
  }
  return i > 0 && src[i] === '@';
}

// ---------------------------------------------------------------------------
// Renderer: marked's Parser + Renderer as switches on the token type.
//
// parse() only ever runs with marked's defaults (no extensions, no
// custom renderer, silent off), so the per-token extension checks and
// the Parser/Renderer/TextRenderer construction are pure overhead.
// Each case below replicates one of marked's Renderer methods exactly
// (same HTML, same escaping, same href sanitizing) without them.
// ---------------------------------------------------------------------------

function failUnknownToken(tok) {
  throw new Error('Token with "' + tok.type + '" type was not found.');
}

// Block-level rendering: one case per token type. `space` and `def`
// contribute nothing.
function renderBlockToken(tok) {
  switch (tok.type) {
    case 'space':
      return '';
    case 'hr':
      return '<hr>\n';
    case 'heading': {
      const inner = renderInlineTokens(tok.tokens);
      return '<h' + tok.depth + '>' + inner + '</h' + tok.depth + '>\n';
    }
    case 'code': {
      const lang = (tok.lang || '').match(LEADING_WORD)?.[0];
      let body = '';
      if (tok.text) body = tok.text.replace(FINAL_NEWLINE, '') + '\n';
      const inner = tok.escaped ? body : escapeHtml(body, true);
      if (lang) {
        return '<pre><code class="language-' + escapeHtml(lang) + '">' + inner + '</code></pre>\n';
      }
      return '<pre><code>' + inner + '</code></pre>\n';
    }
    case 'table': {
      let head = '';
      for (const cell of tok.header) head += renderCell(cell);
      let body = '';
      for (const row of tok.rows) {
        let cells = '';
        for (const cell of row) cells += renderCell(cell);
        body += '<tr>\n' + cells + '</tr>\n';
      }
      if (body !== '') body = '<tbody>' + body + '</tbody>';
      return '<table>\n<thead>\n<tr>\n' + head + '</tr>\n</thead>\n' + body + '</table>\n';
    }
    case 'blockquote':
      return '<blockquote>\n' + renderBlockTokens(tok.tokens) + '</blockquote>\n';
    case 'list': {
      let items = '';
      for (const item of tok.items) items += '<li>' + renderBlockTokens(item.tokens) + '</li>\n';
      const tag = tok.ordered ? 'ol' : 'ul';
      let start = '';
      if (tok.ordered && tok.start !== 1) start = ' start="' + tok.start + '"';
      return '<' + tag + start + '>\n' + items + '</' + tag + '>\n';
    }
    case 'checkbox':
      return '<input ' + (tok.checked ? 'checked="" ' : '') + 'disabled="" type="checkbox"> ';
    case 'html':
      return tok.text;
    case 'def':
      return '';
    case 'paragraph':
      return '<p>' + renderInlineTokens(tok.tokens) + '</p>\n';
    case 'text':
      return renderTextToken(tok);
    default:
      failUnknownToken(tok);
      return '';
  }
}

function renderBlockTokens(tokens) {
  let out = '';
  for (let i = 0; i < tokens.length; i += 1) {
    out += renderBlockToken(tokens[i]);
  }
  return out;
}

function renderCell(cell) {
  const inner = renderInlineTokens(cell.tokens);
  const tag = cell.header ? 'th' : 'td';
  if (cell.align) return '<' + tag + ' align="' + cell.align + '">' + inner + '</' + tag + '>\n';
  return '<' + tag + '>' + inner + '</' + tag + '>\n';
}

// The text/escape case shared below: a token with sub-tokens renders
// them, an escaped token is already final, otherwise escape it.
function renderTextToken(tok) {
  if ('tokens' in tok && tok.tokens) return renderInlineTokens(tok.tokens);
  if ('escaped' in tok && tok.escaped) return tok.text;
  return escapeHtml(tok.text);
}

// Inline rendering: one case per token type.
function renderInlineToken(tok) {
  switch (tok.type) {
    // escape falls through to text, like marked's parseInline
    case 'escape':
    case 'text':
      return renderTextToken(tok);
    case 'html':
      return tok.text;
    case 'link': {
      let label;
      if (tok.autolink) label = escapeHtml(tok.text, true);
      else label = renderInlineTokens(tok.tokens);
      const href = sanitizeHref(tok.href);
      if (href === null) return label;
      let tag = '<a href="' + escapeHtml(href, !!tok.autolink) + '"';
      if (tok.title) tag += ' title="' + escapeHtml(tok.title) + '"';
      return tag + '>' + label + '</a>';
    }
    case 'image': {
      let alt = tok.text;
      if (tok.tokens) alt = renderPlainTokens(tok.tokens);
      const href = sanitizeHref(tok.href);
      if (href === null) return escapeHtml(alt);
      let tag = '<img src="' + escapeHtml(href) + '" alt="' + escapeHtml(alt) + '"';
      if (tok.title) tag += ' title="' + escapeHtml(tok.title) + '"';
      return tag + '>';
    }
    case 'checkbox':
      return '<input ' + (tok.checked ? 'checked="" ' : '') + 'disabled="" type="checkbox"> ';
    case 'strong':
      return '<strong>' + renderInlineTokens(tok.tokens) + '</strong>';
    case 'em':
      return '<em>' + renderInlineTokens(tok.tokens) + '</em>';
    case 'codespan':
      return '<code>' + escapeHtml(tok.text, true) + '</code>';
    case 'br':
      return '<br>';
    case 'del':
      return '<del>' + renderInlineTokens(tok.tokens) + '</del>';
    default:
      failUnknownToken(tok);
      return '';
  }
}

function renderInlineTokens(tokens) {
  let out = '';
  for (let i = 0; i < tokens.length; i += 1) {
    out += renderInlineToken(tokens[i]);
  }
  return out;
}

// marked's TextRenderer (used for image alt text): renders inline
// tokens to plain text, dropping all markup.
function renderPlainToken(tok) {
  switch (tok.type) {
    case 'escape':
    case 'text':
    case 'html':
      return tok.text;
    case 'link':
    case 'image':
    case 'strong':
    case 'em':
    case 'del':
      if (tok.tokens) return renderPlainTokens(tok.tokens);
      return tok.text;
    case 'codespan':
      return tok.text;
    case 'br':
      return '';
    case 'checkbox':
      return tok.raw;
    default:
      failUnknownToken(tok);
      return '';
  }
}

function renderPlainTokens(tokens) {
  let out = '';
  for (let i = 0; i < tokens.length; i += 1) {
    out += renderPlainToken(tokens[i]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// FastTokenizer: marked's Tokenizer with the hot methods guarded or replaced.
// ---------------------------------------------------------------------------
class FastTokenizer extends Tokenizer {
  // NOTE: inlineText is deliberately left as marked wrote it. A
  // hand-written scanner was built and verified 720/720 in an earlier
  // entry, but it ran ~15% SLOWER than marked's regex (V8 executes
  // the big regex in C++; a per-character JS loop cannot keep up).
  // marked's own inlineText runs instead.

  // First-character guards: each of these patterns is anchored and
  // can only match at one (or two) first characters. Marked's inline
  // loop tries every tokeniser at every position; the guard turns the
  // nine hopeless regex runs per text position into nine cheap
  // single-character tests.
  escape(src) {
    if (src.charCodeAt(0) !== 92) return; // backslash
    return super.escape(src);
  }
  tag(src) {
    if (src.charCodeAt(0) !== 60) return; // <
    if (src.indexOf('>') === -1) return; // every tag ends with '>'
    return super.tag(src);
  }
  reflink(src, links) {
    const c0 = src.charCodeAt(0);
    if (c0 !== 91 && c0 !== 33) return; // [ !
    if (src.indexOf(']') === -1) return; // reflink/nolink both need a ']'
    return super.reflink(src, links);
  }
  emStrong(src, masked, prev) {
    const c0 = src.charCodeAt(0);
    if (c0 !== 42 && c0 !== 95) return; // * _
    // An emphasis span needs a closer of the same character after the
    // opener run; without one, emStrong cannot match.
    const closer = c0 === 42 ? '*' : '_';
    let run = 1;
    for (; src.charCodeAt(run) === c0; run += 1) { /* count the opener run */ }
    if (src.indexOf(closer, run) < 0) return;
    return super.emStrong(src, masked, prev);
  }
  codespan(src) {
    if (src.charCodeAt(0) !== 96) return; // `
    // A code span needs a closing backtick run after the opener run.
    let run = 1;
    for (; src.charCodeAt(run) === 96; run += 1) { /* count the opener run */ }
    if (src.indexOf('`', run) < 0) return;
    return super.codespan(src);
  }
  br(src) {
    const c0 = src.charCodeAt(0);
    // br is two or more spaces + newline, or backslash + newline.
    const twoSpaces = c0 === 32 && src.charCodeAt(1) === 32;
    const backslashNl = c0 === 92 && src.charCodeAt(1) === 10;
    if (!twoSpaces && !backslashNl) return;
    return super.br(src);
  }
  del(src, masked, prev) {
    if (src.charCodeAt(0) !== 126) return; // ~
    // A deletion span needs a closer after the opener run; without
    // another '~' at all, del cannot match.
    let run = 1;
    for (; src.charCodeAt(run) === 126; run += 1) { /* count the opener run */ }
    if (src.indexOf('~', run) < 0) return;
    return super.del(src, masked, prev);
  }
  autolink(src) {
    if (src.charCodeAt(0) !== 60) return; // <
    if (src.indexOf('>') === -1) return; // every autolink ends with '>'
    return super.autolink(src);
  }
  url(src) {
    if (!couldBeUrl(src)) return;
    return super.url(src);
  }
  // Link: the link pattern needs a literal '](' (label close + paren
  // open). Without one anywhere in the remaining input it cannot
  // match, so skip the giant regex (it is tried at every '[' and
  // usually fails). The cheap checks run first: link can only start
  // at '[' or '!', and the suffix scan keeps the work off the hot
  // path (it would otherwise run at every inline position).
  link(src) {
    const c0 = src.charCodeAt(0);
    if (c0 !== 91 && c0 !== 33) return; // [ !
    if (src.indexOf('](') < 0) return;
    if (this.lexer.state.linkParenPossible === false) return;
    return super.link(src);
  }

  // Whether a list-item continuation line ends the item instead of
  // extending it: any of the block-start patterns matches the marker
  // line, the previous line was blank, or the marker line is indented
  // four or more spaces in. Marked's own list() code, kept verbatim in
  // behaviour; only the grouping changed.
  continuationBreaks(markerLine, prevBlank, pats) {
    let flat = markerLine;
    if (markerLine.indexOf('\t') >= 0) {
      flat = markerLine.replace(this.rules.other.tabCharGlobal, '    ');
    }
    if (pats.fence.test(markerLine) || pats.heading.test(markerLine) ||
        pats.html.test(markerLine) || pats.hr.test(markerLine)) return true;
    if (prevBlank) return true;
    return flat.search(this.rules.other.nonSpaceChar) >= 4;
  }

  // List tokeniser: marked's, with index-based line reads instead of
  // split() and a first-character dispatch for the six per-line
  // block-start tests (fences / heading / html / blockquote / bullet /
  // hr). The dispatch only skips tests whose pattern cannot match the
  // line's first non-space character; the outcome is identical.
  list(src) {
    const open = this.rules.block.list.exec(src);
    if (open === null) return;
    const full = src;
    let tail = src;
    const consumed = () => full.length - tail.length;
    const mark = open[1].trim();
    const isOrdered = mark.length > 1;
    const list = {
      type: 'list', raw: '', ordered: isOrdered,
      start: isOrdered ? +mark.slice(0, -1) : '', loose: false, items: [],
    };
    let marker = isOrdered ? '\\d{1,9}\\' + mark.slice(-1) : '\\' + mark;
    if (this.options.pedantic) marker = isOrdered ? marker : '[*+-]';
    const itemRe = this.rules.other.listItemRegex(marker);
    let sawDoubleBlank = false;
    for (; tail.length > 0;) {
      let emptyItem = false;
      let body = '';
      const m = itemRe.exec(tail);
      if (m === null || this.rules.block.hr.test(tail)) break;
      const itemStart = consumed();
      tail = tail.substring(m[0].length);
      const head = firstLineOf(m[2]);
      const markerLen = m[1].length;
      let markerLine;
      if (this.options.pedantic) markerLine = expandTabs(head, markerLen);
      else markerLine = expandLeadingTabs(head, this.rules, markerLen);
      let following = firstLineOf(tail);
      const markerBlank = markerLine.trim().length === 0;
      // Whether the previous line (marker line first, then each
      // consumed line) was blank. This is NOT the empty-item flag
      // below — a blank line after a content line ends the item.
      let prevBlank = markerBlank;
      let indent;
      if (this.options.pedantic) {
        indent = 2;
        body = markerLine.trimStart();
      } else if (markerBlank) {
        indent = markerLen + 1;
      } else {
        const lead = countLeadingSpaces(markerLine);
        indent = lead > 4 ? 1 : lead;
        body = markerLine.slice(indent);
        indent += markerLen;
      }
      if (markerBlank && this.rules.other.blankLine.test(following)) {
        tail = tail.substring(following.length + 1);
        emptyItem = true;
      }
      if (emptyItem === false) {
        const pats = {
          bullet: this.rules.other.nextBulletRegex(indent),
          hr: this.rules.other.hrRegex(indent),
          fence: this.rules.other.fencesBeginRegex(indent),
          heading: this.options.pedantic
            ? this.rules.other.pedanticHeadingBeginRegex(indent)
            : this.rules.other.headingBeginRegex(indent),
          html: this.rules.other.htmlBeginRegex(indent),
          quote: this.rules.other.blockquoteBeginRegex(indent),
        };
        for (; tail.length > 0;) {
          const line = firstLineOf(tail);
          let expanded;
          if (this.options.pedantic) {
            following = line.replace(this.rules.other.listReplaceNesting, '  ');
            expanded = following;
          } else {
            following = line;
            expanded = expandLeadingTabs(line, this.rules, 0);
          }
          if (lineStartsBlock(following, indent, pats.fence, pats.heading, pats.html, pats.quote, pats.bullet, pats.hr)) break;
          const lineBlank = line.trim().length === 0;
          if (countLeadingSpaces(expanded) >= indent || lineBlank) {
            body += '\n' + expanded.slice(indent);
          } else if (this.continuationBreaks(markerLine, prevBlank, pats)) {
            break;
          } else if (this.options.pedantic === false &&
              /^ {0,3}(?:=+|-+) *$/.test(line) &&
              this.rules.block.lheading.test(markerLine + '\n' + line)) {
            body += '\n    ' + expanded.replace(/^ {0,3}/, '');
          } else {
            body += '\n' + line;
          }
          prevBlank = lineBlank;
          tail = tail.substring(line.length + 1);
          markerLine = expanded.slice(indent);
        }
      }
      const rawItem = full.slice(itemStart, consumed());
      if (list.loose === false) {
        if (sawDoubleBlank) list.loose = true;
        else if (endsWithDoubleBlank(rawItem)) sawDoubleBlank = true;
      }
      list.items.push({
        type: 'list_item', raw: rawItem,
        task: !!this.options.gfm && this.rules.other.listIsTask.test(body),
        loose: false, text: body, tokens: [],
      });
    }
    const last = list.items[list.items.length - 1];
    if (last === undefined) return;
    last.raw = last.raw.trimEnd();
    last.text = last.text.trimEnd();
    list.raw = full.slice(0, consumed()).trimEnd();
    this.finalizeList(list);
    return list;
  }

  // Finish a list token: tokenise every item's text, work out whether
  // the list is loose, then handle task-list markers (checkbox tokens
  // and the marker text stripped from the queued inline sources).
  // Marked's own list() tail, kept verbatim in behaviour; only the
  // grouping and loop shapes changed.
  finalizeList(list) {
    for (let i = 0; i < list.items.length; i += 1) {
      const item = list.items[i];
      this.lexer.state.top = false;
      item.tokens = this.lexer.blockTokens(item.text, []);
      if (list.loose === false) {
        let hasBlank = false;
        for (let j = 0; j < item.tokens.length; j += 1) {
          const tok = item.tokens[j];
          if (tok.type === 'space' && this.rules.other.anyLine.test(tok.raw)) {
            hasBlank = true;
            break;
          }
        }
        if (hasBlank) list.loose = true;
      }
    }
    for (let i = 0; i < list.items.length; i += 1) {
      const item = list.items[i];
      const firstTok = item.tokens[0];
      const isTaskPara = item.task && (firstTok?.type === 'text' || firstTok?.type === 'paragraph');
      if (isTaskPara) {
        item.text = item.text.replace(this.rules.other.listReplaceTask, '');
        firstTok.raw = firstTok.raw.replace(this.rules.other.listReplaceTask, '');
        firstTok.text = firstTok.text.replace(this.rules.other.listReplaceTask, '');
        for (let g = this.lexer.inlineQueue.length - 1; g >= 0; g -= 1) {
          if (this.rules.other.listIsTask.test(this.lexer.inlineQueue[g].src)) {
            this.lexer.inlineQueue[g].src = this.lexer.inlineQueue[g].src.replace(this.rules.other.listReplaceTask, '');
            break;
          }
        }
        const found = this.rules.other.listTaskCheckbox.exec(item.raw);
        if (found !== null) {
          const boxTok = { type: 'checkbox', raw: found[0] + ' ', checked: found[0] !== '[ ]' };
          item.checked = boxTok.checked;
          if (list.loose) {
            const head0 = item.tokens[0];
            const hasPara = head0 !== undefined && (head0.type === 'paragraph' || head0.type === 'text') &&
              'tokens' in head0 && head0.tokens;
            if (hasPara) {
              head0.raw = boxTok.raw + head0.raw;
              head0.text = boxTok.raw + head0.text;
              head0.tokens.unshift(boxTok);
            } else {
              item.tokens.unshift({ type: 'paragraph', raw: boxTok.raw, text: boxTok.raw, tokens: [boxTok] });
            }
          } else {
            item.tokens.unshift(boxTok);
          }
        }
      } else if (item.task) {
        item.task = false;
      }
    }
    if (list.loose) {
      for (let i = 0; i < list.items.length; i += 1) {
        const item = list.items[i];
        item.loose = true;
        for (let j = 0; j < item.tokens.length; j += 1) {
          if (item.tokens[j].type === 'text') item.tokens[j].type = 'paragraph';
        }
      }
    }
  }
}

// Whether the list-item line `line` starts a new block: the six tests
// marked runs per line, dispatched on the line's first non-space
// character (only spaces count toward the indent the regexes allow —
// each pattern allows at most indent-1 leading spaces, so a line with
// indent or more cannot start a block). Returns true when any test
// matches.
function lineStartsBlock(line, indent, fenceRe, headingRe, htmlRe, quoteRe, bulletRe, hrRe) {
  let p = 0;
  for (; p < line.length; p += 1) {
    if (line.charCodeAt(p) !== 32) break;
  }
  if (p >= indent) return false;
  const c = line.charCodeAt(p);
  if (c === 96 || c === 126) return fenceRe.test(line); // ` ~
  if (c === 35) return headingRe.test(line); // #
  if (c === 60) return htmlRe.test(line); // <
  if (c === 62) return quoteRe.test(line); // >
  if (c === 43) return bulletRe.test(line); // +
  if (c === 45 || c === 95 || c === 42) return bulletRe.test(line) || hrRe.test(line); // - _ *
  if (c >= 48 && c <= 57) return bulletRe.test(line); // digit
  return false;
}

// ---------------------------------------------------------------------------
// FastLexer: marked's Lexer with an if-chain blockTokens.
// ---------------------------------------------------------------------------
const BIT = {
  space: 1, code: 2, fences: 4, heading: 8, hr: 16,
  blockquote: 32, list: 64, html: 128, def: 256, table: 512,
  lheading: 1024, paragraph: 2048, text: 4096,
};
const BIT_ALL = BIT.space | BIT.code | BIT.fences | BIT.heading | BIT.hr |
  BIT.blockquote | BIT.list | BIT.html | BIT.def | BIT.table |
  BIT.lheading | BIT.paragraph | BIT.text;
const BIT_TEXTUAL = BIT.table | BIT.lheading | BIT.paragraph | BIT.text;

// Which block tokenisers can match, by the first character of the
// remaining input. A digit can open a list; anything else falls back
// to the textual tokenisers.
function kindsForFirst(code) {
  switch (code) {
    case 10: return BIT.space; // \n: only a blank-line block can start here
    case 32: case 9: return BIT_ALL; // space / tab: anything indented may follow
    case 35: return BIT.heading | BIT_TEXTUAL; // #
    case 62: return BIT.blockquote | BIT_TEXTUAL; // >
    case 96: case 126: return BIT.fences | BIT_TEXTUAL; // ` ~
    case 45: case 42: case 95: return BIT.hr | BIT.list | BIT_TEXTUAL; // - * _
    case 43: return BIT.list | BIT_TEXTUAL; // +
    case 60: return BIT.html | BIT_TEXTUAL; // <
    case 91: return BIT.def | BIT_TEXTUAL; // [
    case 124: return BIT_TEXTUAL; // |
    default:
      if (code >= 48 && code <= 57) return BIT.list | BIT_TEXTUAL; // digit
      return BIT_TEXTUAL;
  }
}

class FastLexer extends Lexer {
  // Inline loop for sources in which no emphasis or deletion span can
  // form (fewer than two of each of '*', '_' and '~'). marked's loop
  // would run the masking pass first and call emStrong/del at every
  // delimiter position; neither can change the outcome here, so this
  // loop dispatches on the first character instead, in marked's order
  // (escape, tag, link, reflink, codespan, br, autolink, url, text),
  // with the same token merging. emStrong/del are never called.
  inlineTokensNoEmphasis(src, tokens) {
    this.tokenizer.lexer = this;
    let shortest = Infinity;
    while (src.length > 0) {
      if (src.length < shortest) shortest = src.length;
      else { this.infiniteLoopError(src.charCodeAt(0)); break; }
      const c = src.charCodeAt(0);
      let tok;
      if (c === 92) {
        tok = this.tokenizer.escape(src) || this.tokenizer.br(src); // backslash
      } else if (c === 60) {
        tok = this.tokenizer.tag(src) || this.tokenizer.autolink(src); // <
      } else if (c === 91 || c === 33) { // [ !
        tok = this.tokenizer.link(src);
        if (tok === undefined) {
          tok = this.tokenizer.reflink(src, this.tokens.links);
          if (tok !== undefined) {
            src = src.substring(tok.raw.length);
            const prev = tokens[tokens.length - 1];
            if (tok.type === 'text' && prev !== undefined && prev.type === 'text') {
              prev.raw += tok.raw;
              prev.text += tok.text;
            } else {
              tokens.push(tok);
            }
            continue;
          }
        }
      } else if (c === 96) {
        tok = this.tokenizer.codespan(src); // `
      } else if (c === 32) {
        tok = this.tokenizer.br(src); // space
      } else if (this.state.inLink === false) {
        tok = this.tokenizer.url(src);
      }
      if (tok !== undefined) {
        src = src.substring(tok.raw.length);
        tokens.push(tok);
        continue;
      }
      tok = this.tokenizer.inlineText(src);
      if (tok !== undefined) {
        src = src.substring(tok.raw.length);
        const prev = tokens[tokens.length - 1];
        if (prev !== undefined && prev.type === 'text') {
          prev.raw += tok.raw;
          prev.text += tok.text;
        } else {
          tokens.push(tok);
        }
        continue;
      }
      if (src.length > 0) { this.infiniteLoopError(src.charCodeAt(0)); break; }
    }
    return tokens;
  }

  // Plain-text fast path: when the inline source holds no inline
  // construct at all (no escape/tag/link/emphasis/code/del/autolink/url
  // starter and no hard break), marked's inline loop would produce
  // exactly one text token for it. Emit that token directly, skipping
  // the masking pass, the emphasis analysis and the per-tokeniser
  // dispatch. Anything else falls through to marked's inlineTokens.
  // (Default options only: breaks off, no inline extensions.)
  // Two details make the direct emission exact: inlineText decodes
  // entities (only needed when the source holds '&'), and it stops
  // before a bare "http"/"https" word (its regex's protocol lookahead
  // needs no ://). With neither present, one inlineText call would
  // consume the whole source unchanged, so the token is emitted without
  // running the regex at all; with either present, the source is
  // consumed in successive inlineText calls and merged, exactly as the
  // inline loop does.
  inlineTokens(src, tokens = []) {
    const plain = !this.options.pedantic && !this.options.breaks &&
      !this.options.extensions?.inline && !this.options.extensions?.startInline;
    if (plain && src.length > 0 && isPlainText(src)) {
      this.tokenizer.lexer = this;
      if (src.indexOf('&') < 0 && HTTP_WORD.test(src) === false) {
        tokens.push({ type: 'text', raw: src, text: src, escaped: this.state.inRawBlock });
        return tokens;
      }
      const raws = [];
      const texts = [];
      let escaped = this.state.inRawBlock;
      let rest = src;
      let stalled = false;
      while (rest.length > 0) {
        const tok = this.tokenizer.inlineText(rest);
        if (tok === undefined || tok.raw.length === 0) { stalled = true; break; }
        raws.push(tok.raw);
        texts.push(tok.text);
        escaped = tok.escaped;
        rest = rest.substring(tok.raw.length);
      }
      // If the loop stalled (inlineText made no progress — it never
      // does on a plain source, but a missed trigger must not silently
      // drop text), fall back to marked's inline loop for the whole
      // source.
      if (!stalled && rest.length === 0 && raws.length > 0) {
        tokens.push({ type: 'text', raw: raws.join(''), text: texts.join(''), escaped });
        return tokens;
      }
      return super.inlineTokens(src, tokens);
    }
    if (plain && src.length > 0 && noEmphasisPossible(src)) {
      return this.inlineTokensNoEmphasis(src, tokens);
    }
    return super.inlineTokens(src, tokens);
  }

  // marked's block loop, except tokenisers that cannot match the
  // current block's first character are never tried, and the two
  // expensive patterns (table, lheading) get a cheap
  // necessary-condition guard first. The order and the merging rules
  // are unchanged. Falls back to marked's loop for pedantic mode or
  // when block extensions are registered.
  blockTokens(src, tokens = [], inBlockquote = false) {
    if (this.options.pedantic || this.options.extensions?.block || this.options.extensions?.startBlock) {
      return super.blockTokens(src, tokens, inBlockquote);
    }
    this.tokenizer.lexer = this;
    let shortest = Infinity;
    while (src.length > 0) {
      if (src.length < shortest) shortest = src.length;
      else { this.infiniteLoopError(src.charCodeAt(0)); break; }
      const mask = kindsForFirst(src.charCodeAt(0));
      const quote = inBlockquote;
      let token;
      if ((mask & BIT.space) !== 0 && (token = this.tokenizer.space(src)) != null) {
        const prev = tokens[tokens.length - 1];
        if (token.raw.length === 1 && prev !== undefined) prev.raw += '\n';
        else tokens.push(token);
        src = src.substring(token.raw.length);
        continue;
      }
      if ((mask & BIT.code) !== 0 && (token = this.tokenizer.code(src)) != null) {
        const prev = tokens[tokens.length - 1];
        if (prev !== undefined && (prev.type === 'paragraph' || prev.type === 'text')) {
          prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + token.raw;
          prev.text += '\n' + token.text;
          this.inlineQueue[this.inlineQueue.length - 1].src = prev.text;
        } else {
          tokens.push(token);
        }
        src = src.substring(token.raw.length);
        continue;
      }
      if ((mask & BIT.fences) !== 0 && (token = this.tokenizer.fences(src)) != null) {
        tokens.push(token);
        src = src.substring(token.raw.length);
        continue;
      }
      if ((mask & BIT.heading) !== 0 && (token = this.tokenizer.heading(src)) != null) {
        tokens.push(token);
        src = src.substring(token.raw.length);
        continue;
      }
      if ((mask & BIT.hr) !== 0 && (token = this.tokenizer.hr(src)) != null) {
        tokens.push(token);
        src = src.substring(token.raw.length);
        continue;
      }
      if ((mask & BIT.blockquote) !== 0 && (token = this.tokenizer.blockquote(src)) != null) {
        tokens.push(token);
        src = src.substring(token.raw.length);
        continue;
      }
      if ((mask & BIT.list) !== 0 && (token = this.tokenizer.list(src)) != null) {
        tokens.push(token);
        src = src.substring(token.raw.length);
        continue;
      }
      if ((mask & BIT.html) !== 0 && (token = this.tokenizer.html(src)) != null) {
        tokens.push(token);
        src = src.substring(token.raw.length);
        continue;
      }
      if ((mask & BIT.def) !== 0 && (token = this.tokenizer.def(src)) != null) {
        const prev = tokens[tokens.length - 1];
        if (prev !== undefined && (prev.type === 'paragraph' || prev.type === 'text')) {
          prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + token.raw;
          prev.text += '\n' + token.raw;
          this.inlineQueue[this.inlineQueue.length - 1].src = prev.text;
        } else {
          if (this.tokens.links[token.tag] === undefined) {
            this.tokens.links[token.tag] = { href: token.href, title: token.title };
          }
          tokens.push(token);
        }
        src = src.substring(token.raw.length);
        continue;
      }
      if ((mask & BIT.table) !== 0 && hyphenOnSecondLine(src) && (token = this.tokenizer.table(src)) != null) {
        tokens.push(token);
        src = src.substring(token.raw.length);
        continue;
      }
      if ((mask & BIT.lheading) !== 0 && setextUnderlineAhead(src) && (token = this.tokenizer.lheading(src)) != null) {
        tokens.push(token);
        src = src.substring(token.raw.length);
        continue;
      }
      if ((mask & BIT.paragraph) !== 0 && this.state.top !== false && (token = this.tokenizer.paragraph(src)) != null) {
        const prev = tokens[tokens.length - 1];
        if (quote && prev !== undefined && prev.type === 'paragraph') {
          prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + token.raw;
          prev.text += '\n' + token.text;
          this.inlineQueue.pop();
          this.inlineQueue[this.inlineQueue.length - 1].src = prev.text;
        } else {
          tokens.push(token);
        }
        // A paragraph token ends the blockquote-merge context: this
        // is marked's own behaviour, copied faithfully (without
        // startBlock extensions the flag the table version computed
        // here is always false).
        inBlockquote = false;
        src = src.substring(token.raw.length);
        continue;
      }
      if ((mask & BIT.text) !== 0 && (token = this.tokenizer.text(src)) != null) {
        const prev = tokens[tokens.length - 1];
        if (prev !== undefined && prev.type === 'text') {
          prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + token.raw;
          prev.text += '\n' + token.text;
          this.inlineQueue.pop();
          this.inlineQueue[this.inlineQueue.length - 1].src = prev.text;
        } else {
          tokens.push(token);
        }
        src = src.substring(token.raw.length);
        continue;
      }
      if (src.length > 0) { this.infiniteLoopError(src.charCodeAt(0)); break; }
    }
    this.state.top = true;
    return tokens;
  }

  // Like marked's lex, but the whole-input CR normalisation is skipped
  // when the input holds no CR at all (the common case).
  lex(src) {
    if (src.indexOf('\r') >= 0) src = src.replace(this.tokenizer.rules.other.carriageReturn, '\n');
    this.blockTokens(src, this.tokens);
    for (let t = 0; t < this.inlineQueue.length; t += 1) {
      const item = this.inlineQueue[t];
      this.state.inRawBlock = false;
      this.inlineTokens(item.src, item.tokens);
    }
    this.inlineQueue = [];
    return this.tokens;
  }
}

// ---------------------------------------------------------------------------
// Entry point: exactly marked.parse with the defaults, through the fast
// lexer and the switch renderer above.
// ---------------------------------------------------------------------------
export function parse(markdown) {
  if (markdown === undefined || markdown === null) {
    throw new Error('marked(): input parameter is undefined or null');
  }
  if (typeof markdown !== 'string') {
    throw new Error('marked(): input parameter is of type ' + Object.prototype.toString.call(markdown) + ', string expected');
  }
  const opts = { ...defaults };
  opts.tokenizer = new FastTokenizer(opts);
  const lexer = new FastLexer(opts);
  return renderBlockTokens(lexer.lex(markdown));
}
