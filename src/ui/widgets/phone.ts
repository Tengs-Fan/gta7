// The phone: contacts (from the contact registry) who call with work, a text log of contact texts and earnings,
// Azura Cab, and the map. PhoneLog and PhoneCalls are plain logic (no DOM); PhoneWidget draws the incoming-call card
// and showPhone the phone itself, as a menu screen (the game stands still while it is open).

import './phone.css';
import { formatMoney } from '../../core/math';
import { CONTACTS, contactById, contactUnlocked, type ContactDef } from '../../sim/missions/contacts';
import type { MissionDef } from '../../sim/missions/runner';
import { playerOf, type PlayerView, type ViewState } from '../../sim/viewState';
import { formatKeys, padGlyph } from '../glyphs';
import { escapeHtml } from '../hud';
import { h, type MenuCtx } from '../screens/shared';

/** The text log keeps this many entries, newest first; older ones drop off. */
export const MAX_TEXTS = 40;
/** A contact rings this long after work turns up (s), once nothing else is going on... */
export const CALL_DELAY = 4;
/** ...and rings for this long (s) before it counts as missed; in a vehicle the call is answered hands-free after CALL_HANDS_FREE s. */
export const CALL_RING = 12;
export const CALL_HANDS_FREE = 2;

/** The phone's contacts, in registry order. */
export function phoneContacts(view: ViewState, me: PlayerView): ContactDef[] {
  return CONTACTS.filter((c) => contactUnlocked(view.missions.defs, me.progress, c.id));
}

export interface PhoneEntry {
  /** 'text': a contact's message; 'earning': money paid in; 'call': a missed call. */
  kind: 'text' | 'earning' | 'call';
  from: string;
  /** CSS colour of the sender (a contact's), if any. */
  color?: string;
  text: string;
  /** Money paid with it, where there was any. */
  amount?: number;
  /** Game day and clock when it came in. */
  day: number;
  time: string;
}

/** What a payout's activity kind reads as in the log. */
const PAYOUT_NAMES: Record<string, string> = {
  taxi: 'Taxi fare',
  vigilante: 'Vigilante reward',
  rampage: 'Rampage bonus',
  streetRun: 'Street Run prize',
  ambulance: 'Paramedic pay',
  firefighter: 'Firefighter pay',
  courier: 'Azura Express pay',
  carExport: 'Export list payment',
  business: 'Pier Arcade takings',
};

function payoutName(kind: string): string {
  return PAYOUT_NAMES[kind] ?? `${kind.charAt(0).toUpperCase()}${kind.slice(1).replace(/([A-Z])/g, ' $1').toLowerCase()} payout`;
}

/**
 * The text log: contact texts tied to missions and every payment in (mission rewards, activity payouts, business
 * income, prizes), each with its amount; newest first, at most MAX_TEXTS. A frame's money is put down to what paid it
 * (an activity milestone, a stunt, a package...) when that is told the same frame; flush() books the rest as payments.
 */
export class PhoneLog {
  private list: PhoneEntry[] = [];
  private pending: number[] = [];
  private unsub: Array<() => void> = [];
  private done = new Set<string>();

  /** Newest first. */
  get entries(): readonly PhoneEntry[] {
    return this.list;
  }

