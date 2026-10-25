import React, { useMemo } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { IconButton } from 'react-native-paper';
import color from 'color';
import Animated, {
  Easing,
  ReduceMotion,
  withTiming,
} from 'react-native-reanimated';
import { useChapterContext } from '../ChapterContext';
import { useTheme } from '@hooks/persisted';
import { useNovelLayout } from '@screens/novel/NovelContext';
import TtsDockedBar, { TTS_DOCKED_BAR_HEIGHT, TtsStatus } from './TtsDockedBar';

interface ChapterFooterProps {
  openReaderSheet: () => void;
  scrollToStart: () => void;
  openDrawer: () => void;
  /** Set in docked TTS mode: the TTS bar is drawn above the buttons. */
  ttsStatus?: TtsStatus;
}

const fastOutSlowIn = Easing.bezier(0.4, 0.0, 0.2, 1.0);

const createEntering = (navigationBarHeight: number) => () => {
  'worklet';
  const animations = {
    transform: [
      {
        translateY: withTiming(0, {
          duration: 250,
          easing: fastOutSlowIn,
          reduceMotion: ReduceMotion.System,
        }),
      },
    ],
    opacity: withTiming(1, { duration: 150 }),
  };
  const initialValues = {
    transform: [{ translateY: 64 + navigationBarHeight }],
    opacity: 0,
  };
  return { initialValues, animations };
};

const createExiting = (navigationBarHeight: number) => () => {
  'worklet';
  const animations = {
    transform: [
      {
        translateY: withTiming(64 + navigationBarHeight, {
          duration: 250,
          easing: fastOutSlowIn,
          reduceMotion: ReduceMotion.System,
        }),
      },
    ],
    opacity: withTiming(0, { duration: 150 }),
  };
  const initialValues = {
    transform: [{ translateY: 0 }],
    opacity: 1,
  };
  return { initialValues, animations };
};

const ChapterFooter = ({
  openReaderSheet,
  scrollToStart,
  openDrawer,
  ttsStatus,
}: ChapterFooterProps) => {
  const { nextChapter, prevChapter, navigateChapter, webViewRef } =
    useChapterContext();
  const theme = useTheme();
  const rippleConfig = {
    color: theme.rippleColor,
    borderless: true,
    radius: 50,
  };
  const { navigationBarHeight } = useNovelLayout();

  const style = useMemo(
    () => [
      {
        backgroundColor: color(theme.surface).alpha(0.9).string(),
        paddingBottom: navigationBarHeight,
      },
    ],
    [theme.surface, navigationBarHeight],
  );

  const offset = navigationBarHeight + (ttsStatus ? TTS_DOCKED_BAR_HEIGHT : 0);
  const entering = useMemo(() => createEntering(offset), [offset]);
  const exiting = useMemo(() => createExiting(offset), [offset]);

  return (
    <Animated.View
      entering={entering}
      exiting={exiting}
      // Lets TTS keep the paragraph it reads (or starts at) clear of the bar.
      onLayout={e =>
        webViewRef.current?.injectJavaScript(
          `window.tts?.setChromeInsets?.({ bottom: ${e.nativeEvent.layout.height} }); true;`,
        )
      }
      style={[styles.footer, style]}
    >
      {ttsStatus ? <TtsDockedBar {...ttsStatus} /> : null}
      <View style={styles.buttonsContainer}>
        <Pressable
          android_ripple={rippleConfig}
          style={styles.buttonStyles}
          onPress={() => navigateChapter('PREV')}
        >
          <IconButton
            icon="chevron-left"
            size={26}
            disabled={!prevChapter}
            iconColor={theme.onSurface}
          />
        </Pressable>
        <Pressable
          android_ripple={rippleConfig}
          style={styles.buttonStyles}
          onPress={() => scrollToStart()}
        >
          <IconButton
            icon="arrow-collapse-up"
            size={26}
            iconColor={theme.onSurface}
          />
        </Pressable>
        <Pressable
          android_ripple={rippleConfig}
          style={styles.buttonStyles}
          onPress={() => openDrawer()}
        >
          <IconButton
            icon="format-list-bulleted"
            size={26}
            iconColor={theme.onSurface}
          />
        </Pressable>
        <Pressable
          android_ripple={rippleConfig}
          style={styles.buttonStyles}
          onPress={openReaderSheet}
        >
          <IconButton
            icon="cog-outline"
            size={26}
            iconColor={theme.onSurface}
          />
        </Pressable>
        <Pressable
          android_ripple={rippleConfig}
          style={styles.buttonStyles}
          onPress={() => navigateChapter('NEXT')}
        >
          <IconButton
            icon="chevron-right"
            size={26}
            disabled={!nextChapter}
            iconColor={theme.onSurface}
          />
        </Pressable>
      </View>
    </Animated.View>
  );
};

export default React.memo(ChapterFooter);

const styles = StyleSheet.create({
  buttonStyles: {
    alignItems: 'center',
    flex: 1,
    justifyContent: 'center',
    paddingBottom: 4,
    paddingVertical: 8,
  },
  buttonsContainer: {
    flexDirection: 'row',
  },
  footer: {
    bottom: 0,
    flex: 1,
    position: 'absolute',
    width: '100%',
    zIndex: 1,
  },
});
