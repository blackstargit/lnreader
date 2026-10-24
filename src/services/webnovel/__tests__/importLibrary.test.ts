import { getAllNovels } from '@database/queries/NovelQueries';
import { fetchNovel } from '@services/plugin/fetch';
import type { NovelInfo } from '@database/types';

import {
  findLastReadIndex,
  importWebnovelLibrary,
  indexNovelsByBookId,
  novelPathFromChapters,
  parseWebnovelLibrary,
} from '../importLibrary';

jest.mock('@database/queries/NovelQueries', () => ({
  getAllNovels: jest.fn(),
}));
jest.mock('@utils/sleep', () => ({ sleep: jest.fn(() => Promise.resolve()) }));
jest.mock('@i18n/translations', () => ({
  getString: (key: string) => key,
}));
jest.mock('@database/queries/ChapterQueries', () => ({}));
jest.mock('@database/queries/HistoryQueries', () => ({}));
jest.mock('@plugins/pluginManager', () => ({ getPlugin: jest.fn(() => ({})) }));
jest.mock('@services/plugin/fetch', () => ({ fetchNovel: jest.fn() }));
jest.mock('@hooks/persisted/useNovel/store-helper/contracts', () => ({
  novelPersistence: {},
}));

const book = (
  bid: string,
  cid: string | undefined,
  ntype: string,
  progress: string,
) => `
<li class="g_col _2 pr mb32 ">
  <div class="m-book"> <a class="c_000 pr db" href="/book/${bid}/${cid}"
      title="Book &#39;${bid}" data-report-bid="${bid}"${
  cid === undefined ? '' : ` data-report-cid="${cid}"`
}>
      <i class="g_thumb mb8"><img data-original="//book-pic.webnovel.com/bookcover/${bid}"></i>
      <h3>Book ${bid}</h3></a>
    <label><input type="checkbox" class="hide" value="${bid}" data-ntype="${ntype}"></label>
    <strong class="db ell c_s lh24">Progress ${progress}</strong>
  </div></li>`;

const page = `<html><head><link rel="prefetch" href="/book/999"></head><body><ul>
${book('111', '5001', '0', '18/703')}
${book('222', '0', '0', '0/50')}
${book('333', '7001', '100', '0/80')}
${book('444', undefined, '0', '3/undefined')}
${book('111', '5001', '0', '18/703')}
</ul></body></html>`;

describe('parseWebnovelLibrary', () => {
  it('extracts novels, skips comics and duplicates', () => {
    expect(parseWebnovelLibrary(page)).toEqual({
      comics: 1,
      novels: [
        { bookId: '111', name: "Book '111", chapterId: '5001', readCount: 18 },
        {
          bookId: '222',
          name: "Book '222",
          chapterId: undefined,
          readCount: 0,
        },
        {
          bookId: '444',
          name: "Book '444",
          chapterId: undefined,
          readCount: 3,
        },
      ],
    });
  });
});

describe('findLastReadIndex', () => {
  const paths = [1, 2, 3, 4, 5].map(n => `/book/x_111/chapter-${n}_${n}00`);

  it('matches the last-read chapter id', () => {
    expect(findLastReadIndex(paths, { chapterId: '300', readCount: 1 })).toBe(
      2,
    );
  });

  it('falls back to the read count when the id is unknown', () => {
    expect(findLastReadIndex(paths, { chapterId: '999', readCount: 2 })).toBe(
      1,
    );
    expect(findLastReadIndex(paths, { readCount: 40 })).toBe(4);
  });

  it('returns -1 when nothing was read', () => {
    expect(findLastReadIndex(paths, { chapterId: '300', readCount: 0 })).toBe(
      -1,
    );
    expect(findLastReadIndex([], { readCount: 3 })).toBe(-1);
  });
});

describe('novelPathFromChapters', () => {
  it('uses the chapter path prefix, like plugin search results', () => {
    expect(
      novelPathFromChapters('111', ["/book/a-tale's-end_111/chapter-1_500"]),
    ).toBe("/book/a-tale's-end_111");
    expect(novelPathFromChapters('111', [])).toBe('/book/111');
  });
});

describe('indexNovelsByBookId', () => {
  it('prefers the library row when bookIds collide', () => {
    const cached = { id: 1, path: '/book/a_111', inLibrary: false };
    const library = { id: 2, path: '/book/b_111', inLibrary: true };
    const other = { id: 3, path: '/book/c_111', inLibrary: false };
    const index = (...novels: object[]) =>
      indexNovelsByBookId(novels as NovelInfo[]).get('111');

    expect(index(cached, library, other)).toBe(library);
    expect(index(library, cached)).toBe(library);
  });
});

describe('importWebnovelLibrary', () => {
  it('stops after 5 failures in a row and says so', async () => {
    (getAllNovels as jest.Mock).mockResolvedValue([]);
    (fetchNovel as jest.Mock).mockRejectedValue(new Error('blocked'));
    const novels = Array.from({ length: 8 }, (_, i) => ({
      bookId: String(i + 1),
      name: `Book ${i + 1}`,
      readCount: 0,
    }));
    let meta: any = {};
    await importWebnovelLibrary({ novels, comics: 0 }, update => {
      meta = update(meta);
    });

    // 4 attempts per book (1 + 3 retries), 5 books.
    expect(fetchNovel).toHaveBeenCalledTimes(20);
    expect(meta.completionText).toContain(
      'backupScreen.webnovelImport.stopped',
    );
  });
});