  bind(view: ViewState, localPlayerId = 0): void {
    this.unbind();
    this.list = [];
    this.pending = [];
    const me = () => playerOf(view, localPlayerId);
    const mine = (e: { playerId?: number }) => (e.playerId ?? 0) === localPlayerId;
    this.done = new Set(me().progress.missionsDone);
    const ev = view.events;
    this.unsub.push(
      ev.on('money', (e) => {
        if (!mine(e) || !(e.amount > 0)) return;
        // A mission is marked done just before its reward is paid (MissionSystem.settle).
        const fresh = me().progress.missionsDone.find((id) => !this.done.has(id));
        if (fresh) {
          this.done.add(fresh);
          const def = view.missions.defs.find((d) => d.id === fresh);
          const c = def ? contactById(def.giver) : null;
          this.add(view, { kind: 'text', from: c?.name ?? 'Mission', color: c?.color, text: def ? `${def.title}: nice work. Your cut is in.` : 'Mission passed.', amount: e.amount });
          return;
        }
        this.pending.push(e.amount);
      }),
      ev.on('activityMilestone', (e) => mine(e) && this.claim(view, payoutName(e.kind), e.reward)),
      ev.on('streetRunFinished', (e) => mine(e) && e.reward > 0 && this.claim(view, `Street Run: ${e.medal} finish`, e.reward)),
      ev.on('stunt', (e) => mine(e) && e.bonus > 0 && this.claim(view, e.unique ? 'Unique stunt bonus' : 'Stunt bonus', e.bonus)),
      ev.on('pickup', (e) => {
        if (e.kind === 'package') this.claim(view, 'Hidden package', this.pendingSum());
        else if (e.kind === 'money') this.claim(view, 'Cash picked up', this.pendingSum());
      }),
    );
  }

  unbind(): void {
    for (const u of this.unsub) u();
    this.unsub = [];
  }

  /** A text from someone (a call answered, a missed call). */
  text(view: ViewState, from: string, text: string, color?: string, kind: PhoneEntry['kind'] = 'text'): void {
    this.add(view, { kind, from, color, text });
  }

  /** Books the money of this frame that nothing claimed (a cheat, business income) as payments. Once a frame. */
  flush(view: ViewState): void {
    for (const a of this.pending) this.add(view, { kind: 'earning', from: 'Bank', text: 'Payment received', amount: a });
    this.pending = [];
  }

  private pendingSum(): number {
    return this.pending.reduce((a, b) => a + b, 0);
  }

  /** An earning for what paid this frame's money; `amount` is what it says it paid. */
  private claim(view: ViewState, what: string, amount: number): void {
    this.pending = [];
    if (amount > 0) this.add(view, { kind: 'earning', from: 'Bank', text: what, amount });
  }

  private add(view: ViewState, e: Omit<PhoneEntry, 'day' | 'time'>): void {
    this.list.unshift({ ...e, day: view.clock.day, time: view.clock.label() });
    if (this.list.length > MAX_TEXTS) this.list.length = MAX_TEXTS;
  }
}

export interface CallState {
  contact: ContactDef;
  mission: MissionDef;
  /** Seconds it has rung. */
  t: number;
}

/** What may hold an incoming call back (the game tells it every frame). */
export interface CallFrame {
  /** A line of dialogue or a title card is up. */
  talking: boolean;
  inVehicle: boolean;
}

/**
 * Incoming calls: a contact rings once about each mission that becomes available during the session (after a mission
 * pass, say), CALL_DELAY s after it does and once no mission, side job (a cab ride aside), line of dialogue, title card,
 * wasted / busted screen or fade is up. Never during those. A call nobody answers is a missed call (see PhoneLog).
 */
export class PhoneCalls {
  ringing: CallState | null = null;
  private known = new Set<string>();
  private queue: Array<{ contact: ContactDef; mission: MissionDef }> = [];
  private wait = 0;

  /** A new session: the work on offer now is not news. */
  reset(view: ViewState): void {
    this.known = new Set(view.missions.offers().map((d) => d.id));
    this.queue = [];
    this.ringing = null;
    this.wait = 0;
  }

