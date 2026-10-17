/**
 * Normalized data model shared between the API client, the app and the drivers.
 */

/** Lock modes of a SureFlap, matching the numeric values used by the Sure Petcare API. */
export enum LockMode {
  Unlocked = 0,
  KeepIn = 1,
  KeepOut = 2,
  Locked = 3,
  Curfew = 4,
}

/** Identifiers used by the Homey capability, flow cards and the dashboard. */
export type LockModeId = 'normal' | 'keep_in' | 'keep_out' | 'locked' | 'curfew';

export const LOCK_MODE_IDS: readonly LockModeId[] = ['normal', 'keep_in', 'keep_out', 'locked', 'curfew'];

const LOCK_MODE_BY_ID: Record<LockModeId, LockMode> = {
  normal: LockMode.Unlocked,
  keep_in: LockMode.KeepIn,
  keep_out: LockMode.KeepOut,
  locked: LockMode.Locked,
  curfew: LockMode.Curfew,
};

export function lockModeFromId(id: unknown): LockMode | null {
  return typeof id === 'string' && id in LOCK_MODE_BY_ID ? LOCK_MODE_BY_ID[id as LockModeId] : null;
}

export function lockModeToId(mode: LockMode | null): LockModeId | null {
  if (mode === null) return null;
  return LOCK_MODE_IDS.find((id) => LOCK_MODE_BY_ID[id] === mode) ?? null;
}

export type PetPosition = 'inside' | 'outside' | 'unknown';

/** Product ids reported by the Sure Petcare API. Unknown products are ignored. */
export const PRODUCT_HUB = 1;
export const PRODUCT_PET_FLAP = 3;
export const PRODUCT_FEEDER = 4;
export const PRODUCT_CAT_FLAP = 6;
export const PRODUCT_FELAQUA = 8;

export const FLAP_PRODUCT_IDS: readonly number[] = [PRODUCT_PET_FLAP, PRODUCT_CAT_FLAP];
export const FEEDER_PRODUCT_IDS: readonly number[] = [PRODUCT_FEEDER];
export const FELAQUA_PRODUCT_IDS: readonly number[] = [PRODUCT_FELAQUA];

/** Battery level (percent) at or below which a device counts as "low". */
export const LOW_BATTERY_THRESHOLD = 20;

export type DeviceKind = 'flap' | 'feeder' | 'felaqua';

export interface SureDeviceBase {
  id: number;
  householdId: number | null;
  productId: number;
  name: string;
  /** Raw battery voltage of the whole pack, when reported. */
  batteryVoltage: number | null;
  /** Battery level 0-100, when it can be determined. */
  batteryPercent: number | null;
  online: boolean | null;
  /** Signal strength between hub and device in dBm (negative), when reported. */
  signalStrength: number | null;
}

/** The most recent pet movement through a flap, as far as the recent timeline shows. */
export interface FlapUse {
  petId: number;
  petName: string | null;
  at: string;
}

export interface SureFlap extends SureDeviceBase {
  lockMode: LockMode | null;
  lastUse: FlapUse | null;
}

export interface SureBowl {
  index: number;
  /** Weight currently in the bowl in grams. */
  weightGrams: number | null;
  fillPercent: number | null;
}

export interface SureFeeder extends SureDeviceBase {
  /** True when the feeder is configured with a single bowl. */
  singleBowl: boolean;
  /** Index 0 is the left bowl, index 1 the right bowl. */
  bowls: SureBowl[];
}

export interface SureFelaqua extends SureDeviceBase {
  /** Water in the reservoir in grams (about equal to ml). */
  waterMl: number | null;
  fillPercent: number | null;
}

export interface PetIntake {
  /** ISO timestamp of the last time the pet ate or drank. */
  at: string;
  /** Amount consumed in grams (food) or ml (water). */
  amount: number;
  /** The feeder or fountain that registered it, when Sure Petcare tells. */
  deviceId: number | null;
  /** Grams eaten per bowl (index 0 is the left bowl). Empty for water. */
  bowlGrams: number[];
}

