import type { SourceNovel } from '@plugins/types';

const MAX_INFO_ITEMS = 20;
const MAX_INFO_TEXT = 100;

const toInfoText = (value: unknown) =>
  typeof value === 'string' || typeof value === 'number'
    ? String(value).trim().slice(0, MAX_INFO_TEXT)
    : '';

/**
 * Plugin-provided stats as DB columns. Only keys the plugin actually sent
 * (with a valid shape) are present, so updates keep stored values otherwise.
 * Some plugins send rating 0 for "unknown", so the rating must be in (0, 5].
 */
export const getNovelStatsValues = (novel: SourceNovel) => {
  const values: { rating?: number; ratingCount?: number; info?: string } = {};
  if (
    typeof novel.rating === 'number' &&
    novel.rating > 0 &&
    novel.rating <= 5
  ) {
    values.rating = novel.rating;
  }
  if (
    typeof novel.ratingCount === 'number' &&
    Number.isFinite(novel.ratingCount)
  ) {
    values.ratingCount = Math.round(novel.ratingCount);
  }
  if (Array.isArray(novel.info)) {
    values.info = JSON.stringify(
      novel.info
        .map(item => ({
          label: toInfoText(item?.label),
          value: toInfoText(item?.value),
        }))
        .filter(item => item.label && item.value)
        .slice(0, MAX_INFO_ITEMS),
    );
  }
  return values;
};
