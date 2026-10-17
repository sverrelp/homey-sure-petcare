import SureDevice from '../../lib/SureDevice';
import {
  LockMode, SureSnapshot, lockModeFromId, lockModeToId,
} from '../../lib/types';

/** Capabilities added after the first release: older paired doors get them on startup. */
const EXTRA_CAPABILITIES = ['locked', 'last_used_by', 'last_used_at', 'measure_signal_strength', 'alarm_offline'];

class FlapDevice extends SureDevice {
  protected async onSureInit(): Promise<void> {
    for (const capability of EXTRA_CAPABILITIES) {
      if (!this.hasCapability(capability)) {
        await this.addCapability(capability);
      }
    }

    this.registerCapabilityListener('flap_lock_mode', async (value: string) => {
      const mode = lockModeFromId(value);
      if (mode === null) {
        throw new Error(`Unknown lock mode: ${value}`);
      }
      await this.sendLockMode(mode);
    });

    // Simple lock button for the standard Homey interface and voice assistants.
    this.registerCapabilityListener('locked', async (value: boolean) => {
      await this.sendLockMode(value ? LockMode.Locked : LockMode.Unlocked);
    });
  }

  private async sendLockMode(mode: LockMode): Promise<void> {
    try {
      await this.sureApp.setLockMode(this.sureId, mode);
    } catch (err) {
      throw new Error(this.homey.__('device.command_failed', { reason: (err as Error)?.message ?? '' }));
    }
  }

  protected async updateFromSnapshot(snapshot: SureSnapshot): Promise<boolean> {
    const flap = snapshot.flaps.find((f) => f.id === this.sureId);
    if (!flap) {
      return false;
    }

    const modeId = lockModeToId(flap.lockMode);
    if (modeId) {
      await this.setCap('flap_lock_mode', modeId);
      await this.setCap('locked', flap.lockMode === LockMode.Locked);
    }

    await this.setCap('last_used_by', flap.lastUse?.petName ?? null);
    await this.setCap('last_used_at', this.formatTimestamp(flap.lastUse?.at ?? null));
    await this.updateBattery(flap);
    await this.updateConnection(flap);

    return true;
  }
}

export = FlapDevice;
