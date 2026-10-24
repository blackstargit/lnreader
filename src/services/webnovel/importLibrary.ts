import { load } from 'cheerio';

import {
  addNovelToLibraryQuery,
  getAllNovels,
  getNovelById,
  insertNovelAndChapters,
} from '@database/queries/NovelQueries';
import {
  getNovelChapters,
  insertChapters,
  markChaptersRead,
} from '@database/queries/ChapterQueries';
import { insertHistory } from '@database/queries/HistoryQueries';
import type { NovelInfo } from '@database/types';
import { novelPersistence } from '@hooks/persisted/useNovel/store-helper/contracts';
import { getString } from '@i18n/translations';
import { getPlugin } from '@plugins/pluginManager';
import type {
  TaskProgressUpdater,
  WebnovelImportData,
  WebnovelLibraryEntry,
} from '@services/backgroundTasks/contracts';
import { fetchNovel } from '@services/plugin/fetch';
import { sleep } from '@utils/sleep';

export const WEBNOVEL_PLUGIN_ID = 'webnovel';
const COMIC_NTYPE = '100';
const BOOK_DELAY_MS = 1500;
const RETRY_DELAYS_MS = [5000, 20000, 60000];
const FETCH_TIMEOUT_MS = 60000;
const MAX_CONSECUTIVE_FAILURES = 5;
const PROGRESS_EVERY = 25;

/** Parses a saved webnovel.com library page (`.m-book` entries). */
export const parseWebnovelLibrary = (html: string): WebnovelImportData => {
  const $ = load(html);
  const novels: WebnovelLibraryEntry[] = [];
  const seen = new Set<string>();
  let comics = 0;

  $('.m-book').each((_, element) => {
    const book = $(element);
    const link = book.find('a[data-report-bid]').first();
    const bookId = link.attr('data-report-bid');
    if (!bookId || !/^\d+$/.test(bookId) || seen.has(bookId)) {
      return;
    }
    seen.add(bookId);
    if (book.find('input[data-ntype]').attr('data-ntype') === COMIC_NTYPE) {
      comics += 1;
      return;
    }
    const chapterId = link.attr('data-report-cid');
    const progress = /Progress\s+(\d+)\//.exec(book.find('strong').text());
    novels.push({
      bookId,
      name: link.attr('title') || book.find('h3').text().trim(),
      chapterId: chapterId && chapterId !== '0' ? chapterId : undefined,
      readCount: progress ? Number(progress[1]) : 0,
    });
  });

  return { novels, comics };
};

const bookIdOfNovelPath = (path: string) =>
  /(?:_|^\/book\/)(\d+)$/.exec(path)?.[1];

/** Indexes stored novels by bookId, preferring rows that are in the library. */
export const indexNovelsByBookId = (novels: NovelInfo[]) => {
  const byBookId = new Map<string, NovelInfo>();
  for (const novel of novels) {
    const bookId = bookIdOfNovelPath(novel.path);
    if (bookId && !byBookId.get(bookId)?.inLibrary) {
      byBookId.set(bookId, novel);
    }
  }
  return byBookId;
};

/**
 * Plugin search returns `/book/<slug>_<bookId>`; catalog chapter paths are
 * `/book/<slug>_<bookId>/<chapter>`, so their prefix is the same novel path.
 */
export const novelPathFromChapters = (
  bookId: string,
  chapterPaths: string[],
) => {
  const prefix = chapterPaths[0]?.split('/').slice(0, 3).join('/');
  return prefix?.endsWith(`_${bookId}`) ? prefix : `/book/${bookId}`;
};

/** Index of the chapter to continue from, or -1 when nothing was read. */
export const findLastReadIndex = (
  chapterPaths: string[],
  {
    chapterId,
    readCount,
  }: Pick<WebnovelLibraryEntry, 'chapterId' | 'readCount'>,
) => {
  if (!readCount || !chapterPaths.length) {
    return -1;
  }
  const byId = chapterId
    ? chapterPaths.findIndex(path => path.endsWith(`_${chapterId}`))
    : -1;
  return byId >= 0 ? byId : Math.min(readCount, chapterPaths.length) - 1;
};

const withTimeout = <T>(promise: Promise<T>, ms: number) => {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Request timed out')), ms);
    }),
  ]).finally(() => clearTimeout(timer));
};

