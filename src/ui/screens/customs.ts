// Azura Customs: engine, brakes and tyre upgrades and paint for the car the player drove in (sim/mods.ts).

import { formatMoney } from '../../core/math';
import { buyMod, buyPaint, MAX_MOD_LEVEL, MOD_CATEGORIES, MOD_TABLE, nextModPrice, PAINT_COLORS, PAINT_PRICE } from '../../sim/mods';
import { padGlyph, type InputDevice } from '../glyphs';
import { escapeHtml } from '../hud';
import { registerScreen } from './registry';
import { h, localPlayer, type MenuCtx } from './shared';
import './customs.css';

const hex = (c: number): string => `#${c.toString(16).padStart(6, '0')}`;

export function showCustoms(ctx: MenuCtx, onClose: () => void): boolean {
  const sim = ctx.host.sim();
  const me = localPlayer(ctx.host);
  const car = me?.character.vehicle;
  if (!sim || !me || !car) return false;
  const el = h('div', 'screen dim');
  const panel = h('div', 'panel customs');
  panel.style.width = 'min(660px, 92vw)';
  const head = h('h2', '', 'AZURA CUSTOMS');
  const sub = h('p', 'customs-sub', `${escapeHtml(car.spec.name)} · upgrades stay with this car; store it in your garage to keep them through a save.`);
  const money = h('div', 'money');
  const list = h('div', 'shop-list');
  const msg = h('div', 'shop-msg');
  const rowCount = MOD_CATEGORIES.length + 1;
  let sel = 0;
  let paint = Math.max(0, PAINT_COLORS.findIndex((p) => p.color === car.color));
  const rows: HTMLDivElement[] = [];
  const render = () => {
    money.textContent = formatMoney(me.progress.money);
    MOD_CATEGORIES.forEach((cat, i) => {
      const t = MOD_TABLE[cat];
      const lvl = car.mods[cat];
      const price = nextModPrice(car, cat);
      const pips = Array.from({ length: MAX_MOD_LEVEL }, (_v, k) => `<i class="pip${k < lvl ? ' on' : ''}"></i>`).join('');
      const r = rows[i]!;
      r.dataset.cat = cat;
      r.dataset.level = String(lvl);
      r.innerHTML = `<span>${escapeHtml(t.label)} <span class="own">+${Math.round((t.multipliers[MAX_MOD_LEVEL]! - 1) * 100)}% ${escapeHtml(t.effect)} at max</span></span><span class="own">${pips} LVL ${lvl}/${MAX_MOD_LEVEL}</span><span class="price">${price === null ? 'MAX' : formatMoney(price)}</span>`;
      r.classList.toggle('sel', i === sel);
    });
    const pr = rows[MOD_CATEGORIES.length]!;
    const c = PAINT_COLORS[paint]!;
    pr.dataset.cat = 'paint';
    pr.innerHTML = `<span>Paint <span class="own">${ctx.device === 'pad' ? `${padGlyph('left')}${padGlyph('right')}` : '&larr; &rarr;'} ${escapeHtml(c.name)}</span></span><span class="swatches">${PAINT_COLORS.map((p, k) => `<i class="swatch${k === paint ? ' on' : ''}${p.color === car.color ? ' cur' : ''}" style="background:${hex(p.color)}"></i>`).join('')}</span><span class="price">${formatMoney(PAINT_PRICE)}</span>`;
    pr.classList.toggle('sel', sel === MOD_CATEGORIES.length);
  };
  const buy = (i: number) => {
    let err: string | null;
    let what: string;
    if (i < MOD_CATEGORIES.length) {
      const cat = MOD_CATEGORIES[i]!;
      const price = nextModPrice(car, cat);
      err = buyMod(me.progress, car, cat);
      what = `${MOD_TABLE[cat].label} level ${car.mods[cat]}`;
      if (!err && price !== null) sim.events.emit('money', { amount: -price, ...me.tag });
    } else {
      const c = PAINT_COLORS[paint]!;
      err = buyPaint(me.progress, car, c.color);
      what = `${c.name} paint`;
      if (!err) sim.events.emit('money', { amount: -PAINT_PRICE, ...me.tag });
    }
    msg.textContent = err ?? `Done: ${what}.`;
    ctx.host.click();
    render();
  };
  for (let i = 0; i < rowCount; i++) {
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
  }
  render();
  panel.append(head, sub, money, list, msg);
  const row = h('div', 'row-end');
  const how = h('div', 'shop-how');
  let howDevice: InputDevice | null = null;
  const showHow = () => {
    howDevice = ctx.device;
    how.innerHTML = ctx.device === 'pad' ? `${padGlyph('up')}${padGlyph('down')} to choose · ${padGlyph('a')} to buy · ${padGlyph('b')} to drive off` : 'Click or <kbd>Enter</kbd> to buy, arrows for paint, <kbd>Esc</kbd> to drive off.';
  };
  showHow();
  const back = h('button', 'btn primary', 'DRIVE OFF');
  back.addEventListener('click', () => ctx.pop());
  row.append(how, back);
  panel.appendChild(row);
  el.appendChild(panel);
  ctx.push({
    el,
    tick: () => {
      if (howDevice !== ctx.device) {
        showHow();
        render();
      }
    },
    input: (ui) => {
      if (ui.back) ctx.pop();
      else if (ui.up) {
        sel = (sel + rowCount - 1) % rowCount;
        render();
      } else if (ui.down) {
        sel = (sel + 1) % rowCount;
        render();
      } else if ((ui.left || ui.right) && sel === MOD_CATEGORIES.length) {
        paint = (paint + (ui.right ? 1 : PAINT_COLORS.length - 1)) % PAINT_COLORS.length;
        render();
      } else if (ui.confirm) buy(sel);
    },
    close: onClose,
  });
  return true;
}

registerScreen('customs', showCustoms);
