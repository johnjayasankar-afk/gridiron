/** The appearance in effect: the saved choice, or the operating system's when the choice is System. */
import { usePrefs, type Theme } from '../state/prefs';
import { useMediaQuery } from './media';

export type ResolvedTheme = 'light' | 'dark';

export const DARK_SCHEME_QUERY = '(prefers-color-scheme: dark)';

export function resolveTheme(theme: Theme, systemDark: boolean): ResolvedTheme {
  return theme === 'system' ? (systemDark ? 'dark' : 'light') : theme;
}

export function currentResolvedTheme(): ResolvedTheme {
  const systemDark = typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(DARK_SCHEME_QUERY).matches;
  return resolveTheme(usePrefs.getState().theme, systemDark);
}

export function useResolvedTheme(): ResolvedTheme {
  const theme = usePrefs((s) => s.theme);
  const systemDark = useMediaQuery(DARK_SCHEME_QUERY);
  return resolveTheme(theme, systemDark);
}

export const useIsDark = () => useResolvedTheme() === 'dark';
