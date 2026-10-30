// Full-screen map.

import { clamp } from '../../core/math';
import { WHEEL_GESTURE_GAP, WHEEL_STEP } from '../../input/input';
import { padGlyph, type InputDevice } from '../glyphs';
import { escapeHtml } from '../hud';
import { COMPLETION_GROUP_NAMES, COMPLETION_GROUPS, completionPercent, completionRows } from '../../sim/completion';
import { collectBlips, drawBlip, drawPoliceOverlay, drawRegattaCourse, MAP_CATEGORIES, MAP_SCALE, type Blip, type MapCategory } from '../mapRender';
import { h, localPlayer, type MenuCtx } from './shared';

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
  // The legend: a row per category the player can switch off (number keys, a pad's Y to pick and X to switch, a
  // click) and the markers that always show. Off states are kept in the settings (mapLayers).
  const legend = h('div', 'map-legend');
  const fixed = [
    ['#ffffff', 'You'],
    ['#ffd23d', 'Objective'],
    ['#ff3030', 'Police unit'],
    ['rgba(255, 48, 48, 0.55)', 'Search area'],
    ['#c04fff', 'Waypoint'],
  ];
  const layerOn = (id: string) => menus.host.settings().mapLayers[id] !== false;
  let pick = 0;
  const catRows: HTMLElement[] = [];
  const swatch = (w: MapCategory['swatches'][number]) =>
    `<i class="${w.hollow ? 'hollow' : ''}" style="${w.hollow ? `border-color:${w.color}` : `background:${w.color}`}">${w.label ? escapeHtml(w.label) : ''}</i>`;
  const drawLegend = () => {
    catRows.forEach((r, i) => {
      const c = MAP_CATEGORIES[i]!;
      const on = layerOn(c.id);
      r.classList.toggle('off', !on);
      r.classList.toggle('sel', menus.device === 'pad' && i === pick);
      const st = r.children[r.children.length - 1];
      if (st) st.textContent = on ? 'ON' : 'OFF';
    });
  };
  const toggleLayer = (i: number) => {
    const c = MAP_CATEGORIES[i];
    if (!c) return;
    const s = menus.host.settings();
    menus.host.applySettings({ ...s, mapLayers: { ...s.mapLayers, [c.id]: !layerOn(c.id) } });
    menus.host.click();
    drawLegend();
  };
  legend.appendChild(h('div', 'legend-head', 'LEGEND'));
  MAP_CATEGORIES.forEach((c, i) => {
    const row = h('div', 'legend-row', `<span class="legend-key">${i < 9 ? i + 1 : ''}</span>${(c.legendSwatches?.(sim, localId) ?? c.swatches).map(swatch).join('')}<span class="legend-name">${escapeHtml(c.label)}</span>`);
    row.appendChild(h('span', 'legend-state', ''));
    row.addEventListener('click', () => {
      pick = i;
      toggleLayer(i);
    });
    catRows.push(row);
    legend.appendChild(row);
  });
  for (const [c, t] of fixed) legend.appendChild(h('div', 'legend-row fixed', `<span class="legend-key"></span><i style="background:${c}"></i><span class="legend-name">${t}</span>`));
  el.appendChild(legend);
  drawLegend();
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
    hint.innerHTML =
      menus.device === 'pad'
        ? `${padGlyph('a')} waypoint at the cross (again to clear it) · Left stick or D-pad to pan · ${padGlyph('lb')} ${padGlyph('rb')} to zoom · ${padGlyph('y')} pick a legend row, ${padGlyph('x')} switch it · ${padGlyph('b')} to close`
        : `Click, or <kbd>Enter</kbd> at the cross, to set a waypoint (again to clear it) · Drag or arrow keys to pan · Wheel or <kbd>+</kbd> <kbd>-</kbd> to zoom · <kbd>1</kbd>-<kbd>${Math.min(9, MAP_CATEGORIES.length)}</kbd> legend on / off · <kbd>${escapeHtml(menus.keys.label('KeyM'))}</kbd>/<kbd>Esc</kbd> to close`;
    drawLegend();
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
    if (layerOn('turf')) ctx.drawImage(menus.map.turf, 0, 0);
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
    // The waypoint goes first, under the rest: a contact's L / D on the same spot stays on top.
    const wp = menus.host.waypoint();
    const blips: Blip[] = wp ? [{ x: wp.x, z: wp.z, color: '#c04fff', label: 'W', sticky: true, shape: 'circle' }] : [];
    const s = menus.host.settings();
    const hidden = new Set(MAP_CATEGORIES.filter((c) => s.mapLayers[c.id] === false).map((c) => c.id));
    blips.push(...collectBlips(sim, time, localId, { map: true, hidden }));
    for (const b of blips) drawBlip(ctx, b, vw / 2 + (b.x - cx) * k, vh / 2 + (b.z - cz) * k, 18);
    const p = me.pos();
    const ph = me.character.vehicle ? me.character.vehicle.heading : me.character.heading;
    ctx.save();
    ctx.translate(vw / 2 + (p.x - cx) * k, vh / 2 + (p.z - cz) * k);
    ctx.rotate(Math.PI - ph);
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, -12);
    ctx.lineTo(8, 9);
    ctx.lineTo(0, 4);
    ctx.lineTo(-8, 9);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();
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
    zoom = clamp(zoom - Math.sign(dy) * 0.5 * steps, 0, 4);
  }, { passive: false });
  menus.push({
    el,
    input: (ui, dt) => {
      if (ui.back || ui.map || ui.pause) {
        menus.pop();
        return;
      }
      if (ui.confirm) toggleWaypointAt({ x: cx, z: cz });
      if (ui.digit) toggleLayer(ui.digit - 1);
      if (ui.padY && MAP_CATEGORIES.length > 0) {
        pick = (pick + 1) % MAP_CATEGORIES.length;
        drawLegend();
      }
      if (ui.padX) toggleLayer(pick);
      if (ui.zoomIn) zoom = clamp(zoom + 0.5, 0, 4);
      if (ui.zoomOut) zoom = clamp(zoom - 0.5, 0, 4);
      // Each press (arrows / WASD, the D-pad) steps the view 60 px, also a tap whose key is up again before
      // Input polls and so is never seen held. Held, they and the left stick pan it on, by up to 0.8 of its
      // height a second (its size on the page, as the pointer handlers measure it), once let go since it opened.
      const k = scale();
      cx += (((ui.right ? 1 : 0) - (ui.left ? 1 : 0)) * 60) / k;
      cz += (((ui.down ? 1 : 0) - (ui.up ? 1 : 0)) * 60) / k;
      const speed = (0.8 * Math.min(vw, vh)) / k;
      if (freeX) cx += (ui.panX ?? 0) * speed * dt;
      if (freeY) cz += (ui.panY ?? 0) * speed * dt;
    },
    tick: (dt, ui) => {
      if (!ui.panX) freeX = true;
      if (!ui.panY) freeY = true;
      t += dt;
      if (hintDevice !== menus.device) showHint();
      draw(t);
    },
    close: onClose,
    pans: true,
  });
}
