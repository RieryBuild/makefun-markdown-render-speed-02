// parse.js — a fast drop-in for marked 18.1.3.
//
// parse(markdown) returns exactly the HTML marked.parse(markdown) returns
// with marked's default options (GFM on, breaks off, pedantic off, async
// off) — but faster.
//
// The vendored marked (vendor/marked/marked.esm.js, MIT, byte for byte as
// the kit ships it) is the exactness reference. This module subclasses
// marked's Lexer and Tokenizer and replaces only measured hot paths:
//
//   * Tokenizer.list — marked's list tokeniser, rewritten with
//     index-based line reads (no split()) and a first-character dispatch
//     for the six per-line block-start tests; tab expansion is skipped
//     when the leading whitespace holds no tab at all.
//   * Tokenizer.link — skips the link regex unless the input can match
//     it (starts at '[' or '!', linkParenPossible, and a '](' exists).
//   * Every other inline tokeniser (escape, tag, reflink, emStrong,
//     codespan, br, del, autolink, url) — a first-character guard, so the
//     regex only runs where it can match. Marked's inline loop tries all
//     of them at every position; most fail on the first character.
//   * Lexer.blockTokens — a first-character dispatch over the block
//     tokenisers, plus cheap necessary-condition guards for the two
//     expensive regexes: lheading needs a setext-looking line inside the
//     current paragraph run, table needs a '-' on the second line.
//   * Lexer.lex — skips the whole-input CR normalisation when the input
//     holds no CR at all.
//   * Lexer.inlineTokens — a plain-text fast path: when the inline
//     source holds no inline construct at all, it is one text token;
//     when it also holds no '&' and no bare http/https word, the token
//     is emitted directly without running the inline-text regex.
//
//   * The parser/renderer — marked's Parser + Renderer reimplemented as
//     plain functions (same HTML, same escaping, same href sanitizing),
//     without the per-token extension checks or the per-call
//     Parser/Renderer/TextRenderer construction.
//
// Everything else — the emphasis and link machinery, and inlineText
// itself (whose regex V8 runs faster than any per-character JS scanner)
// — is marked's own, untouched.
//
// TARGET: marked's DEFAULT options only (gfm on, breaks off, pedantic
// off, no extensions) — the competition's contract. blockTokens and
// inlineTokens step aside to marked's originals when pedantic mode or
// block/inline extensions are set, but the tokenizer guards, list(),
// lex() and the plain renderer do not universally defer, so non-default
// options are NOT guaranteed to match marked. Do not use this module
// outside the default-options contract.
//
// No caching across parse() calls: every case is rendered from its own
// markdown alone, and nothing is kept from an earlier call.
import { Lexer, Tokenizer, defaults } from './vendor/marked/marked.esm.js';

// ---------------------------------------------------------------------------
// Small helpers.
// ---------------------------------------------------------------------------

// First line of `s` (up to the first \n, or the whole string), without
// allocating through split().
function firstLine(s) {
  const nl = s.indexOf('\n');
  return nl === -1 ? s : s.slice(0, nl);
}

// Number of leading spaces in `s` (tabs do not count: the block regexes
// only allow spaces before a marker).
function leadingSpaces(s) {
  let i = 0;
  while (i < s.length && s.charCodeAt(i) === 32) i++;
  return i;
}

// Expand tabs in `s` to spaces, counting columns from `col` (marked's
// tab-expansion helper, default column 0). A string with no tab expands
// to itself — return it unchanged instead of rebuilding it character by
// character (the common case: leading spaces, no tabs).
function expandTabs(s, col = 0) {
  if (s.indexOf('\t') === -1) return s;
  let out = '';
  let at = col;
  for (const ch of s) {
    if (ch === '\t') {
      const n = 4 - (at % 4);
      out += ' '.repeat(n);
      at += n;
    } else {
      out += ch;
      at++;
    }
  }
  return out;
}

// Expand the tabs in the leading whitespace of `line` (marked's
// leadingSpaceTab replace). When the leading run holds no tab, the
// replacement is the line itself — skip the replace entirely.
function expandLeading(line, rules, col) {
  let i = 0;
  let tab = false;
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if (c === 32) { i++; continue; }
    if (c === 9) { tab = true; i++; continue; }
    break;
  }
  if (!tab) return line;
  return line.replace(rules.other.leadingSpaceTab, (m) => expandTabs(m, col));
}

