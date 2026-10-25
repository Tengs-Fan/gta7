// Fixed structures of the wave-1 places (activities/places.ts): signs at the courier office, Lou's export board and the
// service depots. Built once from the world; a few meshes, the same on every tier.

import * as THREE from 'three';
import { places } from '../sim/activities/places';
import { VEHICLE_SPECS } from '../sim/specs';
import type { StaticWorld } from '../world/staticWorld';
import { SAFEHOUSE_BAY_LENGTH } from './dressing';

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
  /** A sign's unprinted back: painted sheet metal. */
  private readonly back = new THREE.MeshStandardMaterial({ color: 0x8c9096, roughness: 0.55, metalness: 0.45 });

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
    // The safehouse garage: a carport over its four bays, a back wall, bay lines with a stop line at the head of each
    // bay (its furnishing keeps behind it, dressing.ts) and a sign over the aisle.
    const g = at.garageArea;
    this.carport(g.minX, g.minZ, g.maxX, g.maxZ, 3.1, 0x6b7179, 'x+');
    const bx = at.garageBays[0]!.x;
    const half = SAFEHOUSE_BAY_LENGTH / 2;
    for (let k = 0; k <= at.garageBays.length; k++) {
      const z = at.garageBays[0]!.z - 1.7 + k * 3.4;
      this.box(bx - half, z - 0.06, bx + half, z + 0.06, 0.03, 0xf2f2f2, 0.01);
    }
    this.box(bx + half - 0.12, at.garageBays[0]!.z - 1.7, bx + half, at.garageBays[at.garageBays.length - 1]!.z + 1.7, 0.03, 0xf2c94c, 0.01);
    this.sign('SAFEHOUSE GARAGE', '#3fd96b', '#101614', g.minX + 0.1, (g.minZ + g.maxZ) / 2, -Math.PI / 2, 4, 0.8, 3.25);
    // Azura Customs: a canopy over its drive-in bay, a purple floor and its sign over the way in.
    const c = at.customsBay;
    this.carport(c.minX, c.minZ, c.maxX, c.maxZ, 4.2, 0x2a2238, 'z-');
    this.box(c.minX + 0.3, c.minZ + 0.3, c.maxX - 0.3, c.maxZ - 0.3, 0.02, 0x4b2a6e, 0.01);
    this.sign('AZURA CUSTOMS', '#d8b4ff', '#1a1024', (c.minX + c.maxX) / 2, c.maxZ, 0, 6, 1.1, 4.35);
    // The Pier Arcade's sign on the pier's south rail, facing the boardwalk.
    this.sign('PIER ARCADE', '#ff5fd2', '#140a1c', at.arcade.x, at.arcade.z - 3.7, 0, 4.2, 1.1, 2.0);
  }

  /** A flat box from (x0, z0) to (x1, z1), `h` thick, its bottom `lift` m over the ground. */
  private box(x0: number, z0: number, x1: number, z1: number, h: number, color: number, lift: number): THREE.Mesh {
    const m = new THREE.Mesh(new THREE.BoxGeometry(x1 - x0, h, z1 - z0), new THREE.MeshStandardMaterial({ color, roughness: 0.8 }));
    const x = (x0 + x1) / 2;
    const z = (z0 + z1) / 2;
    m.position.set(x, this.world.groundHeight(x, z) + lift + h / 2, z);
    m.receiveShadow = true;
    this.group.add(m);
    return m;
  }

  /** A roof on posts over a rect, `height` m up, with a back wall on the side `wall` names. */
  private carport(x0: number, z0: number, x1: number, z1: number, height: number, color: number, wall: 'x+' | 'z-'): void {
    const roof = this.box(x0 - 0.2, z0 - 0.2, x1 + 0.2, z1 + 0.2, 0.18, color, height);
    roof.castShadow = true;
    const y = this.world.groundHeight((x0 + x1) / 2, (z0 + z1) / 2);
    for (const [x, z] of [[x0, z0], [x1, z0], [x0, z1], [x1, z1]] as const) {
      const p = new THREE.Mesh(new THREE.BoxGeometry(0.16, height, 0.16), this.post);
      p.position.set(x, y + height / 2, z);
      p.castShadow = true;
      this.group.add(p);
    }
    const w = wall === 'x+' ? this.box(x1 - 0.12, z0, x1, z1, height, color, 0) : this.box(x0, z0, x1, z0 + 0.12, height, color, 0);
    w.castShadow = true;
  }

  /** A sign board on two posts facing `heading` (its printed face; the back is plain), its bottom edge at `bottom` m. */
  protected sign(text: string, fg: string, bg: string, x: number, z: number, heading: number, w: number, h: number, bottom: number): THREE.Group {
    const g = new THREE.Group();
    const y = this.world.groundHeight(x, z);
    g.position.set(x, y, z);
    g.rotation.y = heading;
    const tex = signTexture(text, fg, bg);
    const face = new THREE.MeshStandardMaterial({ map: tex, emissiveMap: tex, emissive: 0xffffff, emissiveIntensity: 0.35, roughness: 0.6 });
    const panel = new THREE.Mesh(new THREE.BoxGeometry(w, h, 0.08), [this.post, this.post, this.post, this.post, face, this.back]);
    panel.name = 'sign-plate';
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
