import { render, screen } from '@testing-library/react-native';
import type { ThemeColors } from '@theme/types';
import NovelStats, { parseNovelInfoItems } from '../NovelStats';

const theme = {
  primary: '#6750a4',
  onSurface: '#1c1b1f',
  onSurfaceVariant: '#49454f',
  outlineVariant: '#cac4d0',
} as ThemeColors;

const info = JSON.stringify([
  { label: 'Views', value: '82.2M' },
  { label: 'Power Stones', value: '1,606' },
]);

describe('NovelStats', () => {
  it('renders rating, count and info items', () => {
    render(
      <NovelStats
        theme={theme}
        rating={4.886}
        ratingCount={5272}
        info={info}
      />,
    );

    expect(screen.getByText('4.89')).toBeTruthy();
    expect(screen.getByText(`(${(5272).toLocaleString()})`)).toBeTruthy();
    expect(screen.getByText('Views')).toBeTruthy();
    expect(screen.getByText('82.2M')).toBeTruthy();
    expect(screen.getByText('Power Stones')).toBeTruthy();
    expect(screen.getByText('1,606')).toBeTruthy();
  });

  it('hides an unknown (0) rating but renders info', () => {
    render(<NovelStats theme={theme} rating={0} info={info} />);

    expect(screen.getByText('Views')).toBeTruthy();
    expect(screen.queryByText(/\d\.\d\d$/)).toBeNull();
  });

  it('renders nothing without rating and info', () => {
    render(<NovelStats theme={theme} rating={null} info={null} />);

    expect(screen.toJSON()).toBeNull();
  });

  it.each([
    ['malformed json', '{oops'],
    ['non-array', '{"label":"a","value":"b"}'],
    ['bad items', '[{"label":1,"value":"b"},null,{"label":"","value":"x"}]'],
  ])('ignores %s info', (_case, value) => {
    expect(parseNovelInfoItems(value)).toEqual([]);
  });
});
