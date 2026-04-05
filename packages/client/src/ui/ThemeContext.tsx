import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { LIGHT_COLORS, DARK_COLORS, type ThemeColors } from './styles';

interface ThemeContextValue {
  colors: ThemeColors;
  isDark: boolean;
  toggle: () => void;
}

const STORAGE_KEY = 'ai-village-theme';

const ThemeContext = createContext<ThemeContextValue>({
  colors: LIGHT_COLORS,
  isDark: false,
  toggle: () => {},
});

export const ThemeProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [isDark, setIsDark] = useState(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      return stored === null ? true : stored === 'dark';
    } catch {
      return true;
    }
  });

  const toggle = useCallback(() => {
    setIsDark((prev) => !prev);
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, isDark ? 'dark' : 'light');
    } catch {
      // ignore
    }
    document.documentElement.style.background = isDark ? DARK_COLORS.bg : LIGHT_COLORS.bg;
    document.body.style.background = isDark ? DARK_COLORS.bg : LIGHT_COLORS.bg;
  }, [isDark]);

  const value: ThemeContextValue = {
    colors: isDark ? DARK_COLORS : LIGHT_COLORS,
    isDark,
    toggle,
  };

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
};

export const useTheme = () => useContext(ThemeContext);
