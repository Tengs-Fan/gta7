// Gun shop.

import { formatMoney } from '../../core/math';
import { shopItems } from '../../sim/interactions';
import { weaponKindOf } from '../../sim/specs';
import { padGlyph, type InputDevice } from '../glyphs';
import { escapeHtml } from '../hud';
import { h, localPlayer, type MenuCtx } from './shared';

export function showShop(ctx: MenuCtx, onClose: () => void): void {
  const sim = ctx.host.sim();
  const me = localPlayer(ctx.host);
  if (!sim || !me) return;
  const el = h('div', 'screen dim');
  const panel = h('div', 'panel');
  panel.style.width = 'min(620px, 92vw)';
  const head = h('h2', '', 'BANG BANG GUNS');
  const money = h('div', 'money');
  const list = h('div', 'shop-list');
  const msg = h('div', 'shop-msg');
  const items = shopItems();
  let sel = 0;
  const rows: HTMLDivElement[] = [];
  const render = () => {
    money.textContent = formatMoney(me.progress.money);
    items.forEach((it, i) => {
      const r = rows[i]!;
      const owned = it.weapon ? me.character.inventory.has(it.weapon) : false;
      const price = sim.interactions.priceOf(it, me);
      const kind = it.weapon ? weaponKindOf(it.weapon) : null;
      if (kind === 'melee') {
        // A bat or a knife has no ammo: owned or not, and its price until it is.
        r.innerHTML = `<span>${escapeHtml(it.label)}</span><span class="own">${owned ? 'owned' : ''}</span><span class="price">${owned ? '—' : formatMoney(price)}</span>`;
      } else {
        const unit = kind === 'thrown' ? '' : ' rounds';
        r.innerHTML = `<span>${escapeHtml(it.label)}${owned ? ' <span class="own">(ammo +' + it.ammo + ')</span>' : it.weapon ? ` <span class="own">+${it.ammo}${unit}</span>` : ''}</span><span class="own">${it.weapon ? me.character.inventory.total(it.weapon) + ' owned' : ''}</span><span class="price">${formatMoney(price)}</span>`;
      }
      r.classList.toggle('sel', i === sel);
    });
  };
  const buy = (i: number) => {
    const err = sim.interactions.buy(items[i]!.id, me);
    msg.textContent = err ?? `Bought: ${items[i]!.label}`;
    ctx.host.click();
    render();
  };
  items.forEach((_it, i) => {
    const r = h('div', 'shop-item');
    r.addEventListener('click', () => {
      sel = i;
      buy(i);
    });
    r.addEventListener('mousemove', () => {
      if (sel === i) return;
      sel = i;
      render();
    });
    rows.push(r);
    list.appendChild(r);
  });
  render();
  panel.append(head, money, list, msg);
  // How to buy, for the device in use (Enter has no pad button, and Start, the pad's Esc, does not leave), beside LEAVE.
  const row = h('div', 'row-end');
  const how = h('div', 'shop-how');
  let howDevice: InputDevice | null = null;
  const showHow = () => {
    howDevice = ctx.device;
    how.innerHTML = ctx.device === 'pad' ? `${padGlyph('up')}${padGlyph('down')} to choose · ${padGlyph('a')} to buy · ${padGlyph('b')} to leave` : 'Click or press <kbd>Enter</kbd> to buy, <kbd>Esc</kbd> to leave.';
  };
  showHow();
  const back = h('button', 'btn primary', 'LEAVE');
  back.addEventListener('click', () => {
    ctx.pop();
  });
  row.append(how, back);
  panel.appendChild(row);
  el.appendChild(panel);
  ctx.push({
    el,
    tick: () => {
      if (howDevice !== ctx.device) showHow();
    },
    input: (ui) => {
      if (ui.back) ctx.pop();
      else if (ui.up) {
        sel = (sel + items.length - 1) % items.length;
        render();
      } else if (ui.down) {
        sel = (sel + 1) % items.length;
        render();
      } else if (ui.confirm) buy(sel);
    },
    close: onClose,
  });
}
