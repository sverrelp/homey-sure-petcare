import SureDriver from '../../lib/SureDriver';
import { PairableDevice, SureSnapshot } from '../../lib/types';

class PetDriver extends SureDriver {
  async onInit(): Promise<void> {
    this.log('Pet driver initialized');
  }

  protected listDevices(snapshot: SureSnapshot): PairableDevice[] {
    return snapshot.pets.map((pet) => ({ name: pet.name, data: { id: pet.id } }));
  }
}

export = PetDriver;
