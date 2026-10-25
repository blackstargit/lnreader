import React, { memo, useEffect, useMemo, useRef, useState } from 'react';
import {
  NativeEventEmitter,
  NativeModules,
  StatusBar,
  StyleSheet,
} from 'react-native';
import WebView from 'react-native-webview';
import * as Linking from 'expo-linking';
import color from 'color';

import { useTheme } from '@hooks/persisted';
import { getString } from '@i18n/translations';

import { getPlugin } from '@plugins/pluginManager';
import { MMKVStorage, getMMKVObject } from '@utils/mmkv/mmkv';
import {
  CHAPTER_GENERAL_SETTINGS,
  CHAPTER_READER_SETTINGS,
  ChapterGeneralSettings,
  ChapterReaderSettings,
  initialChapterGeneralSettings,
  initialChapterReaderSettings,
} from '@hooks/persisted/useSettings';
import { getBatteryLevel } from 'react-native-device-info';
import { PLUGIN_STORAGE } from '@utils/Storages';
import { showToast } from '@utils/showToast';
import { useChapterContext } from '../ChapterContext';
import { ReaderSearchResult } from '../types';
import { useTtsSession } from '../hooks/useTtsSession';
import { useBackgroundTtsAdvance } from '../hooks/useBackgroundTtsAdvance';
import type { TtsSettings } from '@modules/nitro-tts';
import { ChapterInfo } from '@database/types';
import { Dialog } from '@components/Dialog';
import { TextInput } from 'react-native-paper';
import useCustomCode from './Hooks/useCustomCode';
import useTextModifications from './Hooks/useTextModifications';
import { applyTextModifications } from '@utils/customCode';
import {
  isChapterRefreshUrl,
  isPluginIssueReportUrl,
} from '../utils/sanitizeChapterText';

export type WebViewPostEvent = {
  type: string;
  data?: unknown;
  autoStartTTS?: boolean;
  chapterId?: number;
  index?: number;
  total?: number;
};

type WebViewReaderProps = {
  onPress(): void;
  onTouchStart?(): void;
  onSearchResult(result: ReaderSearchResult): void;
  searchTextRef: React.MutableRefObject<string>;
};

const onLogMessage = (payload: { nativeEvent: { data: string } }) => {
  const dataPayload = JSON.parse(payload.nativeEvent.data);
  if (dataPayload) {
    if (dataPayload.type === 'console') {
      /* eslint-disable no-console */
      console.info(`[Console] ${JSON.stringify(dataPayload.msg, null, 2)}`);
    }
  }
};

/** Checks whether two TTS settings objects are equal */
const areTTSSettingsEqual = (
  a: ChapterReaderSettings['tts'],
  b: ChapterReaderSettings['tts'],
) => {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.rate === b.rate &&
    a.pitch === b.pitch &&
    a.autoPageAdvance === b.autoPageAdvance &&
    a.scrollToTop === b.scrollToTop &&
    a.voice?.identifier === b.voice?.identifier &&
    a.engine?.name === b.engine?.name
  );
};

const toNativeTtsSettings = (
  settings: ChapterReaderSettings['tts'],
): TtsSettings => ({
  engineName: settings?.engine?.name,
  voiceIdentifier: settings?.voice?.identifier,
  rate: settings?.rate ?? 1,
  pitch: settings?.pitch ?? 1,
  sentencePauseMs: settings?.sentencePause ?? 200,
  paragraphPauseMs: settings?.paragraphPause ?? 400,
});

/**
 * The adjacent chapters are resolved after the chapter itself is on screen, so
 * they are pushed into the loaded page instead of being baked into the HTML –
 * rebuilding the HTML would reload the WebView and lose the reading position.
 */
const buildAdjacentChapterScript = (
  nextChapter?: ChapterInfo,
  prevChapter?: ChapterInfo,
) => `
  window.reader?.setAdjacentChapters?.(${JSON.stringify({
    nextChapter,
    prevChapter,
    strings: {
      nextChapter: getString('readerScreen.nextChapter', {
        name: nextChapter?.name,
      }),
    },
  })});
  true;
`;

const finishedString = (chapter: ChapterInfo) =>
  getString('readerScreen.finished') + ': ' + chapter.name.trim();

const { RNDeviceInfo } = NativeModules;
const deviceInfoEmitter = new NativeEventEmitter(RNDeviceInfo);

/**
 * Last level seen, so a chapter can be rendered without the synchronous native
 * call the sync variant of this API performs. It is refreshed asynchronously
 * and pushed into the page, which also happens on every battery change event.
 */
