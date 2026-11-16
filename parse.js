// parse.js — a fast, byte-exact replacement for marked 18.1.3.
//
// parse(md) returns exactly what marked.parse(md) returns under
// marked's stock settings (GFM on, hard breaks off, pedantic off,
// synchronous). The reference is the marked copy vendored at
// vendor/marked/marked.esm.js, shipped unmodified (MIT). Where
// marked and the CommonMark/GFM specs disagree, marked's output
// wins — the spec is never the target.
//
// The design, in brief:
//
//   - Lexing still runs through marked's own Lexer and Tokenizer
//     subclasses, so every token is marked's token. The speed comes
//     from skipping work marked repeats: block dispatch is a switch
//     on the first character, so a tokeniser that cannot open at
//     that character is never attempted, and the two expensive
//     block patterns (table, setext heading) first pass a cheap
//     necessary-condition test.
//   - Inline sources with no inline construct at all collapse to a
//     single text token. Sources that cannot hold an emphasis or
//     deletion span run a small handler-map loop instead of marked's
//     try-everything loop. Every other inline tokeniser first looks
//     at the one character it could start with.
//   - Lists are gathered by a small ListBuilder that walks the
//     source by absolute index instead of slicing a shrinking tail,
//     and decides the per-line block starts through one
//     first-character test table.
//   - Rendering is a class, not a set of functions: an HtmlRenderer
//     accumulates output into a parts array, dispatches each token
//     to a method by name, and renders nested inline content by
//     capturing it into a fresh buffer. No Parser or Renderer
//     object is built per call.
//   - lex() skips the whole-input CR normalisation when the input
//     holds no CR at all, which is the usual case.
//
// Only marked's DEFAULT options are supported. blockTokens and
// inlineTokens hand back to marked for pedantic mode or registered
// extensions; the guards, the list builder, lex() and the renderer
// promise nothing outside the defaults. Do not reuse this module
// anywhere else.
//
// Every parse() call is independent: no state survives between
// calls, nothing is cached from one case to the next, nothing is
// written to /tmp.
import { Lexer, Tokenizer, defaults } from './vendor/marked/marked.esm.js';

// ---------------------------------------------------------------------------
// HTML escaping and href cleaning — marked's Renderer behaviour.
// ---------------------------------------------------------------------------

// One replacement character at a time: the five characters marked
// escapes, each mapped to its entity.
function escapeChar(ch) {
  switch (ch) {
    case '&': return '&amp;';
    case '<': return '&lt;';
    case '>': return '&gt;';
    case '"': return '&quot;';
    default: return '&#39;'; // '
  }
}

