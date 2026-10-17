import Homey from 'homey';
import { randomInt } from 'crypto';
import { EventEmitter } from 'events';

import { SureHubClient } from './lib/SureHubClient';
import { FlowHandler } from './lib/FlowHandler';
import { diffSnapshots } from './lib/events';
import { buildWidgetOverview, WidgetOverview } from './lib/widgetData';
import {
  ApiError, AuthError, NetworkError, RateLimitError,
} from './lib/errors';
import {
  AppStatus, ConnectionListener, ConnectionState, Credentials, LOCK_MODE_IDS, LockMode, LockModeId, lockModeFromId,
  PetAccess, PetUpdate, SnapshotListener, SureSnapshot,
} from './lib/types';

// Settings keys
const SETTING_EMAIL = 'email';
const SETTING_PASSWORD = 'password';
const SETTING_TOKEN = 'token';
const SETTING_DEVICE_ID = 'deviceId';
const SETTING_POLL_INTERVAL = 'pollInterval';
const SETTING_TEMP_LOCKS = 'tempLocks';

/** A lock mode that is active for a limited time and then goes back to the previous mode. */
interface TempLock {
  restoreMode: LockMode;
  tempMode: LockMode;
  /** Epoch milliseconds. */
  until: number;
}
/** Restores never run sooner than this after a restart, so the first poll can finish. */
const TEMP_LOCK_MIN_DELAY_MS = 5_000;
const TEMP_LOCK_RETRY_MS = 60_000;
/** Realtime event that dashboard widgets listen to, and how long changes are collected before sending. */
const WIDGET_EVENT = 'snapshot';
const WIDGET_PUSH_DELAY_MS = 1_000;
/** Pet photos are downloaded once and handed to widgets as data URIs. */
const PHOTO_TIMEOUT_MS = 10_000;
const PHOTO_MAX_BYTES = 1_000_000;
const PHOTO_CACHE_MAX_ENTRIES = 20;

// Polling configuration (seconds / milliseconds)
const DEFAULT_POLL_INTERVAL_S = 60;
const MIN_POLL_INTERVAL_S = 30;
const MAX_POLL_INTERVAL_S = 3600;
/** A non-forced refresh() within this window returns the cached snapshot. */
const MIN_REFRESH_AGE_MS = 10_000;
/** Number of consecutive network failures before the connection is reported as lost. */
const NETWORK_FAILURE_THRESHOLD = 3;
const MAX_NETWORK_BACKOFF_MS = 5 * 60_000;
const BASE_RATE_LIMIT_BACKOFF_MS = 60_000;
const MAX_RATE_LIMIT_BACKOFF_MS = 15 * 60_000;
/** Delay before re-reading data after a successful lock mode change. */
const POST_COMMAND_REFRESH_DELAY_MS = 2_000;

class SurePetApp extends Homey.App {
  private client!: SureHubClient;
  private flowHandler!: FlowHandler;
  private readonly events = new EventEmitter();

  private snapshot: SureSnapshot | null = null;
  private state: ConnectionState = 'no_credentials';
  private lastError: string | null = null;

  private readonly tempLockTimers = new Map<number, NodeJS.Timeout>();
  private widgetPushTimer: NodeJS.Timeout | null = null;
  private readonly photoCache = new Map<string, string>();
  private readonly photoRequests = new Map<string, Promise<string | null>>();

  private polling = false;
  private pollTimer: NodeJS.Timeout | null = null;
  private inFlight: Promise<SureSnapshot | null> | null = null;

  private networkFailures = 0;
  private rateLimitHits = 0;
  private blockedUntil = 0;

  async onInit(): Promise<void> {
    this.events.setMaxListeners(100);

    this.client = new SureHubClient({
      deviceId: this.getOrCreateDeviceId(),
      onTokenChange: (token) => this.persistToken(token),
      log: (...args) => this.log(...args),
      error: (...args) => this.error(...args),
    });

    this.flowHandler = new FlowHandler({
      homey: this.homey,
      setLockMode: (deviceId, mode) => this.setLockMode(deviceId, mode),
      setLockModeFor: (deviceId, mode, minutes) => this.setLockModeFor(deviceId, mode, minutes),
      setPetPosition: (petId, position) => this.setPetPosition(petId, position),
      setPetAccess: (petId, deviceId, access) => this.setPetAccess(petId, deviceId, access),
      log: (...args) => this.log(...args),
      error: (...args) => this.error(...args),
    });
    this.flowHandler.register();

    this.events.on('snapshot', () => this.scheduleWidgetPush());
    this.events.on('connection-state', () => this.scheduleWidgetPush());

    const token = this.homey.settings.get(SETTING_TOKEN);
    if (typeof token === 'string' && token.length > 0) {
      this.client.setToken(token);
    }

    this.homey.settings.on('set', (key: string) => {
      if (key === SETTING_POLL_INTERVAL && this.polling) {
        this.scheduleNextPoll(this.getPollIntervalMs());
      }
    });

    const credentials = this.readCredentials();
    if (credentials) {
      this.client.setCredentials(credentials);
      this.startPolling();
    } else {
      this.log('No Sure Petcare credentials configured yet');
    }

    for (const [id, entry] of Object.entries(this.readTempLocks())) {
      this.scheduleTempLock(Number(id), entry);
    }

    this.log('Sure Petcare app initialized');
  }

