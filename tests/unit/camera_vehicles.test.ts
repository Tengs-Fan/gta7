import { describe, expect, it } from 'vitest';
import { CameraController } from '../../src/render/camera';
import { makeSim } from './helpers';

function scene() {
  const sim = makeSim({ police: false });
  const node = sim.roads.node(4, 4);
  Object.assign(sim.player.pos, { x: node.x, y: sim.world.groundHeight(node.x, node.z), z: node.z });
  sim.player.heading = 0;
  const camera = new CameraController(16 / 9);
  camera.mode = 'play';
  camera.reset(sim);
  camera.yaw = 0;
  for (let i = 0; i < 60; i++) camera.update(1 / 60, sim, false);
  return { sim, camera, node };
}

describe('on-foot camera beside vehicles', () => {
  it('keeps the camera in front of a bus behind the player', () => {
    const { sim, camera, node } = scene();
    const normalZ = camera.camera.position.z;
    const bus = sim.spawnVehicle('bus', node.x, node.z - 3, Math.PI / 2);
    camera.update(1 / 60, sim, false);
    expect(camera.camera.position.z).toBeGreaterThan(bus.pos.z + bus.halfW);
    expect(camera.camera.position.z).toBeGreaterThan(normalZ + 1);
  });

  it('returns smoothly to its normal boom once the obstruction moves away', () => {
    const { sim, camera, node } = scene();
    const normalZ = camera.camera.position.z;
    const bus = sim.spawnVehicle('bus', node.x, node.z - 3, Math.PI / 2);
    camera.update(1 / 60, sim, false);
    const closeZ = camera.camera.position.z;
    bus.pos.x += 30;
    camera.update(1 / 60, sim, false);
    expect(Math.abs(camera.camera.position.z - closeZ)).toBeLessThan(0.3);
    for (let i = 0; i < 90; i++) camera.update(1 / 60, sim, false);
    expect(camera.camera.position.z).toBeCloseTo(normalZ, 1);
  });

  it('ignores a bus on a different height level and removed wrecks', () => {
    const { sim, camera, node } = scene();
    const normalZ = camera.camera.position.z;
    const bus = sim.spawnVehicle('bus', node.x, node.z - 3, Math.PI / 2);
    bus.pos.y += 12;
    camera.update(1 / 60, sim, false);
    expect(camera.camera.position.z).toBeCloseTo(normalZ, 1);
    bus.pos.y -= 12;
    bus.removed = true;
    camera.update(1 / 60, sim, false);
    expect(camera.camera.position.z).toBeCloseTo(normalZ, 1);
  });
});
