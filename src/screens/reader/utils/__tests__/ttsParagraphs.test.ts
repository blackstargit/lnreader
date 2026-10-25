import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';

import {
  extractTtsParagraphs,
  HtmlElement,
  HtmlNode,
  parseChapterHtml,
} from '../ttsParagraphs';

const CHAPTER = `
<h1>Chapter 12: The Long Road</h1>
<div class="chapter-content">
  <div class="note"><p><em>Translator: Someone</em></p></div>
  <p>The wind howled across the plain. Lin Feng pulled his cloak tighter.</p>
  <p>&nbsp;</p>
  <p>   </p>
  <p></p>
  <p>“Are we there yet?” she asked,<br>her voice barely a whisper.</p>
  <p><span>Nested <strong>bold</strong> and <a href="#">a link</a>.</span></p>
  <div>
    <div>
      <p>Deep inside two divs.</p>
    </div>
  </div>
  <p>----------</p>
  <p>Line one<br><br>Line two</p>
  <p>He said: <u>underlined</u> words.</p>
  <h3>Part Two</h3>
  <p>Wait...what? He laughed!He ran.</p>
  <!-- ad slot -->
  <div>Loose text directly in a div<br>with a break.</div>
  <p><img src="x.png"> after the image</p>
</div>
`;

/** A DOM stand-in for core.js, built from the same parse. */
class TestElement {
  readonly childNodes: (TestElement | { nodeName: string })[] & {
    item(index: number): unknown;
  };
  readonly children: TestElement[];

  constructor(readonly nodeName: string, private readonly node: HtmlElement) {
    const childNodes = node.children.map(child =>
      'children' in child
        ? new TestElement(child.name, child)
        : { nodeName: child.name },
    );
    this.childNodes = Object.assign(childNodes, {
      item: (index: number) => childNodes[index],
    });
    this.children = childNodes.filter(
      (child): child is TestElement => child instanceof TestElement,
    );
  }

  hasChildNodes() {
    return this.childNodes.length > 0;
  }

  get innerText(): string {
    const text = (node: HtmlNode): string => {
      if (node.name === '#text') return (node as { text: string }).text;
      if (!('children' in node)) return '';
      if (node.name === 'BR') return '\n';
      return node.children.map(text).join('');
    };
    return text(this.node);
  }
}

type PageTts = {
  getAllReadableElements(el: TestElement): TestElement[];
  normalizeText(text: string): string;
  mapQueue(queue: string[], pageTexts: string[]): number[];
};

/** core.js's TTS object, run against `root`. */
const loadPageTts = (root: TestElement): PageTts => {
  const core = readFileSync(
    join(process.cwd(), 'assets/reader/js/core.js'),
    'utf8',
  );
  const start = core.indexOf('window.tts = new (function () {');
  const end = core.indexOf('\n})();', start);
  const context: {
    reader: { chapterElement: TestElement };
    window: { tts?: PageTts };
  } = { reader: { chapterElement: root }, window: {} };
  runInNewContext(core.slice(start, end + '\n})();'.length), context);
  return context.window.tts!;
};

/** What the reader page itself queues, running core.js's TTS traversal. */
const pageQueue = (html: string): string[] => {
  const root = new TestElement('DIV', parseChapterHtml(html));
  const tts = loadPageTts(root);
  return tts
    .getAllReadableElements(root)
    .map(el => tts.normalizeText(el.innerText))
    .filter(Boolean);
};

describe('extractTtsParagraphs', () => {
  it('queues a realistic chapter the way the reader page does', () => {
    expect(extractTtsParagraphs(CHAPTER)).toEqual([
      'Chapter 12: The Long Road',
      'Translator: Someone',
      'The wind howled across the plain. Lin Feng pulled his cloak tighter.',
      // core.js's punctuation spacing quirks are kept on purpose.
      'Are we there yet? ” she asked, her voice barely a whisper.',
      'Nested bold and a link.',
      'Deep inside two divs.',
      'Line one Line two',
      // core.js skips text beside non-inline tags such as <u> and <img>.
      'underlined',
      'Part Two',
      'Wait. . . what? He laughed! He ran.',
      'Loose text directly in a div with a break.',
    ]);
  });

  it('matches core.js traversal and normalization', () => {
    expect(extractTtsParagraphs(CHAPTER)).toEqual(pageQueue(CHAPTER));
  });

  it('reads a chapter that is plain text as one paragraph', () => {
    expect(extractTtsParagraphs('Just text<br>and more')).toEqual([
      'Just text and more',
    ]);
  });

  it('returns nothing for an empty chapter', () => {
    expect(extractTtsParagraphs('  <p> </p><div></div> ')).toEqual([]);
  });
});

describe('core.js tts.mapQueue', () => {
  const { mapQueue } = loadPageTts(
    new TestElement('DIV', parseChapterHtml('')),
  );

  it('maps identical queues one to one', () => {
    expect(mapQueue(['a', 'b', 'c'], ['a', 'b', 'c'])).toEqual([0, 1, 2]);
  });

  it('skips paragraphs only the page has', () => {
    expect(mapQueue(['a', 'b', 'c'], ['a', 'note', 'b', 'c'])).toEqual([
      0, 2, 3,
    ]);
  });

  it("doesn't let a repeated line far ahead pin the rest", () => {
    const filler = Array.from({ length: 10 }, (_, n) => `filler ${n}`);
    const page = ['a', 'b', 'c', 'd', ...filler, '***', 'e'];
    expect(mapQueue(['a', 'b', 'c', '***', 'd'], page)).toEqual([
      0, 1, 2, 3, 3,
    ]);
  });

  it('falls back to the relative position when the text was rewritten', () => {
    expect(
      mapQueue(['a', 'b', 'c', 'd'], ['w', 'x', 'y', 'z', 'v', 'u', 't', 's']),
    ).toEqual([0, 2, 4, 6]);
  });
});
