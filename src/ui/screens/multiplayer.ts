// The title's MULTIPLAYER screen: name, server address and room, JOIN and BACK. Arrow keys / the pad's D-pad move
// between the rows, a selected field takes the keyboard (Input leaves text fields alone), Enter in a field joins,
// Escape goes back.

import { DEFAULT_ROOM, MAX_NAME, menuServerAddress } from '../../net/url';
import { escapeHtml } from '../hud';
import { h, type MenuCtx, type MultiplayerFields } from './shared';
import './multiplayer.css';

const FIELDS_KEY = 'gta7.multiplayer.v1';

/** Whether the page came from the game server (it marks its pages; vite and GitHub Pages do not). */
export function servedByGameServer(): boolean {
  return typeof document !== 'undefined' && !!document.querySelector('meta[name="gta7-server"]');
}

/** The fields as last joined with, else a blank name, this page's game server (or ws://localhost:4210) and 'lobby'. */
export function rememberedFields(): MultiplayerFields {
  const fallback: MultiplayerFields = { name: '', server: menuServerAddress(location, servedByGameServer()), room: DEFAULT_ROOM };
  try {
    const raw = JSON.parse(localStorage.getItem(FIELDS_KEY) ?? 'null') as Partial<MultiplayerFields> | null;
    if (!raw || typeof raw !== 'object') return fallback;
    const str = (v: unknown, d: string) => (typeof v === 'string' && v.length <= 256 ? v : d);
    return { name: str(raw.name, ''), server: str(raw.server, fallback.server) || fallback.server, room: str(raw.room, DEFAULT_ROOM) || DEFAULT_ROOM };
  } catch {
    return fallback;
  }
}

export function rememberFields(f: MultiplayerFields): void {
  try {
    localStorage.setItem(FIELDS_KEY, JSON.stringify({ name: f.name, server: f.server, room: f.room }));
  } catch {
    // Storage full or off: the defaults next time.
  }
}

/** Trims what the player typed: the name to MAX_NAME characters, an empty room to 'lobby'. Null name: none given. */
export function joinValues(f: MultiplayerFields): MultiplayerFields | { error: string; field: keyof MultiplayerFields } {
  const name = f.name.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim().slice(0, MAX_NAME);
  if (!name) return { error: 'Enter a name to join.', field: 'name' };
  const server = f.server.trim();
  if (!server) return { error: 'Enter the server address (host:port).', field: 'server' };
  return { name, server, room: f.room.trim() || 'lobby' };
}

export function showMultiplayer(ctx: MenuCtx): void {
  const start = ctx.host.multiplayerFields?.() ?? { name: '', server: 'ws://localhost:4210', room: 'lobby' };
  const el = h('div', 'screen dim mp-join-screen');
  const panel = h('div', 'panel mp-join');
  panel.style.width = 'min(560px, 92vw)';
  panel.appendChild(h('div', 'panel-eyebrow', 'SAN AZURA / ONLINE'));
  panel.appendChild(h('h2', '', 'MULTIPLAYER'));
  panel.appendChild(h('p', 'mp-join-intro', 'Free roam with up to 8 players on a game server. Story missions, cheats and saving stay in single player.'));
  const rows: HTMLElement[] = [];
  const fields = {} as Record<keyof MultiplayerFields, HTMLInputElement>;
  const field = (key: keyof MultiplayerFields, label: string, value: string, hint: string, max: number) => {
    const row = h('label', 'mp-field');
    row.dataset.field = key;
    row.appendChild(h('span', 'mp-field-label', label));
    const input = h('input', 'mp-input');
    input.type = 'text';
    input.value = value;
    input.maxLength = max;
    input.spellcheck = false;
    input.autocomplete = 'off';
    input.name = `mp-${key}`;
    input.dataset.field = key;
    input.setAttribute('aria-label', label);
    row.appendChild(input);
    row.appendChild(h('span', 'mp-field-hint', hint));
    panel.appendChild(row);
    rows.push(row);
    fields[key] = input;
  };
  field('name', 'NAME', start.name, `Up to ${MAX_NAME} characters.`, MAX_NAME);
  field('server', 'SERVER', start.server, 'host:port or ws://host:port', 200);
  field('room', 'ROOM', start.room, 'Players in the same room play together.', 64);
  const error = h('div', 'mp-join-error');
  error.setAttribute('role', 'alert');
  panel.appendChild(error);
  const buttons = h('div', 'menu mp-join-buttons');
  const join = h('button', '', 'JOIN');
  join.dataset.id = 'mp-join';
  const back = h('button', '', 'BACK');
  back.dataset.id = 'mp-back';
  buttons.append(join, back);
  panel.appendChild(buttons);
  rows.push(join, back);
  el.appendChild(panel);

  let sel = 0;
  const values = (): MultiplayerFields => ({ name: fields.name.value, server: fields.server.value, room: fields.room.value });
  const select = (i: number, focus = true) => {
    sel = Math.max(0, Math.min(rows.length - 1, i));
    rows.forEach((r, k) => r.classList.toggle('sel', k === sel));
    const input = rows[sel]!.querySelector('input');
    if (input && focus) input.focus();
    else if (!input) (document.activeElement as HTMLElement | null)?.blur?.();
  };
  const doJoin = () => {
    const v = joinValues(values());
    if ('error' in v) {
      error.innerHTML = escapeHtml(v.error);
      select(rows.indexOf(fields[v.field].parentElement!));
      return;
    }
    error.textContent = '';
    fields.name.value = v.name;
    fields.room.value = v.room;
    ctx.host.click();
    rememberFields(v);
    // The connection screens take the keyboard from here (a focused field would keep it).
    (document.activeElement as HTMLElement | null)?.blur?.();
    ctx.host.joinMultiplayer?.(v);
  };
  const goBack = () => {
    ctx.host.click();
    ctx.pop();
  };
  join.addEventListener('click', doJoin);
  back.addEventListener('click', goBack);
  for (const b of [join, back]) b.addEventListener('mousemove', () => select(rows.indexOf(b), false));
  for (const input of Object.values(fields)) {
    input.addEventListener('focus', () => {
      const i = rows.indexOf(input.parentElement!);
      if (i !== sel) select(i, false);
    });
    input.addEventListener('input', () => (error.textContent = ''));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        doJoin();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        input.blur();
        goBack();
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        select(sel + 1);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        select(sel - 1);
      }
    });
  }
  ctx.push({
    el,
    input: (ui) => {
      if (ui.back) return goBack();
      if (ui.up) select(sel - 1);
      if (ui.down) select(sel + 1);
      if (ui.confirm) {
        const r = rows[sel]!;
        if (r === join) doJoin();
        else if (r === back) goBack();
        else r.querySelector('input')?.focus();
      }
    },
    close: () => (document.activeElement as HTMLElement | null)?.blur?.(),
    refresh: () => select(sel, false),
  });
  // A keyboard player can type his name at once; a pad starts on the name row without a caret.
  select(0, ctx.device === 'kb');
}
