import SureDevice from '../../lib/SureDevice';
import { latestIntake } from '../../lib/intake';
import { SureSnapshot } from '../../lib/types';

/** Capabilities added after the first release: older paired feeders get them on startup. */
const EXTRA_CAPABILITIES = ['last_used_by', 'last_used_at', 'measure_signal_strength', 'alarm_offline'];

class FeederDevice extends SureDevice {
  protected async onSureInit(): Promise<void> {
    await this.ensureCapabilities(EXTRA_CAPABILITIES);
  }

  protected async updateFromSnapshot(snapshot: SureSnapshot): Promise<boolean> {
    const feeder = snapshot.feeders.find((f) => f.id === this.sureId);
    if (!feeder) {
      return false;
    }

    // A single-bowl feeder has no right bowl.
    if (feeder.singleBowl && this.hasCapability('measure_food_right')) {
      await this.removeCapability('measure_food_right');
    } else if (!feeder.singleBowl && !this.hasCapability('measure_food_right')) {
      await this.addCapability('measure_food_right');
    }

    const left = feeder.bowls.find((bowl) => bowl.index === 0);
    const right = feeder.bowls.find((bowl) => bowl.index === 1);

    await this.setCap('measure_food_left', left?.weightGrams ?? null);
    await this.setCap('measure_food_right', right?.weightGrams ?? null);
    const last = latestIntake(snapshot, 'food', feeder.id);
    await this.setCap('last_used_by', last?.petName ?? null);
    await this.setCap('last_used_at', this.formatTimestamp(last?.at ?? null));

    await this.updateBattery(feeder);
    await this.updateConnection(feeder);

    return true;
  }
}

export = FeederDevice;
