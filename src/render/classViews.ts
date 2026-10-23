// Views by vehicle class: cars are VehicleView's (pooled by VehicleViewPool), motorbikes BikeView's. The renderer asks
// this pool for a view of any kind and treats them all alike (see AnyVehicleView).

import type { VehicleKind } from '../sim/specs';
import { VEHICLE_SPECS } from '../sim/specs';
import { BikeView } from './bikeView';
import { VehicleView, VehicleViewPool } from './vehicleView';

export type AnyVehicleView = VehicleView | BikeView;

export class ClassViewPool {
  private readonly cars = new VehicleViewPool();
  private readonly free = new Map<VehicleKind, BikeView[]>();

  acquire(kind: VehicleKind): AnyVehicleView {
    const cls = VEHICLE_SPECS[kind]?.class ?? 'car';
    if (cls === 'bike') return this.free.get(kind)?.pop() ?? new BikeView(kind);
    return this.cars.acquire(kind);
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
