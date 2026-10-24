window.onUserInteraction = (() => {
  let groupStart = 0;
  // Group multiple interactions within a short time frame to avoid excessive calls
  const groupTime = 3000;
  return () => {
    let now = Date.now();
    if (now - groupStart < groupTime) {
      // We're inside the group
    } else {
      // We're the first in a while
      groupStart = now;
      reader.post({ type: 'interaction' });
    }
  };
})();

/* eslint-disable no-console */
window.reader = new (function () {
  const {
    readerSettings,
    chapterGeneralSettings,
    novel,
    chapter,
    canAppendChapters,
    batteryLevel,
    autoSaveInterval,
    DEBUG,
    strings,
  } = initialReaderConfig;

  // state
  this.hidden = van.state(true);
  this.batteryLevel = van.state(batteryLevel);
  this.readerSettings = van.state(readerSettings);
  this.generalSettings = van.state(chapterGeneralSettings);
  /**
   * Bumped whenever the app pushes new adjacent chapters. The chapter is
   * rendered before its neighbours are known, so any UI that depends on them
   * has to read this state to re-render when they arrive.
   */
  this.adjacentVersion = van.state(0);

  this.chapterElement = document.querySelector('#LNReader-chapter');
  this.chapterElement.lnChapter = chapter;
  this.selection = window.getSelection();
  this.viewport = document.querySelector('meta[name=viewport]');

  this.novel = novel;
  this.chapter = chapter;
  this.nextChapter = undefined;
  this.prevChapter = undefined;
  this.strings = strings;

  /** Called by the app once the neighbouring chapters have been resolved. */
  this.setAdjacentChapters = ({ nextChapter, prevChapter, strings: texts }) => {
    this.nextChapter = nextChapter ?? undefined;
    this.prevChapter = prevChapter ?? undefined;
    Object.assign(this.strings, texts);
    this.adjacentVersion.val++;
  };
  this.autoSaveInterval = autoSaveInterval;
  // In continuous mode every chapter container keeps its own untransformed
  // markup; `rawHTML` stays the active chapter's so existing code keeps working.
  Object.defineProperty(this, 'rawHTML', {
    get: () => this.chapterElement.lnRawHTML,
    set: html => {
      this.chapterElement.lnRawHTML = html;
    },
  });
  this.rawHTML = this.chapterElement.innerHTML;

  /** Chapters appended below the first one are only loaded in scroll mode. */
  this.isContinuous = () =>
    canAppendChapters === true &&
    this.generalSettings.val.continuousChapters === true &&
    !this.generalSettings.val.pageReader;
  /** Chapter containers in document order: the first chapter, then appended ones. */
  this.chapterContainers = () =>
    [...document.querySelectorAll('#LNReader-chapter, .ln-chapter')].filter(
      el => !el.hidden,
    );

  //layout props
  this.paddingTop = parseInt(
    getComputedStyle(document.querySelector('body')).getPropertyValue(
      'padding-top',
    ),
    10,
  );
  this.chapterHeight = this.chapterElement.scrollHeight + this.paddingTop;
  /** Document offset of the active chapter; progress is relative to it. */
  this.chapterTop = 0;
  this.layoutHeight = window.innerHeight;
  this.layoutWidth = window.innerWidth;

  this.layoutEvent = undefined;
  this.chapterEndingVisible = van.state(false);

  this.post = obj => window.ReactNativeWebView.postMessage(JSON.stringify(obj));
  this.refresh = () => {
    this.layoutHeight = window.innerHeight;
    this.layoutWidth = window.innerWidth;
    this.paddingTop =
      parseFloat(
        getComputedStyle(document.body).getPropertyValue('padding-top'),
      ) || 0;
    if (this.generalSettings.val.pageReader) {
      this.chapterWidth = this.chapterElement.scrollWidth;
    } else if (
      this.chapterElement.id === 'LNReader-chapter' &&
      this.chapterElement ===
        document.querySelector('#LNReader-chapter, .ln-chapter')
    ) {
      this.chapterTop = 0;
      this.chapterHeight = this.chapterElement.scrollHeight + this.paddingTop;
    } else {
      this.chapterTop =
        this.chapterElement.getBoundingClientRect().top + window.scrollY;
      this.chapterHeight = this.chapterElement.scrollHeight;
    }
  };

  let loadedFontFamily = readerSettings.fontFamily || '';
  van.derive(() => {
    const settings = this.readerSettings.val;
    document.documentElement.style.setProperty(
      '--readerSettings-theme',
      settings.theme,
    );
    document.documentElement.style.setProperty(
      '--readerSettings-padding',
      settings.padding + 'px',
    );
    document.documentElement.style.setProperty(
      '--readerSettings-textSize',
      settings.textSize + 'px',
    );
    document.documentElement.style.setProperty(
      '--readerSettings-textColor',
      settings.textColor,
    );
    document.documentElement.style.setProperty(
      '--readerSettings-textAlign',
      settings.textAlign,
    );
    document.documentElement.style.setProperty(
      '--readerSettings-lineHeight',
      settings.lineHeight,
    );
    document.documentElement.style.setProperty(
      '--readerSettings-fontFamily',
      settings.fontFamily,
    );
    if (settings.fontFamily && settings.fontFamily !== loadedFontFamily) {
      loadedFontFamily = settings.fontFamily;
      new FontFace(
        settings.fontFamily,
        'url("file:///android_asset/fonts/' + settings.fontFamily + '.ttf")',
      )
        .load()
        .then(function (loadedFont) {
          document.fonts.add(loadedFont);
          schedulePageCalculation();
        });
    } else if (!settings.fontFamily && loadedFontFamily) {
      loadedFontFamily = '';
      // have no affect with a font declared in head
      document.fonts.forEach(fontFace => document.fonts.delete(fontFace));
    }
    schedulePageCalculation();
  });

  document.onscrollend = () => {
    onUserInteraction();
    if (!this.generalSettings.val.pageReader) {
      this.updateActiveChapter?.();
      this.post({
        type: 'save',
        data: parseInt(
          ((window.scrollY + this.layoutHeight - this.chapterTop) /
            this.chapterHeight) *
            100,
          10,
        ),
        chapterId: this.chapter.id,
      });
    }
  };

  document.onpointerdown = () => onUserInteraction();
  document.onpointermove = () => onUserInteraction();
  document.onpointerup = () => onUserInteraction();

  if (DEBUG) {
    // eslint-disable-next-line no-global-assign, no-new-object
    console = new Object();
    console.log = function (...data) {
      reader.post({ 'type': 'console', 'msg': data?.join(' ') });
    };
    console.debug = console.log;
    console.info = console.log;
    console.warn = console.log;
    console.error = console.log;
  }
  // end reader
})();

