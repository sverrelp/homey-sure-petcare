const { AuthError, NetworkError, RateLimitError } = require('../../lib/errors');

/**
 * Backend of the Household widget. All data comes from the cache of the shared app client,
 * so opening a dashboard never causes extra Sure Petcare requests. Responses never contain secrets.
 *
 * Errors are reduced to short codes that the widget turns into localized messages.
 */
function toApiError(err) {
  if (err instanceof AuthError) return new Error('AUTH_FAILED');
  if (err instanceof RateLimitError) return new Error('RATE_LIMITED');
  if (err instanceof NetworkError) return new Error('NETWORK_ERROR');
  if (err && err.message === 'INVALID_REQUEST') return new Error('INVALID_REQUEST');
  return new Error('UNKNOWN_ERROR');
}

module.exports = {
  async getOverview({ homey }) {
    return homey.app.getWidgetOverview();
  },

  async setLockMode({ homey, body }) {
    const deviceId = Number(body && body.deviceId);
    const mode = body && body.mode;
    if (!Number.isInteger(deviceId) || typeof mode !== 'string') {
      throw new Error('INVALID_REQUEST');
    }

    try {
      await homey.app.setLockModeFromWidget(deviceId, mode);
    } catch (err) {
      throw toApiError(err);
    }
    return homey.app.getWidgetOverview();
  },

  async getPetPhoto({ homey, body }) {
    const petId = Number(body && body.petId);
    if (!Number.isInteger(petId)) {
      throw new Error('INVALID_REQUEST');
    }

    // A missing photo is not an error: the widget shows the initial of the pet instead.
    return { dataUri: await homey.app.getPetPhoto(petId) };
  },

  async setPetPosition({ homey, body }) {
    const petId = Number(body && body.petId);
    const position = body && body.position;
    if (!Number.isInteger(petId) || typeof position !== 'string') {
      throw new Error('INVALID_REQUEST');
    }

    try {
      await homey.app.setPetPositionFromWidget(petId, position);
    } catch (err) {
      throw toApiError(err);
    }
    return homey.app.getWidgetOverview();
  },
};
