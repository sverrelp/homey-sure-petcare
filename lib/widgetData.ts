import { bowlName, BowlName } from './events';
import {
  ConnectionState, LOCK_MODE_IDS, LockModeId, lockModeToId, PetPosition, SureSnapshot,
} from './types';

/**
 * Small, secret-free view model of the household for dashboard widgets.
 * Built from the cached snapshot, so a widget never causes a Sure Petcare request.
 */

export interface WidgetPet {
  id: number;
  name: string;
  position: PetPosition;
  /** Public photo URL from Sure Petcare. The widget loads the picture through the app. */
  photoUrl: string | null;
  /** ISO timestamp of the last position change. */
  since: string | null;
  /** ISO timestamp of the last sign of life (movement, eating or drinking). */
  lastSeen: string | null;
  mealsToday: number | null;
  drinksToday: number | null;
  tripsToday: number | null;
  outsideMinutesToday: number | null;
  lastDoor: string | null;
}

export interface WidgetDoor {
  id: number;
  name: string;
  mode: LockModeId | null;
  batteryPercent: number | null;
  online: boolean | null;
  lastUsedBy: string | null;
  lastUsedAt: string | null;
}

export interface WidgetFeeder {
  id: number;
  name: string;
  bowls: Array<{ bowl: BowlName; grams: number | null }>;
  batteryPercent: number | null;
  online: boolean | null;
}

export interface WidgetFountain {
  id: number;
  name: string;
  fillPercent: number | null;
  waterMl: number | null;
  batteryPercent: number | null;
  online: boolean | null;
}

export interface WidgetOverview {
  state: ConnectionState;
  /** Epoch milliseconds of the last successful sync. */
  updatedAt: number | null;
  lockModes: readonly LockModeId[];
  pets: WidgetPet[];
  doors: WidgetDoor[];
  feeders: WidgetFeeder[];
  fountains: WidgetFountain[];
}

export function buildWidgetOverview(snapshot: SureSnapshot | null, state: ConnectionState): WidgetOverview {
  return {
    state,
    updatedAt: snapshot?.fetchedAt ?? null,
    lockModes: LOCK_MODE_IDS,
    pets: (snapshot?.pets ?? []).map((pet) => ({
      id: pet.id,
      name: pet.name,
      position: pet.position,
      photoUrl: pet.photoUrl,
      since: pet.since,
      lastSeen: pet.lastSeen,
      mealsToday: pet.today?.mealCount ?? null,
      drinksToday: pet.today?.drinkCount ?? null,
      tripsToday: pet.today?.tripCount ?? null,
      outsideMinutesToday: pet.today?.outsideMinutes ?? null,
      lastDoor: pet.lastDoor?.deviceName ?? null,
    })),
    doors: (snapshot?.flaps ?? []).map((flap) => ({
      id: flap.id,
      name: flap.name,
      mode: lockModeToId(flap.lockMode),
      batteryPercent: flap.batteryPercent,
      online: flap.online,
      lastUsedBy: flap.lastUse?.petName ?? null,
      lastUsedAt: flap.lastUse?.at ?? null,
    })),
    feeders: (snapshot?.feeders ?? []).map((feeder) => ({
      id: feeder.id,
      name: feeder.name,
      bowls: feeder.bowls.map((bowl) => ({
        bowl: bowlName(feeder.singleBowl, bowl.index),
        grams: bowl.weightGrams,
      })),
      batteryPercent: feeder.batteryPercent,
      online: feeder.online,
    })),
    fountains: (snapshot?.felaquas ?? []).map((felaqua) => ({
      id: felaqua.id,
      name: felaqua.name,
      fillPercent: felaqua.fillPercent,
      waterMl: felaqua.waterMl,
      batteryPercent: felaqua.batteryPercent,
      online: felaqua.online,
    })),
  };
}
