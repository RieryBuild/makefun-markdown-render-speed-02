// Fast drop-in for marked 18.1.3: parse(markdown) returns exactly the HTML
// marked.parse(markdown) returns with marked's default options (gfm on,
// breaks off, pedantic off, async off) — but faster.
//
// How: the vendored marked (vendor/marked/marked.esm.js, MIT, byte for byte
// as the kit hands it out, licence + notice kept beside it) is the
// exactness reference. This module subclasses marked's Lexer and Tokenizer
// and replaces only the measured hot paths with equivalent code:
//
//   - Tokenizer.list: the same list tokeniser, with index-based line reads
//     instead of split() and a first-character dispatch for the six
//     per-line block-start tests.
//   - Tokenizer.link: skips the giant link regex when the input cannot
//     match it (first char not '[' / '!', no ')' per linkParenPossible,
//     or no '](' anywhere in the remaining input).
//   - Lexer.blockTokens: the same block loop, with a first-character
//     dispatch so tokenisers that cannot match a block's first character
//     are never tried.
//   - Lexer.lex: skips the whole-input CR normalisation when the input
//     holds no CR at all.
//   - Lexer.inlineTokens: a plain-text fast path — when the inline source
//     holds no inline construct at all, emit the single text token
//     directly (consuming it in successive inlineText calls, because
//     inlineText stops before a bare http/https word); anything else
//     falls through to marked's inline loop.
//
// Everything else — every other tokeniser (including inlineText, whose
// giant regex V8 runs faster than any per-character JS scanner we tried),
// the renderer, the emphasis and link machinery — is marked's own,
// untouched. When the options are not the defaults (pedantic, extensions),
// the fast paths step aside and marked's original methods run instead.
//
// No caching across parse() calls: every case is rendered from its own
// markdown alone, and nothing is kept from an earlier call.
import { Lexer, Parser, Tokenizer, defaults } from './vendor/marked/marked.esm.js';

// ---------------------------------------------------------------------------
// Small helpers for the list tokeniser.
// ---------------------------------------------------------------------------

// First line of `s` (up to the first \n, or the whole string), without
// allocating through split().
function firstLine(s) {
  const nl = s.indexOf('\n');
  return nl === -1 ? s : s.slice(0, nl);
}

// Index of the first character of `s` that is not a space, or s.length.
function firstNonSpace(s) {
  let i = 0;
  while (i < s.length && s.charCodeAt(i) === 32) i++;
  return i;
}