const fetchWithRetry = async (bookId: string) => {
  for (let attempt = 0; ; attempt++) {
    try {
      const source = await withTimeout(
        fetchNovel(WEBNOVEL_PLUGIN_ID, `/book/${bookId}`),
        FETCH_TIMEOUT_MS,
      );
      // A blocked/captcha page parses as a novel without chapters.
      if (source.chapters?.length) {
        return { ...source, chapters: source.chapters };
      }
      throw new Error(`No chapters for book ${bookId}`);
    } catch (error) {
      if (attempt >= RETRY_DELAYS_MS.length) {
        throw error;
      }
      await sleep(RETRY_DELAYS_MS[attempt]);
    }
  }
};

const importBook = async (
  entry: WebnovelLibraryEntry,
  cached: NovelInfo | undefined,
) => {
  const source = await fetchWithRetry(entry.bookId);
  const path =
    cached?.path ??
    novelPathFromChapters(
      entry.bookId,
      source.chapters.map(chapter => chapter.path),
    );

  let novelId = cached?.id;
  if (novelId) {
    await insertChapters(novelId, source.chapters);
  } else {
    novelId = await insertNovelAndChapters(WEBNOVEL_PLUGIN_ID, {
      ...source,
      path,
    });
  }
  if (!novelId) {
    throw new Error(`Could not save ${entry.name}`);
  }

  // Progress goes in before the library flag so an interrupted run redoes it.
  const chapters = await getNovelChapters(
    novelId,
    undefined,
    undefined,
    undefined,
    Number.MAX_SAFE_INTEGER,
  );
  // A cached novel the user already read keeps its own progress.
  const hasProgress =
    cached !== undefined &&
    chapters.some(
      chapter =>
        chapter.unread === false ||
        !!chapter.readTime ||
        (chapter.progress ?? 0) > 0,
    );
  const lastRead = hasProgress
    ? -1
    : findLastReadIndex(
        chapters.map(chapter => chapter.path),
        entry,
      );
  if (lastRead >= 0) {
    await markChaptersRead(
      chapters.slice(0, lastRead).map(chapter => chapter.id),
    );
    await insertHistory(chapters[lastRead].id);
    novelPersistence.writeLastRead(
      { pluginId: WEBNOVEL_PLUGIN_ID, novelPath: path },
      chapters[lastRead],
    );
  }

  await addNovelToLibraryQuery(novelId);
};

export const importWebnovelLibrary = async (
  { novels, comics }: WebnovelImportData,
  setMeta: TaskProgressUpdater,
) => {
  if (!getPlugin(WEBNOVEL_PLUGIN_ID)) {
    throw new Error(getString('backupScreen.webnovelImport.pluginMissing'));
  }

  const existing = indexNovelsByBookId(
    (await getAllNovels()).filter(
      novel => novel.pluginId === WEBNOVEL_PLUGIN_ID,
    ),
  );
  let imported = 0;
  let inLibrary = 0;
  let failed = 0;
  let consecutiveFailures = 0;
  let stopped = false;

  for (const [index, entry] of novels.entries()) {
    // Outside the try: this is where pause/cancel interrupts the task.
    const report = () =>
      setMeta(meta => ({
        ...meta,
        isRunning: true,
        progress: index / novels.length,
        progressText: `${index + 1}/${novels.length}: ${entry.name}`,
      }));

    const cached = existing.get(entry.bookId);
    if (cached?.inLibrary) {
      inLibrary += 1;
      if (index % PROGRESS_EVERY === 0) {
        report();
        await sleep(0); // let the JS thread breathe while skipping
      }
      continue;
    }
    report();
    // The snapshot above may be stale after earlier (slow) books.
    if (cached && getNovelById(cached.id)?.inLibrary) {
      inLibrary += 1;
      continue;
    }
    try {
      await importBook(entry, cached);
      imported += 1;
      consecutiveFailures = 0;
    } catch {
      failed += 1;
      consecutiveFailures += 1;
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        stopped = true;
        break;
      }
    }
    await sleep(BOOK_DELAY_MS);
  }

  setMeta(meta => ({
    ...meta,
    isRunning: false,
    progress: 1,
    progressText: undefined,
    completionText:
      getString('backupScreen.webnovelImport.summary', {
        imported,
        existing: inLibrary,
        comics,
        failed,
      }) +
      (stopped
        ? ' ' +
          getString('backupScreen.webnovelImport.stopped', {
            count: MAX_CONSECUTIVE_FAILURES,
          })
        : ''),
  }));
};
