import { RefObject, useEffect, useMemo, useRef } from 'react';
import { AppState } from 'react-native';
import WebView from 'react-native-webview';

import type { ChapterInfo } from '@database/types';
import type { ChapterReaderSettings } from '@hooks/persisted/useSettings';
import type { TtsPlaybackState, TtsProgress } from '@modules/nitro-tts';
import { applyTextModifications } from '@utils/customCode';
import { extractTtsParagraphs } from '../utils/ttsParagraphs';

type AdvanceResult = { chapter: ChapterInfo; html: string } | undefined;

export type BackgroundTtsOptions = {
  webViewRef: RefObject<WebView<object> | null>;
  readerSettingsRef: RefObject<ChapterReaderSettings>;
  ttsState: TtsPlaybackState;
  ttsProgress: TtsProgress;
  documentChapterId: number;
  advanceTtsChapter(chapterId: number): Promise<AdvanceResult>;
  /** Resolves to false when the chapter wasn't shown (failed or superseded). */
  getChapter(chapter: ChapterInfo): Promise<boolean>;
  /** Loads `queue` into native TTS and plays it; resolves to whether it did. */
  play(queue: string[], chapter: ChapterInfo): Promise<boolean>;
};

/**
 * Moves TTS on to the next chapter while the app is in the background (e.g.
 * the screen is off). Fabric holds back every WebView update then - both
 * `injectJavaScript` and a new `source` - until the activity resumes, so the
 * page can't do it: the app loads the next chapter's text into native TTS
 * itself, and brings the page to that chapter once it is in the foreground.
 */
export const createBackgroundTtsAdvance = (
  getOptions: () => BackgroundTtsOptions,
  isForeground: () => boolean,
) => {
  const state: {
    /** The chapter native TTS reads that the page doesn't show yet. */
    background: {
      chapter: ChapterInfo;
      queue: string[];
      failed: boolean;
    } | null;
    advancing: boolean;
    /** Navigating the page to `background`; it attaches once loaded. */
    attaching: boolean;
    /** The chapter TTS reads, once the page shows it again. */
    queueChapterId?: number;
    /** Bumped when the user takes over TTS: work started before is dropped. */
    epoch: number;
  } = { background: null, advancing: false, attaching: false, epoch: 0 };

  const inject = (script: string) =>
    getOptions().webViewRef.current?.injectJavaScript(`${script}; true;`);

  const attach = () => {
    const background = state.background!;
    const { ttsProgress, ttsState } = getOptions();
    state.queueChapterId = background.chapter.id;
    state.background = null;
    // Failed to load: native is still done with the chapter before. Show this
    // one from its start; play reloads it (tts.restartIfDropped).
    const [index, playback] = background.failed
      ? [0, 'idle']
      : [ttsProgress.index, ttsState];
    inject(
      `window.tts?.attach?.(${JSON.stringify(
        background.queue,
      )}, ${index}, ${JSON.stringify(playback)}, ${background.chapter.id})`,
    );
  };

  const sync = () => {
    const { background } = state;
    if (!background || state.advancing || state.attaching || !isForeground()) {
      return;
    }
    if (background.chapter.id === getOptions().documentChapterId) {
      attach();
      return;
    }
    state.attaching = true;
    const epoch = state.epoch;
    void getOptions()
      .getChapter(background.chapter)
      .then(shown => {
        if (
          !shown &&
          epoch === state.epoch &&
          state.background === background
        ) {
          // Native reads on regardless; stop holding the page back for it.
          state.queueChapterId = background.chapter.id;
          state.background = null;
          state.attaching = false;
        }
      });
  };

  const advance = () => {
    const from = state.background?.chapter.id ?? state.queueChapterId;
    if (from === undefined) {
      return false;
    }
    const epoch = state.epoch;
    const documentChapterId = getOptions().documentChapterId;
    state.advancing = true;
    // No timers on this path: they don't fire while the app is backgrounded.
    getOptions()
      .advanceTtsChapter(from)
      .then(async result => {
        if (!result || epoch !== state.epoch) {
          return;
        }
        const { removeText, replaceText } =
          getOptions().readerSettingsRef.current;
        // Custom JS, plugin custom.js and CSS aren't applied here (they need
        // the page); the page matches paragraphs by text when it attaches.
        const queue = extractTtsParagraphs(
          applyTextModifications(
            result.html,
            removeText ?? [],
            replaceText ?? {},
          ),
        );
        const background = { chapter: result.chapter, queue, failed: false };
        state.background = background;
        background.failed = !(await getOptions().play(queue, result.chapter));
      })
      .catch(() => {})
      .then(() => {
        if (epoch !== state.epoch) {
          return;
        }
        state.advancing = false;
        if (state.background) {
          sync();
        } else if (getOptions().documentChapterId === documentChapterId) {
          // Nothing moved on (no next chapter, or it failed to load): let the
          // page end the chapter as it would have in the foreground. Like any
          // injection now, it runs once the app resumes.
          inject('window.tts?.started && window.tts.complete()');
        }
      });
    return true;
  };

  /** The user took TTS over (navigated, or the page queued its own text). */
  const cancel = () => {
    state.epoch += 1;
    state.advancing = false;
    state.attaching = false;
    state.background = null;
  };

  return {
    /**
     * Native TTS is ahead of the page. TTS updates for the page are held
     * back: Fabric would replay them on resume, against the old chapter.
     */
    isDetached: () => state.advancing || state.background !== null,
    /** The page is being brought to `chapterId` for TTS; don't stop it. */
    isAttachingTo: (chapterId: number) =>
      state.attaching && state.background?.chapter.id === chapterId,

    cancel,

    /** The page loaded a queue itself: it owns TTS again. */
    setQueueChapter(chapterId: number) {
      cancel();
      state.queueChapterId = chapterId;
    },

    /**
     * Native stopped or failed: drop an advance in flight, which would start
     * it again. A chapter already moved on to is still synced to the page.
     */
    onStopped() {
      if (state.advancing) {
        state.epoch += 1;
        state.advancing = false;
      }
    },

    /**
     * Native finished the queue. True when this moves TTS on; false leaves it
     * to the page (foreground, auto-advance off, or nothing to advance from).
     */
    onCompleted() {
      if (
        isForeground() ||
        getOptions().readerSettingsRef.current.tts?.autoPageAdvance !== true
      ) {
        return false;
      }
      return state.advancing || advance();
    },

    sync,

    onLoadEnd() {
      if (!state.attaching) {
        return;
      }
      const epoch = state.epoch;
      // The same settling time the reader gives a fresh page before it starts
      // TTS (paged mode lays itself out after load).
      setTimeout(() => {
        if (epoch !== state.epoch) {
          return;
        }
        state.attaching = false;
        // Advancing again: its completion syncs to the newer chapter.
        if (!state.background || state.advancing) {
          return;
        }
        if (state.background.chapter.id === getOptions().documentChapterId) {
          attach();
        } else {
          sync();
        }
      }, 800);
    },
  };
};

export const useBackgroundTtsAdvance = (options: BackgroundTtsOptions) => {
  const optionsRef = useRef(options);
  useEffect(() => {
    optionsRef.current = options;
  });

  const controller = useMemo(
    () =>
      createBackgroundTtsAdvance(
        // Only called from effects and event handlers, never during render.
        // eslint-disable-next-line react-hooks/refs
        () => optionsRef.current,
        () => AppState.currentState === 'active',
      ),
    [],
  );

  useEffect(() => {
    const subscription = AppState.addEventListener('change', state => {
      if (state === 'active') {
        controller.sync();
      }
    });
    return () => subscription.remove();
  }, [controller]);

  return controller;
};
