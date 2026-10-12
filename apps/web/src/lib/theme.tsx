import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

import { STORAGE_THEME_KEY } from './constants';
import { readPreferenceFrom, writePreference } from './storage';

/** 主题偏好：主题只存浏览器 localStorage，默认跟随系统。 */

export type ThemePreference = 'system' | 'light' | 'dark';
export type ResolvedTheme = 'light' | 'dark';

const THEME_VALUES = ['system', 'light', 'dark'] as const;

interface ThemeContextValue {
  preference: ThemePreference;
  resolved: ResolvedTheme;
  setPreference: (preference: ThemePreference) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

function systemPrefersDark(): boolean {
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preference, setPreferenceState] = useState<ThemePreference>(() =>
    readPreferenceFrom(STORAGE_THEME_KEY, THEME_VALUES, 'system'),
  );
  const [systemDark, setSystemDark] = useState<boolean>(() => systemPrefersDark());

  useEffect(() => {
    const query = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = (event: MediaQueryListEvent): void => {
      setSystemDark(event.matches);
    };
    query.addEventListener('change', onChange);
    return () => {
      query.removeEventListener('change', onChange);
    };
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    if (preference === 'system') {
      root.removeAttribute('data-theme');
    } else {
      root.setAttribute('data-theme', preference);
    }
  }, [preference]);

  const value = useMemo<ThemeContextValue>(
    () => ({
      preference,
      resolved: preference === 'system' ? (systemDark ? 'dark' : 'light') : preference,
      setPreference: (next: ThemePreference) => {
        setPreferenceState(next);
        writePreference(STORAGE_THEME_KEY, next);
      },
    }),
    [preference, systemDark],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const context = useContext(ThemeContext);
  if (context === null) {
    throw new Error('useTheme 必须在 ThemeProvider 内使用');
  }
  return context;
}
