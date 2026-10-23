// Settings.

import { clamp } from '../../core/math';
import { QUALITY } from '../../render/quality';
import { FPS_CAPS, SUBTITLE_SIZES, type Settings } from '../../settings';
import { showBindings } from './bindings';
import { showSlots } from './slots';
import { h, showConfirm, type MenuCtx } from './shared';

export function showSettings(ctx: MenuCtx): void {
  const s = { ...ctx.host.settings() };
  const el = h('div', 'screen dim');
  const panel = h('div', 'panel');
  panel.appendChild(h('h2', '', 'SETTINGS'));
  // Key bindings (their own screen) and the map legend change settings under this one: keep theirs.
  const apply = () => {
    const now = ctx.host.settings();
    ctx.host.applySettings({ ...s, bindings: now.bindings, mapLayers: now.mapLayers });
  };
  // Keyboard / gamepad: up / down pick a row, left / right adjust it, confirm activates it.
  const rows: Array<{ el: HTMLElement; adjust?(d: number): void; activate?(): void; skip?(): boolean }> = [];
  let sel = 0;
  const select = (i: number) => {
    sel = i;
    rows.forEach((r, k) => r.el.classList.toggle('sel', k === i));
    // The panel scrolls in short windows (1280 x 560): the picked row stays in view.
    rows[i]?.el.scrollIntoView?.({ block: 'nearest' });
  };
  const move = (d: number) => {
    const n = rows.length;
    for (let k = 1; k <= n; k++) {
      const i = (sel + d * k + n * 10) % n;
      if (!rows[i]!.skip?.()) {
        select(i);
        return;
      }
    }
  };
  const addRow = (r: (typeof rows)[number]) => {
    const i = rows.length;
    rows.push(r);
    // As in ButtonList: only a real mouse move picks a row, and never a skipped one (DELETE SAVE greyed out).
    r.el.addEventListener('mousemove', () => {
      if (i !== sel && !r.skip?.()) select(i);
    });
    r.el.addEventListener('focusin', () => {
      if (!r.skip?.()) select(i);
    });
  };
  const slider = (label: string, key: 'master' | 'music' | 'sfx' | 'sensitivity' | 'fov' | 'resolutionScale', min: number, max: number, stepv: number, keyStep: number, fmt: (v: number) => string) => {
    const row = h('div', 'setting');
    const lab = h('span', '', label);
    const input = h('input');
    input.type = 'range';
    input.ariaLabel = label;
    input.min = String(min);
    input.max = String(max);
    input.step = String(stepv);
    input.value = String(s[key]);
    input.style.pointerEvents = 'auto';
    const val = h('span', '', fmt(s[key]));
    const set = (v: number) => {
      s[key] = v;
      input.value = String(v);
      val.textContent = fmt(v);
      apply();
    };
    input.addEventListener('input', () => set(Number(input.value)));
    row.append(lab, input, val);
    panel.appendChild(row);
    // Snapped to the slider's step so repeated presses don't drift (0.7999999...).
    const snap = (v: number) => Number((Math.round(v / stepv) * stepv).toFixed(6));
    addRow({ el: row, adjust: (d) => set(clamp(snap(s[key] + d * keyStep), min, max)) });
  };
  const qualities = ['auto', 'low', 'medium', 'high'] as const;
  const qinfo = ctx.host.quality?.() ?? null;
  const qrow = h('div', 'setting');
  const qsel = h('select');
  qsel.ariaLabel = 'Graphics quality';
  for (const q of qualities) {
    const o = h('option');
    o.value = q;
    o.textContent = q === 'auto' && qinfo ? `AUTO (${qinfo.auto.toUpperCase()})` : q.toUpperCase();
    if (s.quality === q) o.selected = true;
    qsel.appendChild(o);
  }
  // Everything else applies at once (Low's FXAA included, where the renderer post-processes); MSAA is fixed
  // when the renderer is created.
  const qnote = h('div', 'setting-note');
  const showNote = () => {
    if (qinfo?.software) {
      qnote.textContent = 'Software rendering detected. Hardware acceleration improves performance.';
      qnote.classList.remove('hidden');
      return;
    }
    const tier = s.quality === 'auto' ? qinfo?.auto : s.quality;
    const msaa = tier ? QUALITY[tier].msaa : null;
    const pending = qinfo !== null && msaa !== null && msaa !== qinfo.msaa;
    qnote.textContent = pending
      ? msaa
        ? 'MSAA anti-aliasing turns on after a reload.'
        : qinfo.post === false
          ? 'MSAA turns off after a reload.'
          : 'FXAA applies now; MSAA turns off after a reload.'
      : '';
    qnote.classList.toggle('hidden', !pending);
  };
  const setQuality = (q: Settings['quality']) => {
    s.quality = q;
    qsel.value = q;
    showNote();
    apply();
  };
  qsel.addEventListener('change', () => setQuality(qsel.value as Settings['quality']));
  qrow.append(h('span', '', 'Graphics quality'), qsel, h('span', '', ''), qnote);
  showNote();
  panel.appendChild(qrow);
  addRow({
    el: qrow,
    adjust: (d) => {
      const q = qualities[clamp(qualities.indexOf(s.quality) + d, 0, qualities.length - 1)]!;
      if (q !== s.quality) setQuality(q);
    },
  });
  const pct = (v: number) => `${Math.round(v * 100)}%`;
  slider('Master volume', 'master', 0, 1, 0.05, 0.05, pct);
  slider('Music (radio)', 'music', 0, 1, 0.05, 0.05, pct);
  slider('Sound effects', 'sfx', 0, 1, 0.05, 0.05, pct);
  slider('Mouse sensitivity', 'sensitivity', 0.2, 3, 0.05, 0.1, (v) => v.toFixed(2));
  slider('Field of view', 'fov', 55, 90, 1, 5, (v) => `${v}°`);
  // On / off rows: a checkbox, with its state spelled out in the value column like the sliders'.
  const toggle = (label: string, key: 'invertY' | 'hints' | 'lightningFlashes' | 'cameraShake') => {
    const row = h('div', 'setting');
    const box = h('input');
    box.type = 'checkbox';
    box.ariaLabel = label;
    box.checked = s[key];
    box.style.pointerEvents = 'auto';
    const val = h('span', '', s[key] ? 'On' : 'Off');
    const set = (v: boolean) => {
      s[key] = v;
      box.checked = v;
      val.textContent = v ? 'On' : 'Off';
      apply();
    };
    box.addEventListener('change', () => set(box.checked));
    row.append(h('span', '', label), box, val);
    panel.appendChild(row);
    addRow({ el: row, adjust: () => set(!s[key]), activate: () => set(!s[key]) });
  };
  toggle('Invert look Y', 'invertY');
  toggle('Tutorial hints', 'hints');
  const weathers: ReadonlyArray<readonly [Settings['weather'], string]> = [['dynamic', 'Dynamic'], ['clear', 'Always clear']];
  const wrow = h('div', 'setting');
  const wsel = h('select');
  wsel.ariaLabel = 'Weather';
  for (const [v, label] of weathers) {
    const o = h('option');
    o.value = v;
    o.textContent = label;
    if (s.weather === v) o.selected = true;
    wsel.appendChild(o);
  }
  const setWeather = (v: Settings['weather']) => {
    s.weather = v;
    wsel.value = v;
    apply();
  };
  wsel.addEventListener('change', () => setWeather(wsel.value === 'clear' ? 'clear' : 'dynamic'));
  wrow.append(h('span', '', 'Weather'), wsel, h('span', '', ''));
  panel.appendChild(wrow);
  addRow({ el: wrow, adjust: () => setWeather(s.weather === 'clear' ? 'dynamic' : 'clear'), activate: () => setWeather(s.weather === 'clear' ? 'dynamic' : 'clear') });
  toggle('Lightning flashes', 'lightningFlashes');
  slider('Resolution scale', 'resolutionScale', 0.5, 1, 0.05, 0.05, pct);
  // A row of fixed choices: a select, stepped by left / right and cycled by confirm.
  const choice = <K extends 'fpsCap' | 'subtitleSize'>(label: string, key: K, values: ReadonlyArray<Settings[K]>, name: (v: Settings[K]) => string) => {
    const row = h('div', 'setting');
    const sel = h('select');
    sel.ariaLabel = label;
    values.forEach((v, i) => {
      const o = h('option');
      o.value = String(i);
      o.textContent = name(v);
      if (s[key] === v) o.selected = true;
      sel.appendChild(o);
    });
    const set = (v: Settings[K]) => {
      s[key] = v;
      sel.value = String(values.indexOf(v));
      apply();
    };
    sel.addEventListener('change', () => set(values[Number(sel.value)] ?? values[0]!));
    row.append(h('span', '', label), sel, h('span', '', ''));
    panel.appendChild(row);
    const step = (d: number) => set(values[clamp(values.indexOf(s[key]) + d, 0, values.length - 1)]!);
    addRow({ el: row, adjust: step, activate: () => set(values[(values.indexOf(s[key]) + 1) % values.length]!) });
  };
  choice('FPS cap', 'fpsCap', FPS_CAPS, (v) => (v === 0 ? 'Unlimited' : `${v} FPS`));
  choice('Subtitle size', 'subtitleSize', SUBTITLE_SIZES, (v) => v.charAt(0).toUpperCase() + v.slice(1));
  toggle('Camera shake', 'cameraShake');
  const keysRow = h('div', 'setting setting-link');
  keysRow.append(h('span', '', 'Key bindings'), h('span', 'setting-go', 'Change keyboard keys ›'), h('span', '', ''));
  keysRow.addEventListener('click', () => {
    ctx.host.click();
    showBindings(ctx);
  });
  panel.appendChild(keysRow);
  addRow({ el: keysRow, activate: () => showBindings(ctx) });
  const row = h('div', 'row-end');
  const del = h('button', 'btn', 'DELETE SAVE');
  del.disabled = !ctx.host.hasSave();
  // With save slots it asks which one (and confirms there); the button greys out once none is left.
  del.addEventListener('click', () =>
    ctx.host.slots
      ? showSlots(ctx, 'delete')
      : showConfirm(ctx, 'Delete your saved game? This cannot be undone.', () => {
          ctx.host.deleteSave();
          del.disabled = true;
          if (rows[sel]?.el === del) move(1);
        }),
  );
  const back = h('button', 'btn primary', 'BACK');
  back.addEventListener('click', () => ctx.pop());
  row.append(del, back);
  panel.appendChild(row);
  addRow({ el: del, activate: () => del.click(), skip: () => del.disabled });
  addRow({ el: back, activate: () => back.click() });
  select(0);
  el.appendChild(panel);
  ctx.push({
    el,
    input: (ui) => {
      if (ui.back) {
        ctx.pop();
        return;
      }
      if (ui.up) move(-1);
      if (ui.down) move(1);
      const r = rows[sel]!;
      if (ui.left) r.adjust?.(-1);
      if (ui.right) r.adjust?.(1);
      if (ui.confirm) r.activate?.();
    },
    // Back from the slot picker: DELETE SAVE greys out once no slot holds a save.
    refresh: () => {
      del.disabled = !ctx.host.hasSave();
      if (rows[sel]?.el === del && del.disabled) move(1);
    },
  });
}
