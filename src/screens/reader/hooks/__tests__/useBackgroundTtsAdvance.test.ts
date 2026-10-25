import {
  BackgroundTtsOptions,
  createBackgroundTtsAdvance,
} from '../useBackgroundTtsAdvance';
import type { ChapterInfo } from '@database/types';

const chapter = (id: number) => ({ id, name: `Chapter ${id}` } as ChapterInfo);

const flush = () => new Promise(resolve => setImmediate(resolve));

const setup = () => {
  const injectJavaScript = jest.fn();
  let foreground = false;
  const options: BackgroundTtsOptions = {
    webViewRef: { current: { injectJavaScript } } as never,
    readerSettingsRef: {
      current: {
        tts: { autoPageAdvance: true },
        removeText: [],
        replaceText: {},
      },
    } as never,
    ttsState: 'completed',
    ttsProgress: { index: 4, total: 9, paragraphId: '4' },
    documentChapterId: 1,
    advanceTtsChapter: jest.fn(async (id: number) => ({
      chapter: chapter(id + 1),
      html: `<p>Text of ${id + 1}</p>`,
    })),
    getChapter: jest.fn(async (chap: ChapterInfo) => {
      options.documentChapterId = chap.id;
      return true;
    }),
    play: jest.fn(async () => true),
  };
  const controller = createBackgroundTtsAdvance(
    () => options,
    () => foreground,
  );
  const setForeground = (value: boolean) => {
    foreground = value;
  };
  const attachCalls = () =>
    injectJavaScript.mock.calls
      .map(([script]) => script as string)
      .filter(script => script.includes('tts?.attach'));
  return { controller, options, injectJavaScript, setForeground, attachCalls };
};

describe('createBackgroundTtsAdvance', () => {
  beforeEach(() => jest.useFakeTimers({ doNotFake: ['setImmediate'] }));
  afterEach(() => jest.useRealTimers());

  it('chains chapters in the background and keeps chaining after an attach', async () => {
    const { controller, options, setForeground, attachCalls } = setup();
    controller.setQueueChapter(1);

    expect(controller.onCompleted()).toBe(true);
    await flush();
    expect(controller.onCompleted()).toBe(true);
    await flush();
    expect(options.advanceTtsChapter).toHaveBeenNthCalledWith(1, 1);
    expect(options.advanceTtsChapter).toHaveBeenNthCalledWith(2, 2);
    expect(options.play).toHaveBeenLastCalledWith(['Text of 3'], chapter(3));
    expect(controller.isDetached()).toBe(true);

    setForeground(true);
    controller.sync();
    await flush();
    expect(options.getChapter).toHaveBeenCalledWith(chapter(3));
    expect(controller.isAttachingTo(3)).toBe(true);
    controller.onLoadEnd();
    jest.advanceTimersByTime(800);
    expect(attachCalls()).toEqual([
      expect.stringContaining('(["Text of 3"], 4, "completed", 3)'),
    ]);
    expect(controller.isDetached()).toBe(false);

    // Screen off again: the next advance starts from the attached chapter.
    setForeground(false);
    controller.onCompleted();
    await flush();
    expect(options.advanceTtsChapter).toHaveBeenLastCalledWith(3);
  });

  it('drops an advance the user took over while it was loading', async () => {
    const { controller, options, injectJavaScript } = setup();
    let resolve!: (
      value: Awaited<ReturnType<typeof options.advanceTtsChapter>>,
    ) => void;
    (options.advanceTtsChapter as jest.Mock).mockReturnValueOnce(
      new Promise(res => (resolve = res)),
    );
    controller.setQueueChapter(1);
    controller.onCompleted();
    controller.setQueueChapter(1);
    resolve({ chapter: chapter(2), html: '<p>Two</p>' });
    await flush();

    expect(options.play).not.toHaveBeenCalled();
    expect(injectJavaScript).not.toHaveBeenCalled();
    expect(controller.isDetached()).toBe(false);
  });

  it('drops an advance when native stops meanwhile', async () => {
    const { controller, options } = setup();
    controller.setQueueChapter(1);
    controller.onCompleted();
    controller.onStopped();
    await flush();
    expect(options.play).not.toHaveBeenCalled();
  });

  it('attaches at the start, stopped, when the next chapter failed to play', async () => {
    const { controller, options, setForeground, attachCalls } = setup();
    (options.play as jest.Mock).mockResolvedValueOnce(false);
    controller.setQueueChapter(1);
    controller.onCompleted();
    await flush();

    setForeground(true);
    controller.sync();
    await flush();
    controller.onLoadEnd();
    jest.advanceTimersByTime(800);
    expect(attachCalls()).toEqual([
      expect.stringContaining('(["Text of 2"], 0, "idle", 2)'),
    ]);
  });

  it('leaves the end of the chapter to the page when there is no next one', async () => {
    const { controller, options, injectJavaScript } = setup();
    (options.advanceTtsChapter as jest.Mock).mockResolvedValueOnce(undefined);
    controller.setQueueChapter(1);
    controller.onCompleted();
    await flush();
    expect(injectJavaScript).toHaveBeenCalledWith(
      'window.tts?.started && window.tts.complete(); true;',
    );

    // Not into a page the user has navigated to meanwhile.
    injectJavaScript.mockClear();
    (options.advanceTtsChapter as jest.Mock).mockImplementationOnce(
      async () => {
        options.documentChapterId = 5;
        return undefined;
      },
    );
    controller.onCompleted();
    await flush();
    expect(injectJavaScript).not.toHaveBeenCalled();
  });

  it('stops holding the page back when it could not be navigated', async () => {
    const { controller, options, setForeground } = setup();
    (options.getChapter as jest.Mock).mockResolvedValueOnce(false);
    controller.setQueueChapter(1);
    controller.onCompleted();
    await flush();
    setForeground(true);
    controller.sync();
    await flush();
    expect(controller.isDetached()).toBe(false);
    expect(controller.isAttachingTo(2)).toBe(false);

    setForeground(false);
    controller.onCompleted();
    await flush();
    expect(options.advanceTtsChapter).toHaveBeenLastCalledWith(2);
  });

  it('does not attach while a newer advance is in flight', async () => {
    const { controller, options, setForeground, attachCalls } = setup();
    controller.setQueueChapter(1);
    controller.onCompleted();
    await flush();
    setForeground(true);
    controller.sync();
    await flush();
    controller.onLoadEnd();

    // The app went back to the background and chapter 2 ended meanwhile.
    setForeground(false);
    controller.onCompleted();
    jest.advanceTimersByTime(800);
    expect(attachCalls()).toEqual([]);

    await flush();
    setForeground(true);
    controller.sync();
    await flush();
    expect(options.getChapter).toHaveBeenLastCalledWith(chapter(3));
  });
});