window.tts = new (function () {
  this.readableNodeNames = [
    '#text',
    'B',
    'I',
    'SPAN',
    'EM',
    'BR',
    'STRONG',
    'A',
    'MARK',
  ];
  this.prevElement = null;
  this.currentElement = reader.chapterElement;
  this.started = false;
  this.reading = false;
  this.elementsRead = 0;
  this.totalElements = 0;
  this.allReadableElements = []; // Store all readable elements at start
  this.textQueue = []; // Flat list of normalized text for native fallback

  this.readable = element => {
    const ele = element ?? this.currentElement;
    if (
      ele.nodeName !== 'SPAN' &&
      this.readableNodeNames.includes(ele.nodeName)
    ) {
      return false;
    }
    if (!ele.hasChildNodes()) {
      return false;
    }
    for (let i = 0; i < ele.childNodes.length; i++) {
      if (!this.readableNodeNames.includes(ele.childNodes.item(i).nodeName)) {
        return false;
      }
    }
    return true;
  };

  this.normalizeText = text => {
    if (!text) return '';
    const normalized = text
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/^["'“”‘’]+|["'“”‘’]+$/g, '')
      .replace(/\s*([.,!?;:])\s*/g, '$1 ')
      .trim();

    const dashOnlyText = normalized.replace(/\s/g, '');
    if (
      dashOnlyText.length >= 3 &&
      /^[\-‐‑‒–—―−⁓⸺⸻﹘﹣－]+$/u.test(dashOnlyText)
    ) {
      return '';
    }

    return normalized;
  };

  // if can find a readable node, else stop tts
  // FIXED: Added proper boundary checks to prevent stack overflow
  this.findNextTextNode = (depth = 0) => {
    // Prevent deep recursion
    if (depth > 500) {
      console.warn('TTS: findNextTextNode max depth reached');
      return false;
    }

    if (this.currentElement.isSameNode(reader.chapterElement) && this.started) {
      return false;
    } else {
      this.started = true;
    }

    // Safety check: ensure currentElement is valid
    if (!this.currentElement || !this.currentElement.nodeName) {
      return false;
    }

    // is read, have to go next or go back
    if (this.currentElement.isSameNode(this.prevElement)) {
      this.prevElement = this.currentElement;
      if (this.currentElement.nextElementSibling) {
        this.currentElement = this.currentElement.nextElementSibling;
        return this.findNextTextNode(depth + 1);
      } else if (
        this.currentElement.parentElement &&
        !this.currentElement.parentElement.isSameNode(document.body) &&
        !this.currentElement.parentElement.isSameNode(document.documentElement)
      ) {
        this.currentElement = this.currentElement.parentElement;
        return this.findNextTextNode(depth + 1);
      } else {
        return false;
      }
    } else {
      // can read? read it
      if (this.readable()) {
        return true;
      }
      if (
        !this.prevElement?.parentElement?.isSameNode(this.currentElement) &&
        this.currentElement.firstElementChild
      ) {
        // go deep
        this.prevElement = this.currentElement;
        this.currentElement = this.currentElement.firstElementChild;
        return this.findNextTextNode(depth + 1);
      } else if (this.currentElement.nextElementSibling) {
        this.prevElement = this.currentElement;
        this.currentElement = this.currentElement.nextElementSibling;
        return this.findNextTextNode(depth + 1);
      } else if (
        this.currentElement.parentElement &&
        !this.currentElement.parentElement.isSameNode(document.body) &&
        !this.currentElement.parentElement.isSameNode(document.documentElement)
      ) {
        this.prevElement = this.currentElement;
        this.currentElement = this.currentElement.parentElement;
        return this.findNextTextNode(depth + 1);
      } else {
        return false;
      }
    }
  };

  this.next = () => {
    if (!this.started) return;
    reader.post({ type: 'tts-command', data: { command: 'next' } });
  };

  this.previous = () => {
    if (!this.started) return;
    reader.post({ type: 'tts-command', data: { command: 'previous' } });
  };

  this.start = (element, container) => {
    const root =
      container ??
      element?.closest?.('#LNReader-chapter, .ln-chapter') ??
      reader.chapterElement;
    const startElement = element ?? root;
    this.root = root;

    const readableEntries = this.getAllReadableElements(root)
      .map(readableElement => ({
        element: readableElement,
        text: this.normalizeText(readableElement.innerText),
      }))
      .filter(entry => !!entry.text);
    this.allReadableElements = readableEntries.map(entry => entry.element);
    this.totalElements = this.allReadableElements.length;
    this.textQueue = readableEntries.map(entry => entry.text);

    const requestedIndex =
      element && element !== root
        ? this.allReadableElements.indexOf(startElement)
        : 0;
    const startIndex = requestedIndex >= 0 ? requestedIndex : 0;

    this.started = this.totalElements > 0;
    this.reading = this.started;
    this.setActiveIndex(startIndex);
    reader.post({
      type: 'tts-queue',
      data: {
        queue: this.textQueue,
        startIndex,
        chapterName: root.lnChapter?.name,
      },
    });
  };

  // Get all readable elements in order
  this.getAllReadableElements = element => {
    const elements = [];
    const traverse = el => {
      if (!el) return;
      if (this.readable(el)) {
        elements.push(el);
        // innerText already includes readable descendants, so descending any
        // further would add overlapping text to the speech queue.
        return;
      }
      for (let i = 0; i < el.children.length; i++) {
        traverse(el.children[i]);
      }
    };
    traverse(element);
    return elements;
  };

  this.resume = () => {
    if (!this.started) return;
    reader.post({ type: 'tts-command', data: { command: 'play' } });
  };

  this.pause = () => {
    if (!this.started) return;
    reader.post({ type: 'tts-command', data: { command: 'pause' } });
  };

  this.rewind = () => {
    if (!this.started) return;
    reader.post({ type: 'tts-command', data: { command: 'replay' } });
  };

  this.seekTo = index => {
    if (!this.started || !this.allReadableElements.length) return;
    const targetIndex = Math.max(0, Math.min(index, this.totalElements - 1));
    reader.post({
      type: 'tts-command',
      data: { command: 'seekTo', index: targetIndex },
    });
  };

  this.stop = () => {
    reader.post({ type: 'tts-command', data: { command: 'stop' } });
    this.reset();
  };

  this.reset = () => {
    this.currentElement?.classList?.remove('highlight');
    this.prevElement = null;
    this.currentElement = reader.chapterElement;
    this.started = false;
    this.reading = false;
    this.elementsRead = 0;
    this.totalElements = 0;
    this.allReadableElements = [];
    this.textQueue = [];
    const playPauseButton = document.getElementById('TTS-PlayPause');
    if (playPauseButton) playPauseButton.innerHTML = resumeIcon;
    const progress = document.getElementById('TTS-Progress');
    if (progress) progress.textContent = '';
  };

  this.setActiveIndex = index => {
    if (!this.allReadableElements.length) return;
    const targetIndex = Math.max(0, Math.min(index, this.totalElements - 1));
    this.currentElement?.classList?.remove('highlight');
    this.currentElement = this.allReadableElements[targetIndex];
    this.elementsRead = targetIndex + 1;
    this.started = true;
    this.scrollToElement(this.currentElement);
    this.currentElement.classList.add('highlight');
    const progress = document.getElementById('TTS-Progress');
    if (progress) {
      progress.textContent = `${targetIndex + 1}/${this.totalElements}`;
    }
  };

  this.setPlaybackState = state => {
    this.reading = state === 'playing';
    if (state === 'error') {
      this.reset();
      return;
    }
    const playPauseButton = document.getElementById('TTS-PlayPause');
    if (playPauseButton) {
      playPauseButton.innerHTML = this.reading ? pauseIcon : resumeIcon;
    }
  };

  this.complete = () => {
    this.reading = false;
    if (reader.readerSettings.val.tts?.autoPageAdvance === true) {
      if (reader.isContinuous()) {
        if (reader.continueTTS(this.root)) {
          return;
        }
      } else if (reader.nextChapter) {
        reader.post({ type: 'next', autoStartTTS: true });
        return;
      }
    }
    this.reset();
  };

  this.isElementInViewport = element => {
    if (!element) return false;
    const rect = element.getBoundingClientRect();
    const windowHeight =
      window.innerHeight || document.documentElement.clientHeight;
    const windowWidth =
      window.innerWidth || document.documentElement.clientWidth;

    return (
      rect.top >= 0 &&
      rect.left >= 0 &&
      rect.bottom <= windowHeight &&
      rect.right <= windowWidth
    );
  };

  // UPDATED: Scroll to top or center based on settings with padding for notch/camera
  this.scrollToElement = element => {
    if (!element) return;
    // Check if element is partially visible (at least some part is in viewport)
    const rect = element.getBoundingClientRect();
    if (reader.generalSettings.val.pageReader) {
      const relativePage = Math.floor(
        (rect.left + rect.width / 2) / reader.layoutWidth,
      );
      pageReader.movePage(
        Math.max(
          0,
          Math.min(
            pageReader.totalPages.val - 1,
            pageReader.page.val + relativePage,
          ),
        ),
      );
      return;
    }
    const windowHeight =
      window.innerHeight || document.documentElement.clientHeight;
    const isPartiallyVisible =
      rect.top < windowHeight &&
      rect.bottom > 0 &&
      rect.left < window.innerWidth &&
      rect.right > 0;

    // Only scroll if element is not visible or barely visible
    if (!isPartiallyVisible || rect.top < 0 || rect.bottom > windowHeight) {
      // Check scrollToTop setting (default to true for better reading experience)
      const scrollToTop = reader.readerSettings.val.tts?.scrollToTop !== false;

      if (scrollToTop) {
        // Scroll to top with padding for notch/camera (80px from top)
        const elementTop =
          element.getBoundingClientRect().top + window.pageYOffset;
        const offsetPosition = elementTop - 80; // 80px padding for notch/camera

        window.scrollTo({
          top: offsetPosition,
          behavior: 'smooth',
        });
      } else {
        // Center scroll (original behavior)
        element.scrollIntoView({
          behavior: 'smooth',
          block: 'center',
          inline: 'nearest',
        });
      }
    }
  };

  this.speak = () => {
    this.rewind();
  };
})();

// Watch for TTSEnable changes and stop TTS when disabled
van.derive(() => {
  if (!reader.generalSettings.val.TTSEnable && window.tts) {
    if (tts.reading || tts.started) {
      tts.stop();
    }
  }
});

var pageReader;
window.pageReader = pageReader = new (function () {
  const config =
    typeof initialPageReaderConfig === 'undefined'
      ? {}
      : initialPageReaderConfig;
  this.page = van.state(0);
  this.totalPages = van.state(0);
  this.ignoreClickUntil = 0;
  this.chapterNavigationPending = false;
  this.chapterEndingVisible = van.state(
    config.nextChapterScreenVisible === true,
  );
  this.chapterEnding = document.getElementsByClassName('transition-chapter')[0];

  this.showChapterEnding = (bool, instant, left) => {
    if (!this.chapterEnding) {
      this.chapterEnding =
        document.getElementsByClassName('transition-chapter')[0];
      if (!this.chapterEnding) return;
    }
    const noAnim = Boolean(
      reader.generalSettings?.val?.pageReaderDisableAnimation,
    );
    this.chapterEnding.style.transition = 'unset';
    if (bool) {
      this.chapterEnding.style.transform = `translateX(${left ? -200 : 0}vw)`;
      requestAnimationFrame(() => {
        if (!instant && !noAnim) {
          this.chapterEnding.style.transition = 'transform 200ms';
        }
        this.chapterEnding.style.transform = 'translateX(-100vw)';
      });
      this.chapterEndingVisible.val = true;
    } else {
      if (!instant && !noAnim) {
        this.chapterEnding.style.transition = 'transform 200ms';
      }
      this.chapterEnding.style.transform = `translateX(${left ? -200 : 0}vw)`;
      this.chapterEndingVisible.val = false;
    }
  };

  this.movePage = (destPage, { interaction = true, save = true } = {}) => {
    if (interaction) {
      onUserInteraction();
    }
    if (this.chapterEndingVisible.val) {
      if (this.chapterNavigationPending) {
        return;
      }
      if (destPage < 0) {
        this.showChapterEnding(false);
        return;
      }
      this.showChapterEnding(false, false, true);
      return;
    }
    destPage = parseInt(destPage, 10);
    const noAnim = Boolean(
      reader.generalSettings?.val?.pageReaderDisableAnimation,
    );
    if (destPage < 0) {
      if (!reader.prevChapter) return;
      document.getElementsByClassName('transition-chapter')[0].innerText =
        reader.prevChapter.name;
      this.showChapterEnding(true, noAnim, true);
      this.chapterNavigationPending = true;
      setTimeout(
        () => {
          reader.post({ type: 'prev' });
        },
        noAnim ? 0 : 200,
      );
      return;
    }
    if (destPage >= this.totalPages.val) {
      if (!reader.nextChapter) return;
      document.getElementsByClassName('transition-chapter')[0].innerText =
        reader.nextChapter.name;
      this.showChapterEnding(true, noAnim);
      this.chapterNavigationPending = true;
      setTimeout(
        () => {
          reader.post({ type: 'next' });
        },
        noAnim ? 0 : 200,
      );
      return;
    }
    this.page.val = destPage;
    reader.chapterElement.style.transform =
      'translateX(-' + destPage * 100 + '%)';

    const newProgress = parseInt(
      ((this.page.val + 1) / this.totalPages.val) * 100,
      10,
    );

    if (save && newProgress > reader.chapter.progress) {
      reader.chapter.progress = newProgress;
      reader.post({
        type: 'save',
        data: newProgress,
      });
    }
  };

  this.repaginate = ratio => {
    const previousTotal = this.totalPages.val;
    const currentRatio =
      previousTotal > 0 ? (this.page.val + 1) / previousTotal : 0;
    const positionRatio = Number.isFinite(ratio)
      ? ratio
      : currentRatio || reader.chapter.progress / 100;

    reader.refresh();
    const chapterStyle = getComputedStyle(reader.chapterElement);
    const horizontalPadding =
      (parseFloat(chapterStyle.paddingLeft) || 0) +
      (parseFloat(chapterStyle.paddingRight) || 0);
    this.totalPages.val = Math.max(
      1,
      Math.floor(
        (reader.chapterWidth + horizontalPadding) /
          (reader.chapterElement.clientWidth || reader.layoutWidth) +
          0.001,
      ),
    );

    if (this.chapterEndingVisible.val) {
      return;
    }

    const destination = Math.min(
      this.totalPages.val - 1,
      Math.max(
        0,
        Math.round(
          this.totalPages.val * Math.min(1, Math.max(0, positionRatio)),
        ) - 1,
      ),
    );
    this.movePage(destination, { interaction: false, save: false });
  };

  van.derive(() => {
    // ignore if initial or other states change
    if (
      reader.generalSettings.val.pageReader ===
      reader.generalSettings.oldVal.pageReader
    ) {
      return;
    }
    if (reader.generalSettings.val.pageReader) {
      const ratio = Math.min(
        0.99,
        (window.scrollY + reader.layoutHeight) / reader.chapterHeight,
      );
      document.body.classList.add('page-reader');
      requestAnimationFrame(() => this.repaginate(ratio));
    } else {
      const ratio =
        this.totalPages.val > 0 ? (this.page.val + 1) / this.totalPages.val : 0;
      reader.chapterElement.style.removeProperty('transform');
      reader.chapterElement.style.removeProperty('transition');
      document.body.classList.remove('page-reader');
      requestAnimationFrame(() => {
        reader.refresh();
        window.scrollTo({
          top:
            reader.chapterTop +
            reader.chapterHeight * ratio -
            reader.layoutHeight,
          behavior: 'smooth',
        });
      });
    }
  });

  van.derive(() => {
    document.body.classList.toggle(
      'no-animation',
      Boolean(reader.generalSettings.val.pageReaderDisableAnimation),
    );
    reader.chapterElement?.style.removeProperty('transition');
    const chapterEnding =
      this.chapterEnding ||
      document.getElementsByClassName('transition-chapter')[0];
    chapterEnding?.style.removeProperty('transition');
  });
})();

document.addEventListener('DOMContentLoaded', () => {
  if (pageReader.chapterEndingVisible.val) {
    pageReader.showChapterEnding(true, true);
  }
});

/** Scroll offset the reading position was restored to, in scroll mode. */
let restoredScrollTop = null;
let positionRestored = false;

function calculatePages(behavior = 'instant') {
  reader.refresh();

  if (reader.generalSettings.val.pageReader) {
    pageReader.repaginate(reader.chapter.progress / 100);
  } else {
    restoredScrollTop =
      (reader.chapterHeight * reader.chapter.progress) / 100 -
      reader.layoutHeight;
    window.scrollTo({ top: restoredScrollTop, behavior });
  }
}

let pageCalculationFrame;
let pendingPageRatio;
function schedulePageCalculation(ratio) {
  if (Number.isFinite(ratio)) {
    pendingPageRatio = ratio;
  }
  if (
    pageCalculationFrame ||
    !window.pageReader ||
    !reader.generalSettings.val.pageReader
  ) {
    return;
  }
  pageCalculationFrame = requestAnimationFrame(() => {
    pageCalculationFrame = undefined;
    const nextRatio = pendingPageRatio;
    pendingPageRatio = undefined;
    pageReader.repaginate(nextRatio);
  });
}

const ro = new ResizeObserver(() => {
  if (pageReader.totalPages.val && reader.generalSettings.val.pageReader) {
    schedulePageCalculation();
  }
});
ro.observe(reader.chapterElement);
reader.chapterElement.addEventListener(
  'load',
  () => schedulePageCalculation(),
  true,
);

let viewportResizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(viewportResizeTimer);
  viewportResizeTimer = setTimeout(() => {
    if (reader.generalSettings.val.pageReader) {
      schedulePageCalculation();
    } else {
      reader.refresh();
    }
  }, 100);
});

