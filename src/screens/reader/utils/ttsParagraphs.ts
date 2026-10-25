import { Parser } from 'htmlparser2';

/**
 * Builds the TTS queue for chapter HTML without a WebView, the way the reader
 * page does in `assets/reader/js/core.js` (`tts.readable`,
 * `getAllReadableElements`, `normalizeText`). Used to move TTS on to the next
 * chapter while the app is in the background, where the WebView can't load
 * anything. Keep it in step with core.js: the page attaches to this queue when
 * the app returns and matches paragraphs by text.
 */

type TextNode = { name: '#text'; text: string };
type CommentNode = { name: '#comment' };
export type HtmlElement = { name: string; children: HtmlNode[] };
export type HtmlNode = TextNode | CommentNode | HtmlElement;

/** `tts.readableNodeNames` in core.js. */
const READABLE_NODE_NAMES = new Set([
  '#text',
  'B',
  'I',
  'SPAN',
  'EM',
  'BR',
  'STRONG',
  'A',
  'MARK',
]);

/** Elements `innerText` separates from their surroundings with a line break. */
const BLOCK_NAMES = new Set([
  'ADDRESS',
  'ARTICLE',
  'ASIDE',
  'BLOCKQUOTE',
  'DD',
  'DIV',
  'DL',
  'DT',
  'FIGCAPTION',
  'FIGURE',
  'FOOTER',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'HEADER',
  'HR',
  'LI',
  'OL',
  'P',
  'PRE',
  'SECTION',
  'TABLE',
  'TD',
  'TH',
  'TR',
  'UL',
]);

const isElement = (node: HtmlNode): node is HtmlElement => 'children' in node;

/** Parses `html` into a tree under a root DIV, like the page's chapter container. */
export const parseChapterHtml = (html: string): HtmlElement => {
  const root: HtmlElement = { name: 'DIV', children: [] };
  const stack = [root];
  const parser = new Parser({
    onopentag(name) {
      const element: HtmlElement = { name: name.toUpperCase(), children: [] };
      stack[stack.length - 1].children.push(element);
      stack.push(element);
    },
    ontext(text) {
      stack[stack.length - 1].children.push({ name: '#text', text });
    },
    oncomment() {
      stack[stack.length - 1].children.push({ name: '#comment' });
    },
    onclosetag() {
      if (stack.length > 1) {
        stack.pop();
      }
    },
  });
  parser.write(html);
  parser.end();
  return root;
};

/** `tts.normalizeText` in core.js. */
export const normalizeTtsText = (text: string) => {
  if (!text) return '';
  const normalized = text
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, '')
    .replace(/\s*([.,!?;:])\s*/g, '$1 ')
    .trim();

  const dashOnlyText = normalized.replace(/\s/g, '');
  if (
    dashOnlyText.length >= 3 &&
    /^[\-‐‑‒–—―−⁓⸺⸻﹘﹣－]+$/u.test(dashOnlyText)
  ) {
    return '';
  }

  return normalized;
};

/** `tts.readable` in core.js. */
const isReadable = (element: HtmlElement) =>
  !(element.name !== 'SPAN' && READABLE_NODE_NAMES.has(element.name)) &&
  element.children.length > 0 &&
  element.children.every(child => READABLE_NODE_NAMES.has(child.name));

/** `getAllReadableElements` in core.js; only element children are visited. */
const collectReadable = (element: HtmlElement, out: HtmlElement[]) => {
  if (isReadable(element)) {
    out.push(element);
    return;
  }
  for (const child of element.children) {
    if (isElement(child)) {
      collectReadable(child, out);
    }
  }
};

/** Close enough to `innerText` once normalized: line breaks become spaces. */
const innerText = (node: HtmlNode): string => {
  if (node.name === '#text') return (node as TextNode).text;
  if (!isElement(node)) return '';
  if (node.name === 'BR') return '\n';
  const text = node.children.map(innerText).join('');
  return BLOCK_NAMES.has(node.name) ? `\n${text}\n` : text;
};

/** The paragraphs the reader page would queue for `html`, in order. */
export const extractTtsParagraphs = (html: string): string[] => {
  const readable: HtmlElement[] = [];
  collectReadable(parseChapterHtml(html), readable);
  return readable
    .map(element => normalizeTtsText(innerText(element)))
    .filter(text => text.trim().length > 0);
};
