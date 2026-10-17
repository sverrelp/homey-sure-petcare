import type Homey from 'homey';

import { HouseholdEvent } from './events';
import {
  LockMode, lockModeFromId, lockModeToId, PetAccess,
} from './types';

type HomeyInstance = Homey.App['homey'];

/** Ids come from device data and from the API: compare them as numbers so "12" and 12 match. */
const sameId = (a: unknown, b: unknown): boolean => Number(a) === Number(b);

interface DeviceArg {
  getData(): { id: number };
  getCapabilityValue(capability: string): unknown;
}

interface FlowDependencies {
  homey: HomeyInstance;
  setLockMode: (deviceId: number, mode: LockMode) => Promise<void>;
  setLockModeFor: (deviceId: number, mode: LockMode, minutes: number) => Promise<void>;
  setPetPosition: (petId: number, position: 'inside' | 'outside') => Promise<void>;
  setPetAccess: (petId: number, deviceId: number, access: PetAccess) => Promise<void>;
  log: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

/**
 * Registers all flow cards of the app and fires triggers for household events.
 * Card definitions live in `.homeycompose/flow`.
 *
 * Triggers with a device argument are device trigger cards: they are fired with
 * `getDeviceTriggerCard(id).trigger(device, tokens, state)`, so Homey itself only starts the flows
 * of that device. Run listeners are only needed for extra arguments (a mode or a limit).
 */
export class FlowHandler {
  private readonly homey: HomeyInstance;
  private readonly setLockMode: (deviceId: number, mode: LockMode) => Promise<void>;
  private readonly setLockModeFor: FlowDependencies['setLockModeFor'];
  private readonly setPetPosition: FlowDependencies['setPetPosition'];
  private readonly setPetAccess: FlowDependencies['setPetAccess'];
  private readonly logFn: (...args: unknown[]) => void;
  private readonly errorFn: (...args: unknown[]) => void;

  constructor(deps: FlowDependencies) {
    this.homey = deps.homey;
    this.setLockMode = deps.setLockMode;
    this.setLockModeFor = deps.setLockModeFor;
    this.setPetPosition = deps.setPetPosition;
    this.setPetAccess = deps.setPetAccess;
    this.logFn = deps.log;
    this.errorFn = deps.error;
  }

  /** Register run listeners of all conditions, actions and triggers that have extra arguments. */
  public register(): void {
    const flow = this.homey.flow;

    // The device argument is matched by Homey. Only the extra argument is checked here.
    flow.getDeviceTriggerCard('door_mode_changed').registerRunListener(
      async (args: { mode: string }, state: { mode: string }) => {
        return args.mode === 'any' || args.mode === state.mode;
      },
    );

    flow.getDeviceTriggerCard('felaqua_level_below').registerRunListener(
      async (args: { level: number }, state: { previous: number; level: number }) => {
        return state.previous >= args.level && state.level < args.level;
      },
    );
    flow.getDeviceTriggerCard('feeder_bowl_below').registerRunListener(
      async (args: { grams: number }, state: { previous: number; grams: number }) => {
        return state.previous >= args.grams && state.grams < args.grams;
      },
    );

    flow.getConditionCard('pet_is_inside').registerRunListener(async (args: { pet: DeviceArg }) => {
      return args.pet.getCapabilityValue('pet_presence') === 'inside';
    });

    flow.getConditionCard('door_mode_is').registerRunListener(async (args: { door: DeviceArg; mode: string }) => {
      return args.door.getCapabilityValue('flap_lock_mode') === args.mode;
    });

    flow.getActionCard('set_lock_mode').registerRunListener(async (args: { door: DeviceArg; mode: string }) => {
      const mode = lockModeFromId(args.mode);
      if (mode === null || lockModeToId(mode) === null) {
        throw new Error(`Unknown lock mode: ${args.mode}`);
      }
      await this.setLockMode(Number(args.door.getData().id), mode);
    });

    flow.getActionCard('set_lock_mode_for').registerRunListener(
      async (args: { door: DeviceArg; mode: string; minutes: number }) => {
        const mode = lockModeFromId(args.mode);
        if (mode === null) {
          throw new Error(`Unknown lock mode: ${args.mode}`);
        }
        const minutes = Math.round(Number(args.minutes));
        if (!Number.isFinite(minutes) || minutes < 1 || minutes > 1440) {
          throw new Error('The duration must be between 1 and 1440 minutes');
        }
        await this.setLockModeFor(Number(args.door.getData().id), mode, minutes);
      },
    );

    flow.getActionCard('set_pet_position').registerRunListener(async (args: { pet: DeviceArg; position: string }) => {
      if (args.position !== 'inside' && args.position !== 'outside') {
        throw new Error(`Unknown position: ${args.position}`);
      }
      await this.setPetPosition(Number(args.pet.getData().id), args.position);
    });

    flow.getActionCard('set_pet_access').registerRunListener(
      async (args: { pet: DeviceArg; door: DeviceArg; access: string }) => {
        if (args.access !== 'free' && args.access !== 'indoor_only') {
          throw new Error(`Unknown access: ${args.access}`);
        }
        await this.setPetAccess(Number(args.pet.getData().id), Number(args.door.getData().id), args.access);
      },
    );
  }

  /** Fire "connection problem" with a readable reason. Failures are logged, never thrown. */
  public async connectionProblem(reason: string): Promise<void> {
    try {
      await this.homey.flow.getTriggerCard('connection_problem').trigger({ reason });
    } catch (err) {
      this.errorFn('Failed to fire connection_problem:', (err as Error)?.message ?? err);
    }
  }