/**
 * Fonts and images can still change the chapter height after the position was
 * restored. Correct it when that happens - but only while the reader is sitting
 * exactly where it was put, otherwise this would yank the page from under
 * someone who has already started reading.
 */
const correctReadingPosition = () => {
  if (
    reader.generalSettings.val.pageReader ||
    restoredScrollTop === null ||
    reader.chapterElement.id !== 'LNReader-chapter'
  ) {
    return;
  }

  const previousHeight = reader.chapterHeight;
  reader.refresh();
  if (
    reader.chapterHeight !== previousHeight &&
    Math.abs(window.scrollY - Math.max(0, restoredScrollTop)) < 4
  ) {
    calculatePages();
  }
};

const restoreReadingPosition = () => {
  requestAnimationFrame(() =>
    setTimeout(() => {
      positionRestored = true;
      calculatePages();
      // Deliberately not awaited before restoring: `document.fonts.ready` does
      // not resolve until the document has finished loading, which is what this
      // is trying to avoid waiting for.
      document.fonts.ready.then(correctReadingPosition);
    }, 0),
  );
};

// Restore as soon as the chapter itself is parsed and styled. Waiting for
// `load` means waiting for every image in the chapter, which can take seconds -
// the reader would sit at the top of the chapter until then.
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', restoreReadingPosition, {
    once: true,
  });
} else {
  restoreReadingPosition();
}

