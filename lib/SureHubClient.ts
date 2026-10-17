import {
  ApiError, AuthError, NetworkError, RateLimitError, SureHubError,
} from './errors';
import {
  Credentials,
  FEEDER_PRODUCT_IDS,
  FELAQUA_PRODUCT_IDS,
  FLAP_PRODUCT_IDS,
  LockMode,
  PRODUCT_FELAQUA,
  PetAccess,
  PetFoodType,
  PetGender,
  PetIntake,
  PetLastDoor,
  PetPosition,
  PetProfile,
  PetSpecies,
  PetToday,
  PetUpdate,
  SureBowl,
  SureDeviceBase,
  SureFeeder,
  SureFelaqua,
  SureFlap,
  SureHousehold,
  SureIntruderEvent,
  SurePet,
  SureSnapshot,
} from './types';

const DEFAULT_BASE_URL = 'https://app-api.production.surehub.io/api';
const DEFAULT_TIMEOUT_MS = 20_000;

/** Households rarely change, so they are cached for an hour. */
const HOUSEHOLD_TTL_MS = 60 * 60_000;
/** Consumption reports are refreshed at most this often unless a pet just ate or drank. */
const REPORT_TTL_MS = 5 * 60_000;
/** Pause optional requests (timeline, reports) for this long after a 429 without Retry-After. */
const OPTIONAL_BACKOFF_MS = 5 * 60_000;
const TIMELINE_PAGE_SIZE = 25;

/** Timeline event type: an unregistered chip was seen at a flap. */
const TIMELINE_UNKNOWN_TAG = 7;
/** Timeline event type: a registered pet moved through a flap. */
const TIMELINE_PET_MOVEMENT = 0;

/** Sure Petcare's placeholder for "birth date not set". */
const UNSET_BIRTH_DATE = '1970-01-01T00:00:00Z';
const FOOD_TYPE_IDS: Record<PetFoodType, number> = { wet: 1, dry: 2, both: 3 };
/** Tag profiles on a flap: 2 = may come and go, 3 = indoor only. */
const PET_PROFILE_FREE = 2;
const PET_PROFILE_INDOOR_ONLY = 3;
/** Pet record fields that are sent back on update. Read-only fields (photo, status, ...) are left out. */
const WRITABLE_PET_FIELDS = [
  'name', 'gender', 'date_of_birth', 'weight', 'comments', 'household_id',
  'breed_id', 'species_id', 'food_type_id', 'spayed', 'tag_id', 'version',
];
/** Report datapoint context: a real feeding/drinking session (not a bowl reset or fill). */
const REPORT_CONTEXT_SESSION = 1;

interface BatteryProfile {
  cells: number;
  emptyVolts: number;
  fullVolts: number;
}

const DEFAULT_BATTERY_PROFILE: BatteryProfile = { cells: 4, emptyVolts: 1.25, fullVolts: 1.6 };
const BATTERY_PROFILES: Record<number, BatteryProfile> = {
  [PRODUCT_FELAQUA]: { cells: 1, emptyVolts: 5.2, fullVolts: 6.2 },
};

export interface SureHubClientOptions {
  baseUrl?: string;
  timeoutMs?: number;
  /** Stable id identifying this Homey as a "device" towards Sure Petcare. */
  deviceId: string;
  /** Called with the new token (or null when cleared) so the app can persist it. */
  onTokenChange?: (token: string | null) => void;
  log?: (...args: unknown[]) => void;
  error?: (...args: unknown[]) => void;
}

type JsonObject = Record<string, any>;

interface ReportCacheEntry {
  fetchedAt: number;
  dayKey: string;
  feedingAt: string | null;
  drinkingAt: string | null;
  /** Position timestamp the report was fetched for: a new movement makes the report stale. */
  positionSince: string | null;
  today: PetToday;
}

/**
 * Thin client around the unofficial Sure Petcare REST API.
 * A single instance is shared by the whole app (see `SurePetApp.getSureHubClient()`).
 */