  /** Steps the calls; returns 'missed' or 'answer' (hands-free in a vehicle) when the ringing call ends by itself. */
  update(dt: number, view: ViewState, me: PlayerView, frame: CallFrame): 'missed' | 'answer' | null {
    for (const d of view.missions.offers()) {
      if (this.known.has(d.id)) continue;
      this.known.add(d.id);
      if (!contactUnlocked(view.missions.defs, me.progress, d.giver)) continue;
      this.queue.push({ contact: contactById(d.giver), mission: d });
      this.wait = Math.max(this.wait, CALL_DELAY);
    }
    const job = view.activities.job;
    const quiet = !view.missions.active && (!job || job.kind === 'cab') && !frame.talking && !me.down && me.controlLock <= 0;
    const r = this.ringing;
    if (r) {
      // Still on offer and still quiet: ring on. Work taken up meanwhile (he walked into the marker) ends the call.
      if (!quiet || !view.missions.offers().includes(r.mission)) {
        this.ringing = null;
        if (view.missions.offers().includes(r.mission)) this.queue.unshift(r);
        return null;
      }
      r.t += dt;
      if (frame.inVehicle && r.t >= CALL_HANDS_FREE) return 'answer';
      if (r.t >= CALL_RING) {
        this.ringing = null;
        return 'missed';
      }
      return null;
    }
    if (!quiet) {
      this.wait = Math.max(this.wait, 1);
      return null;
    }
    if (this.wait > 0) {
      this.wait -= dt;
      return null;
    }
    while (this.queue.length > 0) {
      const next = this.queue.shift()!;
      if (!view.missions.offers().includes(next.mission)) continue;
      this.ringing = { ...next, t: 0 };
      break;
    }
    return null;
  }

  /** Picks the ringing call up; returns it. */
  answer(): CallState | null {
    const r = this.ringing;
    this.ringing = null;
    return r;
  }
}

/** The phone screen's view of the game. */
export interface PhoneHost {
  view(): ViewState;
  me(): PlayerView;
  texts(): readonly PhoneEntry[];
  /** Calls a contact: their offer line, and the GPS to them when they have work. */
  callContact(id: string): void;
  callCab(): void;
  /** Opens the map over the phone (closing it comes back here). */
  openMap(): void;
  /** Opens the pause menu over the phone. */
  pause(): void;
  click(): void;
}

interface Row {
  el: HTMLElement;
  /** None for a text: it is selected only to bring it into view. */
  action?: () => void;
}

