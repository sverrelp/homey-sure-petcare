import SureDevice from '../../lib/SureDevice';
import { latestIntake } from '../../lib/intake';
import { SureSnapshot } from '../../lib/types';

/** Capabilities added after the first release: older paired fountains get them on startup. */
const EXTRA_CAPABILITIES = ['last_used_by', 'last_used_at', 'measure_signal_strength', 'alarm_offline'];

class FelaquaDevice extends SureDevice {
  protected async onSureInit(): Promise<void> {
    await this.ensureCapabilities(EXTRA_CAPABILITIES);
  }

  protected async updateFromSnapshot(snapshot: SureSnapshot): Promise<boolean> {
    const felaqua = snapshot.felaquas.find((f) => f.id === this.sureId);
    if (!felaqua) {
      return false;
    }

    await this.setCap('measure_water_level', felaqua.fillPercent);
    await this.setCap('measure_water_volume', felaqua.waterMl);

    const last = latestIntake(snapshot, 'water', felaqua.id);
    await this.setCap('last_used_by', last?.petName ?? null);
    await this.setCap('last_used_at', this.formatTimestamp(last?.at ?? null));

    await this.updateBattery(felaqua);
    await this.updateConnection(felaqua);

    return true;
  }
}

export = FelaquaDevice;
