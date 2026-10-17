import {
  DeviceKind, LOW_BATTERY_THRESHOLD, LockModeId, lockModeToId, SureDeviceBase, SureSnapshot,
} from './types';

/** Things that happened between two consecutive snapshots. Used to fire flow triggers. */
export type HouseholdEvent =
  | {
    type: 'pet_ate'; petId: number; petName: string; grams: number; deviceId: number | null; bowls: number[];
  }
  | { type: 'pet_drank'; petId: number; petName: string; ml: number; deviceId: number | null }
  | {
    type: 'felaqua_refilled'; deviceId: number; deviceName: string; level: number | null;
  }
  | {
    type: 'felaqua_level'; deviceId: number; deviceName: string; previous: number; level: number;
  }
  | {
    type: 'feeder_refilled'; deviceId: number; deviceName: string; bowl: BowlName; grams: number;
  }
  | {
    type: 'feeder_bowl_level'; deviceId: number; deviceName: string; bowl: BowlName; previous: number; grams: number;
  }
  | { type: 'intruder'; eventId: number; flapName: string; at: string }
  | { type: 'door_used'; deviceId: number; deviceName: string; petName: string; at: string }
  | { type: 'door_mode_changed'; deviceId: number; deviceName: string; mode: LockModeId }
  | { type: 'door_online'; deviceId: number; deviceName: string }
  | { type: 'door_offline'; deviceId: number; deviceName: string }
  | { type: 'battery_low'; deviceId: number; deviceName: string; kind: DeviceKind; level: number };

export type BowlName = 'left' | 'right' | 'both';

/** Smallest rise that counts as a refill instead of measurement noise. */
const FELAQUA_REFILL_PERCENT = 10;
const FELAQUA_REFILL_ML = 100;
const BOWL_REFILL_GRAMS = 10;

export function bowlName(singleBowl: boolean, index: number): BowlName {
  if (singleBowl) {
    return 'both';
  }
  return index === 0 ? 'left' : 'right';
}

interface BatteryDevice {
  device: SureDeviceBase;
  kind: DeviceKind;
}

function batteryDevices(snapshot: SureSnapshot): BatteryDevice[] {
  return [
    ...snapshot.flaps.map((device) => ({ device, kind: 'flap' as const })),
    ...snapshot.feeders.map((device) => ({ device, kind: 'feeder' as const })),
    ...snapshot.felaquas.map((device) => ({ device, kind: 'felaqua' as const })),
  ];
}

/**
 * Compare two snapshots and return the events that happened in between.
 * Without a previous snapshot nothing is reported, so a restart never replays old events.
 */
export function diffSnapshots(previous: SureSnapshot | null, next: SureSnapshot): HouseholdEvent[] {
  if (!previous) {
    return [];
  }

  const events: HouseholdEvent[] = [];

  for (const pet of next.pets) {
    const before = previous.pets.find((p) => p.id === pet.id);
    if (!before) {
      continue;
    }

    if (pet.lastFeeding && pet.lastFeeding.at !== before.lastFeeding?.at && pet.lastFeeding.amount > 0) {
      events.push({
        type: 'pet_ate',
        petId: pet.id,
        petName: pet.name,
        grams: pet.lastFeeding.amount,
        deviceId: pet.lastFeeding.deviceId,
        bowls: pet.lastFeeding.bowlGrams,
      });
    }

    if (pet.lastDrinking && pet.lastDrinking.at !== before.lastDrinking?.at && pet.lastDrinking.amount > 0) {
      events.push({
        type: 'pet_drank',
        petId: pet.id,
        petName: pet.name,
        ml: pet.lastDrinking.amount,
        deviceId: pet.lastDrinking.deviceId,
      });
    }
  }

  const knownIntruders = new Set(previous.intruders.map((event) => event.id));
  for (const intruder of next.intruders) {
    if (!knownIntruders.has(intruder.id)) {
      events.push({
        type: 'intruder',
        eventId: intruder.id,
        flapName: intruder.deviceName ?? '',
        at: intruder.at,
      });
    }
  }

  for (const flap of next.flaps) {
    const before = previous.flaps.find((f) => f.id === flap.id);
    if (!before) {
      continue;
    }

    const mode = lockModeToId(flap.lockMode);
    if (mode && before.lockMode !== null && before.lockMode !== flap.lockMode) {
      events.push({
        type: 'door_mode_changed', deviceId: flap.id, deviceName: flap.name, mode,
      });
    }

    if (flap.lastUse && flap.lastUse.at !== before.lastUse?.at && before.lastUse !== null) {
      events.push({
        type: 'door_used',
        deviceId: flap.id,
        deviceName: flap.name,
        petName: flap.lastUse.petName ?? '',
        at: flap.lastUse.at,
      });
    }

    if (before.online === true && flap.online === false) {
      events.push({ type: 'door_offline', deviceId: flap.id, deviceName: flap.name });
    } else if (before.online === false && flap.online === true) {
      events.push({ type: 'door_online', deviceId: flap.id, deviceName: flap.name });
    }
  }

  for (const felaqua of next.felaquas) {
    const before = previous.felaquas.find((f) => f.id === felaqua.id);
    if (!before) {
      continue;
    }

    const refilled = before.fillPercent !== null && felaqua.fillPercent !== null
      ? felaqua.fillPercent - before.fillPercent >= FELAQUA_REFILL_PERCENT
      : before.waterMl !== null && felaqua.waterMl !== null && felaqua.waterMl - before.waterMl >= FELAQUA_REFILL_ML;
    if (refilled) {
      events.push({
        type: 'felaqua_refilled', deviceId: felaqua.id, deviceName: felaqua.name, level: felaqua.fillPercent,
      });
    }

    if (before.fillPercent !== null && felaqua.fillPercent !== null && felaqua.fillPercent < before.fillPercent) {
      events.push({
        type: 'felaqua_level',
        deviceId: felaqua.id,
        deviceName: felaqua.name,
        previous: before.fillPercent,
        level: felaqua.fillPercent,
      });
    }
  }

  for (const feeder of next.feeders) {
    const before = previous.feeders.find((f) => f.id === feeder.id);
    if (!before) {
      continue;
    }

    for (const bowl of feeder.bowls) {
      const earlier = before.bowls.find((b) => b.index === bowl.index)?.weightGrams ?? null;
      if (earlier === null || bowl.weightGrams === null) {
        continue;
      }
      const name = bowlName(feeder.singleBowl, bowl.index);
      if (bowl.weightGrams - earlier >= BOWL_REFILL_GRAMS) {
        events.push({
          type: 'feeder_refilled',
          deviceId: feeder.id,
          deviceName: feeder.name,
          bowl: name,
          grams: Math.round(bowl.weightGrams - earlier),
        });
      } else if (bowl.weightGrams < earlier) {
        events.push({
          type: 'feeder_bowl_level',
          deviceId: feeder.id,
          deviceName: feeder.name,
          bowl: name,
          previous: earlier,
          grams: bowl.weightGrams,
        });
      }
    }
  }

  const previousBattery = new Map(batteryDevices(previous).map((entry) => [entry.device.id, entry.device]));
  for (const { device, kind } of batteryDevices(next)) {
    const before = previousBattery.get(device.id);
    if (
      before
      && before.batteryPercent !== null
      && device.batteryPercent !== null
      && before.batteryPercent > LOW_BATTERY_THRESHOLD
      && device.batteryPercent <= LOW_BATTERY_THRESHOLD
    ) {
      events.push({
        type: 'battery_low',
        deviceId: device.id,
        deviceName: device.name,
        kind,
        level: device.batteryPercent,
      });
    }
  }

  return events;
}
