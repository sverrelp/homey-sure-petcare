import SureDevice from '../../lib/SureDevice';
import { translate } from '../../lib/i18n';
import {
  PetProfile, PetUpdate, SurePet, SureSnapshot,
} from '../../lib/types';

/** Capabilities added after the first release: older paired pets get them on startup. */
const EXTRA_CAPABILITIES = [
  'last_door',
  'measure_meals_today',
  'measure_drinks_today',
  'measure_trips_today',
  'measure_outside_minutes_today',
];

/** The stay outside as one poll saw it. */
interface OutsideStay {
  since: string | null;
  trips: number | null;
  minutes: number | null;
  /** When the poll that produced these numbers fetched its data. */
  dataAt: number;
}

class PetDevice extends SureDevice {
  /** Last editable profile values received from Sure Petcare. */
  private profileSignature: string | null = null;
  /** Last position applied to this device. Undefined until the first snapshot. */
  private lastPresence: string | null | undefined;
  /**
   * The current stay outside as the last poll saw it: when it began, and the trips and minutes outside today
   * (the minutes include this stay). Used for the timeline line when the pet comes back. Null while inside.
   */
  private stayOutside: OutsideStay | null = null;
  /** Moment of our last successful profile write, until the result has been confirmed by fresh data. */
  private writtenAt: number | null = null;

  protected async onSureInit(): Promise<void> {
    for (const capability of EXTRA_CAPABILITIES) {
      if (!this.hasCapability(capability)) {
        await this.addCapability(capability);
      }
    }
  }

  protected async updateFromSnapshot(snapshot: SureSnapshot): Promise<boolean> {
    const pet = snapshot.pets.find((p) => p.id === this.sureId);
    if (!pet) {
      return false;
    }

    const previousFood = this.getCapabilityValue('measure_food_eaten_today') as number | null;
    const previousWater = this.getCapabilityValue('measure_water_drunk_today') as number | null;

    // Remember the position synchronously, so two overlapping snapshots can never fire the same change twice.
    const previousPresence = this.lastPresence === undefined
      ? this.getCapabilityValue('pet_presence') as string | null
      : this.lastPresence;
    this.lastPresence = pet.position;
    // The stay outside as seen by the last poll, taken now for the same reason.
    const stayOutside = this.stayOutside;
    this.stayOutside = pet.position === 'outside' ? {
      since: pet.since,
      trips: pet.today?.tripCount ?? null,
      minutes: pet.today?.outsideMinutes ?? null,
      dataAt: snapshot.fetchedAt,
    } : null;
    await this.setCap('pet_presence', pet.position);
    await this.checkPresenceChange(pet, previousPresence, stayOutside);
    await this.setCap('last_seen', this.formatTimestamp(pet.lastSeen));
    await this.setCap('last_door', pet.lastDoor?.deviceName ?? null);

    if (pet.today) {
      await this.setCap('measure_food_eaten_today', pet.today.foodGrams);
      await this.setCap('measure_meals_today', pet.today.mealCount);
      await this.setCap('measure_water_drunk_today', pet.today.waterMl);
      await this.setCap('measure_drinks_today', pet.today.drinkCount);
      if (pet.today.tripCount !== null) {
        await this.setCap('measure_trips_today', pet.today.tripCount);
      }
      if (pet.today.outsideMinutes !== null) {
        await this.setCap('measure_outside_minutes_today', pet.today.outsideMinutes);
      }
    }

    await this.updateWeight(pet.profile);
    await this.updateProfileSettings(pet.profile, snapshot.fetchedAt);

    await this.checkOutsideTooLong(pet);
    if (pet.today) {
      await this.checkGoal(pet, 'food', previousFood, pet.today.foodGrams);
      await this.checkGoal(pet, 'water', previousWater, pet.today.waterMl);
    }

    return true;
  }

  /** The weight is optional in the Sure Petcare app, so the capability only exists when it is known. */
  private async updateWeight(profile: PetProfile): Promise<void> {
    if (profile.weightKg === null) {
      if (this.hasCapability('measure_weight')) {
        await this.removeCapability('measure_weight');
      }
      return;
    }
    if (!this.hasCapability('measure_weight')) {
      await this.addCapability('measure_weight');
    }
    await this.setCap('measure_weight', profile.weightKg);
  }

