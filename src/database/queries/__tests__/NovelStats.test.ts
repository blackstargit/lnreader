import './mockDb';
import { setupTestDatabase, getTestDb, teardownTestDatabase } from './setup';
import { insertTestNovel, clearAllTables } from './testData';
import { getNovelStatsValues } from '@database/utils/novelStats';
import { getNovelById } from '../NovelQueries';
import { fetchNovel } from '@services/plugin/fetch';
import type { SourceNovel } from '@plugins/types';
import { updateNovel } from '@services/updates/LibraryUpdateQueries';

jest.mock('@services/plugin/fetch', () => ({
  fetchNovel: jest.fn(),
  fetchPage: jest.fn(),
}));

jest.mock('@hooks/persisted/useSettings', () => ({
  getLibraryDefaultCategoryId: () => undefined,
}));

const mockedFetchNovel = jest.mocked(fetchNovel);

const base: SourceNovel = {
  id: undefined,
  path: '/novel',
  name: 'Novel',
  chapters: [],
};

const info = JSON.stringify([{ label: 'Views', value: '1' }]);

describe('getNovelStatsValues', () => {
  it('returns nothing when no stats are provided', () => {
    expect(getNovelStatsValues(base)).toEqual({});
  });

  it.each([0, -1, 5.1, NaN])('drops out-of-range rating %p', rating => {
    expect(getNovelStatsValues({ ...base, rating })).toEqual({});
  });

  it('sanitizes, coerces and caps info', () => {
    const values = getNovelStatsValues({
      ...base,
      rating: 4.5,
      ratingCount: '5' as unknown as number,
      info: [
        { label: 'Chapters', value: 1432 as unknown as string },
        { label: 2 } as unknown as { label: string; value: string },
        { label: 'x'.repeat(150), value: 'y' },
        ...Array.from({ length: 30 }, (_, i) => ({
          label: `L${i}`,
          value: 'v',
        })),
      ],
    });

    expect(values.rating).toBe(4.5);
    expect(values.ratingCount).toBeUndefined();
    const items = JSON.parse(values.info!);
    expect(items).toHaveLength(20);
    expect(items[0]).toEqual({ label: 'Chapters', value: '1432' });
    expect(items[1].label).toHaveLength(100);
  });
});

describe('updateNovel stats', () => {
  beforeEach(() => {
    clearAllTables(setupTestDatabase());
    mockedFetchNovel.mockReset();
  });

  afterAll(() => {
    teardownTestDatabase();
  });

  const insertNovel = () =>
    insertTestNovel(getTestDb(), {
      path: '/novel',
      totalPages: 3,
      rating: 4,
      ratingCount: 10,
      info,
    });

  it('keeps stored values when the plugin sends no stats', async () => {
    const novelId = await insertNovel();
    mockedFetchNovel.mockResolvedValue(base);

    await updateNovel('test-plugin', '/novel', novelId, {
      refreshNovelMetadata: false,
    });

    const novel = getNovelById(novelId);
    expect(novel).toMatchObject({
      totalPages: 3,
      rating: 4,
      ratingCount: 10,
      info,
    });
  });

  it('updates provided stats without metadata refresh', async () => {
    const novelId = await insertNovel();
    mockedFetchNovel.mockResolvedValue({
      ...base,
      rating: 0,
      ratingCount: 20,
    });

    await updateNovel('test-plugin', '/novel', novelId, {
      refreshNovelMetadata: false,
    });

    const novel = getNovelById(novelId);
    expect(novel).toMatchObject({
      totalPages: 3,
      rating: 4,
      ratingCount: 20,
      info,
    });
  });
});
