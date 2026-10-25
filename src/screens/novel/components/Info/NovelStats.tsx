import { memo, useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import MaterialCommunityIcons from '@react-native-vector-icons/material-design-icons';

import type { NovelInfoItem } from '@plugins/types';
import type { ThemeColors } from '@theme/types';

export const parseNovelInfoItems = (info: unknown): NovelInfoItem[] => {
  if (typeof info !== 'string' || !info) {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(info);
    return Array.isArray(parsed)
      ? parsed.filter(
          (item): item is NovelInfoItem =>
            typeof item?.label === 'string' &&
            typeof item?.value === 'string' &&
            item.label !== '' &&
            item.value !== '',
        )
      : [];
  } catch {
    return [];
  }
};

const starIcon = (rating: number, index: number) => {
  const fill = rating - index;
  if (fill >= 0.75) {
    return 'star';
  }
  return fill >= 0.25 ? 'star-half-full' : 'star-outline';
};

interface NovelStatsProps {
  theme: ThemeColors;
  rating?: number | null;
  ratingCount?: number | null;
  info?: string | null;
}

const NovelStats = ({ theme, rating, ratingCount, info }: NovelStatsProps) => {
  const items = useMemo(() => parseNovelInfoItems(info), [info]);
  const hasRating = typeof rating === 'number' && rating > 0 && rating <= 5;

  if (!hasRating && !items.length) {
    return null;
  }

  return (
    <View style={styles.container}>
      {hasRating ? (
        <View
          style={styles.ratingRow}
          accessible
          accessibilityLabel={`${rating.toFixed(2)} / 5${
            ratingCount ? ` (${ratingCount.toLocaleString()})` : ''
          }`}
        >
          {[0, 1, 2, 3, 4].map(index => (
            <MaterialCommunityIcons
              key={index}
              name={starIcon(rating, index)}
              size={16}
              color={theme.primary}
            />
          ))}
          <Text style={[styles.ratingValue, { color: theme.onSurface }]}>
            {rating.toFixed(2)}
          </Text>
          {ratingCount ? (
            <Text style={[styles.small, { color: theme.onSurfaceVariant }]}>
              {`(${ratingCount.toLocaleString()})`}
            </Text>
          ) : null}
        </View>
      ) : null}
      {items.length ? (
        <View style={styles.grid}>
          {items.map((item, index) => (
            <View
              key={`${item.label}-${index}`}
              style={[styles.tile, { borderColor: theme.outlineVariant }]}
              accessible
              accessibilityLabel={`${item.label}: ${item.value}`}
            >
              <Text
                style={[styles.value, { color: theme.onSurface }]}
                numberOfLines={2}
              >
                {item.value}
              </Text>
              <Text
                style={[styles.small, { color: theme.onSurfaceVariant }]}
                numberOfLines={1}
              >
                {item.label}
              </Text>
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
};

export default memo(NovelStats);

const styles = StyleSheet.create({
  container: {
    gap: 8,
    paddingHorizontal: 16,
    paddingTop: 8,
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  ratingRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 2,
  },
  ratingValue: {
    fontSize: 14,
    fontWeight: '600',
    marginLeft: 4,
  },
  small: {
    fontSize: 12,
  },
  tile: {
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    maxWidth: '100%',
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  value: {
    fontSize: 14,
    fontWeight: '500',
  },
});