  /**
   * Show the pet profile in the device settings. Species, gender, age and chip are read-only labels.
   * Weight, birth date, food type and neutered are editable: they are only overwritten when the data in
   * Sure Petcare changed, so values the user is typing are not replaced by an unchanged poll result.
   */
  private async updateProfileSettings(profile: PetProfile, fetchedAt: number): Promise<void> {
    const dash = '-';
    const labels: Record<string, string> = {
      species: profile.species ? this.homey.__(`pets.species_${profile.species}`) : dash,
      gender: profile.gender ? this.homey.__(`pets.gender_${profile.gender}`) : dash,
      age: profile.birthDate ? this.formatAge(profile.birthDate) ?? dash : dash,
      chip: profile.chip ?? dash,
    };
    const editable: Record<string, string | number | boolean> = {
      weight_kg: profile.weightKg ?? 0,
      birth_date: profile.birthDate ?? '',
      food_type: profile.foodType ?? '0',
      spayed: profile.spayed ?? false,
    };

    const signature = JSON.stringify(editable);
    // After our own write, show what Sure Petcare really stored once the next fresh data arrives.
    const verifyWrite = this.writtenAt !== null && fetchedAt > this.writtenAt;
    const apply = signature !== this.profileSignature || verifyWrite;
    this.profileSignature = signature;
    if (verifyWrite) {
      this.writtenAt = null;
    }

    const current = this.getSettings() as Record<string, unknown>;
    const next: Record<string, string | number | boolean> = { ...labels, ...(apply ? editable : {}) };
    const changed = Object.keys(next).some((key) => current[key] !== next[key]);
    if (changed) {
      await this.setSettings(next);
    }
  }

  /** Called when the user saves the device settings. Profile changes are written to Sure Petcare first. */
  async onSettings({ newSettings, changedKeys }: {
    oldSettings: Record<string, unknown>;
    newSettings: Record<string, unknown>;
    changedKeys: string[];
  }): Promise<void> {
    const changes: PetUpdate = {};

    if (changedKeys.includes('weight_kg')) {
      const kg = Number(newSettings.weight_kg);
      if (!Number.isFinite(kg) || kg <= 0 || kg > 100) {
        throw new Error(this.homey.__('pets.invalid_weight'));
      }
      changes.weightKg = Math.round(kg * 100) / 100;
    }

    if (changedKeys.includes('birth_date')) {
      const text = String(newSettings.birth_date ?? '').trim();
      if (text === '') {
        changes.birthDate = null;
      } else if (this.isValidBirthDate(text)) {
        changes.birthDate = text;
      } else {
        throw new Error(this.homey.__('pets.invalid_birth_date'));
      }
    }

    if (changedKeys.includes('food_type')) {
      const value = String(newSettings.food_type);
      changes.foodType = value === 'wet' || value === 'dry' || value === 'both' ? value : null;
    }

    if (changedKeys.includes('spayed')) {
      changes.spayed = newSettings.spayed === true;
    }

    if (Object.keys(changes).length === 0) {
      return;
    }

    try {
      await this.sureApp.updatePet(this.sureId, changes);
    } catch (err) {
      throw new Error(translate(this.homey, 'pets.save_failed', { reason: (err as Error)?.message ?? String(err) }));
    }
    this.writtenAt = Date.now();
  }

