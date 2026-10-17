import Homey from 'homey';
import type SurePetApp from '../app';
import { PairableDevice, SureSnapshot } from './types';

/** Base class of all Sure Petcare drivers: lists devices from the shared snapshot while pairing. */
abstract class SureDriver extends Homey.Driver {
  /** Devices of this driver's type found in the snapshot. */
  protected abstract listDevices(snapshot: SureSnapshot): PairableDevice[];

  async onPairListDevices(): Promise<PairableDevice[]> {
    const app = this.homey.app as unknown as SurePetApp;

    const state = app.getConnectionState();
    if (state === 'no_credentials' || state === 'auth_error') {
      throw new Error(this.homey.__('pair.login_required'));
    }

    const snapshot = await app.refresh();
    if (!snapshot) {
      throw new Error(this.homey.__('pair.no_data'));
    }

    return this.listDevices(snapshot);
  }
}

export = SureDriver;
