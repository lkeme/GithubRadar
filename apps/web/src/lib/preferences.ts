import { useCallback, useState } from 'react';

import { DEFAULT_TREND_RANGE, STORAGE_TREND_RANGE_KEY, STORAGE_VIEW_KEY, TREND_RANGE_OPTIONS } from './constants';
import { readPreference, writePreference } from './storage';

/** 视图与展示偏好：只存 localStorage，非法值回落默认。 */

export type RepoView = 'cards' | 'list';

const VIEW_VALUES = ['cards', 'list'] as const;

export function useViewPreference(): [RepoView, (view: RepoView) => void] {
  const [view, setViewState] = useState<RepoView>(() => {
    const raw = readPreference(STORAGE_VIEW_KEY);
    return raw !== null && (VIEW_VALUES as readonly string[]).includes(raw) ? (raw as RepoView) : 'cards';
  });
  const setView = useCallback((next: RepoView) => {
    setViewState(next);
    writePreference(STORAGE_VIEW_KEY, next);
  }, []);
  return [view, setView];
}

export type TrendRange = (typeof TREND_RANGE_OPTIONS)[number];

export function useTrendRangePreference(): [TrendRange, (range: TrendRange) => void] {
  const [range, setRangeState] = useState<TrendRange>(() => {
    const raw = readPreference(STORAGE_TREND_RANGE_KEY);
    const parsed = raw === null ? Number.NaN : Number(raw);
    return (TREND_RANGE_OPTIONS as readonly number[]).includes(parsed) ? (parsed as TrendRange) : DEFAULT_TREND_RANGE;
  });
  const setRange = useCallback((next: TrendRange) => {
    setRangeState(next);
    writePreference(STORAGE_TREND_RANGE_KEY, String(next));
  }, []);
  return [range, setRange];
}