window.addEventListener('load', () => {
  if (!positionRestored) {
    restoreReadingPosition();
    return;
  }

  if (reader.generalSettings.val.pageReader) {
    schedulePageCalculation();
  } else {
    correctReadingPosition();
  }
});

// click handler
(function () {
  const detectTapPosition = (x, y, horizontal) => {
    if (horizontal) {
      if (x < 0.33) {
        return 'left';
      }
      if (x > 0.66) {
        return 'right';
      }
    } else {
      if (y < 0.33) {
        return 'top';
      }
      if (y > 0.66) {
        return 'bottom';
      }
    }
    return 'center';
  };
  document.onclick = e => {
    if (Date.now() < pageReader.ignoreClickUntil) {
      return;
    }
    const { clientX, clientY } = e;
    const { x, y } = {
      x: clientX / reader.layoutWidth,
      y: clientY / reader.layoutHeight,
    };

    if (reader.generalSettings.val.pageReader) {
      const position = detectTapPosition(x, y, true);
      if (position === 'left') {
        pageReader.movePage(pageReader.page.val - 1);
        return;
      }
      if (position === 'right') {
        pageReader.movePage(pageReader.page.val + 1);
        return;
      }
    } else {
      if (reader.generalSettings.val.tapToScroll) {
        const position = detectTapPosition(x, y, false);
        if (position === 'top') {
          window.scrollBy({
            top: -reader.layoutHeight * 0.75,
            behavior: 'smooth',
          });
          return;
        }
        if (position === 'bottom') {
          window.scrollBy({
            top: reader.layoutHeight * 0.75,
            behavior: 'smooth',
          });
          return;
        }
      }
    }
    reader.post({ type: 'hide' });
  };
})();