/** The phone: a contact list with Azura Cab, the texts and the map. Arrow keys / W S or the D-pad and Enter / A; Esc / B or the phone key closes it. */
export function showPhone(ctx: MenuCtx, host: PhoneHost, onClose?: () => void): void {
  const el = h('div', 'screen phone-screen');
  const body = h('div', 'phone');
  const top = h('div', 'phone-top');
  const title = h('div', 'phone-title');
  const list = h('div', 'phone-list');
  const foot = h('div', 'phone-foot');
  body.append(top, title, list, foot);
  el.appendChild(body);
  let view: 'home' | 'texts' = 'home';
  let rows: Row[] = [];
  let sel = 0;
  let footDevice = '';
  const select = (i: number) => {
    sel = i;
    rows.forEach((r, k) => r.el.classList.toggle('sel', k === i));
    rows[i]?.el.scrollIntoView?.({ block: 'nearest' });
  };
  const addEntry = (r: HTMLElement, action?: () => void, color?: string) => {
    if (color) r.style.setProperty('--who', color);
    const i = rows.length;
    r.addEventListener('click', () => {
      select(i);
      if (!action) return;
      host.click();
      action();
    });
    r.addEventListener('mousemove', () => {
      if (sel !== i) select(i);
    });
    rows.push({ el: r, action });
    list.appendChild(r);
  };
  const addRow = (cls: string, html: string, action: () => void, color?: string) => addEntry(h('div', `phone-row ${cls}`, html), action, color);
  const render = () => {
    const v = host.view();
    top.textContent = `${v.clock.label()}  ·  DAY ${v.clock.day}`;
    list.textContent = '';
    rows = [];
    if (view === 'home') {
      title.textContent = 'CONTACTS';
      const offers = v.missions.offers();
      for (const c of phoneContacts(v, host.me())) {
        const work = offers.some((d) => d.giver === c.id);
        addRow(`contact${work ? ' work' : ''}`, `<b>${escapeHtml(c.phoneName)}</b><small>${work ? 'Has work for you' : 'Call'}</small>`, () => host.callContact(c.id), c.color);
      }
      addRow('cab', '<b>Azura Cab</b><small>A ride to your map waypoint</small>', () => host.callCab(), '#f2c230');
      const n = host.texts().length;
      addRow('texts', `<b>Texts</b><small>${n === 0 ? 'No messages' : `${n} message${n === 1 ? '' : 's'}`}</small>`, () => {
        view = 'texts';
        render();
        select(0);
      });
      addRow('map', '<b>Map</b><small>Set a waypoint</small>', () => host.openMap());
    } else {
      title.textContent = 'TEXTS';
      const texts = host.texts();
      if (texts.length === 0) list.appendChild(h('div', 'phone-empty', 'No messages yet.'));
      // Each text is a row of its own (newest first, selected on opening), so up / down scroll a long log into view.
      for (const t of texts) {
        const amount = t.amount !== undefined ? `<span class="amount">+${formatMoney(t.amount)}</span>` : '';
        addEntry(h('div', `phone-text ${t.kind}`, `<div class="phone-text-head"><b>${escapeHtml(t.from)}</b><span>Day ${t.day} ${escapeHtml(t.time)}</span></div><div>${escapeHtml(t.text)}${amount}</div>`), undefined, t.color);
      }
      addRow('back', '<b>Back</b>', () => {
        view = 'home';
        render();
        select(0);
      });
    }
    select(Math.min(sel, rows.length - 1));
    footDevice = '';
  };
  const showFoot = () => {
    if (footDevice === ctx.device) return;
    footDevice = ctx.device;
    foot.innerHTML =
      view === 'texts'
        ? ctx.device === 'pad'
          ? `${padGlyph('up')}${padGlyph('down')} scroll · ${padGlyph('b')} back`
          : formatKeys('<kbd>↑</kbd><kbd>↓</kbd> scroll · <kbd>Esc</kbd> back · <kbd>Tab</kbd> phone', 'kb', { labels: ctx.keys })
        : ctx.device === 'pad'
          ? `${padGlyph('up')}${padGlyph('down')} choose · ${padGlyph('a')} select · ${padGlyph('b')} close`
          : formatKeys('<kbd>Enter</kbd> select · <kbd>Esc</kbd> close · <kbd>Tab</kbd> phone', 'kb', { labels: ctx.keys });
  };
  render();
  select(0);
  showFoot();
  ctx.push({
    el,
    tick: () => showFoot(),
    input: (ui) => {
      if (ui.back) {
        if (view === 'texts') {
          view = 'home';
          render();
          select(0);
        } else ctx.pop();
        return;
      }
      if (ui.phone) {
        ctx.pop();
        return;
      }
      if (ui.pause) {
        host.pause();
        return;
      }
      if (ui.map) {
        host.openMap();
        return;
      }
      const n = rows.length;
      if (n === 0) return;
      if (ui.up) select((sel + n - 1) % n);
      if (ui.down) select((sel + 1) % n);
      const action = rows[sel]?.action;
      if (ui.confirm && action) {
        host.click();
        action();
      }
    },
    refresh: () => render(),
    close: onClose,
  });
}

/** The incoming-call card on the HUD. */
export class PhoneWidget {
  readonly card: HTMLDivElement;
  private shown = '';

  constructor(parent: HTMLElement) {
    this.card = h('div', 'phone-call hidden');
    parent.appendChild(this.card);
  }

  /** Shows the ringing call (null: none), with the key that answers it for the device in use. */
  update(call: CallState | null, device: 'kb' | 'pad', keys: MenuCtx['keys'] | undefined, inVehicle: boolean): void {
    const key = !call ? '' : inVehicle ? 'Hands-free' : device === 'pad' ? `${padGlyph('right')} to answer` : formatKeys('Press <kbd>Tab</kbd> to answer', 'kb', { labels: keys });
    const html = call ? `<div class="phone-call-head">INCOMING CALL</div><b>${escapeHtml(call.contact.phoneName)}</b><small>${key}</small>` : '';
    if (html === this.shown) return;
    this.shown = html;
    this.card.classList.toggle('hidden', !call);
    if (call) {
      this.card.innerHTML = html;
      this.card.style.setProperty('--who', call.contact.color);
    }
  }
}
