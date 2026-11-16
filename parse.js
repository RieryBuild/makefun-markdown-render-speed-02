// parse.js — a faster drop-in for marked 18.1.3 (round 6).
//
// parse(markdown) returns exactly the HTML that marked.parse(markdown)
// returns with marked's stock settings: GFM on, breaks off, pedantic
// off, synchronous. The reference is the marked copy vendored at
// vendor/marked/marked.esm.js, shipped byte-for-byte (MIT). Where
// marked's output and the CommonMark/GFM specs disagree, marked wins
// — the spec is never the target here, and only marked's DEFAULT
// options are supported. Anything outside the defaults (pedantic mode,
// registered extensions) falls through to marked's own code.
//
// How this build is put together — marked's own lexer and tokenizer,
// with the slow parts fenced off by cheap checks, arranged as
// data-driven tables instead of nested switches:
//
//   1. A wrapped tokenizer: the stock marked Tokenizer with a table
//      of guard tests installed on it. Every guard looks at the
//      opening character (and, where it helps, asks indexOf for a
//      character the match cannot do without) before the original
//      method runs. Marked's inline loop tries every tokenizer at
//      every position; the guards turn the hopeless regex runs into
//      single-character tests, and the closer checks skip spans that
//      can never close.
//   2. A block walker that picks its attempt list from a route table
//      keyed by the first character code. Each attempt runs the
//      tokenizers that can open at that character, in marked's
//      order, and the textual tail (table, setext heading,
//      paragraph, text) is one shared routine. The two expensive
//      patterns in the tail first pass a cheap necessary-condition
//      test.
//   3. A list walker that moves by absolute index instead of
//      slicing a shrinking tail, with its per-indent block-start
//      patterns cached in a Map and its continuation lines sorted
//      by one classifier.
//   4. A writer object that turns tokens straight into HTML:
//      blocks append to a chunk array, inline and plain-text
//      rendering build strings by concatenation, and nested inline
//      content renders in one pass with no intermediate buffer.
//
// Inline speed comes from three shortcuts, each proven exact
// against marked by the differential suites: a source with no inline
// construct at all becomes one text token; a source in which no
// emphasis or deletion span can form runs a small table-driven loop
// instead of marked's try-everything loop; and a source whose
// emphasis spans can form but whose masking pass cannot change any
// emphasis or deletion decision runs the same table loop with
// emStrong/del switched on, skipping marked's three masking
// regexes outright. A hand-written inline scanner was tried in an
// earlier build and lost to marked's regex (V8 runs the big pattern
// in C++; a per-character JS loop cannot keep up), so inlineText
// itself is still marked's — only the dispatch around it is new.
//
// Every parse() call is independent: no state survives between
// calls, nothing is cached from one case to the next, nothing is
// written to /tmp.
import { Lexer, Tokenizer, defaults } from './vendor/marked/marked.esm.js';

// ---------------------------------------------------------------------------
// HTML escaping and href cleaning — marked's Renderer behaviour.
// ---------------------------------------------------------------------------

// The five characters marked escapes, each mapped to its entity.
// A lookup table keeps the replace callback allocation-free per
// match: the table is built once, the callback only indexes it.
const ESCAPE_MAP = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

// One shared replace callback (passed by reference, never
// re-created per call): the character's entity from the table.
function escChar(c) {
  return ESCAPE_MAP[c];
}