// swipe handler, bound to every chapter container
const bindChapterTouch = (function () {
  this.initialX = null;
  this.initialY = null;

  const onTouchStart = e => {
    this.initialX = e.changedTouches[0].screenX;
    this.initialY = e.changedTouches[0].screenY;
  };

  const onTouchMove = e => {
    if (reader.generalSettings.val.pageReader) {
      const diffX =
        (e.changedTouches[0].screenX - this.initialX) / reader.layoutWidth;
      reader.chapterElement.style.transition = 'unset';
      reader.chapterElement.style.transform =
        'translateX(-' + (pageReader.page.val - diffX) * 100 + '%)';
    }
  };

  const onTouchEnd = e => {
    const diffX = e.changedTouches[0].screenX - this.initialX;
    const diffY = e.changedTouches[0].screenY - this.initialY;
    if (reader.generalSettings.val.pageReader) {
      if (Math.abs(diffX) > 8 || Math.abs(diffY) > 8) {
        pageReader.ignoreClickUntil = Date.now() + 400;
      }
      reader.chapterElement.style.transition = reader.generalSettings.val
        .pageReaderDisableAnimation
        ? 'none'
        : 'transform 200ms';
      reader.chapterElement.style.removeProperty('transition');
      const diffXPercentage = diffX / reader.layoutWidth;
      if (diffXPercentage < -0.3) {
        pageReader.movePage(pageReader.page.val + 1);
      } else if (diffXPercentage > 0.3) {
        pageReader.movePage(pageReader.page.val - 1);
      } else {
        pageReader.movePage(pageReader.page.val);
      }
      return;
    }
    if (
      e.target.id?.startsWith('scrollbar') ||
      e.target.id === 'Image-Modal-img'
    ) {
      return;
    }
    if (
      diffY > 80 &&
      Math.abs(diffY) > Math.abs(diffX) * 2 &&
      window.scrollY <= 0
    ) {
      e.preventDefault();
      if (!reader.pullToPrepend?.()) {
        reader.post({ type: 'refresh' });
      }
      return;
    }
    if (
      reader.generalSettings.val.swipeGestures &&
      Math.abs(diffX) > Math.abs(diffY) * 2 &&
      Math.abs(diffX) > 180
    ) {
      if (diffX < 0 && this.initialX >= window.innerWidth / 2) {
        e.preventDefault();
        reader.post({ type: 'next' });
      } else if (diffX > 0 && this.initialX <= window.innerWidth / 2) {
        e.preventDefault();
        reader.post({ type: 'prev' });
      }
    }
  };

  return el => {
    el.addEventListener('touchstart', onTouchStart);
    el.addEventListener('touchmove', onTouchMove);
    el.addEventListener('touchend', onTouchEnd);
  };
})();
bindChapterTouch(reader.chapterElement);

