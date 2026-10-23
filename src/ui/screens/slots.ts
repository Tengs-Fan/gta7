// The save slot picker: CONTINUE loads a slot, the safehouse saves into one (asking before it overwrites a save),
// SETTINGS deletes one (asking first). Three slots, each with a summary of the save in it.

import { formatMoney } from '../../core/math';
import { STORY } from '../../sim/missions/story';
import type { SlotInfo } from '../../settings';
import { ButtonList, h, showConfirm, type MenuCtx } from './shared';

export type SlotPickerMode = 'load' | 'save' | 'delete';

function clock(hours: number): string {
  const h24 = ((Math.floor(hours) % 24) + 24) % 24;
  const m = Math.floor((hours - Math.floor(hours)) * 60);
  return `${String(h24).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** One line about what a slot holds: missions done, money, game day and time. */
export function slotSummary(info: SlotInfo): string {
  if (info.state === 'empty') return 'Empty';
  if (info.state === 'corrupt' || !info.data) return 'Unreadable save';
  const d = info.data;
  const done = STORY.filter((m) => d.missionsDone.includes(m.id)).length;
  return `Missions ${done}/${STORY.length} · ${formatMoney(d.money)} · Day ${d.day ?? 1} ${clock(d.hours ?? 12)}`;
}

const TITLES: Record<SlotPickerMode, string> = { load: 'CONTINUE', save: 'SAVE GAME', delete: 'DELETE A SAVE' };
const NOTES: Record<SlotPickerMode, string> = {
  load: 'Choose the save to play.',
  save: 'Choose a slot for this game. A slot with a save in it asks before it is replaced.',
  delete: 'Choose the save to delete. Only that slot is touched.',
};

/** The slot picker; `onClose` runs when it closes (Back, or once a choice is done). */
export function showSlots(ctx: MenuCtx, mode: SlotPickerMode, onClose?: () => void): void {
  const host = ctx.host;
  const el = h('div', 'screen dim');
  const panel = h('div', 'panel slots-panel');
  panel.appendChild(h('h2', '', TITLES[mode]));
  panel.appendChild(h('p', 'slots-note', NOTES[mode]));
  let list: ButtonList | null = null;
  const holder = h('div', '');
  panel.appendChild(holder);
  const choose = (info: SlotInfo) => {
    const what = `slot ${info.slot} (${slotSummary(info)})`;
    if (mode === 'load') {
      host.continueGame(info.slot);
      return;
    }
    if (mode === 'save') {
      const write = () => {
        host.saveToSlot?.(info.slot);
        ctx.pop();
      };
      if (info.state === 'empty') write();
      else showConfirm(ctx, `Overwrite ${what}? The save in it is replaced by this game.`, write);
      return;
    }
    showConfirm(ctx, `Delete ${what}? This cannot be undone.`, () => {
      host.deleteSlot?.(info.slot);
      build();
    });
  };
  const build = () => {
    const infos = host.slots?.() ?? [];
    holder.textContent = '';
    list = new ButtonList(
      [
        ...infos.map((info) => {
          const detail = h('span', `slot-summary ${info.state}`, '');
          detail.textContent = slotSummary(info);
          return {
            label: `SLOT ${info.slot}`,
            id: `slot${info.slot}`,
            detail,
            disabled: mode === 'load' ? info.state !== 'ok' : mode === 'delete' ? info.state === 'empty' : false,
            action: () => choose(info),
          };
        }),
        { label: 'BACK', id: 'back', action: () => ctx.pop() },
      ],
      () => host.click(),
    );
    list.el.classList.add('slots-menu');
    holder.appendChild(list.el);
  };
  build();
  el.appendChild(panel);
  ctx.push({
    el,
    input: (ui) => (ui.back ? ctx.pop() : list?.input(ui)),
    // Back from a confirmation: the slots as they are now.
    refresh: () => build(),
    close: onClose,
  });
}