  async onUninit(): Promise<void> {
    this.stopPolling();
    this.events.removeAllListeners();
  }

  // ---------------------------------------------------------------------------
  // Public API for drivers, devices and the settings page
  // ---------------------------------------------------------------------------

  /** The single shared API client. Drivers and devices must use this instead of creating their own. */
  public getSureHubClient(): SureHubClient {
    return this.client;
  }

  /** Last successfully fetched data, or null if nothing has been fetched yet. */
  public getSnapshot(): SureSnapshot | null {
    return this.snapshot;
  }

  public getConnectionState(): ConnectionState {
    return this.state;
  }

  /** Subscribe to new snapshots. Returns an unsubscribe function. */
  public onSnapshot(listener: SnapshotListener): () => void {
    this.events.on('snapshot', listener);
    return () => this.events.off('snapshot', listener);
  }

  /** Subscribe to connection state changes. Returns an unsubscribe function. */
  public onConnectionState(listener: ConnectionListener): () => void {
    this.events.on('connection-state', listener);
    return () => this.events.off('connection-state', listener);
  }

  /**
   * Get fresh data without making redundant API calls.
   * - Concurrent callers share one in-flight request.
   * - Without `force`, a snapshot younger than 10 seconds is returned from cache.
   * - While rate limited, the cached snapshot is returned and no request is made.
   * Never throws: on failure the (possibly stale) cache is returned.
   */
  public async refresh(options: { force?: boolean } = {}): Promise<SureSnapshot | null> {
    if (!this.client.hasCredentials()) {
      return this.snapshot;
    }

    if (this.inFlight) {
      return this.inFlight;
    }

    if (Date.now() < this.blockedUntil) {
      return this.snapshot;
    }

    if (!options.force && this.snapshot && Date.now() - this.snapshot.fetchedAt < MIN_REFRESH_AGE_MS) {
      return this.snapshot;
    }

    this.inFlight = this.performRefresh().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  /** Change the lock mode of a flap. Throws if the command could not be delivered. */
  public async setLockMode(deviceId: number, mode: LockMode): Promise<void> {
    try {
      await this.client.setLockMode(deviceId, mode);
    } catch (err) {
      this.error(`Failed to set lock mode ${LockMode[mode]} on device ${deviceId}:`, (err as Error).message);
      if (err instanceof AuthError) {
        this.handleAuthError(err);
      }
      throw err;
    }

    this.log(`Lock mode of device ${deviceId} set to ${LockMode[mode]}`);

    // Optimistic update so flows see the new mode immediately.
    if (this.snapshot) {
      const previous = this.snapshot;
      this.snapshot = {
        ...previous,
        flaps: previous.flaps.map((flap) => (flap.id === deviceId ? { ...flap, lockMode: mode } : flap)),
      };
      this.events.emit('snapshot', this.snapshot, previous);

      // The next poll compares with this snapshot, so a change made here has to fire its triggers now.
      const changes = diffSnapshots(previous, this.snapshot);
      if (changes.length > 0) {
        this.flowHandler.handle(changes).catch((err) => this.error('Flow handling failed', err));
      }
    }

    // Confirm with real data shortly after.
    this.homey.setTimeout(() => {
      this.refresh({ force: true }).catch((err) => this.error('Post-command refresh failed', err));
    }, POST_COMMAND_REFRESH_DELAY_MS);
  }

  /**
   * Set a lock mode for a limited time. Afterwards the mode the door had before is restored, unless
   * someone changed the mode in the meantime. Pending restores survive an app restart.
   */
  public async setLockModeFor(deviceId: number, mode: LockMode, minutes: number): Promise<void> {
    const pending = this.readTempLocks()[deviceId];
    const current = this.snapshot?.flaps.find((flap) => flap.id === deviceId)?.lockMode ?? null;
    // A new temporary mode on top of an active one still restores the original mode.
    const restoreMode = pending ? pending.restoreMode : current;
    if (restoreMode === null) {
      throw new Error('The current lock mode of this door is not known yet, try again in a moment');
    }

    await this.setLockMode(deviceId, mode);

    if (restoreMode === mode) {
      this.clearTempLock(deviceId);
      return;
    }

    const entry: TempLock = { restoreMode, tempMode: mode, until: Date.now() + minutes * 60_000 };
    this.writeTempLock(deviceId, entry);
    this.scheduleTempLock(deviceId, entry);
    this.log(`Lock mode ${LockMode[mode]} on device ${deviceId} for ${minutes} min, then ${LockMode[restoreMode]}`);
  }

  private readTempLocks(): Record<string, TempLock> {
    const stored = this.homey.settings.get(SETTING_TEMP_LOCKS);
    return stored && typeof stored === 'object' ? stored as Record<string, TempLock> : {};
  }

  private writeTempLock(deviceId: number, entry: TempLock): void {
    this.homey.settings.set(SETTING_TEMP_LOCKS, { ...this.readTempLocks(), [deviceId]: entry });
  }

  private clearTempLock(deviceId: number): void {
    const timer = this.tempLockTimers.get(deviceId);
    if (timer) {
      this.homey.clearTimeout(timer);
      this.tempLockTimers.delete(deviceId);
    }
    const all = this.readTempLocks();
    if (all[deviceId]) {
      delete all[deviceId];
      this.homey.settings.set(SETTING_TEMP_LOCKS, all);
    }
  }

  private scheduleTempLock(deviceId: number, entry: TempLock): void {
    const existing = this.tempLockTimers.get(deviceId);
    if (existing) {
      this.homey.clearTimeout(existing);
    }
    const delay = Math.max(entry.until - Date.now(), TEMP_LOCK_MIN_DELAY_MS);
    this.tempLockTimers.set(deviceId, this.homey.setTimeout(() => {
      this.tempLockTimers.delete(deviceId);
      this.endTempLock(deviceId).catch((err) => this.error(`Restoring lock mode of device ${deviceId} failed`, err));
    }, delay));
  }

  private async endTempLock(deviceId: number): Promise<void> {
    const entry = this.readTempLocks()[deviceId];
    if (!entry) {
      return;
    }

    const snapshot = await this.refresh({ force: true });
    const current = snapshot?.flaps.find((flap) => flap.id === deviceId)?.lockMode ?? null;
    if (current === null) {
      // Cannot tell what the door is doing right now: try again later instead of guessing.
      this.scheduleTempLock(deviceId, { ...entry, until: Date.now() + TEMP_LOCK_RETRY_MS });
      return;
    }

    this.clearTempLock(deviceId);
    if (current !== entry.tempMode) {
      this.log(`Lock mode of device ${deviceId} was changed meanwhile, not restoring`);
      return;
    }
    await this.setLockMode(deviceId, entry.restoreMode);
    this.log(`Lock mode of device ${deviceId} restored to ${LockMode[entry.restoreMode]}`);
  }

  /** Change profile fields of a pet. Throws if Sure Petcare rejects the change. */
  public async updatePet(petId: number, changes: PetUpdate): Promise<void> {
    await this.runCommand(`update pet ${petId}`, () => this.client.updatePet(petId, changes));
    this.refreshSoon();
  }

  /** Mark a pet as inside or outside. Throws if the command could not be delivered. */
  public async setPetPosition(petId: number, position: 'inside' | 'outside'): Promise<void> {
    await this.runCommand(`set pet ${petId} ${position}`, () => this.client.setPetPosition(petId, position));

    // Optimistic update, so the pet capabilities (and the Came inside / Went outside cards) follow immediately.
    if (this.snapshot) {
      const previous = this.snapshot;
      const since = new Date().toISOString();
      this.snapshot = {
        ...previous,
        pets: previous.pets.map((pet) => (pet.id === petId ? { ...pet, position, since } : pet)),
      };
      this.events.emit('snapshot', this.snapshot, previous);
    }
    this.refreshSoon();
  }

  /** Set whether a pet may use one specific flap or must stay inside. */
  public async setPetAccess(petId: number, deviceId: number, access: PetAccess): Promise<void> {
    const tagId = this.snapshot?.pets.find((pet) => pet.id === petId)?.tagId;
    if (tagId == null) {
      throw new Error('This pet has no chip registered in Sure Petcare');
    }
    await this.runCommand(`set access of pet ${petId} on device ${deviceId}`, () => (
      this.client.setPetAccess(deviceId, tagId, access)
    ));
  }

  private async runCommand(label: string, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      this.error(`Failed to ${label}:`, (err as Error).message);
      if (err instanceof AuthError) {
        this.handleAuthError(err);
      }
      throw err;
    }
    this.log(`Done: ${label}`);
  }