// text options
(function () {
  // What the chapter element currently holds. The document is delivered with
  // the untransformed chapter already parsed, so writing the same markup back
  // would re-parse and re-layout the whole chapter (and restart image loads)
  // for nothing - which is exactly what happens when neither transform is on.
  reader.chapterElement.lnAppliedHTML = reader.rawHTML;

  const transform = rawHTML => {
    let html = rawHTML;
    if (reader.generalSettings.val.bionicReading) {
      html = textVide.textVide(rawHTML);
    }

    if (reader.generalSettings.val.removeExtraParagraphSpacing) {
      html = html
        .replace(/(?:&nbsp;\s*|[\u200b]\s*)+(?=<\/?p[> ])/g, '')
        .replace(/<br>\s*<br>\s*(?:<br>\s*)+/g, '<br><br>') //force max 2 consecutive <br>, chaining regex
        .replace(
          /<br>\s*<br>[^]+/,
          _ =>
            `${
              /\/p>/.test(_)
                ? _.replace(
                    /<br>\s*<br>(?:(?=\s*<\/?p[> ])|(?<=<\/?p(?:>| [^>]+>)<br>\s*<br>))\s*/g,
                    '',
                  )
                : _
            }`,
        ) //if p found, delete all double br near p
        .replace(
          /<br>(?:(?=\s*<\/?p[> ])|(?<=<\/?p(?:>| [^>]+>)(?:<[^>]+>)*\s*<br>))\s*/g,
          '',
        );
    }
    return html;
  };

  /** Applies the text options to a chapter container; true if it changed. */
  reader.applyTextOptions = el => {
    const html = transform(el.lnRawHTML);
    if (html === el.lnAppliedHTML) {
      return false;
    }
    el.innerHTML = html;
    el.lnAppliedHTML = html;
    return true;
  };

  van.derive(() => {
    let changed = false;
    for (const el of reader.chapterContainers()) {
      changed = reader.applyTextOptions(el) || changed;
    }
    if (!changed) {
      return;
    }

    reader.refresh();
    schedulePageCalculation();

    // Replacing the markup dropped the highlights, so restore the search.
    const searchQuery = window.readerSearch?.query;
    const searchIndex = window.readerSearch?.index;
    if (searchQuery) {
      window.readerSearch.search(searchQuery, searchIndex);
    }
  });
})();