const HAS_ESCAPABLE = /[&<>"']/;
const HAS_ESCAPABLE_ALL = /[&<>"']/g;
const HAS_ESCAPABLE_NOAMP = /[<>"']/;
const HAS_ESCAPABLE_NOAMP_ALL = /[<>"']/g;
const HAS_ESCAPABLE_OR_ENTITY = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/;
const HAS_ESCAPABLE_OR_ENTITY_ALL = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;

// marked's escape(): with `encode`, every & < > " ' becomes an entity;
// without it, an & that already opens an entity reference stays put.
// A string without '&' cannot hold an entity reference, so its
// no-encode scan only needs the [<>"'] test. Each branch tests once
// and replaces once, returning early when nothing needs escaping.
function escapeStr(str, encode) {
  if (encode) {
    return HAS_ESCAPABLE.test(str) ? str.replace(HAS_ESCAPABLE_ALL, escChar) : str;
  }
  if (str.indexOf('&') === -1) {
    return HAS_ESCAPABLE_NOAMP.test(str) ? str.replace(HAS_ESCAPABLE_NOAMP_ALL, escChar) : str;
  }
  return HAS_ESCAPABLE_OR_ENTITY.test(str)
    ? str.replace(HAS_ESCAPABLE_OR_ENTITY_ALL, escChar)
    : str;
}

// marked's href cleaning: encodeURI, with %25 restored to %, or null
// when the URI refuses to encode.
function cleanHref(href) {
  try {
    return encodeURI(href).replace(/%25/g, '%');
  } catch {
    return null;
  }
}

const LEADING_WORD = /^\S*/;
const TRAILING_NL = /\n$/;

// ---------------------------------------------------------------------------
// Small string helpers for the lexer and the tokenizer.
// ---------------------------------------------------------------------------

// The first line of `s` (up to the first \n, otherwise the whole
// string), located by index instead of by splitting.
function firstLine(s) {
  const cut = s.indexOf('\n');
  return cut === -1 ? s : s.slice(0, cut);
}

// How many spaces lead `s`. Tabs do not count: the block patterns
// only allow spaces ahead of a marker.
function leadSpaces(s) {
  let n = 0;
  while (n < s.length && s.charCodeAt(n) === 32) n += 1;
  return n;
}

// Columns count Unicode code points, as marked's tab helper does: a
// segment holding a surrogate pair counts its code points, not its
// UTF-16 units.
const HAS_HIGH = /[\uD800-\uDBFF]/;
function cpLength(seg) {
  return HAS_HIGH.test(seg) ? [...seg].length : seg.length;
}

// Expand the tabs in `s` to spaces, counting columns from `col`
// (marked's tab helper, default column 0). Splitting on the tabs
// keeps the work proportional to the number of tabs, not the number
// of characters: each segment joins with the padding its start
// column needs. A string with no tab is already expanded, so it is
// returned untouched — the usual case is leading spaces.
function expandTabs(s, col = 0) {
  if (s.indexOf('\t') === -1) return s;
  const segs = s.split('\t');
  let out = segs[0];
  let at = col + cpLength(segs[0]);
  for (let i = 1; i < segs.length; i += 1) {
    const pad = 4 - (at % 4);
    out += ' '.repeat(pad);
    out += segs[i];
    at += pad + cpLength(segs[i]);
  }
  return out;
}

// Expand the tabs in the leading whitespace of `line` (marked's
// leadingSpaceTab replace). The leading run is found by index; a run
// holding no tab replaces to itself, so the line is returned
// untouched in that case instead of being rebuilt.
function expandLead(line, col) {
  let end = 0;
  while (end < line.length) {
    const c = line.charCodeAt(end);
    if (c !== 32 && c !== 9) break;
    end += 1;
  }
  if (end === 0) return line;
  const lead = line.slice(0, end);
  if (lead.indexOf('\t') === -1) return line;
  return expandTabs(lead, col) + line.slice(end);
}

// Anything that can open an inline token other than plain text: the
// inline stop characters, an autolink or url trigger, or a hard break.
// One regex scan; when it misses, the text holds no inline construct
// at all and is a single text token.
const INLINE_TRIGGERS = /www\.|mailto:|xmpp:|:\/\/| {2}\n|[\\<!\[`*_~@]/;
function hasMarkup(src) {
  return INLINE_TRIGGERS.test(src);
}

// A bare http/https word is the one place inlineText stops inside an
// otherwise plain source (its regex has a protocol lookahead with no
// word boundary), so a plain source holding one still goes through
// inlineText.
const BARE_HTTP = /http/i;

// True when `ch` turns up at least twice in `src`. Native indexOf
// scans run in C++ and exit as soon as the second occurrence is
// found, which beats a per-character JS loop here.
function occursTwice(src, ch) {
  const first = src.indexOf(ch);
  return first !== -1 && src.indexOf(ch, first + 1) !== -1;
}

// Whether an emphasis or deletion span could form in `src`: each of
// '*', '_' and '~' needs two occurrences, an opener plus a matching
// closer of the same character. If none of the three appears twice,
// no span can form.
function spansPossible(src) {
  return occursTwice(src, '*') || occursTwice(src, '_') || occursTwice(src, '~');
}

// Whether the second line of `src` holds a '-'. A table's delimiter
// row sits on the second line and every cell holds at least one '-',
// so without one the table regex cannot match. Found with indexOf
// scans (C++ speed, no regex): the first newline, then a '-' before
// the next newline.
function dashOnLineTwo(src) {
  const nl = src.indexOf('\n');
  if (nl === -1) return false;
  const dash = src.indexOf('-', nl + 1);
  if (dash === -1) return false;
  const nl2 = src.indexOf('\n', nl + 1);
  return nl2 === -1 || dash < nl2;
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
function setextNear(src) {
  // Cheap pre-filter: every match starts with a newline whose next
  // character is a newline, a space, a tab, '=' or '-'. Five indexOf
  // scans in C++; when none of them hits, the regex cannot match and
  // never runs. (A '\n ' hit can still be a false alarm — e.g. an
  // indented continuation line — so a hit only ever says "maybe".)
  if (src.indexOf('\n\n') === -1 && src.indexOf('\n=') === -1 && src.indexOf('\n-') === -1 &&
      src.indexOf('\n ') === -1 && src.indexOf('\n\t') === -1) return false;
  const m = SETEXT_OR_BLANK.exec(src);
  if (m === null) return false;
  return m[0].charCodeAt(m[0].length - 1) !== 10;
}

// The start of an email address as marked's url regex sees it: a run
// of local-part characters followed by '@'. A full address needs
// more than that, so this test is a superset — it only ever says
// "maybe", never wrongly "no".
const EMAIL_HEAD = /^[A-Za-z0-9._+-]+@/;

// True when `src` holds `word` at offset `at`, compared
// case-insensitively on ASCII letters (a fast char-code check that
// avoids the slice + toLowerCase allocation).
function ciMatch(src, at, word) {
  if (at + word.length > src.length) return false;
  for (let i = 0; i < word.length; i += 1) {
    let a = src.charCodeAt(at + i);
    const b = word.charCodeAt(i);
    if (a >= 65 && a <= 90) a += 32;
    if (a !== b) return false;
  }
  return true;
}

// Whether `src` could match marked's url regex at all. The regex has
// three alternatives: a scheme prefix (mailto:, xmpp:, http(s)://,
// ftp://, www.) or an email (a run of local-part characters
// followed by '@'). Anything else fails it — most inline positions
// included. The case rules are marked's own: http/https and ftp
// match in any case, while www., mailto: and xmpp: are
// lowercase-only (WWW.example.com and MAILTO: render as plain text
// in marked too). The first character picks which prefix test can
// apply; anything else falls through to the email test.
function urlPossible(src) {
  const c = src.charCodeAt(0);
  if (c === 119 && src.startsWith('www.')) return true; // w
  if (c === 109 && src.startsWith('mailto:')) return true; // m
  if (c === 120 && src.startsWith('xmpp:')) return true; // x
  if (c === 104 || c === 72) { // h H — http:// or https://, any case
    if (ciMatch(src, 1, 'ttp://') || ciMatch(src, 1, 'ttps://')) return true;
  }
  if (c === 102 || c === 70) { // f F — ftp://, any case
    if (ciMatch(src, 1, 'tp://')) return true;
  }
  return EMAIL_HEAD.test(src);
}

// Whether `line` holds only spaces/tabs (or nothing): a blank-line
// test that allocates nothing, unlike trim().
function isBlankLine(line) {
  for (let i = 0; i < line.length; i += 1) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

// How long the run of `ch` is at the start of `src` (an opener run
// of backticks, asterisks, underscores or tildes).
function runOf(src, ch) {
  let n = 0;
  while (n < src.length && src.charCodeAt(n) === ch) n += 1;
  return n;
}

// ---------------------------------------------------------------------------
// Rendering: a writer object, no renderer instance.
//
// parse() only ever runs with marked's defaults (no extensions, no
// custom renderer, silent off), so the per-token extension checks
// and the Parser/Renderer/TextRenderer construction are pure
// overhead. Each method below replicates one of marked's Renderer
// methods exactly (same HTML, same escaping, same href sanitizing)
// without them. Blocks append straight into a chunk array; inline
// and plain-text rendering return strings, so a paragraph or a
// link label renders as one concatenation with no intermediate
// buffer. One writer is built per parse() call and thrown away
// with it — no state survives between calls.
// ---------------------------------------------------------------------------

function unknownToken(tok) {
  throw new Error('Token with "' + tok.type + '" type was not found.');
}

// The writer's methods live on one shared prototype object, so a
// parse() call allocates one small instance (Object.create + a
// parts array) instead of nine fresh method functions — on the 680
// tiny spec cases that allocation was pure overhead, with no work
// to amortize it.
const WRITER_PROTO = {

    // The text/escape case shared by the block and inline levels: a
    // token with sub-tokens renders them, an escaped token is already
    // final, otherwise escape it.
    textToken(tok) {
      if (tok.tokens) return this.inline(tok.tokens);
      if (tok.escaped) return tok.text;
      return escapeStr(tok.text);
    },

    cell(cell) {
      const inner = this.inline(cell.tokens);
      const tag = cell.header ? 'th' : 'td';
      if (cell.align) {
        this.parts.push(`<${tag} align="${cell.align}">${inner}</${tag}>\n`);
      } else {
        this.parts.push(`<${tag}>${inner}</${tag}>\n`);
      }
    },

    block(tok) {
      switch (tok.type) {
        case 'space':
          // A blank-line block contributes nothing.
          break;
        case 'hr':
          this.parts.push('<hr>\n');
          break;
        case 'heading':
          this.parts.push(`<h${tok.depth}>${this.inline(tok.tokens)}</h${tok.depth}>\n`);
          break;
        case 'code': {
          const lang = (tok.lang || '').match(LEADING_WORD)?.[0];
          let body = '';
          if (tok.text) body = tok.text.replace(TRAILING_NL, '') + '\n';
          const inner = tok.escaped ? body : escapeStr(body, true);
          if (lang) {
            this.parts.push(`<pre><code class="language-${escapeStr(lang)}">${inner}</code></pre>\n`);
          } else {
            this.parts.push(`<pre><code>${inner}</code></pre>\n`);
          }
          break;
        }
        case 'table':
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
          break;
        case 'blockquote':
          this.parts.push('<blockquote>\n');
          this.blocks(tok.tokens);
          this.parts.push('</blockquote>\n');
          break;
        case 'list': {
          const tag = tok.ordered ? 'ol' : 'ul';
          let open = `<${tag}`;
          if (tok.ordered && tok.start !== 1) open += ` start="${tok.start}"`;
          this.parts.push(open + '>\n');
          for (const item of tok.items) {
            this.parts.push('<li>');
            this.blocks(item.tokens);
            this.parts.push('</li>\n');
          }
          this.parts.push(`</${tag}>\n`);
          break;
        }
        case 'checkbox':
          this.parts.push('<input ' + (tok.checked ? 'checked="" ' : '') + 'disabled="" type="checkbox"> ');
          break;
        case 'html':
          this.parts.push(tok.text);
          break;
        case 'def':
          // A link definition contributes nothing.
          break;
        case 'paragraph':
          this.parts.push(`<p>${this.inline(tok.tokens)}</p>\n`);
          break;
        case 'text':
          this.parts.push(this.textToken(tok));
          break;
        default:
          unknownToken(tok);
      }
    },

    blocks(tokens) {
      for (let i = 0; i < tokens.length; i += 1) this.block(tokens[i]);
    },

    // Inline level: every case returns its string, so a paragraph or
    // a link label renders as one concatenation.
    inlineOne(tok) {
      switch (tok.type) {
        case 'escape':
        case 'text':
          return this.textToken(tok);
        case 'html':
          return tok.text;
        case 'link': {
          const label = tok.autolink
            ? escapeStr(tok.text, true)
            : this.inline(tok.tokens);
          const href = cleanHref(tok.href);
          if (href === null) return label;
          let tag = '<a href="' + escapeStr(href, !!tok.autolink) + '"';
          if (tok.title) tag += ' title="' + escapeStr(tok.title) + '"';
          return tag + '>' + label + '</a>';
        }
        case 'image': {
          const alt = tok.tokens ? this.plain(tok.tokens) : tok.text;
          const href = cleanHref(tok.href);
          if (href === null) return escapeStr(alt);
          let tag = '<img src="' + escapeStr(href) + '" alt="' + escapeStr(alt) + '"';
          if (tok.title) tag += ' title="' + escapeStr(tok.title) + '"';
          return tag + '>';
        }
        case 'checkbox':
          return '<input ' + (tok.checked ? 'checked="" ' : '') + 'disabled="" type="checkbox"> ';
        case 'strong':
          return '<strong>' + this.inline(tok.tokens) + '</strong>';
        case 'em':
          return '<em>' + this.inline(tok.tokens) + '</em>';
        case 'codespan':
          return '<code>' + escapeStr(tok.text, true) + '</code>';
        case 'br':
          return '<br>';
        case 'del':
          return '<del>' + this.inline(tok.tokens) + '</del>';
        default:
          unknownToken(tok);
      }
    },

    inline(tokens) {
      let out = '';
      for (let i = 0; i < tokens.length; i += 1) out += this.inlineOne(tokens[i]);
      return out;
    },

    // Plain-text level (marked's TextRenderer, used for image alt
    // text): inline tokens rendered to plain text, all markup dropped.
    plainOne(tok) {
      switch (tok.type) {
        case 'escape':
        case 'text':
        case 'html':
        case 'codespan':
          return tok.text;
        case 'link':
        case 'image':
        case 'strong':
        case 'em':
        case 'del':
          if (tok.tokens) return this.plain(tok.tokens);
          return tok.text;
        case 'br':
          // A hard break contributes nothing to plain text.
          return '';
        case 'checkbox':
          return tok.raw;
        default:
          unknownToken(tok);
      }
    },

    plain(tokens) {
      let out = '';
      for (let i = 0; i < tokens.length; i += 1) out += this.plainOne(tokens[i]);
      return out;
    },

    html(tokens) {
      this.blocks(tokens);
      return this.parts.join('');
    },
};

function makeWriter() {
  const w = Object.create(WRITER_PROTO);
  w.parts = [];
  return w;
}

// ---------------------------------------------------------------------------
// Tokenizer: a stock marked Tokenizer with guarded methods installed
// from a table. Each guard looks at the first character (and, where
// it helps, a cheap indexOf for a character the match cannot do
// without) before the big regex ever runs; when the guard passes
// the original prototype method runs. Marked's inline loop tries
// every tokenizer at every position; the guard turns the hopeless
// regex runs per text position into cheap single-character tests,
// and the closer checks skip spans that cannot close.
//
// NOTE: inlineText is deliberately left as marked wrote it. A
// hand-written scanner was built and verified 720/720 in an earlier
// entry, but it ran ~15% SLOWER than marked's regex (V8 executes the
// big regex in C++; a per-character JS loop cannot keep up). Marked's
// own inlineText runs instead.
// ---------------------------------------------------------------------------

// Guard tests, one per tokenizer method: (src, tz) => may this
// method match here? Every test is a necessary condition — a "no"
// is always right, a "yes" only ever says "maybe", so the original
// method still decides. The list guard is installed separately
// below, since it replaces the method outright.
const TOKEN_GUARDS = {
  escape(src) {
    return src.charCodeAt(0) === 92; // backslash
  },
  tag(src) {
    return src.charCodeAt(0) === 60 && src.indexOf('>') !== -1; // <, and every tag ends with '>'
  },
  reflink(src) {
    const c0 = src.charCodeAt(0);
    return (c0 === 91 || c0 === 33) && src.indexOf(']') !== -1; // [ !, and reflink/nolink both need a ']'
  },
  emStrong(src) {
    const c0 = src.charCodeAt(0);
    if (c0 !== 42 && c0 !== 95) return false; // * _
    // An emphasis span needs a closer of the same character after
    // the opener run; without one, emStrong cannot match.
    return src.indexOf(c0 === 42 ? '*' : '_', runOf(src, c0)) !== -1;
  },
  codespan(src) {
    if (src.charCodeAt(0) !== 96) return false; // `
    // A code span needs a closing backtick run after the opener run.
    return src.indexOf('`', runOf(src, 96)) !== -1;
  },
  br(src) {
    const c0 = src.charCodeAt(0);
    // br is two or more spaces + newline, or backslash + newline.
    const twoSpaces = c0 === 32 && src.charCodeAt(1) === 32;
    const backslashNl = c0 === 92 && src.charCodeAt(1) === 10;
    return twoSpaces || backslashNl;
  },
  del(src) {
    if (src.charCodeAt(0) !== 126) return false; // ~
    // A deletion span needs a closer after the opener run; without
    // another '~' at all, del cannot match.
    return src.indexOf('~', runOf(src, 126)) !== -1;
  },
  autolink(src) {
    return src.charCodeAt(0) === 60 && src.indexOf('>') !== -1; // <, and every autolink ends with '>'
  },
  url(src) {
    return urlPossible(src);
  },
  link(src, tz) {
    const c0 = src.charCodeAt(0);
    if (c0 !== 91 && c0 !== 33) return false; // [ !
    // The link pattern needs a literal '](' (label close + paren
    // open). Without one anywhere in the remaining input it cannot
    // match, so skip the giant regex (it is tried at every '[' and
    // usually fails).
    if (src.indexOf('](') === -1) return false;
    return tz.lexer.state.linkParenPossible !== false;
  },
};

// The guarded methods themselves are built once, at module load:
// each one closes over its test and its original prototype method,
// and wrapTokenizer only assigns the shared references. Building
// ten fresh closures per parse() call was pure overhead on the 680
// tiny spec cases.
const GUARDED_METHODS = {};
for (const name of Object.keys(TOKEN_GUARDS)) {
  const test = TOKEN_GUARDS[name];
  const orig = Tokenizer.prototype[name];
  GUARDED_METHODS[name] = function (src, a, b) {
    if (!test(src, this)) return undefined;
    return orig.call(this, src, a, b);
  };
}

function listMethod(src) {
  return walkList(this, src);
}

function wrapTokenizer(options) {
  const tz = new Tokenizer(options);
  for (const name of Object.keys(GUARDED_METHODS)) tz[name] = GUARDED_METHODS[name];
  tz.list = listMethod;
  return tz;
}

// List tokenizer: marked's, as a walker object whose methods share
// one position field. It walks the source by absolute index instead
// of slicing a shrinking tail. Behaviour is marked's own, kept
// verbatim; only the grouping and the line reads changed.
function walkList(tz, src) {
  const w = {
    tz,
    src,
    rules: tz.rules,
    options: tz.options,
    at: 0,
    patternCache: new Map(),
    sawDoubleBlank: false,
    list: null,
    itemPattern: null,
    indent: 0,
    pats: null,

    // The six per-line block-start patterns for an item indent. The
    // patterns depend only on the indent (and the fixed pedantic
    // flag), and none of them is global or sticky, so a set built once
    // for an indent is safe to reuse across every item that shares it
    // instead of compiling six fresh regexes per item.
    patternsFor(n) {
      let r = this.patternCache.get(n);
      if (r === undefined) {
        r = {
          bullet: this.rules.other.nextBulletRegex(n),
          hr: this.rules.other.hrRegex(n),
          fence: this.rules.other.fencesBeginRegex(n),
          heading: this.options.pedantic
            ? this.rules.other.pedanticHeadingBeginRegex(n)
            : this.rules.other.headingBeginRegex(n),
          html: this.rules.other.htmlBeginRegex(n),
          quote: this.rules.other.blockquoteBeginRegex(n),
        };
        this.patternCache.set(n, r);
      }
      return r;
    },

    // The line starting at `at` (up to the next \n, or the end).
    lineAt(at) {
      const end = this.src.indexOf('\n', at);
      return end === -1 ? this.src.slice(at) : this.src.slice(at, end);
    },

    // Whether the list-item line `line` starts a new block: the six
    // tests marked runs per line, picked by the line's first non-space
    // character. Only tests whose pattern can match that character
    // run; the outcome is identical. A digit (not in the switch)
    // always takes the bullet test. Only spaces count toward the
    // indent the patterns allow — each pattern allows at most indent-1
    // leading spaces, so a line with indent or more cannot start a
    // block.
    opensBlock(line) {
      let p = 0;
      while (p < line.length && line.charCodeAt(p) === 32) p += 1;
      if (p >= this.indent) return false;
      const c = line.charCodeAt(p);
      switch (c) {
        case 96: case 126: return this.pats.fence.test(line); // ` ~ -> fence
        case 35: return this.pats.heading.test(line); // # -> heading
        case 60: return this.pats.html.test(line); // < -> html
        case 62: return this.pats.quote.test(line); // > -> quote
        case 43: return this.pats.bullet.test(line); // + -> bullet
        case 45: case 42: return this.pats.bullet.test(line) || this.pats.hr.test(line); // - * -> bullet or hr
        case 95: return this.pats.hr.test(line); // _ -> hr only (never a bullet marker)
        default:
          if (c >= 48 && c <= 57) return this.pats.bullet.test(line); // digit
          return false;
      }
    },

    // Whether a list-item continuation line ends the item instead of
    // extending it: any of the block-start patterns matches the marker
    // line, the previous line was blank, or the marker line is indented
    // four or more spaces in. Marked's own list() code, kept verbatim
    // in behaviour; only the grouping changed.
    endsItem(markerLine, prevBlank) {
      if (this.pats.fence.test(markerLine) || this.pats.heading.test(markerLine) ||
          this.pats.html.test(markerLine) || this.pats.hr.test(markerLine)) return true;
      if (prevBlank) return true;
      let flat = markerLine;
      if (markerLine.indexOf('\t') !== -1) {
        flat = markerLine.replace(this.rules.other.tabCharGlobal, '    ');
      }
      return flat.search(this.rules.other.nonSpaceChar) >= 4;
    },

    // What a continuation line does to the item body: 0 = join it,
    // 1 = stop the item here, 2 = join it as a setext continuation.
    // The three questions are computed up front, then one branch
    // runs — the same decisions marked's list() makes, in the same
    // order. `following` is the line the block-start tests see
    // (pedantic nesting already replaced); `expanded` is the line
    // with its leading tabs expanded, which the indent test reads.
    lineAction(line, following, expanded, markerLine, prevBlank) {
      if (this.opensBlock(following)) return 1;
      const blank = isBlankLine(line);
      if (leadSpaces(expanded) >= this.indent || blank) return 0;
      if (this.endsItem(markerLine, prevBlank)) return 1;
      if (this.options.pedantic === false &&
          /^ {0,3}(?:=+|-+) *$/.test(line) &&
          this.rules.block.lheading.test(markerLine + '\n' + line)) return 2;
      return 0;
    },

    // Consume the continuation lines of one item, starting from the
    // marker line's body. Lines that open a new block, lines the
    // continuation rules reject, and lines past a blank line after
    // content end the item; the rest join the body, indented lines
    // stripped of the item indent.
    collect(body, markerLine, prevBlank) {
      while (this.at < this.src.length) {
        const line = this.lineAt(this.at);
        let following;
        let expanded;
        if (this.options.pedantic) {
          following = line.replace(this.rules.other.listReplaceNesting, '  ');
          expanded = following;
        } else {
          following = line;
          expanded = expandLead(line, 0);
        }
        const action = this.lineAction(line, following, expanded, markerLine, prevBlank);
        if (action === 1) break;
        const lineBlank = isBlankLine(line);
        if (action === 2) {
          body += '\n    ' + expanded.replace(/^ {0,3}/, '');
        } else if (leadSpaces(expanded) >= this.indent || lineBlank) {
          body += '\n' + expanded.slice(this.indent);
        } else {
          body += '\n' + line;
        }
        prevBlank = lineBlank;
        this.at += line.length + 1;
        markerLine = expanded.slice(this.indent);
      }
      return body;
    },

    // Note a finished item's raw text against the loose-list
    // bookkeeping: a double blank line anywhere in an item makes
    // the whole list loose.
    noteRaw(rawItem) {
      if (this.list.loose) return;
      if (this.sawDoubleBlank) this.list.loose = true;
      else if (endsDoubleBlank(rawItem)) this.sawDoubleBlank = true;
    },

    // Gather one list item starting at the current position. Returns
    // false when no further item opens here (the item pattern fails
    // or the rest is a horizontal rule), which ends the list.
    readOne() {
      const rest = this.src.slice(this.at);
      const m = this.itemPattern.exec(rest);
      if (m === null || this.rules.block.hr.test(rest)) return false;
      const itemStart = this.at;
      this.at += m[0].length;
      const head = firstLine(m[2]);
      const markerLen = m[1].length;
      let markerLine;
      if (this.options.pedantic) markerLine = expandTabs(head, markerLen);
      else markerLine = expandLead(head, markerLen);
      const following = this.lineAt(this.at);
      const markerBlank = isBlankLine(markerLine);
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
        const lead = leadSpaces(markerLine);
        this.indent = lead > 4 ? 1 : lead;
        body = markerLine.slice(this.indent);
        this.indent += markerLen;
      }
      if (markerBlank && this.rules.other.blankLine.test(following)) {
        this.at += following.length + 1;
        emptyItem = true;
      }
      if (!emptyItem) {
        this.pats = this.patternsFor(this.indent);
        body = this.collect(body, markerLine, prevBlank);
      }
      const rawItem = this.src.slice(itemStart, this.at);
      this.noteRaw(rawItem);
      this.list.items.push({
        type: 'list_item', raw: rawItem,
        task: !!this.options.gfm && this.rules.other.listIsTask.test(body),
        loose: false, text: body, tokens: [],
      });
      return true;
    },

    // Tokenize every item's text and work out whether the list is
    // loose: any item whose tokens hold a blank-line space token
    // makes the whole list loose.
    tokenizeItems() {
      const lexer = this.tz.lexer;
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
    },

    // Handle task-list markers: checkbox tokens, and the marker text
    // stripped from the item text, the first token and the queued
    // inline source. Marked's own list() tail, kept verbatim in
    // behaviour; only the grouping and loop shapes changed.
    fixTasks() {
      const lexer = this.tz.lexer;
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
    },

    // A loose list marks every item loose and turns its bare text
    // tokens into paragraphs.
    fixLoose() {
      if (!this.list.loose) return;
      for (const item of this.list.items) {
        item.loose = true;
        for (const tok of item.tokens) {
          if (tok.type === 'text') tok.type = 'paragraph';
        }
      }
    },

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
      this.itemPattern = this.rules.other.listItemRegex(marker);
      while (this.at < this.src.length) {
        if (!this.readOne()) break;
      }
      const items = this.list.items;
      const last = items[items.length - 1];
      if (last === undefined) return undefined;
      last.raw = last.raw.trimEnd();
      last.text = last.text.trimEnd();
      this.list.raw = this.src.slice(0, this.at).trimEnd();
      this.tokenizeItems();
      this.fixTasks();
      this.fixLoose();
      return this.list;
    },
  };
  return w.run();
}

// ---------------------------------------------------------------------------
// Block walk: a route table keyed by first character code.
//
// The block walk picks its attempt list from BLOCK_ROUTES: each case
// runs the tokenizers that can open at that character, in marked's
// order, and the textual tail (table, setext heading, paragraph,
// text) is one shared routine. The two expensive patterns in the
// tail first pass their cheap necessary-condition tests. The order
// and the merging rules are marked's own, unchanged. Falls back to
// marked's loop for pedantic mode or when block extensions are
// registered. Each attempt takes the walk context (lexer, token
// list, blockquote-merge flag) and the remaining source, and returns
// the remaining source after its token — or null when its tokenizer
// does not match.
// ---------------------------------------------------------------------------

// Fold a code/def token into a preceding paragraph/text token the
// way marked's block loop does: the raw grows by the token's raw
// (with a newline separator unless one is already there), the text
// grows by `textBit`, and the queued inline source is updated to
// the merged text. `dropQueued` pops the stale queue entry first
// (paragraph and text merges do; code and def merges do not).
function mergeIntoPrev(ctx, tok, textBit, dropQueued) {
  if (dropQueued) ctx.lx.inlineQueue.pop();
  const prev = ctx.tokens[ctx.tokens.length - 1];
  prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + tok.raw;
  prev.text += '\n' + textBit;
  ctx.lx.inlineQueue[ctx.lx.inlineQueue.length - 1].src = prev.text;
}

function attemptSpace(ctx, s) {
  const tok = ctx.lx.tokenizer.space(s);
  if (tok == null) return null;
  const prev = ctx.tokens[ctx.tokens.length - 1];
  if (tok.raw.length === 1 && prev !== undefined) prev.raw += '\n';
  else ctx.tokens.push(tok);
  return s.substring(tok.raw.length);
}

function attemptCode(ctx, s) {
  const tok = ctx.lx.tokenizer.code(s);
  if (tok == null) return null;
  const prev = ctx.tokens[ctx.tokens.length - 1];
  if (prev !== undefined && (prev.type === 'paragraph' || prev.type === 'text')) {
    mergeIntoPrev(ctx, tok, tok.text, false);
  } else {
    ctx.tokens.push(tok);
  }
  return s.substring(tok.raw.length);
}

function attemptFences(ctx, s) {
  const tok = ctx.lx.tokenizer.fences(s);
  if (tok == null) return null;
  ctx.tokens.push(tok);
  return s.substring(tok.raw.length);
}

function attemptHeading(ctx, s) {
  const tok = ctx.lx.tokenizer.heading(s);
  if (tok == null) return null;
  ctx.tokens.push(tok);
  return s.substring(tok.raw.length);
}

function attemptHr(ctx, s) {
  const tok = ctx.lx.tokenizer.hr(s);
  if (tok == null) return null;
  ctx.tokens.push(tok);
  return s.substring(tok.raw.length);
}

function attemptQuote(ctx, s) {
  const tok = ctx.lx.tokenizer.blockquote(s);
  if (tok == null) return null;
  ctx.tokens.push(tok);
  return s.substring(tok.raw.length);
}

function attemptList(ctx, s) {
  const tok = ctx.lx.tokenizer.list(s);
  if (tok == null) return null;
  ctx.tokens.push(tok);
  return s.substring(tok.raw.length);
}

function attemptHtml(ctx, s) {
  const tok = ctx.lx.tokenizer.html(s);
  if (tok == null) return null;
  ctx.tokens.push(tok);
  return s.substring(tok.raw.length);
}

function attemptDef(ctx, s) {
  const tok = ctx.lx.tokenizer.def(s);
  if (tok == null) return null;
  const prev = ctx.tokens[ctx.tokens.length - 1];
  if (prev !== undefined && (prev.type === 'paragraph' || prev.type === 'text')) {
    mergeIntoPrev(ctx, tok, tok.raw, false);
  } else {
    if (ctx.lx.tokens.links[tok.tag] === undefined) {
      ctx.lx.tokens.links[tok.tag] = { href: tok.href, title: tok.title };
    }
    ctx.tokens.push(tok);
  }
  return s.substring(tok.raw.length);
}

// The textual tail of marked's block order: table, setext heading,
// paragraph, text. The table and setext attempts first pass their
// cheap necessary-condition tests. `ctx.quote` carries the
// blockquote-merge flag: a paragraph token ends the merge context
// (marked sets it to `o.length !== src.length`, which is always
// false without startBlock extensions).
function textTail(ctx, s) {
  if (dashOnLineTwo(s)) {
    const tok = ctx.lx.tokenizer.table(s);
    if (tok != null) {
      ctx.tokens.push(tok);
      return s.substring(tok.raw.length);
    }
  }
  if (setextNear(s)) {
    const tok = ctx.lx.tokenizer.lheading(s);
    if (tok != null) {
      ctx.tokens.push(tok);
      return s.substring(tok.raw.length);
    }
  }
  if (ctx.lx.state.top !== false) {
    const tok = ctx.lx.tokenizer.paragraph(s);
    if (tok != null) {
      const prev = ctx.tokens[ctx.tokens.length - 1];
      if (ctx.quote && prev !== undefined && prev.type === 'paragraph') {
        mergeIntoPrev(ctx, tok, tok.text, true);
      } else {
        ctx.tokens.push(tok);
      }
      ctx.quote = false;
      return s.substring(tok.raw.length);
    }
  }
  const tok = ctx.lx.tokenizer.text(s);
  if (tok != null) {
    const prev = ctx.tokens[ctx.tokens.length - 1];
    if (prev !== undefined && prev.type === 'text') {
      mergeIntoPrev(ctx, tok, tok.text, true);
    } else {
      ctx.tokens.push(tok);
    }
    return s.substring(tok.raw.length);
  }
  return null;
}

// One block step's attempt list per opening character. A newline
// can only open a blank-line block; a space or tab can open
// anything indented; a digit can open a list; anything else falls
// through to the textual tokenizers.
const BLOCK_ROUTES = [];
BLOCK_ROUTES[10] = [attemptSpace]; // \n
BLOCK_ROUTES[32] = BLOCK_ROUTES[9] = [attemptSpace, attemptCode, attemptFences, attemptHeading, attemptHr, attemptQuote, attemptList, attemptHtml, attemptDef]; // space, tab
BLOCK_ROUTES[35] = [attemptHeading]; // #
BLOCK_ROUTES[62] = [attemptQuote]; // >
BLOCK_ROUTES[96] = BLOCK_ROUTES[126] = [attemptFences]; // ` ~
BLOCK_ROUTES[45] = BLOCK_ROUTES[42] = BLOCK_ROUTES[95] = [attemptHr, attemptList]; // - * _
BLOCK_ROUTES[43] = [attemptList]; // +
BLOCK_ROUTES[60] = [attemptHtml]; // <
BLOCK_ROUTES[91] = [attemptDef]; // [
const DIGIT_ROUTE = [attemptList];

function walkBlocks(lx, src, tokens = [], inBlockquote = false) {
  if (lx.options.pedantic || lx.options.extensions?.block || lx.options.extensions?.startBlock) {
    return Lexer.prototype.blockTokens.call(lx, src, tokens, inBlockquote);
  }
  lx.tokenizer.lexer = lx;
  const ctx = { lx, tokens, quote: inBlockquote };
  let shortest = Infinity;
  while (src.length > 0) {
    if (src.length < shortest) shortest = src.length;
    else { lx.infiniteLoopError(src.charCodeAt(0)); break; }
    const code = src.charCodeAt(0);
    let route = BLOCK_ROUTES[code];
    if (route === undefined && code >= 48 && code <= 57) route = DIGIT_ROUTE; // digit
    let rest = null;
    let done = false;
    if (route !== undefined) {
      for (let i = 0; i < route.length; i += 1) {
        rest = route[i](ctx, src);
        if (rest !== null) { done = true; break; }
      }
    }
    if (!done) {
      rest = textTail(ctx, src);
      if (rest === null) { lx.infiniteLoopError(src.charCodeAt(0)); break; }
    }
    src = rest;
  }
  lx.state.top = true;
  return tokens;
}

// One inline loop for both fast paths, dispatching on the first
// character through a handler table in marked's own order. With
// `spans` false it serves sources in which no emphasis or deletion
// span can form (fewer than two of each of '*', '_' and '~'):
// emStrong and del are never called, and delimiter positions fall
// straight through to inlineText. With `spans` true it serves
// sources in which spans can form but marked's masking pass cannot
// change any emphasis or deletion decision (identity, or harmless
// per maskIdentity/maskHarmless): emStrong and del run here exactly
// as marked's loop calls them, with the same masked string (the
// source, or one the masking pass cannot change) and the same
// previous-character tracking. The token merging matches marked's
// loop (only reflink and inlineText can produce a text token, so
// the merge check covers both).
const INLINE_HANDLERS = [];
INLINE_HANDLERS[92] = (lx, src) => lx.tokenizer.escape(src) || lx.tokenizer.br(src); // backslash
INLINE_HANDLERS[60] = (lx, src) => lx.tokenizer.tag(src) || lx.tokenizer.autolink(src); // <
INLINE_HANDLERS[91] = INLINE_HANDLERS[33] = (lx, src) => lx.tokenizer.link(src) || lx.tokenizer.reflink(src, lx.tokens.links); // [ !
INLINE_HANDLERS[96] = (lx, src) => lx.tokenizer.codespan(src); // `
INLINE_HANDLERS[42] = INLINE_HANDLERS[95] = (lx, src, spans, prev) => (spans ? lx.tokenizer.emStrong(src, src, prev) : undefined); // * _
INLINE_HANDLERS[126] = (lx, src, spans, prev) => (spans ? lx.tokenizer.del(src, src, prev) : undefined); // ~
INLINE_HANDLERS[32] = (lx, src) => lx.tokenizer.br(src); // space
// Any other opening character: only the url tokenizer can match,
// and only outside a link.
const INLINE_DEFAULT = (lx, src) => (lx.state.inLink === false ? lx.tokenizer.url(src) : undefined);

function runInline(lx, src, tokens, spans) {
  lx.tokenizer.lexer = lx;
  const tz = lx.tokenizer;
  let shortest = Infinity;
  let prevChar = '';
  let lastWasText = false;
  while (src.length > 0) {
    if (src.length < shortest) shortest = src.length;
    else { lx.infiniteLoopError(src.charCodeAt(0)); break; }
    // marked's loop resets the previous character unless the last
    // token came from inlineText.
    if (!lastWasText) prevChar = '';
    lastWasText = false;
    let tok;
    let fromText = false;
    const handler = INLINE_HANDLERS[src.charCodeAt(0)] || INLINE_DEFAULT;
    tok = handler(lx, src, spans, prevChar);
    if (tok === undefined) {
      tok = tz.inlineText(src);
      fromText = true;
    }
    if (tok === undefined) { lx.infiniteLoopError(src.charCodeAt(0)); break; }
    if (fromText) {
      if (tok.raw.slice(-1) !== '_') prevChar = tok.raw.slice(-1);
      lastWasText = true;
    }
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
// per-tokenizer dispatch. (Default options only: breaks off, no
// inline extensions.) Two details make the direct emission exact:
// inlineText decodes entities (only needed when the source holds
// '&'), and it stops before a bare "http"/"https" word (its
// regex's protocol lookahead needs no ://). With neither present,
// one inlineText call would consume the whole source unchanged, so
// the token is emitted without running the regex at all; with
// either present, the source is consumed in successive inlineText
// calls and merged, exactly as the inline loop does.
function plainSource(lx, src, tokens) {
  lx.tokenizer.lexer = lx;
  if (src.indexOf('&') === -1 && BARE_HTTP.test(src) === false) {
    tokens.push({ type: 'text', raw: src, text: src, escaped: lx.state.inRawBlock });
    return tokens;
  }
  let raw = '';
  let text = '';
  let escaped = lx.state.inRawBlock;
  let rest = src;
  while (rest.length > 0) {
    const tok = lx.tokenizer.inlineText(rest);
    if (tok === undefined || tok.raw.length === 0) {
      // inlineText made no progress — it never does on a plain
      // source, but a missed trigger must not silently drop text.
      // Fall back to marked's inline loop for the whole source.
      return Lexer.prototype.inlineTokens.call(lx, src, tokens);
    }
    raw += tok.raw;
    text += tok.text;
    escaped = tok.escaped;
    rest = rest.substring(tok.raw.length);
  }
  tokens.push({ type: 'text', raw, text, escaped });
  return tokens;
}

// Whether marked's inline masking pass is the identity on `src`:
// the pass replaces reflink candidates (needs '['), escaped
// punctuation and code spans (need '\' or '`'), and link/code/html
// skips (need '[', '`' or '<'). With none of those four characters
// present, no replacement can match and the masked string equals
// the source, so the masking pass — three full-string regex
// replaces — can be skipped outright. (No hooks are registered, so
// the hook mask cannot apply either.)
function maskIdentity(src) {
  return src.indexOf('\\') === -1 && src.indexOf('`') === -1 &&
    src.indexOf('[') === -1 && src.indexOf('<') === -1;
}

// Whether the masking pass, while not the identity, still cannot
// change any emphasis or deletion decision on `src` — so the
// table loop may run with the source as its own mask. The pass
// hides delimiters only inside the constructs its blockSkip and
// reflinkSearch patterns match (inline links, code spans, html
// tags, reference links) and inside backslash escapes of a
// delimiter or backtick; everywhere else it preserves positions,
// lengths, and the punctuation/whitespace class of every character
// a delimiter's neighbours can be (a match's boundary characters
// are punctuation in both the original and the masked string, and
// a backslash escape of any other punctuation becomes '+', which
// counts as punctuation wherever the escaped character did). So
// the pass is harmless exactly when no delimiter sits inside one
// of those matched constructs and no backslash escapes a delimiter
// or backtick. The check is conservative on purpose: a whole match
// is treated as hidden even though the pass keeps a short prefix
// of some matches unmasked, so a "harmless" verdict can never hide
// a delimiter the pass would have left visible.
//
// One interaction the whole-match check alone would miss: the
// pass runs its three replaces in sequence, and the second
// (escaped punctuation / code spans) rewrites inner backticks to
// '+', which can let the third (link/code/html skips) match a code
// span it could not match on the original string — swallowing
// delimiters the check never saw. A source holding any backtick
// is therefore never "harmless" here; the identity check above is
// the only fast path for those. (A backslash inside a reference-link
// match is refused for the same reason: the first replace rewrites
// the whole match, which could likewise let a later replace match
// across it.)
function maskHarmless(src, lx) {
  if (src.indexOf('`') !== -1) return false;
  // No backslash may escape a delimiter or a backtick: the pass
  // replaces the escaped character with '+', hiding it from the
  // closer scans.
  for (let i = src.indexOf('\\'); i !== -1; i = src.indexOf('\\', i + 1)) {
    const n = src.charCodeAt(i + 1);
    if (n === 42 || n === 95 || n === 126 || n === 96) return false; // * _ ~ `
  }
  // No delimiter may sit inside a blockSkip or reflinkSearch match:
  // the pass replaces each match with same-length bracketed 'a's,
  // hiding every delimiter inside it from the closer scans. No
  // backslash may sit inside a reference-link match either (see
  // above).
  const inlineRules = lx.tokenizer.rules.inline;
  for (const m of src.matchAll(inlineRules.reflinkSearch)) {
    const s = m[0];
    if (s.indexOf('*') !== -1 || s.indexOf('_') !== -1 || s.indexOf('~') !== -1) return false;
    if (s.indexOf('\\') !== -1) return false;
  }
  for (const m of src.matchAll(inlineRules.blockSkip)) {
    const s = m[0];
    if (s.indexOf('*') !== -1 || s.indexOf('_') !== -1 || s.indexOf('~') !== -1) return false;
  }
  return true;
}

// Whether `src` holds so many emphasis/deletion delimiters that the
// table loop loses to marked's own loop: each emStrong/del call
// re-scans the source for its closer index (marked caches that scan
// once per inline call; the table loop cannot reach the cache), so
// past a few dozen delimiters the re-scans cost more than the
// masking pass they skip. The measured crossover on this box is
// ~60-80 delimiters per source; 40 leaves margin. The count is
// three indexOf scans (C++ speed) that exit early past the limit.
const DELIM_HEAVY = 40;
function delimHeavy(src) {
  let n = 0;
  for (const ch of ['*', '_', '~']) {
    for (let i = src.indexOf(ch); i !== -1; i = src.indexOf(ch, i + 1)) {
      n += 1;
      if (n > DELIM_HEAVY) return true;
    }
  }
  return false;
}

// Whether the fast inline paths may run for this source: default
// options only (no pedantic, no hard breaks, no inline
// extensions).
function inlineFastOk(lx) {
  return !lx.options.pedantic && !lx.options.breaks &&
    !lx.options.extensions?.inline && !lx.options.extensions?.startInline;
}

function lexInline(lx, src, tokens = []) {
  lx.tokenizer.lexer = lx;
  // marked's own wrapper bookkeeping: linkParenPossible narrows
  // to sources holding a ')', and is restored afterwards, so a
  // failed link candidate in one source never suppresses a link
  // in the next.
  const savedParen = lx.state.linkParenPossible;
  lx.state.linkParenPossible = savedParen && src.includes(')');
  try {
    if (src.length > 0 && inlineFastOk(lx)) {
      if (!hasMarkup(src)) return plainSource(lx, src, tokens);
      if (!spansPossible(src)) return runInline(lx, src, tokens, false);
      if (maskIdentity(src) || maskHarmless(src, lx)) {
        if (!delimHeavy(src)) return runInline(lx, src, tokens, true);
      }
    }
    return Lexer.prototype.inlineTokens.call(lx, src, tokens);
  } finally {
    lx.state.linkParenPossible = savedParen;
  }
}

function buildLexer(options) {
  const lx = new Lexer(options);
  lx.blockTokens = function (src, tokens, inBlockquote) {
    return walkBlocks(this, src, tokens, inBlockquote);
  };
  lx.inlineTokens = function (src, tokens) {
    return lexInline(this, src, tokens);
  };
  // Like marked's lex, but the whole-input CR normalisation is
  // skipped when the input holds no CR at all (the common case).
  lx.lex = function (src) {
    if (src.includes('\r')) src = src.replace(this.tokenizer.rules.other.carriageReturn, '\n');
    this.blockTokens(src, this.tokens);
    for (const item of this.inlineQueue) {
      this.state.inRawBlock = false;
      this.inlineTokens(item.src, item.tokens);
    }
    this.inlineQueue = [];
    return this.tokens;
  };
  return lx;
}

// ---------------------------------------------------------------------------
// Entry point: exactly marked.parse with the defaults, through the fast
// lexer and the writer object above.
// ---------------------------------------------------------------------------
export function parse(markdown) {
  if (markdown === undefined || markdown === null) {
    throw new Error('marked(): input parameter is undefined or null');
  }
  if (typeof markdown !== 'string') {
    throw new Error('marked(): input parameter is of type ' + Object.prototype.toString.call(markdown) + ', string expected');
  }
  const options = { ...defaults };
  options.tokenizer = wrapTokenizer(options);
  const tokens = buildLexer(options).lex(markdown);
  return makeWriter().html(tokens);
}
