import Homey from 'homey';
import type SurePetApp from '../app';
import {
  ConnectionState, LOW_BATTERY_THRESHOLD, SureDeviceBase, SureSnapshot,
} from './types';

/**
 * Base class of all Sure Petcare devices.
 * Devices never call the API to read data: they listen to the shared snapshot of the app.
 */
abstract class SureDevice extends Homey.Device {
  private unsubscribers: Array<() => void> = [];

  /** The central app instance that owns the API client and the cached data. */
  protected get sureApp(): SurePetApp {
    return this.homey.app as unknown as SurePetApp;
  }

  /** Numeric Sure Petcare id (pet id or device id) of this device. */
  protected get sureId(): number {
    return Number(this.getData().id);
  }

  async onInit(): Promise<void> {
    await this.onSureInit();

    this.unsubscribers.push(
      this.sureApp.onSnapshot((snapshot) => this.handleSnapshot(snapshot)),
      this.sureApp.onConnectionState((state) => this.handleConnectionState(state)),
    );

    const snapshot = this.sureApp.getSnapshot();
    if (snapshot) {
      await this.handleSnapshot(snapshot);
    } else {
      this.handleConnectionState(this.sureApp.getConnectionState());
    }
  }

  async onUninit(): Promise<void> {
    this.releaseSubscriptions();
  }

  async onDeleted(): Promise<void> {
    this.releaseSubscriptions();
  }

  /** Register capability listeners and prepare the device. Called before the first snapshot is applied. */
  protected async onSureInit(): Promise<void> {
    // Optional hook for subclasses.
  }

  /**
   * Apply the data of the snapshot to the capabilities.
   * @returns false when this device no longer exists in the Sure Petcare account
   */
  protected abstract updateFromSnapshot(snapshot: SureSnapshot): Promise<boolean>;

  /** Set a capability value, adding the capability first if an older device lacks it. */
  protected async setCap(capability: string, value: string | number | boolean | null): Promise<void> {
    try {
      if (!this.hasCapability(capability)) {
        return;
      }
      if (this.getCapabilityValue(capability) !== value) {
        await this.setCapabilityValue(capability, value);
      }
    } catch (err) {
      this.error(`Failed to set ${capability}:`, (err as Error)?.message ?? err);
    }
  }

  /** Update `measure_battery` and `alarm_battery` from a device. */
  protected async updateBattery(device: SureDeviceBase): Promise<void> {
    await this.setCap('measure_battery', device.batteryPercent);
    await this.setCap(
      'alarm_battery',
      device.batteryPercent === null ? null : device.batteryPercent <= LOW_BATTERY_THRESHOLD,
    );
  }

  /** Add capabilities that older paired devices do not have yet. */
  protected async ensureCapabilities(capabilities: string[]): Promise<void> {
    for (const capability of capabilities) {
      if (!this.hasCapability(capability)) {
        await this.addCapability(capability);
      }
    }
  }

  /** Update `measure_signal_strength` and `alarm_offline` from a device. */
  protected async updateConnection(device: SureDeviceBase): Promise<void> {
    await this.setCap('measure_signal_strength', device.signalStrength);
    await this.setCap('alarm_offline', device.online === false);
  }

  /** Format an ISO timestamp for display in the Homey timezone and language. */
  protected formatTimestamp(iso: string | null): string {
    if (!iso) {
      return '-';
    }

    try {
      return new Intl.DateTimeFormat(this.homey.i18n.getLanguage(), {
        timeZone: this.homey.clock.getTimezone(),
        dateStyle: 'short',
        timeStyle: 'short',
      }).format(new Date(iso));
    } catch {
      return iso;
    }
  }

  private async handleSnapshot(snapshot: SureSnapshot): Promise<void> {
    try {
      const found = await this.updateFromSnapshot(snapshot);
      if (!found) {
        await this.setUnavailable(this.homey.__('device.not_found'));
      } else if (!this.getAvailable()) {
        await this.setAvailable();
      }
    } catch (err) {
      this.error('Failed to apply snapshot:', (err as Error)?.message ?? err);
    }
  }

  private handleConnectionState(state: ConnectionState): void {
    const apply = async (): Promise<void> => {
      if (state === 'auth_error' || state === 'no_credentials') {
        await this.setUnavailable(this.homey.__('device.login_required'));
      } else if (state === 'network_error') {
        await this.setUnavailable(this.homey.__('device.connection_lost'));
      }
    };

    apply().catch((err) => this.error('Failed to update availability:', (err as Error)?.message ?? err));
  }

  private releaseSubscriptions(): void {
    for (const unsubscribe of this.unsubscribers) {
      unsubscribe();
    }
    this.unsubscribers = [];
  }
}

export = SureDevice;
