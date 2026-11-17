import { useEffect, useState } from 'react';

/** Dark, light, or follow the operating system. Saved per browser (public/assets/theme-init.js applies it before paint). */
export type ThemePref = 'dark' | 'light' | 'system';
const KEY = 'ops-theme';
const mq = () => window.matchMedia?.('(prefers-color-scheme: light)');

function read(): ThemePref {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'dark' || v === 'light' ? v : 'system';
  } catch { return 'system'; }
}

function apply(pref: ThemePref) {
  const light = pref === 'light' || (pref === 'system' && !!mq()?.matches);
  document.documentElement.setAttribute('data-theme', light ? 'light' : 'dark');
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', light ? '#f5f6f8' : '#090b0f');
}

export function useTheme(): [ThemePref, (p: ThemePref) => void] {
  const [pref, setPref] = useState<ThemePref>(read);
  useEffect(() => {
    apply(pref);
    if (pref !== 'system') return;
    const m = mq();
    const on = () => apply('system');
    m?.addEventListener?.('change', on);
    return () => m?.removeEventListener?.('change', on);
  }, [pref]);
  return [pref, (p) => {
    try { if (p === 'system') localStorage.removeItem(KEY); else localStorage.setItem(KEY, p); } catch { /* storage blocked: still applies for this visit */ }
    setPref(p);
  }];
}