export interface PetToday {
  foodGrams: number;
  waterMl: number;
  mealCount: number;
  drinkCount: number;
  /** Number of times the pet left the house today, or null when the report has no movement data. */
  tripCount: number | null;
  /** Minutes spent outside today (including the current stay), or null when unknown. */
  outsideMinutes: number | null;
}

export type PetSpecies = 'cat' | 'dog';
export type PetGender = 'male' | 'female';
export type PetFoodType = 'wet' | 'dry' | 'both';

/** Which doors a pet may use. "indoor_only" keeps the pet inside. */
export type PetAccess = 'free' | 'indoor_only';

/** Profile fields of a pet that can be changed in Sure Petcare. Only the given fields are changed. */
export interface PetUpdate {
  weightKg?: number;
  /** ISO date (YYYY-MM-DD), or null to clear the birth date. */
  birthDate?: string | null;
  /** null clears the food type. */
  foodType?: PetFoodType | null;
  spayed?: boolean;
}

/** Static profile data of a pet as entered in the Sure Petcare app. Every field may be missing. */
export interface PetProfile {
  species: PetSpecies | null;
  gender: PetGender | null;
  /** ISO date (YYYY-MM-DD). */
  birthDate: string | null;
  weightKg: number | null;
  foodType: PetFoodType | null;
  spayed: boolean | null;
  /** Microchip or tag number. */
  chip: string | null;
}

/** The pet door a pet used most recently. */
export interface PetLastDoor {
  deviceId: number | null;
  deviceName: string | null;
  at: string;
}

export interface SurePet {
  id: number;
  name: string;
  householdId: number | null;
  tagId: number | null;
  photoUrl: string | null;
  position: PetPosition;
  /** ISO timestamp of the last position change, if known. */
  since: string | null;
  /** Most recent sign of life: movement, eating or drinking (ISO timestamp). */
  lastSeen: string | null;
  lastFeeding: PetIntake | null;
  lastDrinking: PetIntake | null;
  /** Consumption today, or null while the report has not been fetched yet. */
  today: PetToday | null;
  profile: PetProfile;
  /** Last door movement seen in the household timeline, if it is still in the recent page. */
  lastDoor: PetLastDoor | null;
}

/** A visit by a chip that is not registered with the household. */
export interface SureIntruderEvent {
  id: number;
  at: string;
  deviceId: number | null;
  deviceName: string | null;
}

export interface SureHousehold {
  id: number;
  name: string;
}

/** Everything the app caches after one successful poll. */
export interface SureSnapshot {
  households: SureHousehold[];
  pets: SurePet[];
  flaps: SureFlap[];
  feeders: SureFeeder[];
  felaquas: SureFelaqua[];
  /** Recent unregistered chip events from the household timeline. */
  intruders: SureIntruderEvent[];
  /** Epoch milliseconds when the snapshot was fetched. */
  fetchedAt: number;
}

export type ConnectionState =
  | 'no_credentials'
  | 'connecting'
  | 'connected'
  | 'auth_error'
  | 'rate_limited'
  | 'network_error';

/** Status information exposed to the settings page. Never contains secrets. */
export interface AppStatus {
  state: ConnectionState;
  email: string | null;
  lastUpdate: number | null;
  lastError: string | null;
  pollIntervalSeconds: number;
  petCount: number;
  flapCount: number;
  feederCount: number;
  felaquaCount: number;
}

/** A device offered to the user in the pairing list. */
export interface PairableDevice {
  name: string;
  data: { id: number };
}

export type SnapshotListener = (snapshot: SureSnapshot, previous: SureSnapshot | null) => void;
export type ConnectionListener = (state: ConnectionState) => void;

export interface Credentials {
  email: string;
  password: string;
}
