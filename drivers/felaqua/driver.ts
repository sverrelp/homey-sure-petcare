import SureDriver from '../../lib/SureDriver';
import { PairableDevice, SureSnapshot } from '../../lib/types';

class FelaquaDriver extends SureDriver {
  async onInit(): Promise<void> {
    this.log('Felaqua driver initialized');
  }

  protected listDevices(snapshot: SureSnapshot): PairableDevice[] {
    return snapshot.felaquas.map((felaqua) => ({ name: felaqua.name, data: { id: felaqua.id } }));
  }
}

export = FelaquaDriver;