// Anything that can start an inline token other than plain text: the
// inline stop characters, an autolink/url trigger, or a hard break.
// A single regex scan; if it does not match, the text holds no inline
// construct at all and is one text token.
const NON_PLAIN = /[\\<!\[`*_~@]|:\/\/|www\.|mailto:|xmpp:| {2}\n/;
function isPlainInline(src) {
  return !NON_PLAIN.test(src);
}

// ---------------------------------------------------------------------------
// FastTokenizer: marked's Tokenizer with the hot methods replaced.
// ---------------------------------------------------------------------------
class FastTokenizer extends Tokenizer {
  // NOTE: inlineText is deliberately NOT overridden. A hand-written
  // scanner was built and verified 720/720, but it measured ~15% SLOWER
  // than marked's regex (V8 runs the giant regex in C++; a per-character
  // JS loop cannot beat it). marked's own inlineText runs instead.
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
    let t = this.rules.block.list.exec(src);
    if (!t) return;
    const full = src;
    const pos = () => full.length - src.length;
    const bullet = t[1].trim();
    const ordered = bullet.length > 1;
    const list = {
      type: 'list', raw: '', ordered,
      start: ordered ? +bullet.slice(0, -1) : '', loose: false, items: [],
    };
    let marker = ordered ? `\\d{1,9}\\${bullet.slice(-1)}` : `\\${bullet}`;
    if (this.options.pedantic) marker = ordered ? marker : '[*+-]';
    const itemRe = this.rules.other.listItemRegex(marker);
    let lastWasDoubleBlank = false;
    for (; src;) {
      let isBlankItem = false;
      let itemText = '';
      if (!(t = itemRe.exec(src)) || this.rules.block.hr.test(src)) break;
      const startPos = pos();
      src = src.substring(t[0].length);
      const first = firstLine(t[2]);
      const b = t[1].length;
      let markerText = this.options.pedantic
        ? expandTabs(first, b)
        : first.replace(this.rules.other.leadingSpaceTab, (v) => expandTabs(v, b));
      let next = firstLine(src);
      const itemIsBlank = !markerText.trim();
      // y in marked: whether the previous line (marker line first, then
      // each consumed line) was blank. This is NOT the blank-item flag
      // below — a blank line after a content line ends the item.
      let prevBlank = itemIsBlank;
      let indent = 0;
      if (this.options.pedantic) {
        indent = 2;
        itemText = markerText.trimStart();
      } else if (itemIsBlank) {
        indent = b + 1;
      } else {
        indent = firstNonSpace(markerText);
        if (indent > 4) indent = 1;
        itemText = markerText.slice(indent);
        indent += b;
      }
      if (itemIsBlank && this.rules.other.blankLine.test(next)) {
        src = src.substring(next.length + 1);
        isBlankItem = true;
      }
      if (!isBlankItem) {
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
          if (next = line, this.options.pedantic) {
            next = next.replace(this.rules.other.listReplaceNesting, '  ');
            expanded = next;
          } else {
            expanded = next.replace(this.rules.other.leadingSpaceTab, (m) => expandTabs(m));
          }
          if (!lineStartsBlock(next, indent, fenceRe, headingRe, htmlRe, quoteRe, bulletRe, hrRe)) {
            if (firstNonSpace(expanded) >= indent || !line.trim()) {
              itemText += '\n' + expanded.slice(indent);
            } else {
              if (prevBlank || markerText.replace(this.rules.other.tabCharGlobal, '    ').search(this.rules.other.nonSpaceChar) >= 4 ||
                  fenceRe.test(markerText) || headingRe.test(markerText) || htmlRe.test(markerText) || hrRe.test(markerText)) break;
              const setext = !this.options.pedantic && /^ {0,3}(?:=+|-+) *$/.test(line) &&
                this.rules.block.lheading.test(`${markerText}\n${line}`);
              itemText += '\n' + (setext ? `    ${expanded.replace(/^ {0,3}/, '')}` : line);
            }
          } else break;
          prevBlank = !line.trim();
          src = src.substring(line.length + 1);
          markerText = expanded.slice(indent);
        }
      }
      const rawItem = full.slice(startPos, pos());
      if (!list.loose) {
        if (lastWasDoubleBlank) list.loose = true;
        else if (this.rules.other.doubleBlankLine.test(rawItem)) lastWasDoubleBlank = true;
      }
      list.items.push({
        type: 'list_item', raw: rawItem,
        task: !!this.options.gfm && this.rules.other.listIsTask.test(itemText),
        loose: false, text: itemText, tokens: [],
      });
    }
    const last = list.items.at(-1);
    if (!last) return;
    last.raw = last.raw.trimEnd();
    last.text = last.text.trimEnd();
    list.raw = full.slice(0, pos()).trimEnd();
    for (const item of list.items) {
      if (this.lexer.state.top = false, item.tokens = this.lexer.blockTokens(item.text, []), !list.loose) {
        const hasBlank = item.tokens.some((tok) => tok.type === 'space' && this.rules.other.anyLine.test(tok.raw));
        list.loose = hasBlank;
      }
    }
    for (const item of list.items) {
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
          if (list.loose) {
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
    if (list.loose) {
      for (const item of list.items) {
        item.loose = true;
        for (const tok of item.tokens) if (tok.type === 'text') tok.type = 'paragraph';
      }
    }
    return list;
  }
}

// Expand tabs in `s` to spaces, counting columns from `col` (marked's
// tab-expansion helper, with its default column 0). A string with no tab
// expands to itself — return it unchanged instead of rebuilding it
// character by character (the common case: leading spaces, no tabs).
function expandTabs(s, col = 0) {
  if (s.indexOf('\t') === -1) return s;
  let out = '';
  let at = col;
  for (const ch of s) {
    if (ch === '\t') {
      const spaces = 4 - (at % 4);
      out += ' '.repeat(spaces);
      at += spaces;
    } else {
      out += ch;
      at++;
    }
  }
  return out;
}

// Whether the list-item line `line` starts a new block: the six tests
// marked runs per line, dispatched on the line's first non-space
// character (only spaces count toward the indent the regexes allow).
// Returns true when any test matches.
function lineStartsBlock(line, indent, fenceRe, headingRe, htmlRe, quoteRe, bulletRe, hrRe) {
  let p = 0;
  while (p < line.length && line.charCodeAt(p) === 32) p++;
  if (p > indent) return false;
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
const B_SPACE = 1, B_CODE = 2, B_FENCES = 4, B_HEADING = 8, B_HR = 16,
  B_BLOCKQUOTE = 32, B_LIST = 64, B_HTML = 128, B_DEF = 256, B_TABLE = 512,
  B_LHEADING = 1024, B_PARAGRAPH = 2048, B_TEXT = 4096;
const B_ALL = B_SPACE | B_CODE | B_FENCES | B_HEADING | B_HR | B_BLOCKQUOTE |
  B_LIST | B_HTML | B_DEF | B_TABLE | B_LHEADING | B_PARAGRAPH | B_TEXT;
const B_TEXTUAL = B_TABLE | B_LHEADING | B_PARAGRAPH | B_TEXT;

function blockMask(first) {
  switch (first) {
    case 10: return B_SPACE; // \n: only a blank-line block can start here
    case 32: case 9: return B_ALL; // space / tab: anything indented may follow
    case 35: return B_HEADING | B_TEXTUAL; // #
    case 62: return B_BLOCKQUOTE | B_TEXTUAL; // >
    case 96: case 126: return B_FENCES | B_TEXTUAL; // ` ~
    case 45: case 42: case 95: return B_HR | B_LIST | B_TEXTUAL; // - * _
    case 43: return B_LIST | B_TEXTUAL; // +
    case 60: return B_HTML | B_TEXTUAL; // <
    case 91: return B_DEF | B_TEXTUAL; // [
    case 124: return B_TEXTUAL; // |
    default:
      if (first >= 48 && first <= 57) return B_LIST | B_TEXTUAL; // digit
      return B_TEXTUAL;
  }
}

