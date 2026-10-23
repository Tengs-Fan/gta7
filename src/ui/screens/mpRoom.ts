// Multiplayer screens over a running game (the world goes on under them): the room's PLAYERS (Tab, or the pause
// menu), and STREET RUNS, which opens, joins, starts or leaves the room's head-to-head race.

import { formatRunTime } from '../../sim/streetRuns';
import type { RaceView } from '../../net/lobby';
import { escapeHtml } from '../hud';
import { ButtonList, h, type MenuCtx, type MultiplayerMenuHost } from './shared';
import './multiplayer.css';

/** What the phone key says in multiplayer, under the player list it opens there. */
export const MP_NO_PHONE = 'The phone (calls, texts and cabs) is single-player only.';

/** How often (s) the open screens re-read the room. */
const REFRESH = 0.25;

function playersTable(mp: MultiplayerMenuHost): HTMLElement {
  const t = h('table', 'mp-table mp-players');
  t.innerHTML = '<thead><tr><th>PLAYER</th><th class="num">STARS</th><th class="num">KILLS</th><th class="num">DEATHS</th></tr></thead>';
  const body = h('tbody');
  for (const p of mp.players()) {
    const tr = h('tr', p.you ? 'you' : '');
    tr.dataset.playerId = String(p.playerId);
    const watching = p.watching ? ' <span class="mp-you">WATCHING</span>' : '';
    tr.innerHTML = `<td><span class="mp-swatch" style="background:${p.color}"></span><span class="mp-name">${escapeHtml(p.name)}</span>${p.you ? '<span class="mp-you">YOU</span>' : ''}${watching}</td><td class="num mp-stars">${p.wanted > 0 ? '\u2605'.repeat(p.wanted) : '-'}</td><td class="num">${p.kills}</td><td class="num">${p.deaths}</td>`;
    body.appendChild(tr);
  }
  t.appendChild(body);
  return t;
}

/** The room's players: names (the local one marked), kills and deaths, live while it is open. */
export function showPlayers(ctx: MenuCtx, onClose?: () => void): boolean {
  const mp = ctx.host.multiplayer?.();
  if (!mp) return false;
  const el = h('div', 'screen dim');
  const panel = h('div', 'panel mp-players-panel');
  panel.style.width = 'min(560px, 92vw)';
  panel.appendChild(h('div', 'panel-eyebrow', `ROOM / ${escapeHtml(mp.roomId().toUpperCase())}`));
  const title = h('h2', '', 'PLAYERS');
  panel.appendChild(title);
  const holder = h('div');
  panel.appendChild(holder);
  panel.appendChild(h('p', 'mp-note', escapeHtml(MP_NO_PHONE)));
  const close = () => {
    if (onClose) onClose();
    else ctx.pop();
  };
  const list = new ButtonList([{ label: 'BACK', action: close, id: 'players-back' }], () => ctx.host.click());
  panel.appendChild(list.el);
  el.appendChild(panel);
  let key = '';
  let wait = 0;
  const draw = () => {
    const rows = mp.players();
    const k = JSON.stringify(rows);
    if (k === key) return;
    key = k;
    title.textContent = `PLAYERS · ${rows.length}`;
    holder.replaceChildren(playersTable(mp));
  };
  draw();
  ctx.push({
    el,
    tick: (dt) => {
      wait -= dt;
      if (wait > 0) return;
      wait = REFRESH;
      draw();
    },
    input: (ui) => (ui.back || ui.pause || ui.phone ? close() : list.input(ui)),
  });
  return true;
}

function raceLine(race: RaceView, joinLeft: number): string {
  const names = race.entrants.map((e) => escapeHtml(e.name)).join(', ') || 'nobody yet';
  if (race.stage === 'lobby') return `<b>${escapeHtml(race.courseName)}</b>, opened by ${escapeHtml(race.hostName)}. In: ${names}. Starts in ${Math.ceil(joinLeft)} s.`;
  if (race.stage === 'results') return `<b>${escapeHtml(race.courseName)}</b>: results are in.`;
  return `<b>${escapeHtml(race.courseName)}</b> is on: ${names}.`;
}