  /** Confirm a change with real data shortly after. */
  private refreshSoon(): void {
    this.homey.setTimeout(() => {
      this.refresh({ force: true }).catch((err) => this.error('Post-command refresh failed', err));
    }, POST_COMMAND_REFRESH_DELAY_MS);
  }

  /**
   * Validate and store new credentials (used by the settings page).
   * Throws AuthError, RateLimitError or NetworkError when the login does not succeed.
   */
  public async login(credentials: Credentials): Promise<void> {
    const previous = this.readCredentials();

    this.client.setCredentials(credentials);
    this.client.clearSession();

    try {
      await this.client.login();
    } catch (err) {
      // Restore the previous working configuration.
      this.client.setCredentials(previous);
      this.client.clearSession();
      this.error('Login from settings failed:', (err as Error).message);
      throw err;
    }

    this.homey.settings.set(SETTING_EMAIL, credentials.email);
    this.homey.settings.set(SETTING_PASSWORD, credentials.password);

    this.stopPolling();
    this.snapshot = null;
    this.startPolling();
  }

  /** Forget credentials and stop all background activity. */
  public async logout(): Promise<void> {
    this.stopPolling();
    this.client.setCredentials(null);
    this.client.clearSession();
    this.homey.settings.unset(SETTING_EMAIL);
    this.homey.settings.unset(SETTING_PASSWORD);
    this.homey.settings.unset(SETTING_TOKEN);
    this.snapshot = null;
    this.lastError = null;
    this.setState('no_credentials');
  }

