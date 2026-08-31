/**
 * theme.js — Runtime Dark Mode & Theme Management System
 * Issue #104
 */
(function (root, factory) {
  if (typeof define === 'function' && define.amd) {
    define([], factory);
  } else if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.ThemeManager = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {
  const THEME_STORAGE_KEY = 'webcalendar_theme';

  function getStoredTheme() {
    if (typeof localStorage !== 'undefined') {
      return localStorage.getItem(THEME_STORAGE_KEY) || 'system';
    }
    return 'system';
  }

  function getSystemTheme() {
    if (typeof window !== 'undefined' && window.matchMedia) {
      return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }
    return 'light';
  }

  function resolveEffectiveTheme(themeSetting) {
    const pref = themeSetting || getStoredTheme();
    if (pref === 'system') {
      return getSystemTheme();
    }
    return pref === 'dark' ? 'dark' : 'light';
  }

  function applyTheme(themeSetting, doc = document) {
    const effectiveTheme = resolveEffectiveTheme(themeSetting);
    if (doc && doc.documentElement) {
      doc.documentElement.setAttribute('data-theme', effectiveTheme);
      if (effectiveTheme === 'dark') {
        doc.documentElement.classList.add('theme-dark');
      } else {
        doc.documentElement.classList.remove('theme-dark');
      }
    }
    return effectiveTheme;
  }

  function setTheme(themeSetting, doc = document) {
    const validTheme = ['system', 'light', 'dark'].includes(themeSetting) ? themeSetting : 'system';
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(THEME_STORAGE_KEY, validTheme);
    }
    applyTheme(validTheme, doc);
    return validTheme;
  }

  function initTheme(doc = document) {
    const stored = getStoredTheme();
    applyTheme(stored, doc);

    if (typeof window !== 'undefined' && window.matchMedia) {
      const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
      const handleSystemThemeChange = () => {
        if (getStoredTheme() === 'system') {
          applyTheme('system', doc);
        }
      };

      if (mediaQuery.addEventListener) {
        mediaQuery.addEventListener('change', handleSystemThemeChange);
      } else if (mediaQuery.addListener) {
        mediaQuery.addListener(handleSystemThemeChange);
      }
    }
  }

  return {
    THEME_STORAGE_KEY,
    getStoredTheme,
    getSystemTheme,
    resolveEffectiveTheme,
    applyTheme,
    setTheme,
    initTheme
  };
}));
