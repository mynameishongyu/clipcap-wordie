export const AUTH_SYNC_STORAGE_KEY = 'clipcap-auth-sync';
export const AUTH_SYNC_BROADCAST_CHANNEL = 'clipcap-auth-sync';
export const AUTH_SYNC_EVENT_TYPE = 'signed-in';

export function createAuthSyncPayload() {
  return JSON.stringify({
    type: AUTH_SYNC_EVENT_TYPE,
    timestamp: Date.now(),
  });
}

export function publishAuthSyncEvent() {
  if (typeof window === 'undefined') {
    return;
  }

  const payload = createAuthSyncPayload();

  window.localStorage.setItem(AUTH_SYNC_STORAGE_KEY, payload);

  if (typeof window.BroadcastChannel !== 'undefined') {
    const channel = new window.BroadcastChannel(AUTH_SYNC_BROADCAST_CHANNEL);
    channel.postMessage(payload);
    channel.close();
  }
}
