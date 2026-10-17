import SureDriver from '../../lib/SureDriver';
import { PairableDevice, SureSnapshot } from '../../lib/types';

class FlapDriver extends SureDriver {
  async onInit(): Promise<void> {
    this.log('Flap driver initialized');
  }

  protected listDevices(snapshot: SureSnapshot): PairableDevice[] {
    return snapshot.flaps.map((flap) => ({ name: flap.name, data: { id: flap.id } }));
  }
}

export = FlapDriver;