const ESC_ANY = /[&<>"']/;
const ESC_ANY_G = /[&<>"']/g;
const ESC_NOAMP = /[<>"']/;
const ESC_NOAMP_G = /[<>"']/g;
const ESC_KEEP = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/;
const ESC_KEEP_G = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;

// marked's escape(): with `encode`, every & < > " ' becomes an entity;
// without it, an & that already opens an entity reference stays put.
// A string without '&' cannot hold an entity reference, so its
// no-encode scan only needs the [<>"'] test. Each branch tests once
// and replaces once, returning early when nothing needs escaping.
function escapeHtml(str, encode) {
  if (encode) {
    return ESC_ANY.test(str) ? str.replace(ESC_ANY_G, escapeChar) : str;
  }
  if (str.indexOf('&') < 0) {
    return ESC_NOAMP.test(str) ? str.replace(ESC_NOAMP_G, escapeChar) : str;
  }
  return ESC_KEEP.test(str) ? str.replace(ESC_KEEP_G, escapeChar) : str;
}

// marked's href cleaning: encodeURI, with %25 restored to %, or null
// when the URI refuses to encode.
function cleanUrl(href) {
  try {
    const encoded = encodeURI(href);
    return encoded.replace(/%25/g, '%');
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
function lineHead(s) {
  const cut = s.indexOf('\n');
  return cut < 0 ? s : s.slice(0, cut);
}

// How many spaces lead `s`. Tabs do not count: the block patterns
// only allow spaces ahead of a marker.
function leadingSpaces(s) {
  let n = 0;
  while (n < s.length && s.charCodeAt(n) === 32) n += 1;
  return n;
}

// Expand the tabs in `s` to spaces, counting columns from `col`
// (marked's tab helper, default column 0). Splitting on the tabs
// keeps the work proportional to the number of tabs, not the number
// of characters: each segment joins with the padding its start
// column needs. A string with no tab is already expanded, so it is
// returned untouched — the usual case is leading spaces.
// Columns count Unicode code points, as marked's helper does: a
// segment holding a surrogate pair counts its code points, not its
// UTF-16 units.
const HAS_SURROGATE = /[\uD800-\uDBFF]/;
function colWidth(seg) {
  return HAS_SURROGATE.test(seg) ? [...seg].length : seg.length;
}

function expandTabs(s, col = 0) {
  if (s.indexOf('\t') < 0) return s;
  const parts = s.split('\t');
  let out = parts[0];
  let at = col + colWidth(parts[0]);
  for (let i = 1; i < parts.length; i += 1) {
    const pad = 4 - (at % 4);
    out += ' '.repeat(pad);
    out += parts[i];
    at += pad + colWidth(parts[i]);
  }
  return out;
}

// Expand the tabs in the leading whitespace of `line` (marked's
// leadingSpaceTab replace). The leading run is found by index; a run
// holding no tab replaces to itself, so the line is returned
// untouched in that case instead of being rebuilt.
function expandLeadingTabs(line, col) {
  let end = 0;
  while (end < line.length) {
    const c = line.charCodeAt(end);
    if (c !== 32 && c !== 9) break;
    end += 1;
  }
  if (end === 0) return line;
  const lead = line.slice(0, end);
  if (lead.indexOf('\t') < 0) return line;
  return expandTabs(lead, col) + line.slice(end);
}

// Anything that can open an inline token other than plain text: the
// inline stop characters, an autolink or url trigger, or a hard break.
// One regex scan; when it misses, the text holds no inline construct
// at all and is a single text token.
const INLINE_TRIGGERS = /:\/\/|www\.|mailto:|xmpp:| {2}\n|[\\<!\[`*_~@]/;
function isBareText(src) {
  return !INLINE_TRIGGERS.test(src);
}

// A bare http/https word is the one place inlineText stops inside an
// otherwise plain source (its regex has a protocol lookahead with no
// word boundary), so a plain source holding one still goes through
// inlineText.
const HTTP_WORD = /http/i;

// True when `ch` turns up at least twice in `src`. Native indexOf
// scans run in C++ and exit as soon as the second occurrence is
// found, which beats a per-character JS loop here.
function appearsTwice(src, ch) {
  const first = src.indexOf(ch);
  return first >= 0 && src.indexOf(ch, first + 1) >= 0;
}

// Whether an emphasis or deletion span could form in `src`: each of
// '*', '_' and '~' needs two occurrences, an opener plus a matching
// closer of the same character. If none of the three appears twice,
// no span can form.
function emphasisImpossible(src) {
  return !appearsTwice(src, '*') && !appearsTwice(src, '_') && !appearsTwice(src, '~');
}

// Whether the second line of `src` holds a '-'. A table's delimiter
// row sits on the second line and every cell holds at least one '-',
// so without one the table regex cannot match. The pattern is
// anchored, so it only ever inspects the first two lines.
const DASH_ON_LINE_TWO = /^[^\n]*\n[^\n]*-/;
function secondLineHasDash(src) {
  return DASH_ON_LINE_TWO.test(src);
}

// Whether `s` ends with a double blank line: \n, optional spaces or
// tabs, \n, optional spaces or tabs (marked's doubleBlankLine regex,
// matched by walking backwards from the tail instead of with a
// pattern).
function endsDoubleBlank(s) {
  let i = s.length;
  while (i > 0) {
    const c = s.charCodeAt(i - 1);
    if (c !== 32 && c !== 9) break;
    i -= 1;
  }
  if (i === 0 || s.charCodeAt(i - 1) !== 10) return false;
  i -= 1;
  while (i > 0) {
    const c = s.charCodeAt(i - 1);
    if (c !== 32 && c !== 9) break;
    i -= 1;
  }
  return i > 0 && s.charCodeAt(i - 1) === 10;
}

// Whether a setext underline line (0-3 spaces or tabs, then '=' or
// '-') shows up inside the current paragraph run. The lheading regex
// needs such a line, so without one it cannot match. One search
// settles it: the pattern matches whichever comes first, a blank
// line (which ends the run) or an underline-looking line, and the
// match's last character says which one won — a blank-line match
// ends with '\n', an underline match with '=' or '-'. The scan is
// bounded by the first blank or underline line, so it never runs
// past the paragraph run it is guarding.
const SETEXT_OR_BLANK = /\n[ \t]*\n|\n[ \t]{0,3}[=-]/;
function setextLineAhead(src) {
  const m = SETEXT_OR_BLANK.exec(src);
  if (m === null) return false;
  return m[0].charCodeAt(m[0].length - 1) !== 10;
}

// The start of an email address as marked's url regex sees it: a run
// of local-part characters followed by '@'. A full address needs
// more than that, so this test is a superset — it only ever says
// "maybe", never wrongly "no".
const EMAIL_HEAD = /^[A-Za-z0-9._+-]+@/;

// Whether `src` could match marked's url regex at all. The regex has
// three alternatives: a scheme prefix (mailto:, xmpp:, http(s)://,
// ftp://, www.) or an email (a run of local-part characters
// followed by '@'). Anything else fails it — most inline positions
// included. The case rules are marked's own: http/https and ftp
// match in any case, while www., mailto: and xmpp: are
// lowercase-only (WWW.example.com and MAILTO: render as plain text
// in marked too). The first character picks which prefix test can
// apply; anything else falls through to the email test.
function couldStartUrl(src) {
  const c = src.charCodeAt(0);
  if (c === 119 && src.startsWith('www.')) return true; // w
  if (c === 109 && src.startsWith('mailto:')) return true; // m
  if (c === 120 && src.startsWith('xmpp:')) return true; // x
  if (c === 104 || c === 72) { // h H
    const head = src.slice(0, 8).toLowerCase();
    if (head.startsWith('http://') || head.startsWith('https://')) return true;
  }
  if (c === 102 || c === 70) { // f F
    if (src.slice(0, 6).toLowerCase() === 'ftp://') return true;
  }
  return EMAIL_HEAD.test(src);
}

// How long the run of `ch` is at the start of `src` (an opener run
// of backticks, asterisks, underscores or tildes).
function runLength(src, ch) {
  let n = 0;
  while (n < src.length && src.charCodeAt(n) === ch) n += 1;
  return n;
}

// ---------------------------------------------------------------------------
// Renderer: marked's Parser + Renderer as a class.
//
// parse() only ever runs with marked's defaults (no extensions, no
// custom renderer, silent off), so the per-token extension checks and
// the Parser/Renderer/TextRenderer construction are pure overhead.
// Each method below replicates one of marked's Renderer methods
// exactly (same HTML, same escaping, same href sanitizing) without
// them. Blocks append straight into a shared parts array; inline
// and plain-text methods return their strings, so a paragraph or a
// link label renders as one concatenation with no intermediate
// buffer.
// ---------------------------------------------------------------------------

function unknownToken(tok) {
  throw new Error('Token with "' + tok.type + '" type was not found.');
}

// Method names by token type, one table per level. A missing entry
// means marked itself would throw the same "not found" error.
const BLOCK_METHODS = {
  space: 'blkSpace',
  hr: 'blkHr',
  heading: 'blkHeading',
  code: 'blkCode',
  table: 'blkTable',
  blockquote: 'blkBlockquote',
  list: 'blkList',
  checkbox: 'blkCheckbox',
  html: 'blkHtml',
  def: 'blkDef',
  paragraph: 'blkParagraph',
  text: 'blkText',
};

const INLINE_METHODS = {
  escape: 'inlTextual',
  text: 'inlTextual',
  html: 'inlHtml',
  link: 'inlLink',
  image: 'inlImage',
  checkbox: 'inlCheckbox',
  strong: 'inlStrong',
  em: 'inlEm',
  codespan: 'inlCodespan',
  br: 'inlBr',
  del: 'inlDel',
};

const PLAIN_METHODS = {
  escape: 'plnRaw',
  text: 'plnRaw',
  html: 'plnRaw',
  link: 'plnNested',
  image: 'plnNested',
  strong: 'plnNested',
  em: 'plnNested',
  del: 'plnNested',
  codespan: 'plnRaw',
  br: 'plnBr',
  checkbox: 'plnCheckbox',
};

class HtmlRenderer {
  constructor() {
    this.parts = [];
  }

  // Block level -----------------------------------------------------

  blocks(tokens) {
    for (let i = 0; i < tokens.length; i += 1) this.block(tokens[i]);
  }

  block(tok) {
    const name = BLOCK_METHODS[tok.type];
    if (name === undefined) unknownToken(tok);
    this[name](tok);
  }

  blkSpace() {
    // A blank-line block contributes nothing.
  }

  blkHr() {
    this.parts.push('<hr>\n');
  }

  blkHeading(tok) {
    this.parts.push('<h' + tok.depth + '>' + this.inlineList(tok.tokens) + '</h' + tok.depth + '>\n');
  }

  blkCode(tok) {
    const lang = (tok.lang || '').match(LEADING_WORD)?.[0];
    let body = '';
    if (tok.text) body = tok.text.replace(FINAL_NEWLINE, '') + '\n';
    const inner = tok.escaped ? body : escapeHtml(body, true);
    if (lang) {
      this.parts.push('<pre><code class="language-' + escapeHtml(lang) + '">' + inner + '</code></pre>\n');
    } else {
      this.parts.push('<pre><code>' + inner + '</code></pre>\n');
    }
  }

  blkTable(tok) {
    this.parts.push('<table>\n<thead>\n<tr>\n');
    for (const cell of tok.header) this.cell(cell);
    this.parts.push('</tr>\n</thead>\n');
    if (tok.rows.length > 0) {
      this.parts.push('<tbody>');
      for (const row of tok.rows) {
        this.parts.push('<tr>\n');
        for (const cell of row) this.cell(cell);
        this.parts.push('</tr>\n');
      }
      this.parts.push('</tbody>');
    }
    this.parts.push('</table>\n');
  }

  cell(cell) {
    const inner = this.inlineList(cell.tokens);
    const tag = cell.header ? 'th' : 'td';
    if (cell.align) {
      this.parts.push('<' + tag + ' align="' + cell.align + '">' + inner + '</' + tag + '>\n');
    } else {
      this.parts.push('<' + tag + '>' + inner + '</' + tag + '>\n');
    }
  }

  blkBlockquote(tok) {
    this.parts.push('<blockquote>\n');
    this.blocks(tok.tokens);
    this.parts.push('</blockquote>\n');
  }

  blkList(tok) {
    const tag = tok.ordered ? 'ol' : 'ul';
    let open = '<' + tag;
    if (tok.ordered && tok.start !== 1) open += ' start="' + tok.start + '"';
    this.parts.push(open + '>\n');
    for (const item of tok.items) {
      this.parts.push('<li>');
      this.blocks(item.tokens);
      this.parts.push('</li>\n');
    }
    this.parts.push('</' + tag + '>\n');
  }

  blkCheckbox(tok) {
    this.parts.push('<input ' + (tok.checked ? 'checked="" ' : '') + 'disabled="" type="checkbox"> ');
  }

  blkHtml(tok) {
    this.parts.push(tok.text);
  }

  blkDef() {
    // A link definition contributes nothing.
  }

  blkParagraph(tok) {
    this.parts.push('<p>' + this.inlineList(tok.tokens) + '</p>\n');
  }

  blkText(tok) {
    this.parts.push(this.textual(tok));
  }

  // The text/escape case shared by the block and inline levels: a
  // token with sub-tokens renders them, an escaped token is already
  // final, otherwise escape it.
  textual(tok) {
    if ('tokens' in tok && tok.tokens) return this.inlineList(tok.tokens);
    if ('escaped' in tok && tok.escaped) return tok.text;
    return escapeHtml(tok.text);
  }

  // Inline level: every method returns its string, so a paragraph
  // or a link label renders as one concatenation.

  inlineList(tokens) {
    let out = '';
    for (let i = 0; i < tokens.length; i += 1) out += this.inline(tokens[i]);
    return out;
  }

  inline(tok) {
    const name = INLINE_METHODS[tok.type];
    if (name === undefined) unknownToken(tok);
    return this[name](tok);
  }

  inlTextual(tok) {
    return this.textual(tok);
  }

  inlHtml(tok) {
    return tok.text;
  }

  inlLink(tok) {
    const label = tok.autolink
      ? escapeHtml(tok.text, true)
      : this.inlineList(tok.tokens);
    const href = cleanUrl(tok.href);
    if (href === null) return label;
    let tag = '<a href="' + escapeHtml(href, !!tok.autolink) + '"';
    if (tok.title) tag += ' title="' + escapeHtml(tok.title) + '"';
    return tag + '>' + label + '</a>';
  }

  inlImage(tok) {
    const alt = tok.tokens ? this.plainList(tok.tokens) : tok.text;
    const href = cleanUrl(tok.href);
    if (href === null) return escapeHtml(alt);
    let tag = '<img src="' + escapeHtml(href) + '" alt="' + escapeHtml(alt) + '"';
    if (tok.title) tag += ' title="' + escapeHtml(tok.title) + '"';
    return tag + '>';
  }

  inlCheckbox(tok) {
    return '<input ' + (tok.checked ? 'checked="" ' : '') + 'disabled="" type="checkbox"> ';
  }

  inlStrong(tok) {
    return '<strong>' + this.inlineList(tok.tokens) + '</strong>';
  }

  inlEm(tok) {
    return '<em>' + this.inlineList(tok.tokens) + '</em>';
  }

  inlCodespan(tok) {
    return '<code>' + escapeHtml(tok.text, true) + '</code>';
  }

  inlBr() {
    return '<br>';
  }

  inlDel(tok) {
    return '<del>' + this.inlineList(tok.tokens) + '</del>';
  }

  // Plain-text level (marked's TextRenderer, used for image alt
  // text): inline tokens rendered to plain text, all markup dropped.

  plainList(tokens) {
    let out = '';
    for (let i = 0; i < tokens.length; i += 1) out += this.plain(tokens[i]);
    return out;
  }

  plain(tok) {
    const name = PLAIN_METHODS[tok.type];
    if (name === undefined) unknownToken(tok);
    return this[name](tok);
  }

  plnRaw(tok) {
    return tok.text;
  }

  plnNested(tok) {
    if (tok.tokens) return this.plainList(tok.tokens);
    return tok.text;
  }

  plnBr() {
    // A hard break contributes nothing to plain text.
    return '';
  }

  plnCheckbox(tok) {
    return tok.raw;
  }
}

// ---------------------------------------------------------------------------
// TunedTokenizer: marked's Tokenizer with the hot methods guarded or
// replaced.
// ---------------------------------------------------------------------------

// NOTE: inlineText is deliberately left as marked wrote it. A
// hand-written scanner was built and verified 720/720 in an earlier
// entry, but it ran ~15% SLOWER than marked's regex (V8 executes the
// big regex in C++; a per-character JS loop cannot keep up). Marked's
// own inlineText runs instead.
class TunedTokenizer extends Tokenizer {
  // First-character guards: each of these patterns is anchored and
  // can only match at one (or two) first characters. Marked's inline
  // loop tries every tokeniser at every position; the guard turns
  // the hopeless regex runs per text position into cheap
  // single-character tests, and the closer checks skip spans that
  // cannot close.
  escape(src) {
    const c0 = src.charCodeAt(0);
    if (c0 !== 92) return; // backslash
    return super.escape(src);
  }
  tag(src) {
    if (src.charCodeAt(0) !== 60 || src.indexOf('>') < 0) return; // <, and every tag ends with '>'
    return super.tag(src);
  }
  reflink(src, links) {
    const c0 = src.charCodeAt(0);
    if ((c0 !== 91 && c0 !== 33) || src.indexOf(']') < 0) return; // [ !, and reflink/nolink both need a ']'
    return super.reflink(src, links);
  }
  emStrong(src, masked, prev) {
    const c0 = src.charCodeAt(0);
    if (c0 !== 42 && c0 !== 95) return; // * _
    // An emphasis span needs a closer of the same character after
    // the opener run; without one, emStrong cannot match.
    if (src.indexOf(c0 === 42 ? '*' : '_', runLength(src, c0)) < 0) return;
    return super.emStrong(src, masked, prev);
  }
  codespan(src) {
    if (src.charCodeAt(0) !== 96) return; // `
    // A code span needs a closing backtick run after the opener run.
    if (src.indexOf('`', runLength(src, 96)) < 0) return;
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
    if (src.indexOf('~', runLength(src, 126)) < 0) return;
    return super.del(src, masked, prev);
  }
  autolink(src) {
    if (src.charCodeAt(0) !== 60 || src.indexOf('>') < 0) return; // <, and every autolink ends with '>'
    return super.autolink(src);
  }
  url(src) {
    if (!couldStartUrl(src)) return;
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
    if ((c0 !== 91 && c0 !== 33) || src.indexOf('](') < 0) return; // [ !
    if (this.lexer.state.linkParenPossible === false) return;
    return super.link(src);
  }

  list(src) {
    return new ListBuilder(this, src).run();
  }
}

// Which of the six per-line block-start tests can match, by the
// line's first non-space character. FENCE = 1, HEADING = 2,
// HTML = 4, QUOTE = 8, BULLET = 16, HR = 32. A digit (not in the
// table) always takes the bullet test. Only spaces count toward the
// indent the patterns allow — each pattern allows at most indent-1
// leading spaces, so a line with indent or more cannot start a
// block.
const LINE_TESTS = {
  96: 1, 126: 1, // ` ~ -> fence
  35: 2, // # -> heading
  60: 4, // < -> html
  62: 8, // > -> quote
  43: 16, // + -> bullet
  45: 48, 42: 48, // - * -> bullet or hr
  95: 32, // _ -> hr only (never a bullet marker)
};

// List tokeniser: marked's, gathered by a builder object that walks
// the source by absolute index instead of slicing a shrinking tail.
// The builder holds the cross-item state (source, position, items,
// looseness); each item is gathered by one method, then tokenised,
// then task-marked, then loosened, each step its own method.
// Behaviour is marked's own, kept verbatim; only the grouping and
// the line reads changed.
class ListBuilder {
  constructor(tokenizer, src) {
    this.tok = tokenizer;
    this.rules = tokenizer.rules;
    this.options = tokenizer.options;
    this.src = src;
    this.pos = 0;
    this.sawDoubleBlank = false;
    this.list = null;
    this.itemRe = null;
    this.indent = 0;
    this.pats = null;
    this.patsCache = new Map();
  }

  // The six per-line block-start patterns for an item indent. The
  // patterns depend only on the indent (and the fixed pedantic
  // flag), and none of them is global or sticky, so a set built once
  // for an indent is safe to reuse across every item that shares it
  // instead of compiling six fresh regexes per item.
  patsFor(indent) {
    let pats = this.patsCache.get(indent);
    if (pats === undefined) {
      pats = {
        bullet: this.rules.other.nextBulletRegex(indent),
        hr: this.rules.other.hrRegex(indent),
        fence: this.rules.other.fencesBeginRegex(indent),
        heading: this.options.pedantic
          ? this.rules.other.pedanticHeadingBeginRegex(indent)
          : this.rules.other.headingBeginRegex(indent),
        html: this.rules.other.htmlBeginRegex(indent),
        quote: this.rules.other.blockquoteBeginRegex(indent),
      };
      this.patsCache.set(indent, pats);
    }
    return pats;
  }

  run() {
    const open = this.rules.block.list.exec(this.src);
    if (open === null) return undefined;
    const mark = open[1].trim();
    const ordered = mark.length > 1;
    this.list = {
      type: 'list', raw: '', ordered,
      start: ordered ? +mark.slice(0, -1) : '', loose: false, items: [],
    };
    let marker = ordered ? '\\d{1,9}\\' + mark.slice(-1) : '\\' + mark;
    if (this.options.pedantic) marker = ordered ? marker : '[*+-]';
    this.itemRe = this.rules.other.listItemRegex(marker);
    while (this.pos < this.src.length) {
      if (!this.gatherItem()) break;
    }
    const items = this.list.items;
    const last = items[items.length - 1];
    if (last === undefined) return undefined;
    last.raw = last.raw.trimEnd();
    last.text = last.text.trimEnd();
    this.list.raw = this.src.slice(0, this.pos).trimEnd();
    this.tokenizeItems();
    this.applyTasks();
    this.applyLoose();
    return this.list;
  }

  // The line starting at `pos` (up to the next \n, or the end).
  lineAt(pos) {
    const end = this.src.indexOf('\n', pos);
    return end < 0 ? this.src.slice(pos) : this.src.slice(pos, end);
  }

  // Gather one list item starting at the current position. Returns
  // false when no further item opens here (the item pattern fails
  // or the rest is a horizontal rule), which ends the list.
  gatherItem() {
    const rest = this.src.slice(this.pos);
    const m = this.itemRe.exec(rest);
    if (m === null || this.rules.block.hr.test(rest)) return false;
    const itemStart = this.pos;
    this.pos += m[0].length;
    const head = lineHead(m[2]);
    const markerLen = m[1].length;
    let markerLine;
    if (this.options.pedantic) markerLine = expandTabs(head, markerLen);
    else markerLine = expandLeadingTabs(head, markerLen);
    const following = this.lineAt(this.pos);
    const markerBlank = markerLine.trim().length === 0;
    // Whether the previous line (marker line first, then each
    // consumed line) was blank. This is NOT the empty-item flag
    // below — a blank line after a content line ends the item.
    const prevBlank = markerBlank;
    let body = '';
    let emptyItem = false;
    if (this.options.pedantic) {
      this.indent = 2;
      body = markerLine.trimStart();
    } else if (markerBlank) {
      this.indent = markerLen + 1;
    } else {
      const lead = leadingSpaces(markerLine);
      this.indent = lead > 4 ? 1 : lead;
      body = markerLine.slice(this.indent);
      this.indent += markerLen;
    }
    if (markerBlank && this.rules.other.blankLine.test(following)) {
      this.pos += following.length + 1;
      emptyItem = true;
    }
    if (!emptyItem) {
      this.pats = this.patsFor(this.indent);
      body = this.gatherBody(body, markerLine, prevBlank);
    }
    const rawItem = this.src.slice(itemStart, this.pos);
    if (!this.list.loose) {
      if (this.sawDoubleBlank) this.list.loose = true;
      else if (endsDoubleBlank(rawItem)) this.sawDoubleBlank = true;
    }
    this.list.items.push({
      type: 'list_item', raw: rawItem,
      task: !!this.options.gfm && this.rules.other.listIsTask.test(body),
      loose: false, text: body, tokens: [],
    });
    return true;
  }

  // Consume the continuation lines of one item, starting from the
  // marker line's body. Lines that open a new block, lines the
  // continuation rules reject, and lines past a blank line after
  // content end the item; the rest join the body, indented lines
  // stripped of the item indent.
  gatherBody(body, markerLine, prevBlank) {
    while (this.pos < this.src.length) {
      const line = this.lineAt(this.pos);
      let following;
      let expanded;
      if (this.options.pedantic) {
        following = line.replace(this.rules.other.listReplaceNesting, '  ');
        expanded = following;
      } else {
        following = line;
        expanded = expandLeadingTabs(line, 0);
      }
      if (this.lineOpensBlock(following)) break;
      const lineBlank = line.trim().length === 0;
      if (leadingSpaces(expanded) >= this.indent || lineBlank) {
        body += '\n' + expanded.slice(this.indent);
      } else if (this.continuationBreaks(markerLine, prevBlank)) {
        break;
      } else if (this.options.pedantic === false &&
          /^ {0,3}(?:=+|-+) *$/.test(line) &&
          this.rules.block.lheading.test(markerLine + '\n' + line)) {
        body += '\n    ' + expanded.replace(/^ {0,3}/, '');
      } else {
        body += '\n' + line;
      }
      prevBlank = lineBlank;
      this.pos += line.length + 1;
      markerLine = expanded.slice(this.indent);
    }
    return body;
  }

  // Whether the list-item line `line` starts a new block: the six
  // tests marked runs per line, picked from the test table by the
  // line's first non-space character. Only tests whose pattern can
  // match that character run; the outcome is identical.
  lineOpensBlock(line) {
    let p = 0;
    for (; p < line.length; p += 1) {
      if (line.charCodeAt(p) !== 32) break;
    }
    if (p >= this.indent) return false;
    const c = line.charCodeAt(p);
    const tests = LINE_TESTS[c] || 0;
    if (tests === 0) {
      if (c >= 48 && c <= 57) return this.pats.bullet.test(line); // digit
      return false;
    }
    const pats = this.pats;
    if ((tests & 16) !== 0 && pats.bullet.test(line)) return true;
    if ((tests & 32) !== 0 && pats.hr.test(line)) return true;
    if ((tests & 1) !== 0 && pats.fence.test(line)) return true;
    if ((tests & 2) !== 0 && pats.heading.test(line)) return true;
    if ((tests & 4) !== 0 && pats.html.test(line)) return true;
    if ((tests & 8) !== 0 && pats.quote.test(line)) return true;
    return false;
  }

  // Whether a list-item continuation line ends the item instead of
  // extending it: any of the block-start patterns matches the marker
  // line, the previous line was blank, or the marker line is indented
  // four or more spaces in. Marked's own list() code, kept verbatim
  // in behaviour; only the grouping changed.
  continuationBreaks(markerLine, prevBlank) {
    const pats = this.pats;
    if (pats.fence.test(markerLine) || pats.heading.test(markerLine) ||
        pats.html.test(markerLine) || pats.hr.test(markerLine)) return true;
    if (prevBlank) return true;
    let flat = markerLine;
    if (markerLine.indexOf('\t') >= 0) {
      flat = markerLine.replace(this.rules.other.tabCharGlobal, '    ');
    }
    return flat.search(this.rules.other.nonSpaceChar) >= 4;
  }

  // Tokenise every item's text and work out whether the list is
  // loose: any item whose tokens hold a blank-line space token
  // makes the whole list loose.
  tokenizeItems() {
    const lexer = this.tok.lexer;
    for (const item of this.list.items) {
      lexer.state.top = false;
      item.tokens = lexer.blockTokens(item.text, []);
      if (this.list.loose) continue;
      for (const tok of item.tokens) {
        if (tok.type === 'space' && this.rules.other.anyLine.test(tok.raw)) {
          this.list.loose = true;
          break;
        }
      }
    }
  }

  // Handle task-list markers: checkbox tokens, and the marker text
  // stripped from the item text, the first token and the queued
  // inline source. Marked's own list() tail, kept verbatim in
  // behaviour; only the grouping and loop shapes changed.
  applyTasks() {
    const lexer = this.tok.lexer;
    for (const item of this.list.items) {
      const firstTok = item.tokens[0];
      const isTaskPara = item.task && (firstTok?.type === 'text' || firstTok?.type === 'paragraph');
      if (!isTaskPara) {
        if (item.task) item.task = false;
        continue;
      }
      item.text = item.text.replace(this.rules.other.listReplaceTask, '');
      firstTok.raw = firstTok.raw.replace(this.rules.other.listReplaceTask, '');
      firstTok.text = firstTok.text.replace(this.rules.other.listReplaceTask, '');
      for (let g = lexer.inlineQueue.length - 1; g >= 0; g -= 1) {
        if (this.rules.other.listIsTask.test(lexer.inlineQueue[g].src)) {
          lexer.inlineQueue[g].src = lexer.inlineQueue[g].src.replace(this.rules.other.listReplaceTask, '');
          break;
        }
      }
      const found = this.rules.other.listTaskCheckbox.exec(item.raw);
      if (found === null) continue;
      const boxTok = { type: 'checkbox', raw: found[0] + ' ', checked: found[0] !== '[ ]' };
      item.checked = boxTok.checked;
      if (!this.list.loose) {
        item.tokens.unshift(boxTok);
        continue;
      }
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
    }
  }

  // A loose list marks every item loose and turns its bare text
  // tokens into paragraphs.
  applyLoose() {
    if (!this.list.loose) return;
    for (const item of this.list.items) {
      item.loose = true;
      for (const tok of item.tokens) {
        if (tok.type === 'text') tok.type = 'paragraph';
      }
    }
  }
}

// ---------------------------------------------------------------------------
// TunedLexer: marked's Lexer with a first-character switch for block
// dispatch and a handler-map loop for emphasis-free inline sources.
// ---------------------------------------------------------------------------

// Inline handlers by first character code: each name is a method on
// the lexer that tries, in marked's order, the tokenisers that can
// open at that character. Characters with no entry cannot open any
// inline token but a url, which the loop tries next.
const INLINE_HANDLERS = {
  92: 'tryEscapeBr', // backslash
  60: 'tryTagAutolink', // <
  91: 'tryLinkReflink', // [
  33: 'tryLinkReflink', // !
  96: 'tryCodespan', // `
  32: 'tryBr', // space
};

class TunedLexer extends Lexer {
  // -- inline handlers for the no-emphasis loop ----------------------

  tryEscapeBr(src) {
    return this.tokenizer.escape(src) || this.tokenizer.br(src);
  }

  tryTagAutolink(src) {
    return this.tokenizer.tag(src) || this.tokenizer.autolink(src);
  }

  tryLinkReflink(src) {
    return this.tokenizer.link(src) || this.tokenizer.reflink(src, this.tokens.links);
  }

  tryCodespan(src) {
    return this.tokenizer.codespan(src);
  }

  tryBr(src) {
    return this.tokenizer.br(src);
  }

  // Inline loop for sources in which no emphasis or deletion span
  // can form (fewer than two of each of '*', '_' and '~'). Marked's
  // loop would run the masking pass first and call emStrong/del at
  // every delimiter position; neither can change the outcome here,
  // so this loop dispatches on the first character through the
  // handler map above, in marked's order, with the same token
  // merging (only reflink and inlineText can produce a text token,
  // so the merge check covers both). emStrong/del are never called.
  inlineNoEmphasis(src, tokens) {
    this.tokenizer.lexer = this;
    let shortest = Infinity;
    while (src.length > 0) {
      if (src.length < shortest) shortest = src.length;
      else { this.infiniteLoopError(src.charCodeAt(0)); break; }
      const handler = INLINE_HANDLERS[src.charCodeAt(0)];
      let tok;
      if (handler !== undefined) {
        tok = this[handler](src);
      } else if (this.state.inLink === false) {
        tok = this.tokenizer.url(src);
      }
      if (tok === undefined) tok = this.tokenizer.inlineText(src);
      if (tok === undefined) { this.infiniteLoopError(src.charCodeAt(0)); break; }
      src = src.substring(tok.raw.length);
      const prev = tokens[tokens.length - 1];
      if (tok.type === 'text' && prev !== undefined && prev.type === 'text') {
        prev.raw += tok.raw;
        prev.text += tok.text;
      } else {
        tokens.push(tok);
      }
    }
    return tokens;
  }

  // Plain-text fast path: when the inline source holds no inline
  // construct at all (no escape/tag/link/emphasis/code/del/autolink/
  // url starter and no hard break), marked's inline loop would
  // produce exactly one text token for it. Emit that token directly,
  // skipping the masking pass, the emphasis analysis and the
  // per-tokeniser dispatch. (Default options only: breaks off, no
  // inline extensions.) Two details make the direct emission exact:
  // inlineText decodes entities (only needed when the source holds
  // '&'), and it stops before a bare "http"/"https" word (its
  // regex's protocol lookahead needs no ://). With neither present,
  // one inlineText call would consume the whole source unchanged, so
  // the token is emitted without running the regex at all; with
  // either present, the source is consumed in successive inlineText
  // calls and merged, exactly as the inline loop does.
  inlinePlain(src, tokens) {
    this.tokenizer.lexer = this;
    if (src.indexOf('&') < 0 && HTTP_WORD.test(src) === false) {
      tokens.push({ type: 'text', raw: src, text: src, escaped: this.state.inRawBlock });
      return tokens;
    }
    let raw = '';
    let text = '';
    let escaped = this.state.inRawBlock;
    let rest = src;
    while (rest.length > 0) {
      const tok = this.tokenizer.inlineText(rest);
      if (tok === undefined || tok.raw.length === 0) {
        // inlineText made no progress — it never does on a plain
        // source, but a missed trigger must not silently drop text.
        // Fall back to marked's inline loop for the whole source.
        return super.inlineTokens(src, tokens);
      }
      raw += tok.raw;
      text += tok.text;
      escaped = tok.escaped;
      rest = rest.substring(tok.raw.length);
    }
    tokens.push({ type: 'text', raw, text, escaped });
    return tokens;
  }

  // Whether the fast inline paths may run for this source: default
  // options only (no pedantic, no hard breaks, no inline
  // extensions).
  fastInlineOk() {
    return !this.options.pedantic && !this.options.breaks &&
      !this.options.extensions?.inline && !this.options.extensions?.startInline;
  }

  inlineTokens(src, tokens = []) {
    this.tokenizer.lexer = this;
    // marked's own wrapper bookkeeping: linkParenPossible narrows
    // to sources holding a ')', and is restored afterwards, so a
    // failed link candidate in one source never suppresses a link
    // in the next.
    const prevParen = this.state.linkParenPossible;
    this.state.linkParenPossible = prevParen && src.includes(')');
    try {
      if (src.length > 0 && this.fastInlineOk()) {
        if (isBareText(src)) return this.inlinePlain(src, tokens);
        if (emphasisImpossible(src)) return this.inlineNoEmphasis(src, tokens);
      }
      return super.inlineTokens(src, tokens);
    } finally {
      this.state.linkParenPossible = prevParen;
    }
  }

  // -- block attempts: one method per tokeniser. Each returns the
  // remaining source after consuming its token, or null when the
  // tokeniser does not match. The merge rules are marked's own:
  // space appends a newline to the previous token's raw when it is
  // a single newline; code and def merge into a preceding paragraph
  // or text token; the rest push.
  takeSpace(src, tokens) {
    const tok = this.tokenizer.space(src);
    if (tok == null) return null;
    const prev = tokens[tokens.length - 1];
    if (tok.raw.length === 1 && prev !== undefined) prev.raw += '\n';
    else tokens.push(tok);
    return src.substring(tok.raw.length);
  }

  takeCode(src, tokens) {
    const tok = this.tokenizer.code(src);
    if (tok == null) return null;
    const prev = tokens[tokens.length - 1];
    if (prev !== undefined && (prev.type === 'paragraph' || prev.type === 'text')) {
      prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + tok.raw;
      prev.text += '\n' + tok.text;
      this.inlineQueue[this.inlineQueue.length - 1].src = prev.text;
    } else {
      tokens.push(tok);
    }
    return src.substring(tok.raw.length);
  }

  takeFences(src, tokens) {
    const tok = this.tokenizer.fences(src);
    if (tok == null) return null;
    tokens.push(tok);
    return src.substring(tok.raw.length);
  }

  takeHeading(src, tokens) {
    const tok = this.tokenizer.heading(src);
    if (tok == null) return null;
    tokens.push(tok);
    return src.substring(tok.raw.length);
  }

  takeHr(src, tokens) {
    const tok = this.tokenizer.hr(src);
    if (tok == null) return null;
    tokens.push(tok);
    return src.substring(tok.raw.length);
  }

  takeBlockquote(src, tokens) {
    const tok = this.tokenizer.blockquote(src);
    if (tok == null) return null;
    tokens.push(tok);
    return src.substring(tok.raw.length);
  }

  takeList(src, tokens) {
    const tok = this.tokenizer.list(src);
    if (tok == null) return null;
    tokens.push(tok);
    return src.substring(tok.raw.length);
  }

  takeHtml(src, tokens) {
    const tok = this.tokenizer.html(src);
    if (tok == null) return null;
    tokens.push(tok);
    return src.substring(tok.raw.length);
  }

  takeDef(src, tokens) {
    const tok = this.tokenizer.def(src);
    if (tok == null) return null;
    const prev = tokens[tokens.length - 1];
    if (prev !== undefined && (prev.type === 'paragraph' || prev.type === 'text')) {
      prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + tok.raw;
      prev.text += '\n' + tok.raw;
      this.inlineQueue[this.inlineQueue.length - 1].src = prev.text;
    } else {
      if (this.tokens.links[tok.tag] === undefined) {
        this.tokens.links[tok.tag] = { href: tok.href, title: tok.title };
      }
      tokens.push(tok);
    }
    return src.substring(tok.raw.length);
  }

  // The textual tail of marked's block order: table, setext heading,
  // paragraph, text. The table and setext attempts first pass their
  // cheap necessary-condition tests. `st.quote` carries the
  // blockquote-merge flag: a paragraph token ends the merge context
  // (marked sets it to `o.length !== src.length`, which is always
  // false without startBlock extensions).
  tryTextual(src, tokens, st) {
    if (secondLineHasDash(src)) {
      const tok = this.tokenizer.table(src);
      if (tok != null) {
        tokens.push(tok);
        return src.substring(tok.raw.length);
      }
    }
    if (setextLineAhead(src)) {
      const tok = this.tokenizer.lheading(src);
      if (tok != null) {
        tokens.push(tok);
        return src.substring(tok.raw.length);
      }
    }
    if (this.state.top !== false) {
      const tok = this.tokenizer.paragraph(src);
      if (tok != null) {
        const prev = tokens[tokens.length - 1];
        if (st.quote && prev !== undefined && prev.type === 'paragraph') {
          prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + tok.raw;
          prev.text += '\n' + tok.text;
          this.inlineQueue.pop();
          this.inlineQueue[this.inlineQueue.length - 1].src = prev.text;
        } else {
          tokens.push(tok);
        }
        st.quote = false;
        return src.substring(tok.raw.length);
      }
    }
    const tok = this.tokenizer.text(src);
    if (tok != null) {
      const prev = tokens[tokens.length - 1];
      if (prev !== undefined && prev.type === 'text') {
        prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + tok.raw;
        prev.text += '\n' + tok.text;
        this.inlineQueue.pop();
        this.inlineQueue[this.inlineQueue.length - 1].src = prev.text;
      } else {
        tokens.push(tok);
      }
      return src.substring(tok.raw.length);
    }
    return null;
  }

  // One block step: try the tokenisers that can open at the current
  // first character, in marked's order, and return the remaining
  // source — or null when nothing matches. A newline can only open a
  // blank-line block; a space or tab can open anything indented; a
  // digit can open a list; anything else falls through to the
  // textual tokenisers.
  blockStep(src, tokens, st) {
    const c0 = src.charCodeAt(0);
    switch (c0) {
      case 10: // \n
        return this.takeSpace(src, tokens);
      case 32: case 9: // space / tab
        return this.takeSpace(src, tokens) ?? this.takeCode(src, tokens) ??
          this.takeFences(src, tokens) ?? this.takeHeading(src, tokens) ??
          this.takeHr(src, tokens) ?? this.takeBlockquote(src, tokens) ??
          this.takeList(src, tokens) ?? this.takeHtml(src, tokens) ??
          this.takeDef(src, tokens) ?? this.tryTextual(src, tokens, st);
      case 35: // #
        return this.takeHeading(src, tokens) ?? this.tryTextual(src, tokens, st);
      case 62: // >
        return this.takeBlockquote(src, tokens) ?? this.tryTextual(src, tokens, st);
      case 96: case 126: // ` ~
        return this.takeFences(src, tokens) ?? this.tryTextual(src, tokens, st);
      case 45: case 42: case 95: // - * _
        return this.takeHr(src, tokens) ?? this.takeList(src, tokens) ??
          this.tryTextual(src, tokens, st);
      case 43: // +
        return this.takeList(src, tokens) ?? this.tryTextual(src, tokens, st);
      case 60: // <
        return this.takeHtml(src, tokens) ?? this.tryTextual(src, tokens, st);
      case 91: // [
        return this.takeDef(src, tokens) ?? this.tryTextual(src, tokens, st);
      default: {
        if (c0 >= 48 && c0 <= 57) { // digit
          const rest = this.takeList(src, tokens);
          if (rest !== null) return rest;
        }
        return this.tryTextual(src, tokens, st);
      }
    }
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
    const st = { quote: inBlockquote };
    let shortest = Infinity;
    while (src.length > 0) {
      if (src.length < shortest) shortest = src.length;
      else { this.infiniteLoopError(src.charCodeAt(0)); break; }
      const rest = this.blockStep(src, tokens, st);
      if (rest === null) { this.infiniteLoopError(src.charCodeAt(0)); break; }
      src = rest;
    }
    this.state.top = true;
    return tokens;
  }

  // Like marked's lex, but the whole-input CR normalisation is
  // skipped when the input holds no CR at all (the common case).
  lex(src) {
    if (src.includes('\r')) src = src.replace(this.tokenizer.rules.other.carriageReturn, '\n');
    this.blockTokens(src, this.tokens);
    for (const item of this.inlineQueue) {
      this.state.inRawBlock = false;
      this.inlineTokens(item.src, item.tokens);
    }
    this.inlineQueue = [];
    return this.tokens;
  }
}

// ---------------------------------------------------------------------------
// Entry point: exactly marked.parse with the defaults, through the fast
// lexer and the class renderer above.
// ---------------------------------------------------------------------------
export function parse(markdown) {
  if (markdown === undefined || markdown === null) {
    throw new Error('marked(): input parameter is undefined or null');
  }
  if (typeof markdown !== 'string') {
    throw new Error('marked(): input parameter is of type ' + Object.prototype.toString.call(markdown) + ', string expected');
  }
  const options = { ...defaults };
  options.tokenizer = new TunedTokenizer(options);
  const tokens = new TunedLexer(options).lex(markdown);
  const out = new HtmlRenderer();
  out.blocks(tokens);
  return out.parts.join('');
}