// Anything that can start an inline token other than plain text: the
// inline stop characters, an autolink/url trigger, or a hard break.
// A single regex scan; if it does not match, the text holds no inline
// construct at all and is one text token.
const NON_PLAIN = /[\\<!\[`*_~@]|:\/\/|www\.|mailto:|xmpp:| {2}\n/;
function isPlainInline(src) {
  return !NON_PLAIN.test(src);
}

// A bare http/https word is the one place inlineText stops inside an
// otherwise plain source (its regex has an http lookahead with no word
// boundary), so a plain source holding one still goes through inlineText.
const HTTP_WORD = /http/i;

function hasTwo(src, ch) {
  const first = src.indexOf(ch);
  return first !== -1 && src.indexOf(ch, first + 1) !== -1;
}

// Whether any emphasis or deletion span can form in `src`: each of
// '*', '_' and '~' must appear at least twice (an opener needs a
// matching closer of the same character). Two indexOf scans per
// character (native memchr) beat a per-character JS loop here.
function noEmphasisPossible(src) {
  return !hasTwo(src, '*') && !hasTwo(src, '_') && !hasTwo(src, '~');
}

// Whether the second line of `src` holds a '-'. A table's delimiter row
// sits on the second line and every cell holds at least one '-', so
// without one the table regex cannot match. The scan is bounded to the
// second line itself (an indexOf for '-' from there would run to the end
// of the document when the line holds no dash).
function secondLineHasDash(src) {
  const nl = src.indexOf('\n');
  if (nl === -1) return false;
  let end = src.indexOf('\n', nl + 1);
  if (end === -1) end = src.length;
  for (let i = nl + 1; i < end; i++) if (src.charCodeAt(i) === 45) return true;
  return false;
}

// Whether `s` ends with a double blank line: \n, optional spaces/tabs,
// \n, optional spaces/tabs (marked's doubleBlankLine regex, read from
// the end instead of scanned with a regex).
function endsDoubleBlank(s) {
  let i = s.length;
  while (i > 0 && (s.charCodeAt(i - 1) === 32 || s.charCodeAt(i - 1) === 9)) i--;
  if (i === 0 || s.charCodeAt(i - 1) !== 10) return false;
  i--;
  while (i > 0 && (s.charCodeAt(i - 1) === 32 || s.charCodeAt(i - 1) === 9)) i--;
  return i > 0 && s.charCodeAt(i - 1) === 10;
}

// Whether a setext underline line (0-3 spaces, then '=' or '-') appears
// inside the current paragraph run — the run ends at the first blank line
// or at the end of the input. The lheading regex needs such a line, so
// without one it cannot match. Scanned line by line, never past the run.
function hasSetextUnderline(src) {
  let pos = 0;
  for (;;) {
    const nl = src.indexOf('\n', pos);
    if (nl === -1) return false;
    let i = nl + 1;
    while (i < src.length && (src.charCodeAt(i) === 32 || src.charCodeAt(i) === 9)) i++;
    if (i >= src.length || src.charCodeAt(i) === 10) return false; // blank line: run ends
    if (i - (nl + 1) <= 3) {
      const c = src.charCodeAt(i);
      if (c === 61 || c === 45) return true; // = or -
    }
    pos = nl + 1;
  }
}

// Whether `src` could match marked's url regex at all. The regex has
// three alternatives: a scheme prefix (mailto:, xmpp:, http(s)://,
// ftp://, www.) or an email (a run of local-part characters followed by
// '@'). Anything else fails it — most inline positions included.
function isEmailLocalChar(c) {
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) ||
    c === 46 || c === 95 || c === 43 || c === 45;
}
function couldBeUrl(src) {
  const c0 = src.charCodeAt(0);
  if (c0 === 119 && src.startsWith('www.')) return true; // www.
  if (c0 === 109 && src.startsWith('mailto:')) return true; // mailto:
  if (c0 === 120 && src.startsWith('xmpp:')) return true; // xmpp:
  if (c0 === 104 || c0 === 72) { // h H — http(s)://, any case
    const t1 = src.charCodeAt(1) | 32, t2 = src.charCodeAt(2) | 32, t3 = src.charCodeAt(3) | 32;
    if (t1 === 116 && t2 === 116 && t3 === 112) {
      const s4 = src.charCodeAt(4);
      if (s4 === 58) return src.charCodeAt(5) === 47 && src.charCodeAt(6) === 47; // ://
      if ((s4 | 32) === 115) return src.charCodeAt(5) === 58 && src.charCodeAt(6) === 47 && src.charCodeAt(7) === 47; // s://
    }
  }
  if (c0 === 102 || c0 === 70) { // f F — ftp://, any case
    const t1 = src.charCodeAt(1) | 32, t2 = src.charCodeAt(2) | 32;
    if (t1 === 116 && t2 === 112) {
      return src.charCodeAt(3) === 58 && src.charCodeAt(4) === 47 && src.charCodeAt(5) === 47;
    }
  }
  // Email: a run of local-part characters followed by '@'.
  if (!isEmailLocalChar(c0)) return false;
  let i = 1;
  while (i < src.length && isEmailLocalChar(src.charCodeAt(i))) i++;
  return src.charCodeAt(i) === 64;
}

// ---------------------------------------------------------------------------
// FastTokenizer: marked's Tokenizer with the hot methods replaced or guarded.
// ---------------------------------------------------------------------------
class FastTokenizer extends Tokenizer {
  // NOTE: inlineText is deliberately NOT overridden. A hand-written
  // scanner was built and verified 720/720, but it measured ~15% SLOWER
  // than marked's regex (V8 runs the giant regex in C++; a per-character
  // JS loop cannot beat it). marked's own inlineText runs instead.

  // First-character guards: each of these regexes is anchored and can
  // only match at one (or two) first characters. Marked's inline loop
  // tries every tokeniser at every position; the guard turns the nine
  // doomed regex executions per text position into nine charCodeAt calls.
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
    const c = src.charCodeAt(0);
    if (c !== 91 && c !== 33) return; // [ !
    if (src.indexOf(']') === -1) return; // reflink/nolink both need a ']'
    return super.reflink(src, links);
  }
  emStrong(src, masked, prev) {
    const c = src.charCodeAt(0);
    if (c !== 42 && c !== 95) return; // * _
    // An emphasis span needs a closer of the same character after the
    // opener run; without one, emStrong cannot match.
    let run = 1;
    while (src.charCodeAt(run) === c) run++;
    if (src.indexOf(c === 42 ? '*' : '_', run) === -1) return;
    return super.emStrong(src, masked, prev);
  }
  codespan(src) {
    if (src.charCodeAt(0) !== 96) return; // `
    // A code span needs a closing backtick run after the opener run.
    let run = 1;
    while (src.charCodeAt(run) === 96) run++;
    if (src.indexOf('`', run) === -1) return;
    return super.codespan(src);
  }
  br(src) {
    const c0 = src.charCodeAt(0);
    // br is two or more spaces + newline, or backslash + newline.
    if (c0 === 32) { if (src.charCodeAt(1) !== 32) return; }
    else if (c0 === 92) { if (src.charCodeAt(1) !== 10) return; }
    else return;
    return super.br(src);
  }
  del(src, masked, prev) {
    if (src.charCodeAt(0) !== 126) return; // ~
    // A deletion span needs a closer of the same length after the opener
    // run; without another '~' at all, del cannot match.
    let run = 1;
    while (src.charCodeAt(run) === 126) run++;
    if (src.indexOf('~', run) === -1) return;
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
  // Link: the link regex needs a literal '](' (label close + paren open).
  // Without one anywhere in the remaining input it cannot match, so skip
  // the giant regex (it is tried at every '[' and usually fails). The
  // guards come first: link can only start at '[' or '!', and marked's
  // own linkParenPossible guard already rejects inputs with no ')' —
  // checking those before the suffix scan keeps the scan off the hot path
  // (the scan would otherwise run at every inline position).
  link(src) {
    const c0 = src.charCodeAt(0);
    if (c0 !== 91 && c0 !== 33) return; // [ !
    if (this.lexer.state.linkParenPossible === false) return;
    if (src.indexOf('](') === -1) return;
    return super.link(src);
  }
  // List tokeniser: marked's, with index-based line reads instead of
  // split() and a first-character dispatch for the six per-line
  // block-start tests (fences / heading / html / blockquote / bullet /
  // hr). The dispatch only skips tests whose regex cannot match the
  // line's first non-space character; the outcome is identical.
  list(src) {
    let m = this.rules.block.list.exec(src);
    if (!m) return;
    const input = src;
    const consumed = () => input.length - src.length;
    const bullet = m[1].trim();
    const ordered = bullet.length > 1;
    const out = {
      type: 'list', raw: '', ordered,
      start: ordered ? +bullet.slice(0, -1) : '', loose: false, items: [],
    };
    let marker = ordered ? `\\d{1,9}\\${bullet.slice(-1)}` : `\\${bullet}`;
    if (this.options.pedantic) marker = ordered ? marker : '[*+-]';
    const itemRe = this.rules.other.listItemRegex(marker);
    let sawDoubleBlank = false;
    for (; src;) {
      let blankItem = false;
      let itemText = '';
      if (!(m = itemRe.exec(src)) || this.rules.block.hr.test(src)) break;
      const itemStart = consumed();
      src = src.substring(m[0].length);
      const first = firstLine(m[2]);
      const markerLen = m[1].length;
      let markerText = this.options.pedantic
        ? expandTabs(first, markerLen)
        : expandLeading(first, this.rules, markerLen);
      let next = firstLine(src);
      const itemBlank = !markerText.trim();
      // Whether the previous line (marker line first, then each consumed
      // line) was blank. This is NOT the blank-item flag below — a blank
      // line after a content line ends the item.
      let prevBlank = itemBlank;
      let indent = 0;
      if (this.options.pedantic) {
        indent = 2;
        itemText = markerText.trimStart();
      } else if (itemBlank) {
        indent = markerLen + 1;
      } else {
        indent = leadingSpaces(markerText);
        if (indent > 4) indent = 1;
        itemText = markerText.slice(indent);
        indent += markerLen;
      }
      if (itemBlank && this.rules.other.blankLine.test(next)) {
        src = src.substring(next.length + 1);
        blankItem = true;
      }
      if (!blankItem) {
        const bulletRe = this.rules.other.nextBulletRegex(indent);
        const hrRe = this.rules.other.hrRegex(indent);
        const fenceRe = this.rules.other.fencesBeginRegex(indent);
        const headingRe = this.options.pedantic
          ? this.rules.other.pedanticHeadingBeginRegex(indent)
          : this.rules.other.headingBeginRegex(indent);
        const htmlRe = this.rules.other.htmlBeginRegex(indent);
        const quoteRe = this.rules.other.blockquoteBeginRegex(indent);
        for (; src;) {
          const line = firstLine(src);
          let expanded;
          if (this.options.pedantic) {
            next = line.replace(this.rules.other.listReplaceNesting, '  ');
            expanded = next;
          } else {
            next = line;
            expanded = expandLeading(line, this.rules, 0);
          }
          if (!startsBlock(next, indent, fenceRe, headingRe, htmlRe, quoteRe, bulletRe, hrRe)) {
            const lineBlank = !line.trim();
            if (leadingSpaces(expanded) >= indent || lineBlank) {
              itemText += '\n' + expanded.slice(indent);
            } else {
              const markerFlat = markerText.indexOf('\t') === -1
                ? markerText
                : markerText.replace(this.rules.other.tabCharGlobal, '    ');
              if (prevBlank || markerFlat.search(this.rules.other.nonSpaceChar) >= 4 ||
                  fenceRe.test(markerText) || headingRe.test(markerText) ||
                  htmlRe.test(markerText) || hrRe.test(markerText)) break;
              const setext = !this.options.pedantic && /^ {0,3}(?:=+|-+) *$/.test(line) &&
                this.rules.block.lheading.test(`${markerText}\n${line}`);
              itemText += '\n' + (setext ? `    ${expanded.replace(/^ {0,3}/, '')}` : line);
            }
            prevBlank = lineBlank;
          } else break;
          src = src.substring(line.length + 1);
          markerText = expanded.slice(indent);
        }
      }
      const rawItem = input.slice(itemStart, consumed());
      if (!out.loose) {
        if (sawDoubleBlank) out.loose = true;
        else if (endsDoubleBlank(rawItem)) sawDoubleBlank = true;
      }
      out.items.push({
        type: 'list_item', raw: rawItem,
        task: !!this.options.gfm && this.rules.other.listIsTask.test(itemText),
        loose: false, text: itemText, tokens: [],
      });
    }
    const last = out.items.at(-1);
    if (!last) return;
    last.raw = last.raw.trimEnd();
    last.text = last.text.trimEnd();
    out.raw = input.slice(0, consumed()).trimEnd();
    for (const item of out.items) {
      if (this.lexer.state.top = false, item.tokens = this.lexer.blockTokens(item.text, []), !out.loose) {
        const hasBlank = item.tokens.some((tok) => tok.type === 'space' && this.rules.other.anyLine.test(tok.raw));
        out.loose = hasBlank;
      }
    }
    for (const item of out.items) {
      const firstTok = item.tokens[0];
      if (item.task && (firstTok?.type === 'text' || firstTok?.type === 'paragraph')) {
        item.text = item.text.replace(this.rules.other.listReplaceTask, '');
        firstTok.raw = firstTok.raw.replace(this.rules.other.listReplaceTask, '');
        firstTok.text = firstTok.text.replace(this.rules.other.listReplaceTask, '');
        for (let g = this.lexer.inlineQueue.length - 1; g >= 0; g--) {
          if (this.rules.other.listIsTask.test(this.lexer.inlineQueue[g].src)) {
            this.lexer.inlineQueue[g].src = this.lexer.inlineQueue[g].src.replace(this.rules.other.listReplaceTask, '');
            break;
          }
        }
        const box = this.rules.other.listTaskCheckbox.exec(item.raw);
        if (box) {
          const checkbox = { type: 'checkbox', raw: box[0] + ' ', checked: box[0] !== '[ ]' };
          item.checked = checkbox.checked;
          if (out.loose) {
            if (item.tokens[0] && ['paragraph', 'text'].includes(item.tokens[0].type) &&
                'tokens' in item.tokens[0] && item.tokens[0].tokens) {
              item.tokens[0].raw = checkbox.raw + item.tokens[0].raw;
              item.tokens[0].text = checkbox.raw + item.tokens[0].text;
              item.tokens[0].tokens.unshift(checkbox);
            } else {
              item.tokens.unshift({ type: 'paragraph', raw: checkbox.raw, text: checkbox.raw, tokens: [checkbox] });
            }
          } else {
            item.tokens.unshift(checkbox);
          }
        }
      } else if (item.task) {
        item.task = false;
      }
    }
    if (out.loose) {
      for (const item of out.items) {
        item.loose = true;
        for (const tok of item.tokens) if (tok.type === 'text') tok.type = 'paragraph';
      }
    }
    return out;
  }
}

// Whether the list-item line `line` starts a new block: the six tests
// marked runs per line, dispatched on the line's first non-space
// character (only spaces count toward the indent the regexes allow —
// each regex allows at most indent-1 leading spaces, so a line with
// indent or more cannot start a block). Returns true when any test
// matches.
function startsBlock(line, indent, fenceRe, headingRe, htmlRe, quoteRe, bulletRe, hrRe) {
  let p = 0;
  while (p < line.length && line.charCodeAt(p) === 32) p++;
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
// FastLexer: marked's Lexer with a first-character dispatch in blockTokens.
// ---------------------------------------------------------------------------
const M_SPACE = 1, M_CODE = 2, M_FENCES = 4, M_HEADING = 8, M_HR = 16,
  M_BLOCKQUOTE = 32, M_LIST = 64, M_HTML = 128, M_DEF = 256, M_TABLE = 512,
  M_LHEADING = 1024, M_PARAGRAPH = 2048, M_TEXT = 4096;
const M_ALL = M_SPACE | M_CODE | M_FENCES | M_HEADING | M_HR | M_BLOCKQUOTE |
  M_LIST | M_HTML | M_DEF | M_TABLE | M_LHEADING | M_PARAGRAPH | M_TEXT;
const M_TEXTUAL = M_TABLE | M_LHEADING | M_PARAGRAPH | M_TEXT;

function blockMask(first) {
  switch (first) {
    case 10: return M_SPACE; // \n: only a blank-line block can start here
    case 32: case 9: return M_ALL; // space / tab: anything indented may follow
    case 35: return M_HEADING | M_TEXTUAL; // #
    case 62: return M_BLOCKQUOTE | M_TEXTUAL; // >
    case 96: case 126: return M_FENCES | M_TEXTUAL; // ` ~
    case 45: case 42: case 95: return M_HR | M_LIST | M_TEXTUAL; // - * _
    case 43: return M_LIST | M_TEXTUAL; // +
    case 60: return M_HTML | M_TEXTUAL; // <
    case 91: return M_DEF | M_TEXTUAL; // [
    case 124: return M_TEXTUAL; // |
    default:
      if (first >= 48 && first <= 57) return M_LIST | M_TEXTUAL; // digit
      return M_TEXTUAL;
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
  inlineTokensNoEm(src, tokens) {
    this.tokenizer.lexer = this;
    let shortest = Infinity;
    for (; src;) {
      if (src.length < shortest) shortest = src.length;
      else { this.infiniteLoopError(src.charCodeAt(0)); break; }
      const c = src.charCodeAt(0);
      let tok;
      if (c === 92) tok = this.tokenizer.escape(src) || this.tokenizer.br(src);
      else if (c === 60) tok = this.tokenizer.tag(src) || this.tokenizer.autolink(src);
      else if (c === 91 || c === 33) {
        tok = this.tokenizer.link(src);
        if (!tok) {
          tok = this.tokenizer.reflink(src, this.tokens.links);
          if (tok) {
            src = src.substring(tok.raw.length);
            const prev = tokens.at(-1);
            if (tok.type === 'text' && prev?.type === 'text') { prev.raw += tok.raw; prev.text += tok.text; }
            else tokens.push(tok);
            continue;
          }
        }
      }
      else if (c === 96) tok = this.tokenizer.codespan(src);
      else if (c === 32) tok = this.tokenizer.br(src);
      else if (!this.state.inLink) tok = this.tokenizer.url(src);
      if (tok) {
        src = src.substring(tok.raw.length);
        tokens.push(tok);
        continue;
      }
      tok = this.tokenizer.inlineText(src);
      if (tok) {
        src = src.substring(tok.raw.length);
        const prev = tokens.at(-1);
        if (prev?.type === 'text') { prev.raw += tok.raw; prev.text += tok.text; }
        else tokens.push(tok);
        continue;
      }
      if (src) { this.infiniteLoopError(src.charCodeAt(0)); break; }
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
    const fast = !this.options.pedantic && !this.options.breaks &&
      !this.options.extensions?.inline && !this.options.extensions?.startInline;
    if (fast && src.length > 0 && isPlainInline(src)) {
      this.tokenizer.lexer = this;
      if (src.indexOf('&') === -1 && !HTTP_WORD.test(src)) {
        tokens.push({ type: 'text', raw: src, text: src, escaped: this.state.inRawBlock });
        return tokens;
      }
      let raw = '', text = '', escaped = this.state.inRawBlock;
      let rest = src;
      while (rest.length > 0) {
        const tok = this.tokenizer.inlineText(rest);
        if (!tok || tok.raw.length === 0) break;
        raw += tok.raw;
        text += tok.text;
        escaped = tok.escaped;
        rest = rest.substring(tok.raw.length);
      }
      // If the loop stalled (inlineText made no progress — it never does
      // on a plain source, but a missed trigger must not silently drop
      // text), fall back to marked's inline loop for the whole source.
      if (rest.length === 0 && raw.length > 0) {
        tokens.push({ type: 'text', raw, text, escaped });
        return tokens;
      }
      return super.inlineTokens(src, tokens);
    }
    if (fast && src.length > 0 && noEmphasisPossible(src)) {
      return this.inlineTokensNoEm(src, tokens);
    }
    return super.inlineTokens(src, tokens);
  }

  // Like marked's lex, but the whole-input CR normalisation is skipped
  // when the input holds no CR at all (the common case).
  lex(src) {
    if (src.includes('\r')) src = src.replace(this.tokenizer.rules.other.carriageReturn, '\n');
    this.blockTokens(src, this.tokens);
    for (let t = 0; t < this.inlineQueue.length; t++) {
      const item = this.inlineQueue[t];
      this.state.inRawBlock = false;
      this.inlineTokens(item.src, item.tokens);
    }
    this.inlineQueue = [];
    return this.tokens;
  }

  // marked's block loop, except tokenisers that cannot match the current
  // block's first character are never tried, and the two expensive
  // regexes (table, lheading) get a cheap necessary-condition guard
  // first. The order and the merging rules are unchanged. Falls back to
  // marked's loop for pedantic mode or when block extensions are
  // registered.
  blockTokens(src, tokens = [], inBlockquote = false) {
    if (this.options.pedantic || this.options.extensions?.block || this.options.extensions?.startBlock) {
      return super.blockTokens(src, tokens, inBlockquote);
    }
    this.tokenizer.lexer = this;
    let shortest = Infinity;
    for (; src;) {
      if (src.length < shortest) shortest = src.length;
      else { this.infiniteLoopError(src.charCodeAt(0)); break; }
      const mask = blockMask(src.charCodeAt(0));
      let r;
      if ((mask & M_SPACE) && (r = this.tokenizer.space(src))) {
        src = src.substring(r.raw.length);
        const prev = tokens.at(-1);
        if (r.raw.length === 1 && prev !== undefined) prev.raw += '\n';
        else tokens.push(r);
        continue;
      }
      if ((mask & M_CODE) && (r = this.tokenizer.code(src))) {
        src = src.substring(r.raw.length);
        const prev = tokens.at(-1);
        if (prev?.type === 'paragraph' || prev?.type === 'text') {
          prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + r.raw;
          prev.text += '\n' + r.text;
          this.inlineQueue.at(-1).src = prev.text;
        } else tokens.push(r);
        continue;
      }
      if ((mask & M_FENCES) && (r = this.tokenizer.fences(src))) { src = src.substring(r.raw.length); tokens.push(r); continue; }
      if ((mask & M_HEADING) && (r = this.tokenizer.heading(src))) { src = src.substring(r.raw.length); tokens.push(r); continue; }
      if ((mask & M_HR) && (r = this.tokenizer.hr(src))) { src = src.substring(r.raw.length); tokens.push(r); continue; }
      if ((mask & M_BLOCKQUOTE) && (r = this.tokenizer.blockquote(src))) { src = src.substring(r.raw.length); tokens.push(r); continue; }
      if ((mask & M_LIST) && (r = this.tokenizer.list(src))) { src = src.substring(r.raw.length); tokens.push(r); continue; }
      if ((mask & M_HTML) && (r = this.tokenizer.html(src))) { src = src.substring(r.raw.length); tokens.push(r); continue; }
      if ((mask & M_DEF) && (r = this.tokenizer.def(src))) {
        src = src.substring(r.raw.length);
        const prev = tokens.at(-1);
        if (prev?.type === 'paragraph' || prev?.type === 'text') {
          prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + r.raw;
          prev.text += '\n' + r.raw;
          this.inlineQueue.at(-1).src = prev.text;
        } else {
          if (!this.tokens.links[r.tag]) this.tokens.links[r.tag] = { href: r.href, title: r.title };
          tokens.push(r);
        }
        continue;
      }
      if ((mask & M_TABLE) && secondLineHasDash(src) && (r = this.tokenizer.table(src))) { src = src.substring(r.raw.length); tokens.push(r); continue; }
      if ((mask & M_LHEADING) && hasSetextUnderline(src) && (r = this.tokenizer.lheading(src))) { src = src.substring(r.raw.length); tokens.push(r); continue; }
      const o = src;
      if (this.state.top && (mask & M_PARAGRAPH) && (r = this.tokenizer.paragraph(o))) {
        const prev = tokens.at(-1);
        if (inBlockquote && prev?.type === 'paragraph') {
          prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + r.raw;
          prev.text += '\n' + r.text;
          this.inlineQueue.pop();
          this.inlineQueue.at(-1).src = prev.text;
        } else tokens.push(r);
        inBlockquote = o.length !== src.length;
        src = src.substring(r.raw.length);
        continue;
      }
      if ((mask & M_TEXT) && (r = this.tokenizer.text(src))) {
        src = src.substring(r.raw.length);
        const prev = tokens.at(-1);
        if (prev?.type === 'text') {
          prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + r.raw;
          prev.text += '\n' + r.text;
          this.inlineQueue.pop();
          this.inlineQueue.at(-1).src = prev.text;
        } else tokens.push(r);
        continue;
      }
      if (src) { this.infiniteLoopError(src.charCodeAt(0)); break; }
    }
    this.state.top = true;
    return tokens;
  }
}

// ---------------------------------------------------------------------------
// Renderer: marked's Parser + Renderer as plain functions.
//
// parse() only ever runs with marked's defaults (no extensions, no custom
// renderer, silent off), so the per-token extension checks and the
// Parser/Renderer/TextRenderer construction are pure overhead. These
// functions replicate marked's Renderer methods and Parser loops exactly
// (same HTML, same escaping, same href sanitizing) without them.
// ---------------------------------------------------------------------------
const ESCAPE_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESCAPE_TEST = /[&<>"']/;
const ESCAPE_REPLACE = /[&<>"']/g;
const ESCAPE_TEST_NO_AMP = /[<>"']/;
const ESCAPE_REPLACE_NO_AMP = /[<>"']/g;
const ESCAPE_TEST_NO_ENCODE = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/;
const ESCAPE_REPLACE_NO_ENCODE = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;

// marked's escape: with `encode`, every & < > " ' becomes an entity;
// without it, only an & that does not already start an entity reference.
// When the string holds no '&' at all, the no-encode test reduces to a
// plain [<>"'] scan (the entity lookahead can never match).
function escapeHtml(s, encode) {
  if (encode) {
    if (ESCAPE_TEST.test(s)) return s.replace(ESCAPE_REPLACE, (ch) => ESCAPE_MAP[ch]);
    return s;
  }
  if (s.indexOf('&') === -1) {
    if (ESCAPE_TEST_NO_AMP.test(s)) return s.replace(ESCAPE_REPLACE_NO_AMP, (ch) => ESCAPE_MAP[ch]);
    return s;
  }
  if (ESCAPE_TEST_NO_ENCODE.test(s)) return s.replace(ESCAPE_REPLACE_NO_ENCODE, (ch) => ESCAPE_MAP[ch]);
  return s;
}

// marked's href sanitize: encodeURI, with %25 decoded back to %, or null
// when the URI is malformed.
function sanitizeHref(href) {
  try {
    href = encodeURI(href).replace(/%25/g, '%');
  } catch {
    return null;
  }
  return href;
}

const NOT_SPACE_START = /^\S*/;
const ENDING_NEWLINE = /\n$/;

function renderBlock(tokens) {
  let out = '';
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    switch (tok.type) {
      case 'space': break;
      case 'hr': out += '<hr>\n'; break;
      case 'heading': out += `<h${tok.depth}>${renderInline(tok.tokens)}</h${tok.depth}>\n`; break;
      case 'code': {
        const lang = (tok.lang || '').match(NOT_SPACE_START)?.[0];
        const body = tok.text ? tok.text.replace(ENDING_NEWLINE, '') + '\n' : '';
        const inner = tok.escaped ? body : escapeHtml(body, true);
        out += lang
          ? '<pre><code class="language-' + escapeHtml(lang) + '">' + inner + '</code></pre>\n'
          : '<pre><code>' + inner + '</code></pre>\n';
        break;
      }
      case 'table': {
        let head = '';
        for (const cell of tok.header) head += renderTableCell(cell);
        let body = '';
        for (const row of tok.rows) {
          let cells = '';
          for (const cell of row) cells += renderTableCell(cell);
          body += `<tr>\n${cells}</tr>\n`;
        }
        if (body) body = `<tbody>${body}</tbody>`;
        out += `<table>\n<thead>\n<tr>\n${head}</tr>\n</thead>\n${body}</table>\n`;
        break;
      }
      case 'blockquote': out += `<blockquote>\n${renderBlock(tok.tokens)}</blockquote>\n`; break;
      case 'list': {
        let items = '';
        for (const item of tok.items) items += `<li>${renderBlock(item.tokens)}</li>\n`;
        const tag = tok.ordered ? 'ol' : 'ul';
        const start = tok.ordered && tok.start !== 1 ? ' start="' + tok.start + '"' : '';
        out += '<' + tag + start + '>\n' + items + '</' + tag + '>\n';
        break;
      }
      case 'checkbox': out += '<input ' + (tok.checked ? 'checked="" ' : '') + 'disabled="" type="checkbox"> '; break;
      case 'html': out += tok.text; break;
      case 'def': break;
      case 'paragraph': out += `<p>${renderInline(tok.tokens)}</p>\n`; break;
      case 'text':
        out += 'tokens' in tok && tok.tokens ? renderInline(tok.tokens) : ('escaped' in tok && tok.escaped ? tok.text : escapeHtml(tok.text));
        break;
      default: throw new Error('Token with "' + tok.type + '" type was not found.');
    }
  }
  return out;
}

function renderTableCell(cell) {
  const inner = renderInline(cell.tokens);
  const tag = cell.header ? 'th' : 'td';
  return (cell.align ? `<${tag} align="${cell.align}">` : `<${tag}>`) + inner + `</${tag}>\n`;
}

function renderInline(tokens) {
  let out = '';
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    switch (tok.type) {
      case 'escape': // falls through to text, like marked's parseInline
      case 'text':
        out += 'tokens' in tok && tok.tokens ? renderInline(tok.tokens) : ('escaped' in tok && tok.escaped ? tok.text : escapeHtml(tok.text));
        break;
      case 'html': out += tok.text; break;
      case 'link': {
        const label = tok.autolink ? escapeHtml(tok.text, true) : renderInline(tok.tokens);
        const href = sanitizeHref(tok.href);
        if (href === null) { out += label; break; }
        let tag = '<a href="' + escapeHtml(href, !!tok.autolink) + '"';
        if (tok.title) tag += ' title="' + escapeHtml(tok.title) + '"';
        out += tag + '>' + label + '</a>';
        break;
      }
      case 'image': {
        let alt = tok.text;
        if (tok.tokens) alt = renderText(tok.tokens);
        const href = sanitizeHref(tok.href);
        if (href === null) { out += escapeHtml(alt); break; }
        let tag = `<img src="${escapeHtml(href)}" alt="${escapeHtml(alt)}"`;
        if (tok.title) tag += ` title="${escapeHtml(tok.title)}"`;
        out += tag + '>';
        break;
      }
      case 'checkbox': out += '<input ' + (tok.checked ? 'checked="" ' : '') + 'disabled="" type="checkbox"> '; break;
      case 'strong': out += `<strong>${renderInline(tok.tokens)}</strong>`; break;
      case 'em': out += `<em>${renderInline(tok.tokens)}</em>`; break;
      case 'codespan': out += `<code>${escapeHtml(tok.text, true)}</code>`; break;
      case 'br': out += '<br>'; break;
      case 'del': out += `<del>${renderInline(tok.tokens)}</del>`; break;
      default: throw new Error('Token with "' + tok.type + '" type was not found.');
    }
  }
  return out;
}

// marked's TextRenderer (used for image alt text): renders inline tokens
// to plain text, dropping all markup.
function renderText(tokens) {
  let out = '';
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    switch (tok.type) {
      case 'escape': // falls through to text
      case 'text': out += tok.text; break;
      case 'html': out += tok.text; break;
      case 'link':
      case 'image':
      case 'strong':
      case 'em':
      case 'del':
        out += tok.tokens ? renderText(tok.tokens) : tok.text;
        break;
      case 'codespan': out += tok.text; break;
      case 'br': break;
      case 'checkbox': out += tok.raw; break;
      default: throw new Error('Token with "' + tok.type + '" type was not found.');
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Entry point: exactly marked.parse with the defaults, through the fast
// lexer and the plain-function renderer above.
// ---------------------------------------------------------------------------
export function parse(markdown) {
  if (markdown === undefined || markdown === null) {
    throw new Error('marked(): input parameter is undefined or null');
  }
  if (typeof markdown !== 'string') {
    throw new Error('marked(): input parameter is of type ' + Object.prototype.toString.call(markdown) + ', string expected');
  }
  const options = { ...defaults };
  options.tokenizer = new FastTokenizer(options);
  const tokens = new FastLexer(options).lex(markdown);
  return renderBlock(tokens);
}
