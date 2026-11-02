// Full-screen map.

import { clamp } from '../../core/math';
import { WHEEL_GESTURE_GAP, WHEEL_STEP } from '../../input/input';
import { padGlyph, type InputDevice } from '../glyphs';
import { escapeHtml } from '../hud';
import { COMPLETION_GROUP_NAMES, COMPLETION_GROUPS, completionPercent, completionRows } from '../../sim/completion';
import {
  blipKind,
  blipOf,
  blipReach,
  collectBlips,
  drawBlip,
  drawLegendIcon,
  drawPoliceOverlay,
  drawRegattaCourse,
  legendRows,
  MAP_BLIP,
  MAP_CATEGORIES,
  MAP_SCALE,
  searchArea,
  visibleBlips,
  type Blip,
  type MapCategory,
} from '../mapRender';
import { COUNTY_NAME, VALLEY_NAME } from '../../world/country';
import { h, localPlayer, type MenuCtx } from './shared';

/** The map zooms out to this many 1.5x steps (negative) from fitting the city, to show the county and the valley beyond it whole. */
const MIN_ZOOM = -2;

/** Full-screen map; `onClose` runs when it closes (opened from gameplay: resume the game). */
export function showMap(menus: MenuCtx, onClose?: () => void): void {
  const sim = menus.host.sim();
  const me = localPlayer(menus.host);
  if (!sim || !me) return;
  const localId = me.id;
  const el = h('div', 'map-screen');
  const canvas = h('canvas');
  el.appendChild(canvas);
  // The cross in the middle, where the keyboard and a pad set the waypoint: the view centre (cx, cz) is
  // drawn at the middle of the canvas, which fills the screen, so CSS puts it there at any pixel ratio.
  el.appendChild(h('div', 'map-cross'));
  el.appendChild(h('div', 'map-title', 'SAN AZURA'));
  // The legend: under a header per category the player can switch off (number keys, a pad's Y to pick and X to switch,
  // a click), a row for each kind of icon on the map now, drawn as the map draws it; then the live markers. Hovering a
  // row, or picking it with Tab (a pad's Y picks the headers), lights its icons up on the map. Off states are kept in
  // the settings (mapLayers).
  const legend = h('div', 'map-legend');
  legend.appendChild(h('div', 'legend-head', 'LEGEND'));
  const legendBody = legend.appendChild(h('div'));
  const legendCue = legend.appendChild(h('div', 'scroll-cue hidden'));
  const layerOn = (id: string) => menus.host.settings().mapLayers[id] !== false;
  /** The legend's rows top to bottom, headers ('#' and the category) and icons (their kind), and the kinds each lights up. */
  let rows: Array<{ id: string; el: HTMLElement; category: MapCategory | null; kinds: string[]; state?: HTMLElement }> = [];
  let pick = -1;
  let hover: (typeof rows)[number] | null = null;
  let legendKey = '';
  // A row rebuilt under a resting pointer may never hear it leave, so leaving the legend itself lets go too.
  legend.addEventListener('pointerleave', () => (hover = null));
  const drawLegend = () => {
    rows.forEach((r, i) => {
      const on = !r.category || layerOn(r.category.id);
      r.el.classList.toggle('off', !on);
      r.el.classList.toggle('sel', i === pick);
      if (r.state) r.state.textContent = on ? 'ON' : 'OFF';
    });
  };
  const toggleLayer = (c: MapCategory | null | undefined) => {
    if (!c) return;
    const s = menus.host.settings();
    menus.host.applySettings({ ...s, mapLayers: { ...s.mapLayers, [c.id]: !layerOn(c.id) } });
    menus.host.click();
    drawLegend();
  };
  /** Rebuilds the rows when the kinds of icon on the map change (a mission marker, the police, a property bought). */
  const buildLegend = (blips: readonly Blip[]) => {
    const groups = legendRows(blips, ['you', 'waypoint', ...(searchArea(sim, localId) ? ['searchArea'] : [])]);
    const key = groups.map((g) => g.kinds.join(',')).join('|');
    if (key === legendKey) return;
    legendKey = key;
    // The rows picked and under the pointer stay so by id (the game runs on under the map in multiplayer).
    const picked = rows[pick]?.id;
    const hovered = hover?.id;
    const dpr = Math.min(2, window.devicePixelRatio > 0 ? window.devicePixelRatio : 1);
    legendBody.innerHTML = '';
    rows = [];
    const add = (r: (typeof rows)[number]) => {
      r.el.addEventListener('pointerenter', () => (hover = r));
      r.el.addEventListener('pointerleave', () => {
        if (hover === r) hover = null;
      });
      legendBody.appendChild(r.el);
      rows.push(r);
    };
    groups.forEach((g, i) => {
      const c = g.category;
      const head = h('div', c ? 'legend-cat' : 'legend-cat fixed', `<span class="legend-key">${c && i < 9 ? i + 1 : ''}</span><span class="legend-name">${escapeHtml(c?.label ?? 'Live markers')}</span>`);
      const state = c ? head.appendChild(h('span', 'legend-state')) : undefined;
      if (c) head.addEventListener('click', () => toggleLayer(c));
      add({ id: `#${c?.id ?? 'live'}`, el: head, category: c, kinds: g.kinds, state });
      for (const id of g.kinds) {
        const row = h('div', 'legend-row');
        row.dataset.kind = id;
        drawLegendIcon(row.appendChild(h('canvas')), id, dpr);
        row.appendChild(h('span', 'legend-name', escapeHtml(blipKind(id).name)));
        add({ id, el: row, category: c, kinds: [id] });
      }
    });
    pick = rows.findIndex((r) => r.id === picked);
    hover = rows.find((r) => r.id === hovered) ?? null;
    drawLegend();
  };
  /** Picks row `i` (-1: none) and scrolls it into view. */
  const select = (i: number) => {
    pick = i;
    drawLegend();
    rows[pick]?.el.scrollIntoView?.({ block: 'nearest' });
  };
  /** Tab (1) and Shift+Tab (-1): the next or the previous row, with none after the last and before the first. */
  const stepPick = (dir: number) => select(((pick + 1 + dir + rows.length + 1) % (rows.length + 1)) - 1);
  /** A pad's Y: the next category's header, and after the last none (the pad names the icons at the cross instead). */
  const stepCategory = () => select(rows.findIndex((r, i) => i > pick && r.id === `#${r.category?.id}`));
  el.appendChild(legend);
  // The completion checklist: the same rows as STATS (the completion registry).
  const list = h('div', 'map-checklist');
  const drawChecklist = () => {
    const rows = completionRows(sim, me);
    const groups = [...new Set([...COMPLETION_GROUPS, ...rows.map((r) => r.group)])];
    list.innerHTML = `<div class="legend-head">CHECKLIST · ${completionPercent(sim, me)}%</div>${groups
      .map((g) => {
        const rs = rows.filter((r) => r.group === g);
        const body = rs.length
          ? rs.map((r) => `<div class="check-row${r.done >= r.total && r.total > 0 ? ' done' : ''}"><span>${escapeHtml(r.label)}</span><b>${r.done} / ${r.total}</b></div>`).join('')
          : '<div class="check-row none"><span>None yet</span><b>—</b></div>';
        return `<div class="check-group">${escapeHtml(COMPLETION_GROUP_NAMES[g] ?? g)}</div>${body}`;
      })
      .join('')}`;
  };
  drawChecklist();
  el.appendChild(list);
  // What to press, for the device in use: the keyboard and a pad set the waypoint at the cross in the middle.
  const hint = h('div', 'map-hint');
  el.appendChild(hint);
  let hintDevice: InputDevice | null = null;
  const showHint = () => {
    hintDevice = menus.device;
    const tab = escapeHtml(menus.keys.label('Tab'));
    // One line at 1280 wide: the keys alone (a mouse drags and wheels anyway), and a waypoint again clears it (README).
    hint.innerHTML =
      menus.device === 'pad'
        ? `${padGlyph('a')} waypoint at the cross (again to clear it) · Left stick or D-pad to pan · ${padGlyph('lb')} ${padGlyph('rb')} to zoom · ${padGlyph('y')} light up a category, ${padGlyph('x')} switch it, ${padGlyph('b')} let go · ${padGlyph('b')} to close`
        : `Click, or <kbd>Enter</kbd> at the cross, for a waypoint · Arrows to pan · <kbd>+</kbd> <kbd>-</kbd> to zoom · <kbd>1</kbd>-<kbd>${Math.min(9, MAP_CATEGORIES.length)}</kbd> legend on / off · <kbd>${tab}</kbd> <kbd>Shift</kbd>+<kbd>${tab}</kbd> light up a row, <kbd>Esc</kbd> let go · <kbd>${escapeHtml(menus.keys.label('KeyM'))}</kbd>/<kbd>Esc</kbd> to close`;
  };
  showHint();
  const ctx = canvas.getContext('2d')!;
  // Start centred on the island showing the whole city, with as much sea north of it as south: the open sea runs on
  // north to Turbine Row (world/offshore.ts), a pan away, and the city keeps its size on the map.
  const b = sim.world.layout.bounds;
  let zoom = 0;
  let cx = (b.landMinX + b.beachEndX) / 2;
  let cz = (b.landMinZ + b.landMaxZ) / 2;
  const fitW = 2 * (b.worldMaxX - cx);
  const fitH = 2 * (b.worldMaxZ - cz);
  let dragging = false;
  let moved = 0;
  let lx = 0;
  let ly = 0;
  // A direction held since before the map opened (W while driving, the left stick while steering) must not pan it by
  // itself: each axis pans only once it has been seen at rest since the map opened. tick() watches from the first
  // frame on, the input guard included, so a key pressed right after the map opened still pans. Presses still step.
  let freeX = false;
  let freeY = false;
  // The map's size on the page (CSS px), measured at each draw: the view, clicks, the waypoint's 16 px and the pan
  // speed are all in it, whatever the canvas's backing store (see draw).
  let vw = window.innerWidth;
  let vh = window.innerHeight;
  const scale = () => {
    const base = Math.min(vw / fitW, vh / fitH);
    return base * Math.pow(1.5, zoom);
  };
  const toWorld = (sx: number, sy: number) => {
    const k = scale();
    return { x: cx + (sx - vw / 2) / k, z: cz + (sy - vh / 2) / k };
  };
  // The tip that names the icons under the pointer or, once the keys or a pad move the map, under the cross.
  const tip = h('div', 'map-tip hidden');
  el.appendChild(tip);
  let tipKey = '';
  let aim: 'pointer' | 'cross' = menus.device === 'pad' ? 'cross' : 'pointer';
  let pointerAt: { x: number; y: number } | null = null;
  /** This frame's icons and where they are drawn (CSS px), the topmost last. */
  let drawn: Array<{ b: Blip; x: number; y: number }> = [];
  const showTip = () => {
    const at = aim === 'cross' ? { x: vw / 2, y: vh / 2 } : pointerAt;
    // Within the icon as drawn (at least 6 px for the small ones), topmost first, each kind and place once.
    const hits = new Map<string, Blip>();
    if (at) for (const d of [...drawn].reverse()) if (Math.hypot(d.x - at.x, d.y - at.y) <= Math.max(6, blipReach(d.b.shape, MAP_BLIP) + 2)) hits.set(`${d.b.kind}|${d.b.detail ?? ''}`, d.b);
    const key = [...hits.keys()].join('\n');
    if (key !== tipKey) {
      tipKey = key;
      tip.innerHTML = [...hits.values()].map((b) => `<div><b>${escapeHtml(blipKind(b.kind).name)}</b>${b.detail ? `<span>${escapeHtml(b.detail)}</span>` : ''}</div>`).join('');
      tip.classList.toggle('hidden', hits.size === 0);
    }
    if (!at || hits.size === 0) return;
    // Below right of the point, flipped to the left or above it near the right or bottom edge.
    const w = tip.offsetWidth;
    const th = tip.offsetHeight;
    tip.style.left = `${at.x + 16 + w > vw ? at.x - 16 - w : at.x + 16}px`;
    tip.style.top = `${at.y + 16 + th > vh ? at.y - 16 - th : at.y + 16}px`;
  };
  const draw = (time: number) => {
    vw = Math.max(1, el.clientWidth || window.innerWidth);
    vh = Math.max(1, el.clientHeight || window.innerHeight);
    // Backed at the device pixel ratio (at most 2; read every frame, as browser zoom and another monitor change it),
    // so lines and labels are sharp on HiDPI screens. Everything below is drawn in CSS px through the transform,
    // which resizing the canvas resets.
    const dpr = Math.min(2, window.devicePixelRatio > 0 ? window.devicePixelRatio : 1);
    const bw = Math.max(1, Math.round(vw * dpr));
    const bh = Math.max(1, Math.round(vh * dpr));
    if (canvas.width !== bw || canvas.height !== bh) {
      canvas.width = bw;
      canvas.height = bh;
    }
    ctx.setTransform(bw / vw, 0, 0, bh / vh, 0, 0);
    const k = scale();
    ctx.fillStyle = '#08111a';
    ctx.fillRect(0, 0, vw, vh);
    ctx.save();
    ctx.translate(vw / 2, vh / 2);
    ctx.scale(k / MAP_SCALE, k / MAP_SCALE);
    ctx.translate(-(cx - menus.map.minX) * MAP_SCALE, -(cz - menus.map.minZ) * MAP_SCALE);
    ctx.drawImage(menus.map.canvas, 0, 0);
    if (layerOn('turf')) ctx.drawImage(menus.map.turf, menus.map.turfX, menus.map.turfZ);
    drawPoliceOverlay(ctx, sim, menus.map, time, k / MAP_SCALE, localId);
    drawRegattaCourse(ctx, sim, menus.map, k / MAP_SCALE);
    ctx.restore();
    // District labels.
    ctx.font = '700 15px Rajdhani, sans-serif';
    ctx.textAlign = 'center';
    const seen = new Set<string>();
    for (const blk of sim.world.layout.blocks) {
      if (seen.has(blk.zone)) continue;
      if (blk.district === 'park' && zoom < 1) continue;
      seen.add(blk.zone);
      const group = sim.world.layout.blocks.filter((b) => b.zone === blk.zone);
      let mx = group.reduce((a, b) => a + (b.rect.minX + b.rect.maxX) / 2, 0) / group.length;
      let mz = group.reduce((a, b) => a + (b.rect.minZ + b.rect.maxZ) / 2, 0) / group.length;
      // The middle of a district wrapped round another (Midtown round Downtown) lies in that one: there the label goes
      // on the district's own block nearest to it.
      if (sim.world.zoneName(mx, mz) !== blk.zone) {
        const centre = (b: (typeof group)[number]) => ({ x: (b.rect.minX + b.rect.maxX) / 2, z: (b.rect.minZ + b.rect.maxZ) / 2 });
        const near = group.map(centre).reduce((a, c) => (Math.hypot(c.x - mx, c.z - mz) < Math.hypot(a.x - mx, a.z - mz) ? c : a));
        mx = near.x;
        mz = near.z;
      }
      const sx = vw / 2 + (mx - cx) * k;
      const sy = vh / 2 + (mz - cz) * k;
      ctx.lineWidth = 4;
      ctx.strokeStyle = 'rgba(0,0,0,0.85)';
      ctx.fillStyle = '#e8ecf2';
      ctx.strokeText(blk.zone.toUpperCase(), sx, sy);
      ctx.fillText(blk.zone.toUpperCase(), sx, sy);
    }
    // Las Lomas County: its name across it, and zoomed in, its plots' (the wild ones but Coyote Ridge go unnamed).
    const label = (text: string, x: number, z: number) => {
      const sx = vw / 2 + (x - cx) * k;
      const sy = vh / 2 + (z - cz) * k;
      ctx.strokeText(text, sx, sy);
      ctx.fillText(text, sx, sy);
    };
    const country = sim.world.layout.country;
    if (zoom >= 1) for (const p of country.plots) label(p.name.toUpperCase(), (p.rect.minX + p.rect.maxX) / 2, (p.rect.minZ + p.rect.maxZ) / 2);
    ctx.save();
    ctx.font = '700 22px Rajdhani, sans-serif';
    label(COUNTY_NAME.toUpperCase(), -1130, 0);
    label(VALLEY_NAME.toUpperCase(), -1940, 20);
    ctx.restore();
    // The waypoint goes first, under the rest: a contact's L / D on the same spot stays on top; you go on top of all.
    const wp = menus.host.waypoint();
    const p = me.pos();
    const ph = me.character.vehicle ? me.character.vehicle.heading : me.character.heading;
    const blips: Blip[] = [
      ...(wp ? [blipOf('waypoint', wp.x, wp.z, { sticky: true })] : []),
      ...collectBlips(sim, time, localId, { map: true }),
      blipOf('you', p.x, p.z, { angle: Math.PI - ph }),
    ];
    // The legend lists the hidden categories' icons too.
    buildLegend(blips);
    drawn = visibleBlips(blips, menus.host.settings().mapLayers).map((b) => ({ b, x: vw / 2 + (b.x - cx) * k, y: vh / 2 + (b.z - cz) * k }));
    // A legend row hovered or picked: the other icons fade, and its own pulse on top of them. Not for a row with none
    // drawn (turf, an area, a switched-off category, no waypoint): the map stays as it is.
    const r = hover ?? rows[pick];
    const lit = r && drawn.some((d) => r.kinds.includes(d.b.kind)) ? new Set(r.kinds) : null;
    for (const d of drawn) {
      if (lit?.has(d.b.kind)) continue;
      ctx.globalAlpha = lit ? 0.25 : 1;
      drawBlip(ctx, d.b, d.x, d.y, MAP_BLIP);
    }
    ctx.globalAlpha = 1;
    const pulse = 0.5 + 0.5 * Math.sin(time * Math.PI * 3);
    for (const d of drawn) {
      if (!lit?.has(d.b.kind)) continue;
      ctx.beginPath();
      ctx.arc(d.x, d.y, blipReach(d.b.shape, MAP_BLIP) + 4 + 5 * pulse, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(255, 255, 255, ${(1 - 0.6 * pulse).toFixed(3)})`;
      ctx.lineWidth = 2.5;
      ctx.stroke();
      drawBlip(ctx, d.b, d.x, d.y, MAP_BLIP);
    }
    showTip();
  };
  /** Sets a waypoint at a point of the world, or clears the one within 16 px of it on the map. */
  const toggleWaypointAt = (w: { x: number; z: number }) => {
    const cur = menus.host.waypoint();
    if (cur && Math.hypot(cur.x - w.x, cur.z - w.z) * scale() < 16) menus.host.setWaypoint(null);
    else menus.host.setWaypoint(w);
    menus.host.click();
  };
  let t = 0;
  canvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    // Capture, so the move and the release reach the canvas even over the legend / hint or
    // outside the window and the drag always ends with the button.
    try {
      canvas.setPointerCapture(e.pointerId);
    } catch {
      // Pointer already gone: the buttons check below still ends the drag.
    }
    dragging = true;
    moved = 0;
    lx = e.clientX;
    ly = e.clientY;
  });
  canvas.addEventListener('pointermove', (e) => {
    const r = canvas.getBoundingClientRect();
    pointerAt = { x: e.clientX - r.left, y: e.clientY - r.top };
    aim = 'pointer';
    if (!dragging) return;
    if ((e.buttons & 1) === 0) {
      dragging = false; // the release happened where we couldn't see it
      return;
    }
    const k = scale();
    cx -= (e.clientX - lx) / k;
    cz -= (e.clientY - ly) / k;
    moved += Math.abs(e.clientX - lx) + Math.abs(e.clientY - ly);
    lx = e.clientX;
    ly = e.clientY;
  });
  const endDrag = () => {
    dragging = false;
  };
  canvas.addEventListener('pointerleave', () => (pointerAt = null));
  canvas.addEventListener('pointercancel', endDrag);
  canvas.addEventListener('lostpointercapture', endDrag);
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  canvas.addEventListener('pointerup', (e) => {
    if (!dragging || e.button !== 0) return;
    dragging = false;
    if (moved > 6) return;
    const r = canvas.getBoundingClientRect();
    toggleWaypointAt(toWorld(e.clientX - r.left, e.clientY - r.top));
  });
  // Steps like the weapon wheel: the first event of a gesture (see WHEEL_GESTURE_GAP) is one
  // 0.5 step whatever its size, so a notch is a step on every platform (4 px on macOS, 53 on
  // Linux, 100 on Windows, a page). The rest of a gesture, such as a touchpad's dozens of tiny
  // events per swipe, zooms by distance: a step per WHEEL_STEP px, at most one per event.
  let wheelT = -Infinity;
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const unit = e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? 800 : 1;
    const dy = e.deltaY * unit;
    // Ignored events still continue the gesture: a stray vertical event in a sideways touchpad
    // swipe is not a whole step. Unlike for weapons, ctrl+wheel (a touchpad pinch) zooms too.
    const newGesture = e.timeStamp - wheelT > WHEEL_GESTURE_GAP;
    wheelT = e.timeStamp;
    if (dy === 0 || Math.abs(e.deltaX * unit) > Math.abs(dy)) return;
    const steps = newGesture ? 1 : Math.min(Math.abs(dy) / WHEEL_STEP, 1);
    zoom = clamp(zoom - Math.sign(dy) * 0.5 * steps, MIN_ZOOM, 4);
  }, { passive: false });
  menus.push({
    el,
    input: (ui, dt) => {
      // Esc (Backspace, a pad's B) first lets go of a row picked with Tab or Y, then closes the map; M and P close it.
      if (ui.back && pick >= 0) {
        select(-1);
        return;
      }
      if (ui.back || ui.map || ui.pause) {
        menus.pop();
        return;
      }
      if (ui.confirm) toggleWaypointAt({ x: cx, z: cz });
      if (ui.digit) toggleLayer(MAP_CATEGORIES[ui.digit - 1]);
      if (ui.tab) stepPick(ui.tab);
      if (ui.padY) stepCategory();
      if (ui.padX) toggleLayer(rows[pick]?.category);
      if (ui.zoomIn) zoom = clamp(zoom + 0.5, MIN_ZOOM, 4);
      if (ui.zoomOut) zoom = clamp(zoom - 0.5, MIN_ZOOM, 4);
      // Each press (arrows / WASD, the D-pad) steps the view 60 px, also a tap whose key is up again before
      // Input polls and so is never seen held. Held, they and the left stick pan it on, by up to 0.8 of its
      // height a second (its size on the page, as the pointer handlers measure it), once let go since it opened.
      const k = scale();
      cx += (((ui.right ? 1 : 0) - (ui.left ? 1 : 0)) * 60) / k;
      cz += (((ui.down ? 1 : 0) - (ui.up ? 1 : 0)) * 60) / k;
      const speed = (0.8 * Math.min(vw, vh)) / k;
      if (freeX) cx += (ui.panX ?? 0) * speed * dt;
      if (freeY) cz += (ui.panY ?? 0) * speed * dt;
      // Moved by the keys or a pad, the tip names what is under the cross.
      if (ui.confirm || ui.zoomIn || ui.zoomOut || ui.up || ui.down || ui.left || ui.right || (freeX && ui.panX) || (freeY && ui.panY)) aim = 'cross';
    },
    tick: (dt, ui) => {
      if (!ui.panX) freeX = true;
      if (!ui.panY) freeY = true;
      t += dt;
      if (hintDevice !== menus.device) showHint();
      draw(t);
      legendCue.classList.toggle('hidden', !(legend.scrollHeight - legend.clientHeight - legend.scrollTop > 2));
    },
    close: onClose,
    pans: true,
  });
}
