import { fireEvent, render, screen } from '@testing-library/react-native';
import TtsDockedBar, { ttsBarScript } from '../TtsDockedBar';

const mockInject = jest.fn();

jest.mock('@hooks/persisted', () => ({
  useTheme: () => ({ onSurface: '#000', onSurfaceVariant: '#333' }),
}));

jest.mock('../../ChapterContext', () => ({
  useChapterContext: () => ({
    webViewRef: { current: { injectJavaScript: mockInject } },
  }),
}));

const progress = { index: 4, total: 20, paragraphId: '4' };

const injected = () => mockInject.mock.calls.at(-1)?.[0] as string;

/** Runs a bar script against a fake page and reports what it did. */
const runOnPage = (script: string, page: { started: boolean }) => {
  const calls: string[] = [];
  const tts = new Proxy(
    { ...page, reading: false },
    {
      get: (target, key: string) =>
        key in target
          ? target[key as keyof typeof target]
          : () => calls.push(`tts.${key}`),
    },
  );
  const reader = {
    post: (msg: { data: { command: string } }) =>
      calls.push(`native.${msg.data.command}`),
  };
  new Function('tts', 'reader', script)(tts, reader);
  return calls;
};

describe('TtsDockedBar', () => {
  beforeEach(() => mockInject.mockClear());

  it('starts from the visible paragraph through the page when not reading', () => {
    render(<TtsDockedBar state="idle" progress={progress} />);

    fireEvent.press(screen.getByLabelText('Play text-to-speech'));

    expect(injected()).toContain(ttsBarScript('toggle', 'idle'));
    expect(injected()).toContain('reader.generalSettings.val.TTSEnable');
    expect(
      runOnPage(ttsBarScript('toggle', 'idle'), { started: false }),
    ).toEqual(['tts.startFromVisible']);
    // No stale progress for a queue that isn't playing.
    expect(screen.queryByText('5 / 20')).toBeNull();
  });

  it('shows pause and progress while playing', () => {
    render(<TtsDockedBar state="playing" progress={progress} />);

    expect(screen.getByText('5 / 20')).toBeTruthy();
    fireEvent.press(screen.getByLabelText('Pause text-to-speech'));
    expect(injected()).toContain(ttsBarScript('toggle', 'playing'));
  });

  it.each([
    ['Previous paragraph', 'previous'],
    ['Next paragraph', 'next'],
    ['Stop text-to-speech', 'stop'],
  ] as const)('%s runs the page command', (label, action) => {
    render(<TtsDockedBar state="paused" progress={progress} />);

    fireEvent.press(screen.getByLabelText(label));

    expect(injected()).toContain(ttsBarScript(action, 'paused'));
    expect(
      runOnPage(ttsBarScript(action, 'paused'), { started: true }),
    ).toEqual([`tts.${action}`]);
  });

  it('commands native when the page lost the queue native still plays', () => {
    const page = { started: false };
    expect(runOnPage(ttsBarScript('toggle', 'playing'), page)).toEqual([
      'native.pause',
    ]);
    expect(runOnPage(ttsBarScript('toggle', 'paused'), page)).toEqual([
      'native.play',
    ]);
    expect(runOnPage(ttsBarScript('next', 'playing'), page)).toEqual([
      'native.next',
    ]);
    expect(runOnPage(ttsBarScript('previous', 'paused'), page)).toEqual([
      'native.previous',
    ]);
  });

  it('ignores play while the page advances after completion', () => {
    const script = ttsBarScript('toggle', 'completed');
    expect(runOnPage(script, { started: true })).toEqual([]);
    expect(runOnPage(script, { started: false })).toEqual([
      'tts.startFromVisible',
    ]);
  });

  it.each(['completed', 'error'] as const)('hides progress when %s', state => {
    render(<TtsDockedBar state={state} progress={progress} />);
    expect(screen.queryByText('5 / 20')).toBeNull();
  });

  it('replaces play with a spinner while loading', () => {
    render(<TtsDockedBar state="loading" progress={progress} />);

    expect(screen.queryByLabelText('Play text-to-speech')).toBeNull();
    expect(screen.queryByLabelText('Pause text-to-speech')).toBeNull();
  });
});