export class SureHubClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly deviceId: string;
  private readonly onTokenChange?: (token: string | null) => void;
  private readonly logFn: (...args: unknown[]) => void;
  private readonly errorFn: (...args: unknown[]) => void;

  private credentials: Credentials | null = null;
  private token: string | null = null;
  private loginPromise: Promise<void> | null = null;

  private households: SureHousehold[] = [];
  private householdsFetchedAt = 0;
  private readonly reportCache = new Map<number, ReportCacheEntry>();
  /** Last known door movement per pet, kept when the timeline is temporarily unavailable. */
  private readonly lastDoors = new Map<number, PetLastDoor>();
  /** Latest pet movement per flap, keyed by device id. */
  private readonly doorUses = new Map<number, { petId: number; at: string }>();
  /** Last raw pet records, needed to send complete updates back to Sure Petcare. */
  private readonly rawPets = new Map<number, JsonObject>();
  /** Latest bowl weights per device, taken from consumption reports (fallback for missing bowl_status). */
  private readonly reportWeights = new Map<number, Map<number, { at: string; weight: number }>>();
  private optionalBlockedUntil = 0;

  constructor(options: SureHubClientOptions) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.deviceId = options.deviceId;
    this.onTokenChange = options.onTokenChange;
    this.logFn = options.log ?? (() => undefined);
    this.errorFn = options.error ?? (() => undefined);
  }

  // ---------------------------------------------------------------------------
  // Session handling
  // ---------------------------------------------------------------------------

  public setCredentials(credentials: Credentials | null): void {
    this.credentials = credentials;
  }

  public hasCredentials(): boolean {
    return this.credentials !== null;
  }

  public setToken(token: string | null): void {
    this.token = token;
  }

  public hasToken(): boolean {
    return this.token !== null;
  }

  /** Forget the session and all cached account data. The next request will log in again. */
  public clearSession(): void {
    this.updateToken(null);
    this.households = [];
    this.householdsFetchedAt = 0;
    this.reportCache.clear();
    this.reportWeights.clear();
    this.optionalBlockedUntil = 0;
  }

  /**
   * Log in with the configured credentials. Concurrent callers share one login request,
   * which prevents hammering the (strictly rate limited) login endpoint.
   */
  public async login(): Promise<void> {
    if (this.loginPromise) {
      return this.loginPromise;
    }

    this.loginPromise = this.doLogin().finally(() => {
      this.loginPromise = null;
    });
    return this.loginPromise;
  }

  private async doLogin(): Promise<void> {
    if (!this.credentials) {
      throw new AuthError('No Sure Petcare credentials configured');
    }

    this.logFn('Logging in to Sure Petcare');

    let body: JsonObject;
    try {
      body = await this.rawRequest('POST', '/auth/login', {
        email_address: this.credentials.email,
        password: this.credentials.password,
        device_id: this.deviceId,
      }, false);
    } catch (err) {
      // Bad credentials are reported with 400/401/403/422 depending on the failure.
      if (err instanceof ApiError && [400, 401, 403, 422].includes(err.status)) {
        throw new AuthError('Sure Petcare rejected the credentials');
      }
      throw err;
    }

    const token = body?.data?.token;
    if (typeof token !== 'string' || token.length === 0) {
      throw new AuthError('Sure Petcare login response did not contain a token');
    }

    this.updateToken(token);
    this.logFn('Logged in to Sure Petcare');
  }

  private updateToken(token: string | null): void {
    this.token = token;
    try {
      this.onTokenChange?.(token);
    } catch (err) {
      this.errorFn('onTokenChange callback failed', err);
    }
  }

  // ---------------------------------------------------------------------------
  // High level API calls
  // ---------------------------------------------------------------------------

  /**
   * Fetch the complete state of all households.
   * Pets and devices are essential: if they fail, the whole call fails.
   * Timeline and consumption reports are optional and never fail the poll.
   *
   * @param timezone IANA timezone used to decide what "today" means for consumption totals
   */
  public async fetchSnapshot(timezone: string): Promise<SureSnapshot> {
    const households = await this.getHouseholds();

    const petsRaw = await this.getList('/pet?with%5B%5D=photo&with%5B%5D=position&with%5B%5D=status&with%5B%5D=tag');
    const devicesRaw = await this.getList(
      '/device?with%5B%5D=children&with%5B%5D=tags&with%5B%5D=control&with%5B%5D=status',
    );

    petsRaw.forEach((raw) => this.rawPets.set(Number(raw.id), raw));
    const pets = petsRaw.map((raw) => this.normalizePet(raw));
    const flaps = devicesRaw
      .filter((raw) => FLAP_PRODUCT_IDS.includes(Number(raw.product_id)))
      .map((raw) => this.normalizeFlap(raw));
    const feeders = devicesRaw
      .filter((raw) => FEEDER_PRODUCT_IDS.includes(Number(raw.product_id)))
      .map((raw) => this.normalizeFeeder(raw));
    const felaquas = devicesRaw
      .filter((raw) => FELAQUA_PRODUCT_IDS.includes(Number(raw.product_id)))
      .map((raw) => this.normalizeFelaqua(raw));

    await this.attachReports(pets, timezone);
    this.applyReportWeights(feeders, felaquas);

    const intruders = await this.getIntruders(households, flaps);
    for (const pet of pets) {
      pet.lastDoor = this.lastDoors.get(pet.id) ?? null;
    }
    for (const flap of flaps) {
      const use = this.doorUses.get(flap.id);
      flap.lastUse = use
        ? { petId: use.petId, petName: pets.find((p) => p.id === use.petId)?.name ?? null, at: use.at }
        : null;
    }

    return {
      households,
      pets,
      flaps,
      feeders,
      felaquas,
      intruders,
      fetchedAt: Date.now(),
    };
  }

  /** Change the lock mode of a flap. */
  public async setLockMode(deviceId: number, mode: LockMode): Promise<void> {
    await this.request('PUT', `/device/${deviceId}/control`, { locking: mode });
  }

  /**
   * Change profile fields of a pet (weight, birth date, food type, neutered).
   *
   * Sure Petcare replaces the whole pet record, so the editable fields of the last known
   * record are sent along with the changes. If the server rejects that, a minimal update
   * (changes plus record version) is tried once before giving up.
   */
  public async updatePet(petId: number, changes: PetUpdate): Promise<void> {
    const raw = this.rawPets.get(petId);
    if (!raw) {
      throw new SureHubError(`Pet ${petId} is not known yet, wait for the next sync`);
    }

    const patch: JsonObject = {};
    if (changes.weightKg !== undefined) {
      patch.weight = String(Math.round(changes.weightKg * 1000));
    }
    if (changes.birthDate !== undefined) {
      patch.date_of_birth = changes.birthDate ? `${changes.birthDate}T00:00:00Z` : UNSET_BIRTH_DATE;
    }
    if (changes.foodType !== undefined) {
      patch.food_type_id = changes.foodType ? FOOD_TYPE_IDS[changes.foodType] : 0;
    }
    if (changes.spayed !== undefined) {
      patch.spayed = changes.spayed ? 1 : 0;
    }

    const full: JsonObject = {};
    for (const key of WRITABLE_PET_FIELDS) {
      if (raw[key] !== undefined && raw[key] !== null) {
        full[key] = raw[key];
      }
    }
    Object.assign(full, patch);

    let body: JsonObject;
    try {
      body = await this.request('PUT', `/pet/${petId}`, full);
    } catch (err) {
      if (!(err instanceof ApiError) || (err.status !== 400 && err.status !== 422)) {
        throw err;
      }
      this.logFn(`Full pet update rejected (${err.message}), retrying with changed fields only`);
      const minimal: JsonObject = raw.version !== undefined ? { ...patch, version: raw.version } : patch;
      body = await this.request('PUT', `/pet/${petId}`, minimal);
    }

    const data = body?.data;
    this.logFn(`Pet ${petId} updated:`, Object.keys(patch).join(', '));
    this.rawPets.set(petId, { ...raw, ...patch, ...(data && typeof data === 'object' ? data : {}) });
  }

  /** Tell Sure Petcare that a pet is now inside or outside. */
  public async setPetPosition(petId: number, position: 'inside' | 'outside'): Promise<void> {
    const since = new Date().toISOString().slice(0, 19).replace('T', ' ');
    await this.request('POST', `/pet/${petId}/position`, { where: position === 'inside' ? 1 : 2, since });
  }

  /**
   * Set how a pet may use one flap. The server applies this asynchronously
   * (the flap itself is updated through the hub), so the change shows up after a short delay.
   */
  public async setPetAccess(deviceId: number, tagId: number, access: PetAccess): Promise<void> {
    await this.request('PUT', `/device/${deviceId}/tag/${tagId}/async`, {
      profile: access === 'indoor_only' ? PET_PROFILE_INDOOR_ONLY : PET_PROFILE_FREE,
    });
  }

  // ---------------------------------------------------------------------------
  // Data fetching helpers
  // ---------------------------------------------------------------------------

  private async getList(path: string): Promise<JsonObject[]> {
    const body = await this.request('GET', path);
    return Array.isArray(body?.data) ? body.data : [];
  }

  private async getHouseholds(): Promise<SureHousehold[]> {
    if (this.households.length > 0 && Date.now() - this.householdsFetchedAt < HOUSEHOLD_TTL_MS) {
      return this.households;
    }

    const list = await this.getList('/household');
    this.households = list.map((raw) => ({
      id: Number(raw.id),
      name: String(raw.name ?? `Household ${raw.id}`),
    }));
    this.householdsFetchedAt = Date.now();
    return this.households;
  }

  /**
   * Run a request that must not fail the whole poll. Rate limits pause all optional
   * requests; other failures are logged and skipped. Authentication errors still propagate.
   */
  private async optional<T>(label: string, fn: () => Promise<T>): Promise<T | null> {
    if (Date.now() < this.optionalBlockedUntil) {
      return null;
    }

    try {
      return await fn();
    } catch (err) {
      if (err instanceof AuthError) {
        throw err;
      }
      if (err instanceof RateLimitError) {
        this.optionalBlockedUntil = Date.now() + (err.retryAfterMs ?? OPTIONAL_BACKOFF_MS);
        this.errorFn(`${label}: rate limited, pausing optional requests`);
        return null;
      }
      this.errorFn(`${label} failed:`, (err as Error)?.message ?? String(err));
      return null;
    }
  }

  private async getIntruders(households: SureHousehold[], flaps: SureFlap[]): Promise<SureIntruderEvent[]> {
    const result: SureIntruderEvent[] = [];

    for (const household of households) {
      const entries = await this.optional(`Timeline of household ${household.id}`, () => this.getList(
        `/timeline/household/${household.id}?page_size=${TIMELINE_PAGE_SIZE}`,
      ));
      if (!entries) {
        continue;
      }

      for (const entry of entries) {
        const hasPets = Array.isArray(entry.pets) && entry.pets.length > 0;
        if (typeof entry.created_at !== 'string') {
          continue;
        }

        const device = Array.isArray(entry.devices)
          ? entry.devices.find((d: JsonObject) => FLAP_PRODUCT_IDS.includes(Number(d.product_id))) ?? entry.devices[0]
          : undefined;
        const deviceId = device?.id != null ? Number(device.id) : null;
        const flapName = flaps.find((f) => f.id === deviceId)?.name;
        const deviceName = flapName ?? (typeof device?.name === 'string' ? device.name : null);

        if (Number(entry.type) === TIMELINE_PET_MOVEMENT && hasPets) {
          for (const petRef of entry.pets) {
            const petId = Number(petRef?.id);
            const known = this.lastDoors.get(petId);
            if (Number.isFinite(petId) && (!known || new Date(entry.created_at) > new Date(known.at))) {
              this.lastDoors.set(petId, { deviceId, deviceName, at: entry.created_at });
            }
            const knownUse = deviceId !== null ? this.doorUses.get(deviceId) : undefined;
            if (
              deviceId !== null
              && Number.isFinite(petId)
              && (!knownUse || new Date(entry.created_at) > new Date(knownUse.at))
            ) {
              this.doorUses.set(deviceId, { petId, at: entry.created_at });
            }
          }
          continue;
        }

        if (Number(entry.type) !== TIMELINE_UNKNOWN_TAG || hasPets) {
          continue;
        }

        result.push({
          id: Number(entry.id),
          at: entry.created_at,
          deviceId,
          deviceName,
        });
      }
    }

    return result;
  }

  /** Attach cached or freshly fetched consumption totals to each pet. */
  private async attachReports(pets: SurePet[], timezone: string): Promise<void> {
    const todayKey = this.dayKey(new Date(), timezone);

    for (const pet of pets) {
      let cached = this.reportCache.get(pet.id);
      const stale = !cached
        || cached.dayKey !== todayKey
        || Date.now() - cached.fetchedAt > REPORT_TTL_MS
        || cached.feedingAt !== (pet.lastFeeding?.at ?? null)
        || cached.drinkingAt !== (pet.lastDrinking?.at ?? null)
        || cached.positionSince !== pet.since;

      if (stale && pet.householdId !== null) {
        const householdId = pet.householdId;
        const report = await this.optional(`Report of pet ${pet.id}`, () => this.getReport(householdId, pet.id));
        if (report) {
          cached = {
            fetchedAt: Date.now(),
            dayKey: todayKey,
            feedingAt: pet.lastFeeding?.at ?? null,
            drinkingAt: pet.lastDrinking?.at ?? null,
            positionSince: pet.since,
            today: this.computeToday(report, timezone),
          };
          this.reportCache.set(pet.id, cached);
        }
      }

      // Totals of a previous day are worthless: show zero until the new report arrives.
      if (cached && cached.dayKey === todayKey) {
        pet.today = { ...cached.today };
        // The report only knows finished trips: add the stay that is still going on.
        if (pet.today.outsideMinutes !== null && pet.position === 'outside' && pet.since) {
          const from = Math.max(new Date(pet.since).getTime(), this.startOfDay(timezone));
          pet.today.outsideMinutes += Math.max(0, Math.round((Date.now() - from) / 60_000));
          if (pet.today.tripCount !== null && new Date(pet.since).getTime() >= this.startOfDay(timezone)) {
            pet.today.tripCount += 1;
          }
        }
      } else {
        pet.today = null;
      }
    }
  }

  /** Epoch milliseconds of the start of the current calendar day in the given timezone. */
  private startOfDay(timezone: string): number {
    const now = new Date();
    try {
      const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone: timezone, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
      }).formatToParts(now);
      const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? 0);
      return now.getTime() - ((get('hour') * 60 + get('minute')) * 60 + get('second')) * 1000 - now.getMilliseconds();
    } catch {
      return new Date(now.toDateString()).getTime();
    }
  }

  private async getReport(householdId: number, petId: number): Promise<JsonObject> {
    const now = new Date();
    const from = new Date(now.toDateString());
    from.setDate(from.getDate() - 1);
    const to = new Date(now.toDateString());
    to.setHours(23, 59, 59, 999);

    const body = await this.request(
      'GET',
      `/v2/report/household/${householdId}/pet/${petId}/aggregate?from=${from.toISOString()}&to=${to.toISOString()}`,
    );
    return body?.data ?? {};
  }

  private computeToday(report: JsonObject, timezone: string): PetToday {
    const todayKey = this.dayKey(new Date(), timezone);
    const today: PetToday = {
      foodGrams: 0, waterMl: 0, mealCount: 0, drinkCount: 0, tripCount: null, outsideMinutes: null,
    };

    // Movement datapoints describe finished stays outside: { from: left, to: came back }.
    if (Array.isArray(report.movement?.datapoints)) {
      const dayStart = this.startOfDay(timezone);
      let trips = 0;
      let outsideMs = 0;
      for (const point of report.movement.datapoints as JsonObject[]) {
        const left = typeof point.from === 'string' ? new Date(point.from).getTime() : NaN;
        const back = typeof point.to === 'string' ? new Date(point.to).getTime() : NaN;
        if (Number.isNaN(left) || Number.isNaN(back) || back <= dayStart) {
          continue;
        }
        if (left >= dayStart) {
          trips += 1;
        }
        outsideMs += back - Math.max(left, dayStart);
      }
      today.tripCount = trips;
      today.outsideMinutes = Math.round(outsideMs / 60_000);
    }

    const feeding: JsonObject[] = Array.isArray(report.feeding?.datapoints) ? report.feeding.datapoints : [];
    for (const point of feeding) {
      this.rememberWeights(point);
      if (point.context !== REPORT_CONTEXT_SESSION || this.dayKey(new Date(point.to), timezone) !== todayKey) {
        continue;
      }
      today.mealCount += 1;
      for (const bowl of Array.isArray(point.weights) ? point.weights : []) {
        today.foodGrams -= Number(bowl.change) || 0;
      }
    }

    const drinking: JsonObject[] = Array.isArray(report.drinking?.datapoints) ? report.drinking.datapoints : [];
    for (const point of drinking) {
      this.rememberWeights(point);
      if (point.context !== REPORT_CONTEXT_SESSION || this.dayKey(new Date(point.to), timezone) !== todayKey) {
        continue;
      }
      today.drinkCount += 1;
      today.waterMl -= Number(point.weights?.[0]?.change) || 0;
    }

    today.foodGrams = Math.max(0, Math.round(today.foodGrams));
    today.waterMl = Math.max(0, Math.round(today.waterMl));
    return today;
  }

  /** Keep the newest known bowl weights of each device. */
  private rememberWeights(point: JsonObject): void {
    if (point.device_id == null || typeof point.to !== 'string' || !Array.isArray(point.weights)) {
      return;
    }

    const deviceId = Number(point.device_id);
    const known = this.reportWeights.get(deviceId) ?? new Map<number, { at: string; weight: number }>();

    point.weights.forEach((entry: JsonObject, position: number) => {
      const index = entry.index != null ? Number(entry.index) : position;
      const weight = Number(entry.weight);
      const previous = known.get(index);
      if (Number.isFinite(weight) && (!previous || new Date(point.to) > new Date(previous.at))) {
        known.set(index, { at: point.to, weight });
      }
    });

    this.reportWeights.set(deviceId, known);
  }

  /** Fill in bowl weights from reports when the device status does not contain them. */
  private applyReportWeights(feeders: SureFeeder[], felaquas: SureFelaqua[]): void {
    for (const feeder of feeders) {
      const known = this.reportWeights.get(feeder.id);
      if (!known) continue;
      const count = feeder.singleBowl ? 1 : 2;
      for (let index = 0; index < count; index += 1) {
        const bowl = feeder.bowls.find((b) => b.index === index);
        const fromReport = known.get(index);
        if (bowl && bowl.weightGrams === null && fromReport) {
          bowl.weightGrams = Math.round(fromReport.weight);
        } else if (!bowl && fromReport) {
          feeder.bowls.push({ index, weightGrams: Math.round(fromReport.weight), fillPercent: null });
        }
      }
    }

    for (const felaqua of felaquas) {
      const fromReport = this.reportWeights.get(felaqua.id)?.get(0);
      if (felaqua.waterMl === null && fromReport) {
        felaqua.waterMl = Math.round(fromReport.weight);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // HTTP layer
  // ---------------------------------------------------------------------------

  /**
   * Authenticated request. Logs in when no token is present, and re-authenticates
   * exactly once when the API answers 401 (expired token).
   */
  private async request(method: string, path: string, payload?: JsonObject): Promise<JsonObject> {
    if (!this.token) {
      await this.login();
    }

    try {
      return await this.rawRequest(method, path, payload, true);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        this.logFn('Sure Petcare token rejected, logging in again');
        this.clearSession();
        await this.login();
        try {
          return await this.rawRequest(method, path, payload, true);
        } catch (retryErr) {
          if (retryErr instanceof ApiError && retryErr.status === 401) {
            throw new AuthError('Sure Petcare rejected the session token');
          }
          throw retryErr;
        }
      }
      throw err;
    }
  }

  private async rawRequest(
    method: string,
    path: string,
    payload: JsonObject | undefined,
    authenticated: boolean,
  ): Promise<JsonObject> {
    const headers: Record<string, string> = {
      Accept: 'application/json, text/plain, */*',
      'Content-Type': 'application/json;charset=utf-8',
      'Cache-Control': 'no-cache',
      Origin: 'https://production.surehub.io',
      Referer: 'https://production.surehub.io/',
      'spc-client-type': 'react',
      'User-Agent': 'Homey/com.sverre.surepet',
    };
    if (authenticated && this.token) {
      headers.Authorization = `Bearer ${this.token}`;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: payload ? JSON.stringify(payload) : undefined,
        signal: controller.signal,
      });
    } catch (err) {
      const reason = (err as Error)?.name === 'AbortError'
        ? `timeout after ${this.timeoutMs} ms`
        : (err as Error)?.message ?? String(err);
      throw new NetworkError(`Request ${method} ${path.split('?')[0]} failed: ${reason}`);
    } finally {
      clearTimeout(timer);
    }

    const shortPath = path.split('?')[0];

    if (response.status === 429) {
      throw new RateLimitError(
        `Rate limited on ${method} ${shortPath}`,
        this.parseRetryAfter(response.headers.get('retry-after')),
      );
    }

    let text = '';
    try {
      text = await response.text();
    } catch (err) {
      throw new NetworkError(`Reading response of ${method} ${shortPath} failed: ${(err as Error)?.message}`);
    }

    if (!response.ok) {
      const detail = text.trim().slice(0, 300);
      throw new ApiError(
        `${method} ${shortPath} returned HTTP ${response.status}${detail ? `: ${detail}` : ''}`,
        response.status,
      );
    }

    if (text.length === 0) {
      return {};
    }

    try {
      return JSON.parse(text) as JsonObject;
    } catch {
      throw new SureHubError(`Invalid JSON in response of ${method} ${shortPath}`);
    }
  }

  /** Parse a Retry-After header (seconds or HTTP date) into milliseconds. */
  private parseRetryAfter(value: string | null): number | null {
    if (!value) {
      return null;
    }

    const seconds = Number(value);
    if (Number.isFinite(seconds)) {
      return Math.max(0, seconds * 1000);
    }

    const date = Date.parse(value);
    if (!Number.isNaN(date)) {
      return Math.max(0, date - Date.now());
    }

    return null;
  }

  // ---------------------------------------------------------------------------
  // Normalization of raw API payloads
  // ---------------------------------------------------------------------------

  private normalizeDevice(raw: JsonObject): SureDeviceBase {
    const productId = Number(raw.product_id);
    const voltage = typeof raw.status?.battery === 'number' ? raw.status.battery : null;
    const online = typeof raw.status?.online === 'boolean' ? raw.status.online : null;
    const rssi = raw.status?.signal?.device_rssi;
    const signalStrength = typeof rssi === 'number' && Number.isFinite(rssi) ? Math.round(rssi) : null;

    return {
      id: Number(raw.id),
      householdId: raw.household_id != null ? Number(raw.household_id) : null,
      productId,
      name: String(raw.name ?? `Device ${raw.id}`),
      batteryVoltage: voltage,
      batteryPercent: this.batteryPercent(raw, productId, voltage),
      online,
      signalStrength,
    };
  }

  private normalizeFlap(raw: JsonObject): SureFlap {
    const mode = raw.status?.locking?.mode;
    let lockMode: LockMode | null = null;
    if (typeof mode === 'number') {
      if (mode < 0) {
        // Negative values are curfew sub-states (curfew locked / unlocked / unknown).
        lockMode = LockMode.Curfew;
      } else if (mode in LockMode) {
        lockMode = mode as LockMode;
      }
    }

    return { ...this.normalizeDevice(raw), lockMode, lastUse: null };
  }

  private normalizeFeeder(raw: JsonObject): SureFeeder {
    const singleBowl = raw.control?.bowls?.type === 1;
    const status: JsonObject[] = Array.isArray(raw.status?.bowl_status) ? raw.status.bowl_status : [];

    const bowls: SureBowl[] = status
      .slice(0, singleBowl ? 1 : 2)
      .map((bowl, index) => ({
        index,
        weightGrams: typeof bowl.current_weight === 'number' ? Math.round(bowl.current_weight) : null,
        fillPercent: typeof bowl.fill_percent === 'number' ? Math.round(bowl.fill_percent) : null,
      }));

    return { ...this.normalizeDevice(raw), singleBowl, bowls };
  }

  private normalizeFelaqua(raw: JsonObject): SureFelaqua {
    const bowl: JsonObject | undefined = Array.isArray(raw.status?.bowl_status) ? raw.status.bowl_status[0] : undefined;

    return {
      ...this.normalizeDevice(raw),
      waterMl: typeof bowl?.current_weight === 'number' ? Math.round(bowl.current_weight) : null,
      fillPercent: typeof bowl?.fill_percent === 'number' ? Math.round(bowl.fill_percent) : null,
    };
  }

  private normalizePet(raw: JsonObject): SurePet {
    // `position` is the authoritative location; `status.activity` is the fallback.
    const position: JsonObject = raw.position ?? raw.status?.activity ?? {};
    const activity: JsonObject = raw.status?.activity ?? {};

    const lastFeeding = this.toIntake(raw.status?.feeding);
    const lastDrinking = this.toIntake(raw.status?.drinking);
    const since = typeof position.since === 'string' ? position.since : null;

    return {
      id: Number(raw.id),
      name: String(raw.name ?? `Pet ${raw.id}`),
      householdId: raw.household_id != null ? Number(raw.household_id) : null,
      tagId: raw.tag_id != null ? Number(raw.tag_id) : null,
      photoUrl: typeof raw.photo?.location === 'string' ? raw.photo.location : null,
      position: this.toPosition(position.where),
      since,
      lastSeen: this.latest([
        since,
        typeof activity.since === 'string' ? activity.since : null,
        lastFeeding?.at ?? null,
        lastDrinking?.at ?? null,
      ]),
      lastFeeding,
      lastDrinking,
      today: null,
      profile: this.toProfile(raw),
      lastDoor: null,
    };
  }

  /** Read the optional profile fields of a pet. Unknown or missing values become null. */
  private toProfile(raw: JsonObject): PetProfile {
    const speciesById: Record<number, PetSpecies> = { 1: 'cat', 2: 'dog' };
    const genderById: Record<number, PetGender> = { 0: 'female', 1: 'male' };
    const species = speciesById[Number(raw.species_id)] ?? null;
    const gender = raw.gender != null ? genderById[Number(raw.gender)] ?? null : null;
    const foodTypes: Record<number, PetFoodType> = { 1: 'wet', 2: 'dry', 3: 'both' };
    const weight = Number(raw.weight);
    // Sure Petcare stores the weight as a string in grams ("4800") and uses 1970-01-01 for "not set".
    const born = typeof raw.date_of_birth === 'string' ? raw.date_of_birth.slice(0, 10) : null;
    const bornYear = born ? Number(born.slice(0, 4)) : NaN;

    let spayed: boolean | null = null;
    if (typeof raw.spayed === 'boolean') {
      spayed = raw.spayed;
    } else if (raw.spayed === 0 || raw.spayed === 1) {
      spayed = raw.spayed === 1;
    }

    return {
      species,
      gender,
      birthDate: born && !Number.isNaN(Date.parse(born)) && bornYear > 1980 ? born : null,
      weightKg: raw.weight != null && Number.isFinite(weight) && weight > 0 ? Math.round(weight / 10) / 100 : null,
      foodType: foodTypes[Number(raw.food_type_id)] ?? null,
      spayed,
      chip: typeof raw.tag?.tag === 'string' ? raw.tag.tag : null,
    };
  }

  /** Convert `status.feeding` / `status.drinking` ({ change: [-12.5, 0], at }) to an intake. */
  private toIntake(raw: JsonObject | undefined): PetIntake | null {
    if (!raw || typeof raw.at !== 'string') {
      return null;
    }
    const changes: unknown[] = Array.isArray(raw.change) ? raw.change : [];
    const perBowl = changes.map((value) => Math.max(0, Math.round(-(Number(value) || 0) * 10) / 10));
    const consumed = perBowl.reduce((sum, value) => sum + value, 0);
    return {
      at: raw.at,
      amount: Math.round(consumed * 10) / 10,
      deviceId: raw.device_id != null && Number.isFinite(Number(raw.device_id)) ? Number(raw.device_id) : null,
      bowlGrams: perBowl,
    };
  }

  private toPosition(where: unknown): PetPosition {
    if (where === 1) return 'inside';
    if (where === 2) return 'outside';
    return 'unknown';
  }

  private latest(timestamps: Array<string | null>): string | null {
    let best: string | null = null;
    for (const ts of timestamps) {
      if (ts && (best === null || new Date(ts) > new Date(best))) {
        best = ts;
      }
    }
    return best;
  }

  private batteryPercent(raw: JsonObject, productId: number, voltage: number | null): number | null {
    const direct = raw.status?.battery_percentage;
    if (typeof direct === 'number' && Number.isFinite(direct)) {
      return Math.round(Math.min(100, Math.max(0, direct)));
    }
    if (voltage === null) {
      return null;
    }

    const profile = BATTERY_PROFILES[productId] ?? DEFAULT_BATTERY_PROFILE;
    const volts = voltage / profile.cells;
    const ratio = (volts - profile.emptyVolts) / (profile.fullVolts - profile.emptyVolts);
    return Math.round(Math.min(1, Math.max(0, ratio)) * 100);
  }

  /** Calendar day (YYYY-MM-DD) of a date in the given timezone. */
  private dayKey(date: Date, timezone: string): string {
    try {
      return new Intl.DateTimeFormat('en-CA', {
        timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
      }).format(date);
    } catch {
      return date.toISOString().slice(0, 10);
    }
  }
}
