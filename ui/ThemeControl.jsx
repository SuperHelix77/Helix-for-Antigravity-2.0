import React, {useEffect, useState} from 'react';
import {Monitor, Moon, Sun} from 'lucide-react';

const choices = [['system', 'System theme', Monitor], ['light', 'Light theme', Sun], ['dark', 'Dark theme', Moon]];
const storageKey = 'helix.theme';

export default function ThemeControl() {
  const [theme, setTheme] = useState(() => {
    try { const stored = localStorage.getItem(storageKey); return choices.some(([id]) => id === stored) ? stored : 'dark'; }
    catch { return 'dark'; }
  });
  useEffect(() => {
    const media = matchMedia('(prefers-color-scheme: dark)');
    const apply = () => { document.documentElement.dataset.theme = theme === 'system' ? media.matches ? 'dark' : 'light' : theme; };
    apply();
    try { localStorage.setItem(storageKey, theme); } catch { /* Theme still works if storage is unavailable. */ }
    media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, [theme]);
  function navigate(event) {
    const keys = ['ArrowLeft', 'ArrowRight', 'Home', 'End'];
    if (!keys.includes(event.key)) return;
    event.preventDefault();
    const index = choices.findIndex(([id]) => id === theme);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? 2 : (index + (event.key === 'ArrowRight' ? 1 : -1) + choices.length) % choices.length;
    setTheme(choices[next][0]);
    event.currentTarget.querySelector(`[data-theme-choice="${choices[next][0]}"]`)?.focus();
  }
  return <div className="theme-row"><span>Appearance</span><div className="theme-control" role="radiogroup" aria-label="Appearance" onKeyDown={navigate}>{choices.map(([id, label, Icon]) => <button type="button" key={id} role="radio" aria-checked={theme === id} aria-label={label} title={label} data-theme-choice={id} tabIndex={theme === id ? 0 : -1} onClick={() => setTheme(id)}><Icon size={15} /></button>)}</div></div>;
}
