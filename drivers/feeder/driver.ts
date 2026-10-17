import SureDriver from '../../lib/SureDriver';
import { PairableDevice, SureSnapshot } from '../../lib/types';

class FeederDriver extends SureDriver {
  async onInit(): Promise<void> {
    this.log('Feeder driver initialized');
  }

  protected listDevices(snapshot: SureSnapshot): PairableDevice[] {
    return snapshot.feeders.map((feeder) => ({ name: feeder.name, data: { id: feeder.id } }));
  }
}

export = FeederDriver;