/**
 * The head-to-head Street Runs: with no race on, one entry per course opens it; an open race can be joined (or, by the
 * player who opened it, started now) and left; a race under way can be quit.
 */
export function showRaces(ctx: MenuCtx, onClose?: () => void): boolean {
  const mp = ctx.host.multiplayer?.();
  if (!mp) return false;
  const el = h('div', 'screen dim');
  const panel = h('div', 'panel runs-panel mp-races');
  panel.appendChild(h('div', 'panel-eyebrow', 'SAN AZURA / HEAD-TO-HEAD'));
  panel.appendChild(h('h2', '', 'STREET RUNS'));
  const info = h('p', 'runs-intro');
  panel.appendChild(info);
  const holder = h('div');
  panel.appendChild(holder);
  el.appendChild(panel);
  const done = () => {
    if (onClose) onClose();
    else ctx.closeAll();
  };
  const back = () => {
    if (onClose) onClose();
    else ctx.pop();
  };
  const act = (cmd: Parameters<MultiplayerMenuHost['raceCommand']>[0]) => {
    mp.raceCommand(cmd);
    done();
  };
  let list: ButtonList | null = null;
  let key = '';
  let wait = 0;
  const build = () => {
    const race = mp.race();
    const me = mp.players().find((p) => p.you);
    const mine = !!race && !!me && race.entrants.some((e) => e.playerId === me.playerId && e.status !== 'dnf');
    const k = JSON.stringify([race?.stage, race?.courseId, race?.entrants.map((e) => [e.playerId, e.status]), mine, race?.hostId]);
    const left = mp.raceJoinLeft();
    info.innerHTML = race
      ? raceLine(race, left)
      : 'Open a race for the whole room: everyone who joins within 20 s lines up on the same grid, the same countdown starts you all.<br>You can also drive to a course start and press <kbd>T</kbd>.';
    if (k === key) return;
    key = k;
    const items: Array<{ label: string; action: () => void; id: string; description?: string; disabled?: boolean }> = [];
    if (!race) {
      for (const c of mp.courses()) {
        items.push({ label: `OPEN ${c.name.toUpperCase()}`, id: `race-open-${c.id}`, description: `${c.description}\n${(c.distance / 1000).toFixed(1)} KM`, action: () => act({ action: 'open', course: c.id }) });
      }
    } else if (race.stage === 'lobby') {
      if (!mine) items.push({ label: `JOIN ${race.courseName.toUpperCase()}`, id: 'race-join', description: `${race.hostName}'s race`, action: () => act({ action: 'join', course: race.courseId }) });
      if (mine && me && race.hostId === me.playerId) items.push({ label: 'START NOW', id: 'race-start', action: () => act({ action: 'start' }) });
      if (mine) items.push({ label: 'LEAVE RACE', id: 'race-leave', action: () => act({ action: 'leave' }) });
    } else if (race.stage !== 'results' && mine) {
      items.push({ label: 'QUIT RACE', id: 'race-quit', description: 'You will be shown as DNF.', action: () => act({ action: 'leave' }) });
    }
    items.push({ label: 'BACK', id: 'races-back', action: back });
    list = new ButtonList(items, () => ctx.host.click());
    list.el.classList.add('course-menu');
    holder.replaceChildren(list.el);
  };
  build();
  ctx.push({
    el,
    tick: (dt) => {
      wait -= dt;
      if (wait > 0) return;
      wait = REFRESH;
      build();
    },
    input: (ui) => (ui.back ? back() : list?.input(ui)),
  });
  return true;
}

/** "1:02.3" or a reason, for a results row. */
export function resultTime(e: RaceView['entrants'][number]): string {
  if (e.status === 'finished' && e.time !== null) return formatRunTime(e.time);
  if (e.status === 'timeout') return 'OUT OF TIME';
  if (e.status === 'dnf') return 'DNF';
  return '';
}