let lastKnownBatteryLevel = 0;

const assetsUriPrefix = __DEV__
  ? 'http://localhost:8081/assets'
  : 'file:///android_asset';

const WebViewReader: React.FC<WebViewReaderProps> = ({
  onPress,
  onTouchStart,
  onSearchResult,
  searchTextRef,
}) => {
  const {
    novel,
    chapter,
    documentChapter,
    chapterText: html,
    navigateChapter,
    saveProgress,
    nextChapter,
    prevChapter,
    webViewRef,
    onUserInteraction,
    isTTSReadingRef,
    refetch,
    loadChapterBeside,
    advanceTtsChapter,
    getChapter,
    setActiveChapter,
  } = useChapterContext();
  const theme = useTheme();
  const initialReaderSettings = useMemo(
    () => ({
      ...initialChapterReaderSettings,
      ...getMMKVObject<ChapterReaderSettings>(CHAPTER_READER_SETTINGS),
    }), // eslint-disable-next-line react-hooks/exhaustive-deps
    [documentChapter],
  );

  const chapterGeneralSettings = useMemo(
    () => ({
      ...initialChapterGeneralSettings,
      ...getMMKVObject<ChapterGeneralSettings>(CHAPTER_GENERAL_SETTINGS),
    }),
    // needed to preserve settings during chapter change
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [documentChapter],
  );

  const [batteryLevel] = useState(lastKnownBatteryLevel);
  const plugin = getPlugin(novel?.pluginId);
  const pluginCustomJS = `file://${PLUGIN_STORAGE}/${plugin?.id}/custom.js`;
  const pluginCustomCSS = `file://${PLUGIN_STORAGE}/${plugin?.id}/custom.css`;
  const nextChapterScreenVisible = useRef<boolean>(false);
  const autoStartTTSRef = useRef<boolean>(false);
  const documentChapterIdRef = useRef(documentChapter.id);
  const pendingAppendsRef = useRef(new Set<string>());
  const adjacentChapterScriptRef = useRef(buildAdjacentChapterScript());
  const {
    command: runTtsCommand,
    error: ttsError,
    loadAndPlay,
    progress: ttsProgress,
    seekTo: seekTts,
    state: ttsState,
    updateSettings: updateTtsSettings,
  } = useTtsSession();

  const { customJS, customCSS } = useCustomCode(initialReaderSettings);

  const {
    html: processedHtml,
    replaceModalVisible,
    setReplaceModalVisible,
    selectedTextForReplace,
    replacementText,
    setReplacementText,
    handleReplaceSave,
    handleReplaceCancel,
    eventTextAction,
  } = useTextModifications(html, webViewRef);

  const [readerSettings, setReaderSettings] = useState(
    () =>
      getMMKVObject<ChapterReaderSettings>(CHAPTER_READER_SETTINGS) ||
      initialChapterReaderSettings,
  );

  const readerSettingsRef = useRef<ChapterReaderSettings>(readerSettings);

  useEffect(() => {
    readerSettingsRef.current = readerSettings;
  }, [readerSettings]);

  const backgroundTts = useBackgroundTtsAdvance({
    webViewRef,
    readerSettingsRef,
    ttsState,
    ttsProgress,
    documentChapterId: documentChapter.id,
    advanceTtsChapter,
    getChapter,
    play: (queue, nextChapterToRead) =>
      loadAndPlay(
        queue,
        0,
        {
          novelName: novel?.name || 'Unknown',
          chapterName: nextChapterToRead.name,
          coverUri: novel?.cover || undefined,
        },
        toNativeTtsSettings(readerSettingsRef.current.tts),
      ),
  });

  useEffect(() => {
    isTTSReadingRef.current = ttsState === 'playing';
    if (ttsState === 'idle' || ttsState === 'error') {
      backgroundTts.onStopped();
    }
    if (backgroundTts.isDetached()) {
      if (ttsState === 'completed') {
        backgroundTts.onCompleted();
      }
      return;
    }
    webViewRef.current?.injectJavaScript(`
      window.tts?.setPlaybackState?.(${JSON.stringify(ttsState)});
      true;
    `);
    if (ttsState === 'completed' && !backgroundTts.onCompleted()) {
      webViewRef.current?.injectJavaScript('window.tts?.complete?.(); true;');
    }
  }, [backgroundTts, isTTSReadingRef, ttsState, webViewRef]);

  useEffect(() => {
    if (ttsProgress.total > 0 && !backgroundTts.isDetached()) {
      webViewRef.current?.injectJavaScript(`
        window.tts?.setActiveIndex?.(${ttsProgress.index});
        true;
      `);
    }
  }, [backgroundTts, ttsProgress, webViewRef]);

  // Keyed on the document: in continuous mode the active chapter changes while
  // TTS reads on into the next chapter of the same document.
  useEffect(() => {
    if (documentChapterIdRef.current !== documentChapter.id) {
      documentChapterIdRef.current = documentChapter.id;
      // Attaching: the page is being brought to the chapter TTS reads.
      if (backgroundTts.isAttachingTo(documentChapter.id)) {
        return;
      }
      backgroundTts.cancel();
      // Auto-advancing: native load() replaces the queue, and stopping here would
      // release audio focus and the service mid-handover.
      if (!autoStartTTSRef.current) {
        runTtsCommand('stop');
      }
    }
  }, [backgroundTts, documentChapter.id, runTtsCommand]);

  useEffect(() => {
    if (ttsError) {
      showToast(ttsError);
    }
  }, [ttsError]);

  useEffect(() => {
    const script = buildAdjacentChapterScript(nextChapter, prevChapter);
    // Kept for onLoadEnd: an update that lands before the document is ready is
    // dropped by the WebView, so it is replayed once the page has loaded.
    adjacentChapterScriptRef.current = script;
    webViewRef.current?.injectJavaScript(script);
  }, [nextChapter, prevChapter, webViewRef]);

  useEffect(() => {
    const mmkvListener = MMKVStorage.addOnValueChangedListener(key => {
      switch (key) {
        case CHAPTER_READER_SETTINGS: {
          // Update reader settings
          const newReaderSettings =
            getMMKVObject<ChapterReaderSettings>(CHAPTER_READER_SETTINGS) ||
            initialChapterReaderSettings;
          setReaderSettings(newReaderSettings);
          if (
            !areTTSSettingsEqual(
              readerSettingsRef.current.tts,
              newReaderSettings.tts,
            )
          ) {
            updateTtsSettings(toNativeTtsSettings(newReaderSettings.tts));
          }
          // Update WebView settings
          webViewRef.current?.injectJavaScript(
            `
            reader.readerSettings.val = ${JSON.stringify(newReaderSettings)}
            `,
          );
          break;
        }
        case CHAPTER_GENERAL_SETTINGS: {
          const newGeneralSettings =
            getMMKVObject<ChapterGeneralSettings>(CHAPTER_GENERAL_SETTINGS) ||
            initialChapterGeneralSettings;
          webViewRef.current?.injectJavaScript(
            `reader.generalSettings.val = ${JSON.stringify(
              newGeneralSettings,
            )}`,
          );
          break;
        }
      }
    });

    const subscription = deviceInfoEmitter.addListener(
      'RNDeviceInfo_batteryLevelDidChange',
      (level: number) => {
        lastKnownBatteryLevel = level;
        webViewRef.current?.injectJavaScript(
          `reader.batteryLevel.val = ${level}`,
        );
      },
    );

    getBatteryLevel().then(level => {
      lastKnownBatteryLevel = level;
      webViewRef.current?.injectJavaScript(
        `if (window.reader?.batteryLevel) {
          window.reader.batteryLevel.val = ${level};
        }`,
      );
    });

    return () => {
      subscription.remove();
      mmkvListener.remove();
    };
  }, [updateTtsSettings, webViewRef]);
  const isRTL = plugin?.lang === 'Arabic' || plugin?.lang === 'Hebrew';
  const readerDir = isRTL ? 'rtl' : 'ltr';

  /**
   * Serialising the whole chapter is expensive, so the document is built once
   * per chapter. Handing the WebView a different `source` also reloads the
   * page, so nothing that changes while a chapter is on screen may be part of
   * it – those updates go through `injectJavaScript` instead.
   */
  const source = useMemo(() => {
    // eslint-disable-next-line react-hooks/refs
    const isNextChapterScreenVisible = nextChapterScreenVisible.current;
    return {
      baseUrl: !documentChapter.isDownloaded ? plugin?.site : undefined,
      headers: plugin?.imageRequestInit?.headers,
      method: plugin?.imageRequestInit?.method,
      body: plugin?.imageRequestInit?.body,
      html: `
        <!DOCTYPE html>
          <html dir="${readerDir}">
            <head>
              <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0">
              <link rel="stylesheet" href="${assetsUriPrefix}/css/index.css">
              <link rel="stylesheet" href="${assetsUriPrefix}/css/pageReader.css">
              <link rel="stylesheet" href="${assetsUriPrefix}/css/toolWrapper.css">
              <link rel="stylesheet" href="${assetsUriPrefix}/css/tts.css">
              <style>
              :root {
                --StatusBar-currentHeight: ${StatusBar.currentHeight}px;
                --readerSettings-theme: ${initialReaderSettings.theme};
                --readerSettings-padding: ${initialReaderSettings.padding}px;
                --readerSettings-textSize: ${initialReaderSettings.textSize}px;
                --readerSettings-textColor: ${initialReaderSettings.textColor};
                --readerSettings-textAlign: ${initialReaderSettings.textAlign};
                --readerSettings-lineHeight: ${
                  initialReaderSettings.lineHeight
                };
                --readerSettings-fontFamily: ${
                  initialReaderSettings.fontFamily
                };
                --theme-primary: ${theme.primary};
                --theme-onPrimary: ${theme.onPrimary};
                --theme-secondary: ${theme.secondary};
                --theme-tertiary: ${theme.tertiary};
                --theme-onTertiary: ${theme.onTertiary};
                --theme-onSecondary: ${theme.onSecondary};
                --theme-surface: ${theme.surface};
                --theme-surface-0-9: ${color(theme.surface)
                  .alpha(0.9)
                  .toString()};
                --theme-onSurface: ${theme.onSurface};
                --theme-surfaceVariant: ${theme.surfaceVariant};
                --theme-onSurfaceVariant: ${theme.onSurfaceVariant};
                --theme-outline: ${theme.outline};
                --theme-outlineVariant: ${theme.outlineVariant};
                --theme-rippleColor: ${theme.rippleColor};
                }
                </style>
                <style id="ln-font">
                @font-face {
                  font-family: ${initialReaderSettings.fontFamily};
                  src: url("file:///android_asset/fonts/${
                    initialReaderSettings.fontFamily
                  }.ttf");
                }
				</style>
              <link rel="stylesheet" href="${pluginCustomCSS}">
              <style id="ln-custom-css">${customCSS}</style>
            </head>
            <body class="${
              chapterGeneralSettings.pageReader ? 'page-reader' : ''
            } ${
        chapterGeneralSettings.pageReaderDisableAnimation ? 'no-animation' : ''
      }">
              <div class="transition-chapter" style="transform: ${
                isNextChapterScreenVisible
                  ? 'translateX(-100%)'
                  : 'translateX(0%)'
              };
              ${chapterGeneralSettings.pageReader ? '' : 'display: none'}"
              ">${documentChapter.name}</div>
              <div id="LNReader-chapter">
                ${processedHtml}
              </div>
              <div id="reader-ui"></div>
              </body>
              <script>
                var initialPageReaderConfig = ${JSON.stringify({
                  nextChapterScreenVisible: isNextChapterScreenVisible,
                })};


                var initialReaderConfig = ${JSON.stringify({
                  readerSettings: initialReaderSettings,
                  chapterGeneralSettings,
                  novel,
                  chapter: documentChapter,
                  canAppendChapters: true,
                  batteryLevel,
                  autoSaveInterval: 2222,
                  DEBUG: __DEV__,
                  strings: {
                    finished: finishedString(documentChapter),
                    noNextChapter: getString('readerScreen.noNextChapter'),
                    loading: getString('common.loading'),
                    retry: getString('common.retry'),
                    removeText: getString('common.remove'),
                    replaceText: getString('customCodeSettings.replace'),
                  },
                })}
              </script>
              <script src="${assetsUriPrefix}/js/polyfill-onscrollend.js"></script>
              <script src="${assetsUriPrefix}/js/icons.js"></script>
              <script src="${assetsUriPrefix}/js/van.js"></script>
              <script src="${assetsUriPrefix}/js/text-vibe.js"></script>
              <script src="${assetsUriPrefix}/js/core.js"></script>
              <script src="${assetsUriPrefix}/js/search.js"></script>
              <script src="${assetsUriPrefix}/js/index.js"></script>
              <script src="${assetsUriPrefix}/js/textRemover.js"></script>
              <script src="${pluginCustomJS}"></script>
              <script id="ln-custom-js">
              function fn(){
                let html = document.querySelector('#LNReader-chapter').innerHTML;
                ${customJS}
                document.querySelector('#LNReader-chapter').innerHTML = html;
              }
              document.addEventListener('DOMContentLoaded', fn);
              function lnApplyCustomJS(html){
                ${customJS}
                return html;
              }
              </script>
          </html>
          `,
    };
  }, [
    batteryLevel,
    documentChapter,
    chapterGeneralSettings,
    processedHtml,
    customJS,
    customCSS,
    initialReaderSettings,
    novel,
    plugin,
    pluginCustomCSS,
    pluginCustomJS,
    readerDir,
    theme,
  ]);

  const sourceRef = useRef(source);
  useEffect(() => {
    if (sourceRef.current === source) {
      return;
    }
    sourceRef.current = source;
    pendingAppendsRef.current = new Set();
    // A rebuilt page (e.g. after a theme change) only holds the document
    // chapter, even if an appended chapter was being read.
    if (chapter.id !== documentChapter.id) {
      setActiveChapter(documentChapter.id);
    }
  }, [chapter.id, documentChapter.id, setActiveChapter, source]);

  const addAdjacentChapter = (
    chapterId: number,
    direction: 'NEXT' | 'PREV',
  ) => {
    const pending = pendingAppendsRef.current;
    const key = `${direction}:${chapterId}`;
    if (pending.has(key)) {
      return;
    }
    pending.add(key);
    const [add, fail, none] =
      direction === 'NEXT'
        ? ['appendChapter', 'appendFailed', 'appendEnd']
        : ['prependChapter', 'prependFailed', 'prependStart'];
    const requestSource = sourceRef.current;
    const inject = (script: string) => {
      if (sourceRef.current === requestSource) {
        webViewRef.current?.injectJavaScript(`${script}; true;`);
      }
    };
    loadChapterBeside(chapterId, direction)
      .then(result => {
        if (!result) {
          inject(`window.reader?.${none}?.(${chapterId})`);
          return;
        }
        const { removeText, replaceText } = readerSettingsRef.current;
        inject(
          `window.reader?.${add}?.(${JSON.stringify({
            chapter: result.chapter,
            html: applyTextModifications(
              result.html,
              removeText ?? [],
              replaceText ?? {},
            ),
            strings: { finished: finishedString(result.chapter) },
          })})`,
        );
      })
      .catch((e: Error) => {
        inject(
          `window.reader?.${fail}?.(${chapterId}, ${JSON.stringify(
            e?.message ?? '',
          )})`,
        );
      })
      .finally(() => pending.delete(key));
  };

  return (
    <>
      <WebView
        ref={webViewRef}
        onTouchStart={onTouchStart}
        style={{ backgroundColor: readerSettings.theme }}
        allowFileAccess={true}
        originWhitelist={['*']}
        scalesPageToFit={true}
        showsVerticalScrollIndicator={false}
        javaScriptEnabled={true}
        webviewDebuggingEnabled={__DEV__}
        onShouldStartLoadWithRequest={({ url }) => {
          if (isPluginIssueReportUrl(url)) {
            void Linking.openURL(url);
            return false;
          }
          if (isChapterRefreshUrl(url)) {
            refetch();
            return false;
          }
          return true;
        }}
        onLoadEnd={() => {
          webViewRef.current?.injectJavaScript(
            `if (window.reader && window.reader.batteryLevel) {
            window.reader.batteryLevel.val = ${lastKnownBatteryLevel};
          }`,
          );
          webViewRef.current?.injectJavaScript(
            adjacentChapterScriptRef.current,
          );

          const searchText = searchTextRef.current.trim();
          if (searchText) {
            webViewRef.current?.injectJavaScript(
              `window.readerSearch?.search(${JSON.stringify(
                searchText,
              )}); true;`,
            );
          }

          backgroundTts.onLoadEnd();
          if (autoStartTTSRef.current) {
            autoStartTTSRef.current = false;
            setTimeout(() => {
              webViewRef.current?.injectJavaScript(`
              if (window.tts && reader.generalSettings.val.TTSEnable) { tts.start(); }
              true;
            `);
            }, 800);
          }
        }}
        onMessage={(ev: { nativeEvent: { data: string } }) => {
          __DEV__ && onLogMessage(ev);
          const event: WebViewPostEvent = JSON.parse(ev.nativeEvent.data);
          switch (event.type) {
            case 'tts-queue': {
              const payload = event.data as
                | {
                    queue?: unknown;
                    startIndex?: unknown;
                    chapterName?: unknown;
                    chapterId?: unknown;
                  }
                | undefined;
              const queue = Array.isArray(payload?.queue)
                ? payload?.queue.filter(
                    (item): item is string =>
                      typeof item === 'string' && item.trim().length > 0,
                  )
                : [];
              const startIndex =
                typeof payload?.startIndex === 'number'
                  ? payload.startIndex
                  : 0;
              backgroundTts.setQueueChapter(
                typeof payload?.chapterId === 'number'
                  ? payload.chapterId
                  : chapter.id,
              );
              void loadAndPlay(
                queue,
                startIndex,
                {
                  novelName: novel?.name || 'Unknown',
                  chapterName:
                    typeof payload?.chapterName === 'string'
                      ? payload.chapterName
                      : chapter.name,
                  coverUri: novel?.cover || undefined,
                },
                toNativeTtsSettings(readerSettingsRef.current.tts),
              );
              break;
            }
            case 'tts-command': {
              if (!event.data || typeof event.data !== 'object') {
                break;
              }
              const data = event.data as {
                command?: unknown;
                index?: unknown;
              };
              switch (data.command) {
                case 'next':
                case 'pause':
                case 'play':
                case 'previous':
                case 'replay':
                case 'stop':
                  runTtsCommand(data.command);
                  break;
                case 'seekTo':
                  if (typeof data.index === 'number') {
                    seekTts(data.index);
                  }
                  break;
              }
              break;
            }
            case 'hide':
              onPress();
              break;
            case 'refresh':
              refetch();
              break;
            case 'next':
              nextChapterScreenVisible.current = true;
              if (event.autoStartTTS) {
                autoStartTTSRef.current = true;
              }
              navigateChapter('NEXT');
              break;
            case 'prev':
              if (event.autoStartTTS) {
                autoStartTTSRef.current = true;
              }
              navigateChapter('PREV');
              break;
            case 'save':
              // While TTS is ahead of the page, the page's position is stale.
              if (backgroundTts.isDetached()) {
                break;
              }
              if (event.data && typeof event.data === 'number') {
                saveProgress(event.data, event.chapterId);
              }
              break;
            case 'need-next':
              if (typeof event.data === 'number') {
                addAdjacentChapter(event.data, 'NEXT');
              }
              break;
            case 'need-prev':
              if (typeof event.data === 'number') {
                addAdjacentChapter(event.data, 'PREV');
              }
              break;
            case 'active-chapter':
              if (
                typeof event.data === 'number' &&
                !backgroundTts.isDetached()
              ) {
                setActiveChapter(event.data);
              }
              break;
            case 'text-action':
              eventTextAction(event);
              break;
            case 'search-result':
              if (event.data && typeof event.data === 'object') {
                const data = event.data as {
                  query?: unknown;
                  current?: unknown;
                  total?: unknown;
                  renderedTotal?: unknown;
                  isTruncated?: unknown;
                };
                const query = typeof data.query === 'string' ? data.query : '';
                if (query !== searchTextRef.current.trim()) {
                  break;
                }
                const total = typeof data.total === 'number' ? data.total : 0;
                onSearchResult({
                  query,
                  current: typeof data.current === 'number' ? data.current : 0,
                  total,
                  renderedTotal:
                    typeof data.renderedTotal === 'number'
                      ? data.renderedTotal
                      : total,
                  isTruncated: data.isTruncated === true,
                });
              }
              break;
            case 'interaction':
              onUserInteraction();
              break;
          }
        }}
        source={source}
      />
      <Dialog.Root
        visible={replaceModalVisible}
        onDismiss={() => setReplaceModalVisible(false)}
      >
        <Dialog.Header>
          <Dialog.Title>Replace Text</Dialog.Title>
        </Dialog.Header>
        <Dialog.Content>
          <TextInput
            label="Text to replace"
            value={selectedTextForReplace}
            editable={false}
            mode="outlined"
            style={styles.textInput}
            theme={{ colors: { background: theme.surface } }}
          />
          <TextInput
            label="Replace with"
            value={replacementText}
            onChangeText={setReplacementText}
            autoCorrect={false}
            mode="outlined"
            style={styles.textInput}
            theme={{ colors: { background: theme.surface } }}
          />
        </Dialog.Content>
        <Dialog.Actions>
          <Dialog.Action onPress={handleReplaceCancel}>Cancel</Dialog.Action>
          <Dialog.Action onPress={handleReplaceSave}>Save</Dialog.Action>
        </Dialog.Actions>
      </Dialog.Root>
    </>
  );
};

const styles = StyleSheet.create({
  textInput: { marginBottom: 16 },
});

export default memo(WebViewReader);
