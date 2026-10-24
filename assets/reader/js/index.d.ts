import { ChapterInfo, NovelInfo } from '@database/types';
import {
  ChapterGeneralSettings,
  ChapterReaderSettings,
} from '@hooks/persisted/useSettings';
import { State } from './van';

export interface Reader {
  // element
  chapterElement: HTMLElement;
  viewport: HTMLMetaElement;
  selection: Selection;

  // state
  hidden: State<boolean>;
  generalSettings: State<ChapterGeneralSettings>;
  readerSettings: State<ChapterReaderSettings>;
  batteryLevel: State<number>;
  /** Bumped whenever the app pushes newly resolved adjacent chapters. */
  adjacentVersion: State<number>;
  /** Continuous mode: loading state of the chapter after the last one. */
  appendState: State<{
    status: 'idle' | 'loading' | 'failed' | 'end';
    afterId?: number;
    message?: string;
  }>;
  /** Continuous mode: loading state of the chapter before the first one. */
  prependState: State<{
    status: 'idle' | 'loading' | 'failed' | 'start';
    beforeId?: number;
    message?: string;
  }>;

  novel: NovelInfo;
  chapter: ChapterInfo;
  nextChapter?: ChapterInfo;
  prevChapter?: ChapterInfo;
  autoSaveInterval: number;
  rawHTML: string;
  strings: {
    finished: string;
    nextChapter: string;
    noNextChapter: string;
    removeText: string;
    replaceText: string;
    loading: string;
    retry: string;
  };

  setAdjacentChapters: (adjacent: {
    nextChapter?: ChapterInfo;
    prevChapter?: ChapterInfo;
    strings?: Partial<Reader['strings']>;
  }) => void;

  //layout props
  paddingTop: number;
  layoutHeight: number;
  layoutWidth: number;
  chapterTop: number;
  chapterHeight: number;
  chapterWidth: number;

  post: (obj: Record<string, any>) => void;
  refresh: () => void;

  isContinuous: () => boolean;
  chapterContainers: () => HTMLElement[];
  applyTextOptions: (el: HTMLElement) => boolean;
  updateActiveChapter: () => void;
  appendChapter: (payload: {
    chapter: ChapterInfo;
    html: string;
    strings?: Partial<Reader['strings']>;
  }) => void;
  appendFailed: (afterId: number, message: string) => void;
  appendEnd: (afterId: number) => void;
  retryAppend: () => void;
  prependChapter: (payload: { chapter: ChapterInfo; html: string }) => void;
  prependFailed: (beforeId: number, message: string) => void;
  prependStart: (beforeId: number) => void;
  retryPrepend: () => void;
  pullToPrepend: () => boolean;
  continueTTS: (root?: HTMLElement) => boolean;
}

interface PageReader {
  page: State<number>;
  totalPages: State<number>;
  movePage: (page: number) => void;
}

interface TTS {
  started: boolean;
  reading: boolean;
  root?: HTMLElement;
  start: (element?: HTMLElement, container?: HTMLElement) => void;
  resume: () => void;
  stop: () => void;
  pause: () => void;
  readable: (element?: HTMLElement) => void;
}

declare global {
  const reader: Reader;
  const tts: TTS;
  const pageReader: PageReader;
}
