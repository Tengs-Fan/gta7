// Views by vehicle class: cars are VehicleView's (pooled by VehicleViewPool), motorbikes BikeView's and boats
// BoatView's. The renderer asks this pool for a view of any kind and treats them all alike (see AnyVehicleView).

import type { VehicleKind } from '../sim/specs';
import { VEHICLE_SPECS } from '../sim/specs';
import { BikeView } from './bikeView';
import { BoatView } from './boatView';
import type { SeaUniforms } from './sea';
import { Suspension, type GroundSampler } from './suspension';
import { VehicleView, VehicleViewPool } from './vehicleView';

export type AnyVehicleView = VehicleView | BikeView | BoatView;

export class ClassViewPool {
  private readonly cars = new VehicleViewPool();
  private readonly free = new Map<VehicleKind, (BikeView | BoatView)[]>();
  private sea: SeaUniforms | null = null;
  private ground: GroundSampler | null = null;

  /** The sea's wave uniforms, for boats to ride the waves it draws. */
  bindSea(u: SeaUniforms): void {
    this.sea = u;
  }

  /** The ground cars' drawn suspension follows (suspension.ts). */
  bindGround(g: GroundSampler): void {
    this.ground = g;
  }

  acquire(kind: VehicleKind): AnyVehicleView {
    const cls = VEHICLE_SPECS[kind]?.class ?? 'car';
    if (cls === 'car') {
      const car = this.cars.acquire(kind);
      if (!car.suspension && this.ground) car.suspension = new Suspension(this.ground);
      return car;
    }
    const view = this.free.get(kind)?.pop() ?? (cls === 'boat' ? new BoatView(kind) : new BikeView(kind));
    if (view instanceof BoatView) view.bindSea(this.sea);
    return view;
  }

  release(view: AnyVehicleView): void {
    if (view instanceof VehicleView) {
      this.cars.release(view);
      return;
    }
    view.release();
    let list = this.free.get(view.kind);
    if (!list) this.free.set(view.kind, (list = []));
    list.push(view);
  }
}
