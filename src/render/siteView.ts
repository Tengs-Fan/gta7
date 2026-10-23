// Fixed structures of the wave-1 places (activities/places.ts): signs at the courier office, Lou's export board and the
// service depots. Built once from the world; a few meshes, the same on every tier.

import * as THREE from 'three';
import { places } from '../sim/activities/places';
import { VEHICLE_SPECS } from '../sim/specs';
import type { StaticWorld } from '../world/staticWorld';

function signTexture(text: string, fg: string, bg: string): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 128;
  const ctx = c.getContext('2d');
  if (ctx) {
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, 512, 128);
    ctx.strokeStyle = fg;
    ctx.lineWidth = 8;
    ctx.strokeRect(6, 6, 500, 116);
    ctx.fillStyle = fg;
    ctx.font = '700 64px Anton, Impact, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, 256, 68, 480);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export class SiteView {
  readonly group = new THREE.Group();
  private readonly post = new THREE.MeshStandardMaterial({ color: 0x3a3d42, roughness: 0.6, metalness: 0.5 });

  constructor(private readonly world: StaticWorld) {
    const at = places(world);
    const board = at.exportBoard;
    // Just behind the marker, on the building side of the sidewalk.
    this.sign("LOU'S EXPORT LIST", '#ffb347', '#1d140c', board.x - Math.sin(board.heading) * 1.3, board.z - Math.cos(board.heading) * 1.3, board.heading, 2.6, 0.75, 1.6);
    this.sign('AZURA EXPRESS', '#ffd23d', '#16161a', at.courier.x + 4.8, at.courier.z, -Math.PI / 2, 3, 0.8, 2.4);
    for (const d of at.depots) {
      // Beside the parked vehicle on its driver's side (clear of the chase camera behind it), facing the way it does.
      const side = VEHICLE_SPECS[d.kind].width / 2 + 1.6;
      const amb = d.kind === 'ambulance';
      this.sign(amb ? 'AMBULANCE' : 'SAFD STATION 1', amb ? '#ff3a3a' : '#ffffff', amb ? '#f2f2ee' : '#a8191b', d.x + Math.cos(d.heading) * side, d.z - Math.sin(d.heading) * side, d.heading, 2.8, 0.7, 2.6);
    }
  }

  /** A double-sided sign board on two posts facing `heading`, its bottom edge at `bottom` m. */
  protected sign(text: string, fg: string, bg: string, x: number, z: number, heading: number, w: number, h: number, bottom: number): THREE.Group {
    const g = new THREE.Group();
    const y = this.world.groundHeight(x, z);
    g.position.set(x, y, z);
    g.rotation.y = heading;
    const tex = signTexture(text, fg, bg);
    const face = new THREE.MeshStandardMaterial({ map: tex, emissiveMap: tex, emissive: 0xffffff, emissiveIntensity: 0.35, roughness: 0.6 });
    const panel = new THREE.Mesh(new THREE.BoxGeometry(w, h, 0.08), [this.post, this.post, this.post, this.post, face, face]);
    panel.position.y = bottom + h / 2;
    panel.castShadow = true;
    g.add(panel);
    for (const s of [-1, 1]) {
      const p = new THREE.Mesh(new THREE.BoxGeometry(0.1, bottom + h, 0.1), this.post);
      p.position.set((s * w) / 2 - s * 0.1, (bottom + h) / 2, -0.06);
      p.castShadow = true;
      g.add(p);
    }
    this.group.add(g);
    return g;
  }
}