  /** A real calendar date (YYYY-MM-DD) that is not in the future. */
  private isValidBirthDate(text: string): boolean {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
      return false;
    }
    const date = new Date(`${text}T00:00:00Z`);
    return !Number.isNaN(date.getTime())
      && date.toISOString().slice(0, 10) === text
      && date.getUTCFullYear() > 1980
      && date.getTime() <= Date.now();
  }

  /**
   * Fire "Came inside" or "Went outside" when the presence shown on this device changes.
   * The trigger follows the capability, so the card fires for every change the user can see:
   * a pet passing the door, a change in the Sure Petcare app and "Mark as inside/outside".
   * The first value of a new device is not a change.
   */
  private async checkPresenceChange(
    pet: SurePet,
    previous: string | null,
    stay: OutsideStay | null,
  ): Promise<void> {
    if (previous === null || previous === undefined || previous === pet.position) {
      return;
    }

    if (pet.position === 'inside') {
      this.log(`${pet.name} came inside`);
      const entry = this.cameInsideText(pet, stay);
      this.sureApp.logTimeline('pets', entry.key, entry.tokens);
      // Not awaited: Homey can take several seconds to answer, and the other values must not wait for it.
      this.fireTrigger('pet_came_inside', pet, {}).catch(() => undefined);
    } else if (pet.position === 'outside') {
      this.log(`${pet.name} went outside`);
      this.sureApp.logTimeline('pets', 'went_outside', { pet: pet.name });
      this.fireTrigger('pet_went_outside', pet, {}).catch(() => undefined);
    }
  }

  /**
   * The timeline line for a pet that came inside. It tells how long the stay outside lasted and, when the data is
   * known, how many trips outside there were today and the total time outside today.
   * The numbers come from the last poll while the pet was outside, because the day report may not have
   * caught up yet at the moment the pet comes back.
   */
  private cameInsideText(
    pet: SurePet,
    stay: OutsideStay | null,
  ): { key: string; tokens: Record<string, string | number> } {
    const now = Date.now();
    const startedAt = stay?.since ? new Date(stay.since).getTime() : NaN;
    if (!stay || !Number.isFinite(startedAt) || startedAt > now) {
      return { key: 'came_inside', tokens: { pet: pet.name } };
    }

    const duration = this.formatDuration(Math.max(1, Math.round((now - startedAt) / 60_000)));
    if (stay.trips === null || stay.minutes === null) {
      return { key: 'came_inside_after', tokens: { pet: pet.name, duration } };
    }

    const sincePoll = Math.max(0, Math.round((now - stay.dataAt) / 60_000));
    return {
      key: 'came_inside_stats',
      tokens: {
        pet: pet.name,
        duration,
        trips: stay.trips,
        total: this.formatDuration(stay.minutes + sincePoll),
      },
    };
  }

  /** "25 min" or "2 h 10 min", in the language of the Homey. */
  private formatDuration(totalMinutes: number): string {
    const minutes = Math.max(0, Math.round(totalMinutes));
    return minutes >= 60
      ? translate(this.homey, 'pets.hours_minutes', { hours: Math.floor(minutes / 60), minutes: minutes % 60 })
      : translate(this.homey, 'pets.minutes', { minutes });
  }

  /** Fire "has been outside too long" once per stay outside. */
  private async checkOutsideTooLong(pet: SurePet): Promise<void> {
    const maxHours = Number(this.getSetting('max_outside_hours')) || 0;
    if (maxHours <= 0 || pet.position !== 'outside' || !pet.since) {
      return;
    }

    const hoursOutside = (Date.now() - new Date(pet.since).getTime()) / 3_600_000;
    if (hoursOutside < maxHours || this.getStoreValue('outsideAlertSince') === pet.since) {
      return;
    }

    await this.setStoreValue('outsideAlertSince', pet.since);
    this.log(`${pet.name} has been outside for ${hoursOutside.toFixed(1)} hours`);
    await this.fireTrigger('pet_outside_too_long', pet, { hours: Math.round(hoursOutside * 10) / 10 });
  }

  /** Fire a daily goal trigger the moment the total crosses the goal, at most once per day. */
  private async checkGoal(
    pet: SurePet,
    kind: 'food' | 'water',
    previous: number | null,
    current: number,
  ): Promise<void> {
    const goal = Number(this.getSetting(`${kind}_goal`)) || 0;
    if (goal <= 0 || previous === null || previous >= goal || current < goal) {
      return;
    }

    const storeKey = `${kind}GoalDay`;
    const today = this.dayKey();
    if (this.getStoreValue(storeKey) === today) {
      return;
    }

    await this.setStoreValue(storeKey, today);
    this.log(`${pet.name} reached the daily ${kind} goal (${current})`);
    await this.fireTrigger(`pet_${kind}_goal_reached`, pet, { amount: current });
  }

  private async fireTrigger(cardId: string, pet: SurePet, tokens: Record<string, number>): Promise<void> {
    try {
      // A device trigger card: Homey starts only the flows that picked this pet.
      await this.homey.flow.getDeviceTriggerCard(cardId).trigger(this, { name: pet.name, ...tokens }, {});
      this.log(`Fired ${cardId}`);
    } catch (err) {
      this.error(`Failed to fire ${cardId}:`, (err as Error)?.message ?? err);
    }
  }

  private dayKey(): string {
    try {
      return new Intl.DateTimeFormat('en-CA', {
        timeZone: this.homey.clock.getTimezone(), year: 'numeric', month: '2-digit', day: '2-digit',
      }).format(new Date());
    } catch {
      return new Date().toISOString().slice(0, 10);
    }
  }

  /** Age in whole months or years and months, or null when the birth date is in the future. */
  private formatAge(isoDate: string): string | null {
    const born = new Date(isoDate);
    const now = new Date();
    let months = (now.getFullYear() - born.getFullYear()) * 12 + now.getMonth() - born.getMonth();
    if (now.getDate() < born.getDate()) {
      months -= 1;
    }
    if (Number.isNaN(months) || months < 0) {
      return null;
    }
    return months >= 12
      ? translate(this.homey, 'pets.age_years', { years: Math.floor(months / 12), months: months % 12 })
      : translate(this.homey, 'pets.age_months', { months });
  }
}

export = PetDevice;
