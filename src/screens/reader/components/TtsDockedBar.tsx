import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { ActivityIndicator, IconButton } from 'react-native-paper';
import type { TtsPlaybackState, TtsProgress } from '@modules/nitro-tts';
import { useTheme } from '@hooks/persisted';
import { getString } from '@i18n/translations';
import { useChapterContext } from '../ChapterContext';

export type TtsStatus = { state: TtsPlaybackState; progress: TtsProgress };

export const TTS_DOCKED_BAR_HEIGHT = 48;

type TtsBarAction = 'toggle' | 'previous' | 'next' | 'stop';

const postNative = (command: string) =>
  `reader.post({ type: 'tts-command', data: { command: '${command}' } })`;

/**
 * Commands go through the page's `tts` so its state (started, highlight,
 * index map after a background attach) stays the one source of truth. The
 * page can have lost the queue native still plays (it was reloaded, or a
 * background attach hasn't landed yet); then native is commanded directly
 * instead of starting over.
 */
export const ttsBarScript = (
  action: TtsBarAction,
  state: TtsPlaybackState,
): string => {
  const active = state === 'playing' || state === 'paused';
  const pageOrNative = (pageCall: string, command: string) =>
    active
      ? `if (tts.started) ${pageCall}; else ${postNative(command)};`
      : `${pageCall};`;
  switch (action) {
    case 'toggle':
      if (state === 'playing') return pageOrNative('tts.pause()', 'pause');
      if (state === 'paused') return pageOrNative('tts.resume()', 'play');
      // Still started after 'completed': the page is advancing to the next chapter.
      if (state === 'completed') {
        return 'if (!tts.started) tts.startFromVisible();';
      }
      return `if (tts.reading) tts.pause();
        else if (tts.started) tts.resume();
        else tts.startFromVisible();`;
    case 'previous':
      return pageOrNative('tts.previous()', 'previous');
    case 'next':
      return pageOrNative('tts.next()', 'next');
    case 'stop':
      return 'tts.stop();';
  }
};

const TtsDockedBar = ({ state, progress }: TtsStatus) => {
  const { webViewRef } = useChapterContext();
  const theme = useTheme();

  const run = (action: TtsBarAction) =>
    webViewRef.current?.injectJavaScript(
      `if (window.tts && reader.generalSettings.val.TTSEnable) { ${ttsBarScript(
        action,
        state,
      )} } true;`,
    );

  const showProgress =
    (state === 'playing' || state === 'paused' || state === 'loading') &&
    progress.total > 0;

  return (
    <View style={styles.bar}>
      <IconButton
        icon="skip-previous"
        size={24}
        iconColor={theme.onSurface}
        style={styles.button}
        accessibilityLabel={getString('readerScreen.ttsControls.previous')}
        onPress={() => run('previous')}
      />
      {state === 'loading' ? (
        <View style={styles.loading}>
          <ActivityIndicator size={24} color={theme.onSurface} />
        </View>
      ) : (
        <IconButton
          icon={state === 'playing' ? 'pause' : 'play'}
          size={28}
          iconColor={theme.onSurface}
          style={styles.button}
          accessibilityLabel={getString(
            state === 'playing'
              ? 'readerScreen.ttsControls.pause'
              : 'readerScreen.ttsControls.play',
          )}
          onPress={() => run('toggle')}
        />
      )}
      <IconButton
        icon="skip-next"
        size={24}
        iconColor={theme.onSurface}
        style={styles.button}
        accessibilityLabel={getString('readerScreen.ttsControls.next')}
        onPress={() => run('next')}
      />
      <IconButton
        icon="stop"
        size={24}
        iconColor={theme.onSurface}
        style={styles.button}
        accessibilityLabel={getString('readerScreen.ttsControls.stop')}
        onPress={() => run('stop')}
      />
      <Text style={[styles.progress, { color: theme.onSurfaceVariant }]}>
        {showProgress ? `${progress.index + 1} / ${progress.total}` : ''}
      </Text>
    </View>
  );
};

export default React.memo(TtsDockedBar);

const styles = StyleSheet.create({
  bar: {
    alignItems: 'center',
    flexDirection: 'row',
    height: TTS_DOCKED_BAR_HEIGHT,
    justifyContent: 'center',
  },
  button: {
    marginHorizontal: 4,
    marginVertical: 0,
  },
  loading: {
    alignItems: 'center',
    height: 44,
    justifyContent: 'center',
    marginHorizontal: 4,
    width: 44,
  },
  progress: {
    fontSize: 12,
    minWidth: 64,
    textAlign: 'center',
  },
});
