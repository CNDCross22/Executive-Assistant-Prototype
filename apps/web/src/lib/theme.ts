import { useEffect, useState } from 'react';

export type Theme = 'light' | 'dark';

const STORAGE_KEY = 'hermes.theme';

/**
 * Light is the default, deliberately.
 *
 * The system preference is NOT followed unless she has never chosen — and even
 * then we land on light, because this is a working tool opened in daylight
 * next to Outlook, not a code editor. Her choice, once made, always wins.
 */
export function readTheme(): Theme {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'light' || stored === 'dark') return stored;
  } catch {
    // localStorage can be unavailable in private modes; light is a safe default.
  }
  return 'light';
}

export function applyTheme(theme: Theme): void {
  document.documentElement.setAttribute('data-theme', theme);
  document.documentElement.style.colorScheme = theme;
}

export function useTheme(): { theme: Theme; toggle: () => void } {
  const [theme, setTheme] = useState<Theme>(readTheme);

  useEffect(() => {
    applyTheme(theme);
    try {
      localStorage.setItem(STORAGE_KEY, theme);
    } catch {
      // Not worth failing over; the theme still applies for this session.
    }
  }, [theme]);

  return {
    theme,
    toggle: () => setTheme((t) => (t === 'light' ? 'dark' : 'light')),
  };
}
