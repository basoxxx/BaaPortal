import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { RecentEntry } from '../bridge';
import { commands, type Command } from '../commands/commands';
import { useAppStore, useServices } from '../state/AppContext';
import { MENUS, type MenuEntry } from './menuModel';

const MAX_RECENT = 10;

export function MenuBar() {
  const { t } = useTranslation();
  const ctx = useServices();
  const appState = useAppStore((s) => s);
  const [open, setOpen] = useState<number | null>(null);
  const [active, setActive] = useState(-1); // -1 = il titolo del menu
  const [subOpen, setSubOpen] = useState(false);
  const [subActive, setSubActive] = useState(-1); // voce attiva del sottomenu; -1 = la voce "Progetti recenti"
  const [recent, setRecent] = useState<RecentEntry[]>([]);
  const rootRef = useRef<HTMLDivElement>(null);

  const close = useCallback(() => {
    setOpen(null);
    setActive(-1);
    setSubOpen(false);
  }, []);

  // Alt (non su macOS) e F10 aprono il primo menu; un clic fuori dalla barra chiude.
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      const alt = e.key === 'Alt' && ctx.bridge.platform !== 'darwin';
      if (!alt && e.key !== 'F10') return;
      e.preventDefault();
      setOpen((o) => (o === null ? 0 : null));
      setActive(-1);
      setSubOpen(false);
    };
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) close();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onDown);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onDown);
    };
  }, [ctx.bridge.platform, close]);

  // L'elenco dei recenti si rilegge a ogni apertura del menu Progetto.
  const projectOpen = open === 0;
  useEffect(() => {
    if (!projectOpen) return;
    let cancelled = false;
    void ctx.bridge.recentList().then((list) => {
      if (!cancelled) setRecent(list.slice(0, MAX_RECENT));
    });
    return () => {
      cancelled = true;
    };
  }, [projectOpen, ctx.bridge]);

  useEffect(() => {
    if (!subOpen) setSubActive(-1);
  }, [subOpen]);

  // Il fuoco segue la voce attiva.
  useEffect(() => {
    if (open === null) return;
    const root = rootRef.current;
    const selector =
      subOpen && subActive >= 0
        ? `[data-sub-index="${subActive}"]`
        : active < 0
          ? `[data-menu-index="${open}"]`
          : `[data-item-index="${active}"]`;
    root?.querySelector<HTMLElement>(selector)?.focus();
  }, [open, active, subOpen, subActive]);

  const entries: MenuEntry[] = open === null ? [] : MENUS[open]!.items.filter((e) => e !== 'sep');

  const onKeyDown = (e: KeyboardEvent) => {
    if (open === null) return;
    const move = (delta: number) => {
      setOpen((open + delta + MENUS.length) % MENUS.length);
      setActive(-1);
      setSubOpen(false);
    };
    if (subOpen && subActive >= 0) {
      const count = Math.max(recent.length, 1);
      if (e.key === 'ArrowDown') setSubActive((a) => Math.min(a + 1, count - 1));
      else if (e.key === 'ArrowUp') setSubActive((a) => Math.max(a - 1, 0));
      else if (e.key === 'ArrowLeft' || e.key === 'Escape') setSubOpen(false);
      else if (e.key !== 'Enter' && e.key !== 'ArrowRight') return;
      if (e.key !== 'Enter') e.preventDefault();
      return;
    }
    switch (e.key) {
      case 'Escape':
        e.preventDefault();
        if (subOpen) setSubOpen(false);
        else {
          close();
          (document.activeElement as HTMLElement | null)?.blur();
        }
        break;
      case 'ArrowRight':
        e.preventDefault();
        if (entries[active] === 'recent') {
          setSubOpen(true);
          setSubActive(0);
        } else move(1);
        break;
      case 'ArrowLeft':
        e.preventDefault();
        if (subOpen) setSubOpen(false);
        else move(-1);
        break;
      case 'ArrowDown':
        e.preventDefault();
        if (!subOpen) setActive((a) => Math.min(a + 1, entries.length - 1));
        break;
      case 'ArrowUp':
        e.preventDefault();
        if (!subOpen) setActive((a) => Math.max(a - 1, -1));
        break;
    }
  };

  const activate = (cmd: Command) => {
    if (!cmd.isEnabled(appState)) return;
    close();
    void cmd.run(ctx);
  };

  const renderItem = (entry: MenuEntry, index: number) => {
    if (entry === 'sep')
      return <div key={`sep-${index}`} role="separator" className="baa-menu-sep" />;
    const navIndex = entries.indexOf(entry);
    if (entry === 'recent') {
      return (
        <div key="recent" className="baa-menu-sub-wrap">
          <button
            type="button"
            role="menuitem"
            aria-haspopup="menu"
            aria-expanded={subOpen}
            data-item-index={navIndex}
            tabIndex={-1}
            className="baa-menu-item"
            onClick={() => {
              setSubOpen(true);
              setSubActive(0);
            }}
            onMouseEnter={() => setSubOpen(true)}
          >
            <span>{t('menu.recent')}</span>
            <span aria-hidden="true">▸</span>
          </button>
          {subOpen ? (
            <div role="menu" className="baa-menu baa-menu-sub" data-testid="menu-recent">
              {recent.length === 0 ? (
                <button
                  type="button"
                  role="menuitem"
                  aria-disabled="true"
                  data-sub-index={0}
                  tabIndex={-1}
                  className="baa-menu-item"
                >
                  {t('menu.noRecent')}
                </button>
              ) : (
                recent.map((r, ri) => (
                  <button
                    key={r.path}
                    data-sub-index={ri}
                    type="button"
                    role="menuitem"
                    tabIndex={-1}
                    className="baa-menu-item"
                    title={r.path}
                    onClick={() => {
                      close();
                      void ctx.service.open(r.path);
                    }}
                  >
                    {r.name}
                  </button>
                ))
              )}
            </div>
          ) : null}
        </div>
      );
    }
    const cmd = commands[entry];
    const enabled = cmd.isEnabled(appState);
    const checked = cmd.isChecked?.(appState);
    return (
      <button
        key={entry}
        type="button"
        role={checked === undefined ? 'menuitem' : 'menuitemcheckbox'}
        aria-checked={checked}
        aria-disabled={!enabled}
        data-item-index={navIndex}
        tabIndex={-1}
        className="baa-menu-item"
        onClick={() => activate(cmd)}
        onMouseEnter={() => setSubOpen(false)}
      >
        <span aria-hidden="true" className="baa-menu-check">
          {checked ? '✓' : ''}
        </span>
        <span>{t(cmd.labelKey)}</span>
        {cmd.shortcut ? (
          <span aria-hidden="true" className="baa-menu-shortcut">
            {shortcutLabel(cmd.shortcut, ctx.bridge.platform)}
          </span>
        ) : null}
      </button>
    );
  };

  return (
    <div
      ref={rootRef}
      role="menubar"
      data-testid="menu-bar"
      className="baa-menubar"
      onKeyDown={onKeyDown}
    >
      {MENUS.map((menu, i) => (
        <div key={menu.id} className="baa-menu-wrap">
          <button
            type="button"
            role="menuitem"
            aria-haspopup="menu"
            aria-expanded={open === i}
            data-menu-index={i}
            tabIndex={open === i && active < 0 ? 0 : -1}
            className="baa-menubar-title"
            onClick={() => (open === i ? close() : (setOpen(i), setActive(-1)))}
            onMouseEnter={() =>
              open !== null && open !== i && (setOpen(i), setActive(-1), setSubOpen(false))
            }
          >
            {t(`menu.${menu.id}`)}
          </button>
          {open === i ? (
            <div role="menu" className="baa-menu" data-testid={`menu-${menu.id}`}>
              {menu.items.map(renderItem)}
            </div>
          ) : null}
        </div>
      ))}
    </div>
  );
}

export function shortcutLabel(shortcut: string, platform: string): string {
  const mac = platform === 'darwin';
  return shortcut
    .split('+')
    .map((p) =>
      p === 'Mod'
        ? mac
          ? '⌘'
          : 'Ctrl'
        : p === 'Shift'
          ? mac
            ? '⇧'
            : 'Shift'
          : p === 'Alt'
            ? mac
              ? '⌥'
              : 'Alt'
            : p.toUpperCase(),
    )
    .join(mac ? '' : '+');
}