class FastLexer extends Lexer {
  // Plain-text fast path: when the inline source holds no inline
  // construct at all (no escape/tag/link/emphasis/code/del/autolink/url
  // starter and no hard break), marked's inline loop would produce
  // exactly one text token for it. Emit that token directly, skipping
  // the masking pass, the emphasis analysis and the per-tokeniser
  // dispatch. Anything else falls through to marked's inlineTokens.
  // (Default options only: breaks off, no inline extensions.)
  // inlineText can stop before a bare "http"/"https" word — the regex's
  // protocol lookahead needs no :// — so consume the source in
  // successive inlineText calls and merge, exactly as the inline loop
  // does; no other tokeniser can match at those stops (no :// in a
  // plain source, so url/autolink cannot fire there).
  inlineTokens(src, tokens = []) {
    if (!this.options.pedantic && !this.options.breaks &&
        !this.options.extensions?.inline && !this.options.extensions?.startInline &&
        src.length > 0 && isPlainInline(src)) {
      this.tokenizer.lexer = this;
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
  // block's first character are never tried. The order and the merging
  // rules are unchanged. Falls back to marked's loop for pedantic mode
  // or when block extensions are registered.
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
      if ((mask & B_SPACE) && (r = this.tokenizer.space(src))) {
        src = src.substring(r.raw.length);
        const prev = tokens.at(-1);
        if (r.raw.length === 1 && prev !== undefined) prev.raw += '\n';
        else tokens.push(r);
        continue;
      }
      if ((mask & B_CODE) && (r = this.tokenizer.code(src))) {
        src = src.substring(r.raw.length);
        const prev = tokens.at(-1);
        if (prev?.type === 'paragraph' || prev?.type === 'text') {
          prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + r.raw;
          prev.text += '\n' + r.text;
          this.inlineQueue.at(-1).src = prev.text;
        } else tokens.push(r);
        continue;
      }
      if ((mask & B_FENCES) && (r = this.tokenizer.fences(src))) { src = src.substring(r.raw.length); tokens.push(r); continue; }
      if ((mask & B_HEADING) && (r = this.tokenizer.heading(src))) { src = src.substring(r.raw.length); tokens.push(r); continue; }
      if ((mask & B_HR) && (r = this.tokenizer.hr(src))) { src = src.substring(r.raw.length); tokens.push(r); continue; }
      if ((mask & B_BLOCKQUOTE) && (r = this.tokenizer.blockquote(src))) { src = src.substring(r.raw.length); tokens.push(r); continue; }
      if ((mask & B_LIST) && (r = this.tokenizer.list(src))) { src = src.substring(r.raw.length); tokens.push(r); continue; }
      if ((mask & B_HTML) && (r = this.tokenizer.html(src))) { src = src.substring(r.raw.length); tokens.push(r); continue; }
      if ((mask & B_DEF) && (r = this.tokenizer.def(src))) {
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
      if ((mask & B_TABLE) && (r = this.tokenizer.table(src))) { src = src.substring(r.raw.length); tokens.push(r); continue; }
      if ((mask & B_LHEADING) && (r = this.tokenizer.lheading(src))) { src = src.substring(r.raw.length); tokens.push(r); continue; }
      const o = src;
      if (this.state.top && (mask & B_PARAGRAPH) && (r = this.tokenizer.paragraph(o))) {
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
      if ((mask & B_TEXT) && (r = this.tokenizer.text(src))) {
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
// Entry point: exactly marked.parse with the defaults, through the fast
// lexer and marked's own parser/renderer.
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
  return Parser.parse(tokens, options);
}