// continuous chapters
(function () {
  /** status: 'idle' | 'loading' | 'failed' | 'end', for the last chapter. */
  const appendState = (reader.appendState = van.state({ status: 'idle' }));
  /** status: 'idle' | 'loading' | 'failed' | 'start', for the first chapter. */
  const prependState = (reader.prependState = van.state({ status: 'idle' }));
  let checkQueued = false;
  let ttsWaiting = false;
  let reloadRequested = false;
  // Not before the reader has moved away from the restored position: opening a
  // chapter at its start must not immediately load the one before it.
  let prependArmed = false;

  const firstContainer = () => reader.chapterContainers()[0];
  const lastContainer = () => {
    const containers = reader.chapterContainers();
    return containers[containers.length - 1];
  };

  const requestNext = () => {
    const afterId = lastContainer().lnChapter.id;
    appendState.val = { status: 'loading', afterId };
    reader.post({ type: 'need-next', data: afterId });
  };
  reader.retryAppend = requestNext;

  const requestPrev = () => {
    const beforeId = firstContainer().lnChapter.id;
    prependState.val = { status: 'loading', beforeId };
    reader.post({ type: 'need-prev', data: beforeId });
  };
  reader.retryPrepend = requestPrev;

  const check = () => {
    checkQueued = false;
    if (!reader.isContinuous()) {
      return;
    }
    if (appendState.val.status === 'idle') {
      const remaining =
        lastContainer().getBoundingClientRect().bottom - window.innerHeight;
      if (remaining < 2 * window.innerHeight) {
        requestNext();
      }
    }
    if (
      !prependArmed &&
      positionRestored &&
      (restoredScrollTop === null ||
        Math.abs(window.scrollY - Math.max(0, restoredScrollTop)) > 4)
    ) {
      prependArmed = true;
    }
    if (
      prependArmed &&
      prependState.val.status === 'idle' &&
      firstContainer().getBoundingClientRect().top > -window.innerHeight
    ) {
      requestPrev();
    }
  };
  const scheduleCheck = () => {
    if (!checkQueued) {
      checkQueued = true;
      requestAnimationFrame(check);
    }
  };
  window.addEventListener('scroll', scheduleCheck, { passive: true });

  /**
   * Pulling down at the top loads the previous chapter while there is one;
   * false when the pull should refresh the chapter as usual.
   */
  reader.pullToPrepend = () => {
    const { status } = prependState.val;
    if (!reader.isContinuous() || status === 'start') {
      return false;
    }
    prependArmed = true;
    if (status === 'idle' || status === 'failed') {
      requestPrev();
    }
    return true;
  };

  van.derive(() => {
    if (reader.isContinuous()) {
      scheduleCheck();
    }
    // Paged mode lays out the first chapter element only, so reopen the
    // document on the chapter being read.
    if (
      reader.generalSettings.val.pageReader &&
      reader.chapterElement.id !== 'LNReader-chapter' &&
      !reloadRequested
    ) {
      reloadRequested = true;
      reader.post({ type: 'refresh' });
    }
  });

  const settle = (state, id, next) => {
    const current = state.val;
    if (
      current.status !== 'loading' ||
      (current.afterId ?? current.beforeId) !== id
    ) {
      return false;
    }
    state.val = next;
    return true;
  };

  /**
   * Runs `change` and scrolls by however far it moved the active chapter, so
   * changes above the reader don't move the text. Scroll anchoring may or may
   * not have compensated already; measuring covers both.
   */
  const keepPosition = change => {
    const anchorTop = reader.chapterElement.getBoundingClientRect().top;
    change();
    const shift = reader.chapterElement.getBoundingClientRect().top - anchorTop;
    if (shift) {
      window.scrollTo({ top: window.scrollY + shift, behavior: 'instant' });
    }
  };

  const removeChapter = el => {
    el.lnDivider?.remove();
    el.lnDivider = undefined;
    if (el.id === 'LNReader-chapter') {
      // Kept in the document: plugins and custom code look it up by id.
      el.hidden = true;
      el.innerHTML = '';
      el.lnRawHTML = '';
      el.lnAppliedHTML = '';
    } else {
      el.remove();
    }
  };

  // Drops chapters well away from the reader so the document doesn't grow
  // forever; they are loaded again when scrolled back to.
  const trim = () => {
    const containers = reader.chapterContainers();
    const activeIndex = containers.indexOf(reader.chapterElement);
    if (containers.length < 5) {
      return;
    }
    let end = activeIndex - 2;
    const ttsIndex = tts.started ? containers.indexOf(tts.root) : -1;
    if (ttsIndex >= 0) {
      end = Math.min(end, ttsIndex);
    }
    const behind = containers.slice(0, Math.max(0, end));
    // TTS continues into the chapters after the one it reads.
    const ahead =
      ttsIndex >= 0
        ? []
        : containers
            .slice(activeIndex + 3)
            .filter(
              el =>
                (el.lnDivider ?? el).getBoundingClientRect().top >=
                window.innerHeight,
            );
    if (behind.length) {
      keepPosition(() => behind.forEach(removeChapter));
      prependState.val = { status: 'idle' };
    }
    if (ahead.length) {
      ahead.forEach(removeChapter);
      appendState.val = { status: 'idle' };
    }
  };

  /**
   * Makes `active` the chapter being read, so search, text tools, progress and
   * TTS all work on it; chapters scrolled past on the way down count as read.
   */
  const activate = active => {
    if (active === reader.chapterElement) {
      return;
    }
    const containers = reader.chapterContainers();
    const from = containers.indexOf(reader.chapterElement);
    const to = containers.indexOf(active);
    for (let i = Math.max(0, from); i < to; i++) {
      reader.post({
        type: 'save',
        data: 100,
        chapterId: containers[i].lnChapter.id,
      });
    }
    reader.chapterElement = active;
    reader.chapter = active.lnChapter;
    reader.post({ type: 'active-chapter', data: active.lnChapter.id });
    trim();
    reader.refresh();
  };

  // Activated directly: with the screen off there is no scrollend to do it.
  const readOn = el => {
    activate(el);
    tts.start(undefined, el);
  };

  const createChapter = (chapter, html) => {
    try {
      const custom =
        typeof lnApplyCustomJS === 'function' ? lnApplyCustomJS(html) : html;
      if (typeof custom === 'string') {
        html = custom;
      }
    } catch (_e) {}
    const el = van.tags.div({
      class: 'ln-chapter',
      'data-chapter-id': chapter.id,
    });
    el.innerHTML = html;
    el.lnChapter = chapter;
    el.lnDivider = van.tags.div({ class: 'ln-chapter-divider' }, chapter.name);
    el.lnRawHTML = html;
    el.lnAppliedHTML = html;
    return el;
  };

  const setUpChapter = el => {
    reader.applyTextOptions(el);
    bindChapterTouch(el);
    el.addEventListener('load', () => reader.refresh(), true);
  };

  reader.appendChapter = ({ chapter, html, strings }) => {
    const last = lastContainer();
    if (!settle(appendState, last.lnChapter.id, { status: 'idle' })) {
      return;
    }
    let el;
    try {
      el = createChapter(chapter, html);
      last.after(el.lnDivider, el);
      setUpChapter(el);
      Object.assign(reader.strings, strings);
    } catch (e) {
      if (el) {
        removeChapter(el);
        el = undefined;
      }
      appendState.val = {
        status: 'failed',
        afterId: last.lnChapter.id,
        message: String(e),
      };
    }

    if (ttsWaiting) {
      ttsWaiting = false;
      if (!el) {
        tts.reset();
      } else if (tts.started) {
        // Not started means TTS was stopped while the chapter was loading.
        readOn(el);
      }
    }
    scheduleCheck();
  };

  reader.prependChapter = ({ chapter, html }) => {
    const first = firstContainer();
    if (!settle(prependState, first.lnChapter.id, { status: 'idle' })) {
      return;
    }
    let el;
    try {
      keepPosition(() => {
        el = createChapter(chapter, html);
        if (!first.lnDivider) {
          first.lnDivider = van.tags.div(
            { class: 'ln-chapter-divider' },
            first.lnChapter.name,
          );
          first.before(first.lnDivider);
        }
        first.lnDivider.before(el.lnDivider, el);
        setUpChapter(el);
      });
      // The document chapter's restored position no longer applies.
      restoredScrollTop = null;
    } catch (e) {
      if (el) {
        keepPosition(() => removeChapter(el));
      }
      prependState.val = {
        status: 'failed',
        beforeId: first.lnChapter.id,
        message: String(e),
      };
    }
    scheduleCheck();
  };

  const stopWaitingTTS = () => {
    if (ttsWaiting) {
      ttsWaiting = false;
      tts.reset();
    }
  };

  reader.appendFailed = (afterId, message) => {
    if (settle(appendState, afterId, { status: 'failed', afterId, message })) {
      stopWaitingTTS();
    }
  };

  reader.appendEnd = afterId => {
    if (settle(appendState, afterId, { status: 'end', afterId })) {
      stopWaitingTTS();
    }
  };

  reader.prependFailed = (beforeId, message) =>
    settle(prependState, beforeId, { status: 'failed', beforeId, message });

  reader.prependStart = beforeId =>
    settle(prependState, beforeId, { status: 'start', beforeId });

  /** Continues TTS with the chapter after `root`; false if there is none. */
  reader.continueTTS = root => {
    const containers = reader.chapterContainers();
    const index = containers.indexOf(root);
    if (index < 0) {
      return false;
    }
    if (containers[index + 1]) {
      readOn(containers[index + 1]);
      return true;
    }
    const { status } = appendState.val;
    if (status === 'end' || status === 'failed') {
      return false;
    }
    ttsWaiting = true;
    if (status === 'idle') {
      requestNext();
    }
    return true;
  };

  /**
   * Makes the chapter at the top of the viewport the active one. Runs on
   * scrollend.
   */
  reader.updateActiveChapter = () => {
    const containers = reader.chapterContainers();
    if (containers.length < 2) {
      return;
    }
    const atBottom =
      window.scrollY + window.innerHeight >=
      document.documentElement.scrollHeight - 2;
    // At the very bottom a short last chapter can never reach the top.
    const probe = atBottom ? window.innerHeight - 1 : window.innerHeight * 0.1;
    let active = containers[0];
    for (const el of containers) {
      if (el.getBoundingClientRect().top > probe) {
        break;
      }
      active = el;
    }
    // While narrating, the chapter being read aloud stays active even if its
    // start hasn't reached the top of the screen yet.
    if (tts.reading && containers.includes(tts.root)) {
      active = tts.root;
    }
    activate(active);
    reader.refresh();
  };
})();
