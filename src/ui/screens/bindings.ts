// KEY BINDINGS (from SETTINGS): pick an action, press the key for it. A key another action has is refused with a
// message naming that action (never swapped); Escape cancels the wait. RESET TO DEFAULTS puts every key back.

import { ACTIONS, actionLabel, DEFAULT_BINDINGS, rebind, type ActionId } from '../../input/bindings';
import { padGlyph } from '../glyphs';
import { escapeHtml } from '../hud';
import { h, type MenuCtx } from './shared';

/** The line shown when `code` cannot go to `action` (see rebind). */
export function rebindRefusal(ctx: MenuCtx, action: ActionId, code: string): string | null {
  const r = rebind(ctx.host.settings().bindings, action, code);
  if (r.ok) return null;
  const name = ctx.keys.keyName(code);
  if (r.taken) return `${name} is already used for ${actionLabel(r.taken)}. Bind that to another key first.`;
  return `${name} is kept for ${r.reserved}.`;
}

export function showBindings(ctx: MenuCtx): void {
  const el = h('div', 'screen dim');
  const panel = h('div', 'panel bindings-panel');
  panel.appendChild(h('h2', '', 'KEY BINDINGS'));
  const note = h('div', 'setting-note bind-note');
  const rows: Array<{ el: HTMLElement; activate(): void; value?: HTMLElement; action?: ActionId }> = [];
  let sel = 0;
  let waiting: ActionId | null = null;
  const select = (i: number) => {
    sel = i;
    rows.forEach((r, k) => r.el.classList.toggle('sel', k === i));
    rows[i]?.el.scrollIntoView?.({ block: 'nearest' });
  };
  const show = () => {
    const b = ctx.host.settings().bindings;
    for (const r of rows) {
      if (!r.action || !r.value) continue;
      r.value.textContent = waiting === r.action ? 'Press a key…' : ctx.keys.keyName(b[r.action]);
      r.el.classList.toggle('waiting', waiting === r.action);
    }
  };
  const say = (text: string, bad = false) => {
    note.textContent = text;
    note.classList.toggle('bad', bad);
  };
  const stop = () => {
    waiting = null;
    ctx.host.cancelCapture?.();
    show();
  };
  const listen = (action: ActionId) => {
    waiting = action;
    say(ctx.device === 'pad' ? `Press the key for ${actionLabel(action)} on the keyboard. B cancels.` : `Press the key for ${actionLabel(action)}. Esc cancels.`);
    show();
    ctx.host.captureKey?.((code) => {
      if (waiting !== action) return;
      waiting = null;
      if (code === 'Escape') {
        say('Cancelled.');
        show();
        return;
      }
      const why = rebindRefusal(ctx, action, code);
      if (why) say(why, true);
      else {
        const s = ctx.host.settings();
        const r = rebind(s.bindings, action, code);
        if (r.ok) ctx.host.applySettings({ ...s, bindings: r.bindings });
        say(`${actionLabel(action)}: ${ctx.keys.keyName(code)}.`);
      }
      show();
    });
  };
  const addRow = (row: HTMLElement, activate: () => void, extra: Partial<(typeof rows)[number]> = {}) => {
    const i = rows.length;
    rows.push({ el: row, activate, ...extra });
    row.addEventListener('click', () => {
      select(i);
      ctx.host.click();
      activate();
    });
    row.addEventListener('mousemove', () => {
      if (i !== sel) select(i);
    });
  };
  const list = h('div', 'bind-list');
  for (const a of ACTIONS) {
    const row = h('div', 'setting bind-row');
    const value = h('span', 'bind-key');
    row.append(h('span', '', escapeHtml(a.label)), value);
    list.appendChild(row);
    addRow(row, () => (waiting === a.id ? stop() : listen(a.id)), { value, action: a.id });
  }
  // The message goes above the list, held at the top as the panel scrolls: it must be seen as the key is pressed.
  panel.appendChild(note);
  panel.appendChild(list);
  const fixed = h('p', 'bind-fixed', 'The arrow keys, Esc, Enter, Backspace, right Shift, the number keys and + / - keep their jobs. A gamepad has fixed buttons (see CONTROLS).');
  panel.appendChild(fixed);
  const end = h('div', 'row-end');
  const reset = h('button', 'btn', 'RESET TO DEFAULTS');
  reset.addEventListener('click', () => {
    stop();
    ctx.host.applySettings({ ...ctx.host.settings(), bindings: { ...DEFAULT_BINDINGS } });
    say('Every key is back to its default.');
    show();
  });
  const back = h('button', 'btn primary', 'BACK');
  back.addEventListener('click', () => ctx.pop());
  end.append(reset, back);
  panel.appendChild(end);
  addRow(reset, () => reset.click());
  addRow(back, () => back.click());
  el.appendChild(panel);
  show();
  select(0);
  say(ctx.device === 'pad' ? `${padGlyph('a')} on an action, then press its new key on the keyboard.` : 'Choose an action, then press its new key.');
  ctx.push({
    el,
    input: (ui) => {
      // A key press goes to the waiting rebind (Input.captureKey); a pad's B gives up the wait.
      if (waiting) {
        if (ui.back) {
          stop();
          say('Cancelled.');
        }
        return;
      }
      if (ui.back) {
        ctx.pop();
        return;
      }
      const n = rows.length;
      if (ui.up) select((sel + n - 1) % n);
      if (ui.down) select((sel + 1) % n);
      if (ui.confirm) {
        ctx.host.click();
        rows[sel]?.activate();
      }
    },
    close: () => ctx.host.cancelCapture?.(),
  });
}