  /** Status information for the settings page. Never contains the password or token. */
  public getStatus(): AppStatus {
    const email = this.homey.settings.get(SETTING_EMAIL);
    return {
      state: this.state,
      email: typeof email === 'string' ? email : null,
      lastUpdate: this.snapshot?.fetchedAt ?? null,
      lastError: this.lastError,
      pollIntervalSeconds: this.getPollIntervalMs() / 1000,
      petCount: this.snapshot?.pets.length ?? 0,
      flapCount: this.snapshot?.flaps.length ?? 0,
      feederCount: this.snapshot?.feeders.length ?? 0,
      felaquaCount: this.snapshot?.felaquas.length ?? 0,
    };
  }

  /** Aggregated household data for the settings dashboard. */
  public getHousehold(): { status: AppStatus; snapshot: SureSnapshot | null; lockModes: readonly LockModeId[] } {
    return {
      status: this.getStatus(),
      snapshot: this.snapshot,
      lockModes: LOCK_MODE_IDS,
    };
  }

  /** Compact household view for dashboard widgets. Reads the cache only. */
  public getWidgetOverview(): WidgetOverview {
    return buildWidgetOverview(this.snapshot, this.state);
  }

  /** Widget command: change the lock mode of a known pet door. Throws INVALID_REQUEST for bad input. */
  public async setLockModeFromWidget(deviceId: number, modeId: string): Promise<void> {
    const mode = lockModeFromId(modeId);
    if (mode === null || !this.snapshot?.flaps.some((flap) => flap.id === deviceId)) {
      throw new Error('INVALID_REQUEST');
    }
    await this.setLockMode(deviceId, mode);
  }

  /** Widget command: mark a known pet as inside or outside. Throws INVALID_REQUEST for bad input. */
  public async setPetPositionFromWidget(petId: number, position: string): Promise<void> {
    if ((position !== 'inside' && position !== 'outside') || !this.snapshot?.pets.some((pet) => pet.id === petId)) {
      throw new Error('INVALID_REQUEST');
    }
    await this.setPetPosition(petId, position);
  }

