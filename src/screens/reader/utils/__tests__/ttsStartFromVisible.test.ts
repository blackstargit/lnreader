import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';

type Rect = { top: number; bottom: number; left: number; right: number };

const toDomRect = (rect: Rect) => ({
  ...rect,
  width: rect.right - rect.left,
  height: rect.bottom - rect.top,
});

/** A `<p>` with one text node (fragments = column pieces), or a container. */
class TestElement {
  readonly childNodes: { nodeName: string }[] & {
    item(index: number): { nodeName: string };
  };
  readonly children: TestElement[];

  constructor(
    readonly nodeName: string,
    readonly fragments: Rect[],
    children: TestElement[] = [],
    readonly innerText = '',
  ) {
    const nodes = children.length ? [...children] : [{ nodeName: '#text' }];
    this.childNodes = Object.assign(nodes, {
      item: (index: number) => nodes[index],
    });
    this.children = children;
  }

  hasChildNodes() {
    return true;
  }

  getClientRects() {
    return this.fragments.map(toDomRect);
  }

  getBoundingClientRect() {
    return toDomRect({
      top: Math.min(...this.fragments.map(r => r.top)),
      bottom: Math.max(...this.fragments.map(r => r.bottom)),
      left: Math.min(...this.fragments.map(r => r.left)),
      right: Math.max(...this.fragments.map(r => r.right)),
    });
  }
}

const VIEW = { width: 400, height: 800 };

/** Scroll mode: paragraph at [top, bottom). */
const para = (top: number, bottom: number, text = `p${top}`) =>
  new TestElement('P', [{ top, bottom, left: 0, right: VIEW.width }], [], text);

/** Paged mode: paragraph split into column fragments. */
const columns = (text: string, ...fragments: Rect[]) =>
  new TestElement('P', fragments, [], text);
const frag = (page: number, top: number, bottom: number): Rect => ({
  top,
  bottom,
  left: page * VIEW.width,
  right: (page + 1) * VIEW.width,
});

const container = (...paragraphs: TestElement[]) =>
  new TestElement(
    'DIV',
    [paragraphs[0].getBoundingClientRect()].concat(
      paragraphs.map(p => p.getBoundingClientRect()),
    ),
    paragraphs,
  );

type Options = {
  pageReader?: boolean;
  insets?: { top: number; bottom: number };
};

const startFromVisible = (
  containers: TestElement[],
  { pageReader = false, insets }: Options = {},
) => {
  const core = readFileSync(
    join(process.cwd(), 'assets/reader/js/core.js'),
    'utf8',
  );
  const start = core.indexOf('window.tts = new (function () {');
  const closing = '\n})();';
  const end = core.indexOf(closing, start);
  type Tts = {
    start: jest.Mock;
    startFromVisible(): void;
    setChromeInsets(insets: object): void;
  };
  const context = {
    reader: {
      chapterElement: containers[0],
      chapterContainers: () => containers,
      generalSettings: { val: { pageReader } },
      hidden: { val: !insets },
      layoutWidth: VIEW.width,
    },
    window: { innerHeight: VIEW.height, tts: undefined as Tts | undefined },
  };
  runInNewContext(core.slice(start, end + closing.length), context);
  const tts = context.window.tts!;
  if (insets) {
    tts.setChromeInsets(insets);
  }
  tts.start = jest.fn();
  tts.startFromVisible();
  expect(tts.start).toHaveBeenCalledTimes(1);
  return tts.start.mock.calls[0][0] as TestElement | undefined;
};

/** App bar 120 px, bottom bar + docked TTS bar 160 px: band is [120, 640). */
const insets = { top: 120, bottom: 160 };

describe('tts.startFromVisible', () => {
  it('starts at the first paragraph whose top is on screen', () => {
    const target = para(50, 200);
    expect(
      startFromVisible([
        container(para(-400, -100), para(-100, 30), target, para(200, 900)),
      ]),
    ).toBe(target);
  });

  it('keeps a mostly visible paragraph cut at the top', () => {
    const target = para(-20, 300);
    expect(
      startFromVisible([container(para(-400, -20), target, para(300, 500))]),
    ).toBe(target);
  });

  it('falls back to a paragraph longer than the screen', () => {
    const target = para(-2000, 1500);
    expect(startFromVisible([container(para(-2100, -2000), target)])).toBe(
      target,
    );
  });

  it('skips empty paragraphs and chapters above the screen (continuous)', () => {
    const target = para(400, 600);
    expect(
      startFromVisible([
        container(para(-3000, -1000)),
        container(para(-50, 10), para(100, 300, '   '), target),
        container(para(900, 1200)),
      ]),
    ).toBe(target);
  });

  it('starts at the next chapter when it is the first one on screen', () => {
    const target = para(250, 400);
    expect(
      startFromVisible([
        container(para(-1000, -10)),
        container(target, para(400, 900)),
      ]),
    ).toBe(target);
  });

  describe('with the app chrome shown', () => {
    it('skips paragraphs under the app bar', () => {
      const target = para(130, 300);
      expect(
        startFromVisible([container(para(0, 110), target, para(300, 500))], {
          insets,
        }),
      ).toBe(target);
    });

    it('takes a paragraph mostly below the app bar', () => {
      const target = para(100, 400);
      expect(
        startFromVisible([container(para(0, 100), target)], { insets }),
      ).toBe(target);
    });

    it('ignores paragraphs under the bottom bar', () => {
      const partly = para(-500, 700);
      expect(
        startFromVisible([container(partly, para(700, 780))], { insets }),
      ).toBe(partly);
    });

    it('falls back to the first paragraph below the band', () => {
      const target = para(700, 900);
      expect(
        startFromVisible([container(para(0, 110), target)], { insets }),
      ).toBe(target);
    });
  });

  it('falls back to the last paragraph above when nothing follows', () => {
    const target = para(-300, -100);
    expect(
      startFromVisible([
        container(
          para(-500, -300),
          target,
          para(-100, -50, ''),
          para(-50, 900, ''),
        ),
      ]),
    ).toBe(target);
  });

  it('falls back to the last paragraph of a chapter above (continuous)', () => {
    const target = para(-1500, -1200);
    expect(
      startFromVisible([container(para(-2000, -1500), target)], { insets }),
    ).toBe(target);
  });

  describe('paged mode', () => {
    it('uses the current page', () => {
      const target = columns('t', frag(0, 0, 100));
      expect(
        startFromVisible(
          [
            container(
              columns('a', frag(-2, 0, 800)),
              columns('b', frag(-1, 700, 800), frag(0, 0, 0)),
              target,
            ),
          ],
          { pageReader: true },
        ),
      ).toBe(target);
    });

    it('counts a paragraph continued from the previous page that is mostly here', () => {
      const target = columns('t', frag(-1, 750, 800), frag(0, 0, 300));
      expect(
        startFromVisible([container(target, columns('n', frag(0, 300, 400)))], {
          pageReader: true,
        }),
      ).toBe(target);
    });

    it('skips a fragment hidden under the app bar', () => {
      const target = columns('t', frag(0, 130, 300));
      expect(
        startFromVisible(
          [
            container(
              columns('a', frag(-1, 600, 800), frag(0, 0, 100)),
              target,
            ),
          ],
          { pageReader: true, insets },
        ),
      ).toBe(target);
    });
  });
});