  /** Fire the triggers belonging to the given events. Failures are logged, never thrown. */
  public async handle(events: HouseholdEvent[]): Promise<void> {
    // Together, so one slow answer from Homey does not hold back the other events.
    await Promise.all(events.map(async (event) => {
      try {
        await this.fire(event);
      } catch (err) {
        this.errorFn(`Failed to fire trigger for ${event.type}:`, (err as Error)?.message ?? err);
      }
    }));
  }

  /**
   * Fire a device trigger card for the Homey device(s) of a driver.
   * With a null id (an event without a known device) the card fires for every device of the driver.
   */
  private async triggerDevices(
    cardId: string,
    driverId: string,
    sureId: number | null,
    tokens: Record<string, string | number>,
    state: Record<string, unknown> = {},
  ): Promise<void> {
    let devices: Homey.Device[];
    try {
      devices = this.homey.drivers.getDriver(driverId).getDevices();
    } catch (err) {
      this.errorFn(`Driver ${driverId} not available for ${cardId}:`, (err as Error)?.message ?? err);
      return;
    }

    const targets = sureId === null
      ? devices
      : devices.filter((device) => sameId((device.getData() as { id?: unknown }).id, sureId));
    if (targets.length === 0) {
      this.logFn(`No ${driverId} device (id ${sureId}) to fire ${cardId} for`);
      return;
    }

    const card = this.homey.flow.getDeviceTriggerCard(cardId);
    for (const device of targets) {
      try {
        await card.trigger(device, tokens, state);
        this.logFn(`Fired ${cardId} for ${device.getName()}`);
      } catch (err) {
        this.errorFn(`Failed to fire ${cardId} for ${device.getName()}:`, (err as Error)?.message ?? err);
      }
    }
  }

  private async fire(event: HouseholdEvent): Promise<void> {
    const flow = this.homey.flow;

    switch (event.type) {
      case 'pet_ate':
        this.logFn(`${event.petName} ate ${event.grams} g`);
        await this.triggerDevices('pet_ate_food', 'pet', event.petId, { name: event.petName, amount: event.grams });
        await this.triggerDevices('feeder_pet_ate', 'feeder', event.deviceId, {
          name: event.petName,
          amount: event.grams,
          left: event.bowls[0] ?? 0,
          right: event.bowls[1] ?? 0,
        });
        break;
      case 'pet_drank':
        this.logFn(`${event.petName} drank ${event.ml} ml`);
        await this.triggerDevices('pet_drank_water', 'pet', event.petId, { name: event.petName, amount: event.ml });
        await this.triggerDevices('felaqua_drank', 'felaqua', event.deviceId, {
          name: event.petName,
          amount: event.ml,
        });
        break;
      case 'felaqua_refilled':
        this.logFn(`${event.deviceName} was refilled`);
        await this.triggerDevices('felaqua_refilled', 'felaqua', event.deviceId, {
          name: event.deviceName,
          level: event.level ?? 0,
        });
        break;
      case 'felaqua_level':
        await this.triggerDevices(
          'felaqua_level_below',
          'felaqua',
          event.deviceId,
          { name: event.deviceName, level: event.level },
          { previous: event.previous, level: event.level },
        );
        break;
      case 'feeder_refilled':
        this.logFn(`${event.deviceName} bowl ${event.bowl} was refilled with ${event.grams} g`);
        await this.triggerDevices('feeder_bowl_refilled', 'feeder', event.deviceId, {
          name: event.deviceName,
          bowl: this.homey.__(`feeder.bowl_${event.bowl}`),
          amount: event.grams,
        });
        break;
      case 'feeder_bowl_level':
        await this.triggerDevices(
          'feeder_bowl_below',
          'feeder',
          event.deviceId,
          { name: event.deviceName, bowl: this.homey.__(`feeder.bowl_${event.bowl}`), amount: event.grams },
          { previous: event.previous, grams: event.grams },
        );
        break;
      case 'intruder':
        this.logFn(`Unregistered chip detected at ${event.flapName || 'a pet door'}`);
        await flow.getTriggerCard('intruder_attempt').trigger({ door: event.flapName, time: event.at });
        break;
      case 'door_used':
        this.logFn(`${event.petName || 'A pet'} used ${event.deviceName}`);
        await this.triggerDevices('door_used', 'flap', event.deviceId, {
          name: event.petName,
          door: event.deviceName,
          time: event.at,
        });
        break;
      case 'door_mode_changed':
        this.logFn(`${event.deviceName} is now in mode ${event.mode}`);
        await this.triggerDevices(
          'door_mode_changed',
          'flap',
          event.deviceId,
          { door: event.deviceName, mode: event.mode },
          { mode: event.mode },
        );
        break;
      case 'door_offline':
        this.logFn(`${event.deviceName} went offline`);
        await this.triggerDevices('door_went_offline', 'flap', event.deviceId, { door: event.deviceName });
        break;
      case 'door_online':
        this.logFn(`${event.deviceName} came online`);
        await this.triggerDevices('door_came_online', 'flap', event.deviceId, { door: event.deviceName });
        break;
      case 'battery_low':
        this.logFn(`Battery of ${event.deviceName} is low (${event.level}%)`);
        await flow.getTriggerCard('battery_low').trigger({
          name: event.deviceName,
          level: event.level,
          type: event.kind,
        });
        break;
      default:
        break;
    }
  }
}