  /** Widget request: the photo of a known pet as a data URI, or null when there is none or it cannot be loaded. */
  public async getPetPhoto(petId: number): Promise<string | null> {
    const url = this.snapshot?.pets.find((pet) => pet.id === petId)?.photoUrl ?? null;
    if (!url) {
      return null;
    }

    const cached = this.photoCache.get(url);
    if (cached) {
      return cached;
    }

    let request = this.photoRequests.get(url);
    if (!request) {
      request = this.downloadPhoto(url).finally(() => this.photoRequests.delete(url));
      this.photoRequests.set(url, request);
    }

    const dataUri = await request;
    if (dataUri) {
      if (this.photoCache.size >= PHOTO_CACHE_MAX_ENTRIES) {
        this.photoCache.clear();
      }
      this.photoCache.set(url, dataUri);
    }
    return dataUri;
  }

  private async downloadPhoto(url: string): Promise<string | null> {
    if (!/^https:\/\//i.test(url)) {
      return null;
    }

    const controller = new AbortController();
    const timer = this.homey.setTimeout(() => controller.abort(), PHOTO_TIMEOUT_MS);
    try {
      const response = await fetch(url, { signal: controller.signal });
      const contentType = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
      if (!response.ok || !contentType.startsWith('image/')) {
        return null;
      }

      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length === 0 || bytes.length > PHOTO_MAX_BYTES) {
        return null;
      }
      return `data:${contentType};base64,${bytes.toString('base64')}`;
    } catch (err) {
      this.log('Could not download a pet photo');
      return null;
    } finally {
      this.homey.clearTimeout(timer);
    }
  }

  /** Tell open widgets that something changed. Bursts of changes are merged into one message. */
  private scheduleWidgetPush(): void {
    if (this.widgetPushTimer) {
      return;
    }
    this.widgetPushTimer = this.homey.setTimeout(() => {
      this.widgetPushTimer = null;
      try {
        this.homey.api.realtime(WIDGET_EVENT, this.getWidgetOverview());
      } catch (err) {
        this.error('Could not notify widgets', err);
      }
    }, WIDGET_PUSH_DELAY_MS);
  }

  /** Fetch fresh data now (dashboard "Force Sync"). Returns the updated household data. */
  public async forceSync(): Promise<ReturnType<SurePetApp['getHousehold']>> {
    if (!this.client.hasCredentials()) {
      throw new AuthError('No Sure Petcare credentials configured');
    }

    // After an authentication failure polling was stopped; a manual sync gives it a fresh start.
    if (!this.polling && this.state === 'auth_error') {
      this.polling = true;
    }

    await this.refresh({ force: true });
    return this.getHousehold();
  }

  /** Store a new polling interval (seconds) and apply it right away. */
  public setPollInterval(seconds: number): void {
    const clamped = Math.min(MAX_POLL_INTERVAL_S, Math.max(MIN_POLL_INTERVAL_S, Math.round(seconds)));
    this.homey.settings.set(SETTING_POLL_INTERVAL, clamped);
  }

  // ---------------------------------------------------------------------------
  // Polling
  // ---------------------------------------------------------------------------

  private startPolling(): void {
    this.polling = true;
    this.networkFailures = 0;
    this.rateLimitHits = 0;
    this.blockedUntil = 0;
    this.setState('connecting');
    this.scheduleNextPoll(0);
  }

  private stopPolling(): void {
    this.polling = false;
    if (this.pollTimer) {
      this.homey.clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private scheduleNextPoll(delayMs: number): void {
    if (this.pollTimer) {
      this.homey.clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }

    if (!this.polling) {
      return;
    }

    // A little jitter avoids all Homey installations polling at the same instant.
    const jitter = delayMs > 0 ? Math.round(delayMs * 0.1 * Math.random()) : 0;

    this.pollTimer = this.homey.setTimeout(() => {
      this.pollTimer = null;
      this.refresh({ force: true })
        .catch((err) => this.error('Unexpected poll error', err))
        .finally(() => {
          // performRefresh() schedules the next poll itself; this covers the case where
          // refresh() returned early (e.g. blocked by a rate limit) and nothing was scheduled.
          if (this.polling && !this.pollTimer && !this.inFlight) {
            this.scheduleNextPoll(Math.max(this.getPollIntervalMs(), this.blockedUntil - Date.now()));
          }
        });
    }, delayMs + jitter);
  }

  private async performRefresh(): Promise<SureSnapshot | null> {
    if (!this.snapshot && this.state !== 'connecting') {
      this.setState('connecting');
    }

    let nextDelay = this.getPollIntervalMs();

    try {
      const next = await this.client.fetchSnapshot(this.getTimezone());

      // The user may have logged out while the request was in flight.
      if (!this.client.hasCredentials()) {
        return null;
      }

      const previous = this.snapshot;

      this.snapshot = next;
      this.networkFailures = 0;
      this.rateLimitHits = 0;
      this.blockedUntil = 0;
      this.lastError = null;

      this.setState('connected');
      this.events.emit('snapshot', next, previous);

      // Fire flow triggers for whatever changed since the last poll.
      const householdEvents = diffSnapshots(previous, next);
      if (householdEvents.length > 0) {
        this.flowHandler.handle(householdEvents).catch((err) => this.error('Flow handling failed', err));
      }
    } catch (err) {
      nextDelay = this.handleRefreshError(err, nextDelay);
    }

    if (this.polling) {
      this.scheduleNextPoll(nextDelay);
    }
    return this.snapshot;
  }

  /** Update state for a failed poll and return the delay before the next attempt. */
  private handleRefreshError(err: unknown, baseDelayMs: number): number {
    const message = (err as Error)?.message ?? String(err);
    this.lastError = message;

    if (err instanceof AuthError) {
      this.handleAuthError(err);
      return baseDelayMs;
    }

    if (err instanceof RateLimitError) {
      this.rateLimitHits += 1;
      const exponential = Math.min(
        BASE_RATE_LIMIT_BACKOFF_MS * 2 ** (this.rateLimitHits - 1),
        MAX_RATE_LIMIT_BACKOFF_MS,
      );
      const delay = Math.max(exponential, err.retryAfterMs ?? 0);
      this.blockedUntil = Date.now() + delay;
      this.error(`Rate limited by Sure Petcare, backing off for ${Math.round(delay / 1000)}s`);
      this.setState('rate_limited');
      return delay;
    }

    // Network errors and 5xx responses: exponential backoff, report only after repeated failures.
    this.networkFailures += 1;
    const delay = Math.min(baseDelayMs * 2 ** this.networkFailures, MAX_NETWORK_BACKOFF_MS);

    if (err instanceof NetworkError || (err instanceof ApiError && err.status >= 500)) {
      this.error(`Poll failed (${this.networkFailures}x): ${message}. Retrying in ${Math.round(delay / 1000)}s`);
    } else {
      this.error(`Unexpected poll failure (${this.networkFailures}x):`, err);
    }

    if (this.networkFailures >= NETWORK_FAILURE_THRESHOLD) {
      this.setState('network_error');
    }
    return delay;
  }

  /** Bad credentials: stop polling so we do not retry (and risk an account lock) in a loop. */
  private handleAuthError(err: AuthError): void {
    this.error('Authentication with Sure Petcare failed:', err.message);
    this.lastError = err.message;
    this.stopPolling();
    this.setState('auth_error');
  }

  private setState(state: ConnectionState): void {
    if (this.state === state) {
      return;
    }
    this.log(`Connection state: ${this.state} -> ${state}`);
    this.state = state;
    this.events.emit('connection-state', state);

    if (state === 'auth_error' || state === 'network_error') {
      this.flowHandler.connectionProblem(this.homey.__(`state.${state}`)).catch(() => undefined);
    }
  }

  // ---------------------------------------------------------------------------
  // Settings helpers
  // ---------------------------------------------------------------------------

  private readCredentials(): Credentials | null {
    const email = this.homey.settings.get(SETTING_EMAIL);
    const password = this.homey.settings.get(SETTING_PASSWORD);
    if (typeof email === 'string' && email.length > 0 && typeof password === 'string' && password.length > 0) {
      return { email, password };
    }
    return null;
  }

  private persistToken(token: string | null): void {
    if (token) {
      this.homey.settings.set(SETTING_TOKEN, token);
    } else {
      this.homey.settings.unset(SETTING_TOKEN);
    }
  }

  private getOrCreateDeviceId(): string {
    const existing = this.homey.settings.get(SETTING_DEVICE_ID);
    if (typeof existing === 'string' && existing.length > 0) {
      return existing;
    }
    const created = String(randomInt(1_000_000_000, 9_999_999_999));
    this.homey.settings.set(SETTING_DEVICE_ID, created);
    return created;
  }

  private getTimezone(): string {
    try {
      return this.homey.clock.getTimezone();
    } catch {
      return 'UTC';
    }
  }

  private getPollIntervalMs(): number {
    const configured = Number(this.homey.settings.get(SETTING_POLL_INTERVAL));
    const seconds = Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_POLL_INTERVAL_S;
    return Math.min(MAX_POLL_INTERVAL_S, Math.max(MIN_POLL_INTERVAL_S, seconds)) * 1000;
  }
}

export = SurePetApp;
