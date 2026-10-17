import type Homey from 'homey';
import type SurePetApp from './app';
import {
  AuthError, NetworkError, RateLimitError,
} from './lib/errors';
import { lockModeFromId } from './lib/types';

type HomeyInstance = Homey.App['homey'];

interface ApiContext<TBody = undefined> {
  homey: HomeyInstance;
  body: TBody;
}

interface LoginBody {
  email?: unknown;
  password?: unknown;
}

interface LockModeBody {
  deviceId?: unknown;
  mode?: unknown;
}

interface SettingsBody {
  pollInterval?: unknown;
}

function getApp(homey: HomeyInstance): SurePetApp {
  return homey.app as unknown as SurePetApp;
}

/**
 * Translate errors into short machine readable codes.
 * The settings page maps these to localized messages.
 */
function toApiError(err: unknown): Error {
  if (err instanceof AuthError) return new Error('AUTH_FAILED');
  if (err instanceof RateLimitError) return new Error('RATE_LIMITED');
  if (err instanceof NetworkError) return new Error('NETWORK_ERROR');
  return new Error('UNKNOWN_ERROR');
}

/**
 * Web API endpoints used by the settings dashboard (see `api` in .homeycompose/app.json).
 * Responses never contain the password or the session token.
 */
export = {
  async login({ homey, body }: ApiContext<LoginBody>) {
    const email = typeof body?.email === 'string' ? body.email.trim() : '';
    const password = typeof body?.password === 'string' ? body.password : '';
    if (!email || !password) {
      throw new Error('MISSING_CREDENTIALS');
    }

    const app = getApp(homey);
    try {
      await app.login({ email, password });
    } catch (err) {
      throw toApiError(err);
    }
    return app.getStatus();
  },

  async logout({ homey }: ApiContext) {
    const app = getApp(homey);
    await app.logout();
    return app.getStatus();
  },

  async getStatus({ homey }: ApiContext) {
    return getApp(homey).getStatus();
  },

  /** Aggregated household state from the cache of the shared client. Makes no Sure Petcare request. */
  async getHousehold({ homey }: ApiContext) {
    return getApp(homey).getHousehold();
  },

  /** "Force sync": fetch fresh data right now. */
  async sync({ homey }: ApiContext) {
    try {
      return await getApp(homey).forceSync();
    } catch (err) {
      throw toApiError(err);
    }
  },

  async setLockMode({ homey, body }: ApiContext<LockModeBody>) {
    const deviceId = Number(body?.deviceId);
    const mode = lockModeFromId(body?.mode);
    if (!Number.isInteger(deviceId) || mode === null) {
      throw new Error('INVALID_REQUEST');
    }

    const app = getApp(homey);
    try {
      await app.setLockMode(deviceId, mode);
    } catch (err) {
      throw toApiError(err);
    }
    return app.getHousehold();
  },

  async saveSettings({ homey, body }: ApiContext<SettingsBody>) {
    const seconds = Number(body?.pollInterval);
    if (!Number.isFinite(seconds) || seconds <= 0) {
      throw new Error('INVALID_REQUEST');
    }

    const app = getApp(homey);
    app.setPollInterval(seconds);
    return app.getStatus();
  },
};
