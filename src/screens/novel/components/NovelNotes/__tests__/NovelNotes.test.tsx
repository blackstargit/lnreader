import { useState, type ReactNode } from 'react';
import { fireEvent, render, screen, waitFor } from '@test-utils';

import { updateNovelNotes } from '@database/queries/NovelQueries';
import type { NovelInfo } from '@database/types';
import type { ThemeColors } from '@theme/types';

import NovelNotes from '../NovelNotes';

jest.mock('@database/queries/NovelQueries', () => ({
  updateNovelNotes: jest.fn().mockResolvedValue(undefined),
  getNovelById: jest.fn(() => undefined),
}));

jest.mock('react-native-safe-area-context', () => {
  const ReactModule = require('react');
  const { View } = require('react-native');
  const frame = { height: 800, width: 400, x: 0, y: 0 };
  const insets = { bottom: 0, left: 0, right: 0, top: 0 };

  return {
    SafeAreaFrameContext: ReactModule.createContext(frame),
    SafeAreaInsetsContext: ReactModule.createContext(insets),
    SafeAreaProvider: ({ children }: { children: ReactNode }) => children,
    SafeAreaView: ({ children, ...props }: { children: ReactNode }) =>
      ReactModule.createElement(View, props, children),
    initialWindowMetrics: { frame, insets },
    useSafeAreaFrame: () => frame,
    useSafeAreaInsets: () => insets,
  };
});

jest.mock('@gorhom/bottom-sheet', () => ({
  BottomSheetModalProvider: ({ children }: { children: ReactNode }) => children,
}));

const mockSetNovel = jest.fn();
jest.mock('@screens/novel/NovelContext', () => ({
  NovelContextProvider: ({ children }: { children: ReactNode }) => children,
  useNovelAction: () => mockSetNovel,
}));

jest.mock('@components/AppErrorBoundary/AppErrorBoundary', () => ({
  __esModule: true,
  default: ({ children }: { children: ReactNode }) => children,
}));

jest.mock('@hooks/persisted/useTheme', () => ({
  ThemeProvider: ({ children }: { children: ReactNode }) => children,
  useTheme: () => mockTheme,
}));

jest.mock('@hooks/persisted', () => ({
  useTheme: () => mockTheme,
}));

const mockTheme = {
  error: '#ba1a1a',
  isDark: false,
  onPrimary: '#fff',
  onSurface: '#000',
  onSurfaceVariant: '#444',
  outline: '#888',
  primary: '#6750a4',
  rippleColor: 'rgba(0,0,0,0.1)',
  scrim: '#000',
  surface: '#fff',
  surfaceContainerHigh: '#eee',
  surfaceVariant: '#ddd',
};

const theme = {
  onSurface: '#000',
  onSurfaceVariant: '#444',
  outline: '#888',
} as ThemeColors;

const baseNovel = {
  id: 7,
  path: '/n',
  pluginId: 'p',
  name: 'N',
} as NovelInfo;

// Mirrors the store: setNovel feeds the new novel back in as a prop.
const Harness = ({ initial }: { initial: NovelInfo }) => {
  const [novel, setNovel] = useState(initial);
  mockSetNovel.mockImplementation(setNovel);
  return <NovelNotes novel={novel} theme={theme} />;
};

describe('NovelNotes', () => {
  beforeEach(() => jest.clearAllMocks());

  it('adds a note', async () => {
    render(<Harness initial={baseNovel} />);
    fireEvent.press(screen.getByText('Add note'));
    fireEvent.changeText(
      screen.getByPlaceholderText('Write a note...'),
      ' hi ',
    );
    fireEvent.press(screen.getByText('Save'));

    await waitFor(() => expect(updateNovelNotes).toHaveBeenCalledWith(7, 'hi'));
    expect(await screen.findByText('Notes')).toBeTruthy();
    expect(screen.getByText('hi')).toBeTruthy();
  });

  it('edits a note, and empty text deletes it', async () => {
    render(<Harness initial={{ ...baseNovel, notes: 'old' }} />);
    fireEvent.press(screen.getByLabelText('Edit note'));
    fireEvent.changeText(screen.getByPlaceholderText('Write a note...'), 'new');
    fireEvent.press(screen.getByText('Save'));
    await waitFor(() =>
      expect(updateNovelNotes).toHaveBeenCalledWith(7, 'new'),
    );
    expect(await screen.findByText('new')).toBeTruthy();

    fireEvent.press(screen.getByLabelText('Edit note'));
    fireEvent.changeText(screen.getByPlaceholderText('Write a note...'), '');
    fireEvent.press(screen.getByText('Save'));
    await waitFor(() =>
      expect(updateNovelNotes).toHaveBeenLastCalledWith(7, null),
    );
    expect(await screen.findByText('Add note')).toBeTruthy();
  });

  it('keeps the dialog open when saving fails', async () => {
    (updateNovelNotes as jest.Mock).mockRejectedValueOnce(new Error('boom'));
    render(<Harness initial={baseNovel} />);
    fireEvent.press(screen.getByText('Add note'));
    fireEvent.changeText(screen.getByPlaceholderText('Write a note...'), 'x');
    fireEvent.press(screen.getByText('Save'));

    await waitFor(() => expect(updateNovelNotes).toHaveBeenCalled());
    expect(screen.getByPlaceholderText('Write a note...')).toBeTruthy();
  });

  it('deletes after confirmation', async () => {
    render(<Harness initial={{ ...baseNovel, notes: 'bye' }} />);
    fireEvent.press(screen.getByLabelText('Delete note'));
    expect(screen.getByText('Delete this note?')).toBeTruthy();
    fireEvent.press(screen.getAllByText('Delete').slice(-1)[0]);

    await waitFor(() => expect(updateNovelNotes).toHaveBeenCalledWith(7, null));
    expect(await screen.findByText('Add note')).toBeTruthy();
  });
});
