export class UserCanceledError extends Error {
  constructor() {
    super('canceled by user');
    this.name = 'UserCanceledError';
  }
}

// Distinguishes the orchestrator's client-disconnect abort from a real user
// DELETE so a later DELETE racing in can read the existing reason and decide
// to upgrade to a user-cancel, instead of being silently no-op'd on an
// already-aborted controller.
export class ClientDisconnectedError extends Error {
  constructor() {
    super('client disconnected');
    this.name = 'ClientDisconnectedError';
  }
}

// SIGTERM/SIGINT abort reason. Distinct from disconnect/user-cancel so the
// orchestrator's stream tear-down can still emit a terminal event before the
// process exits — clients treat missing `done` as truncation.
export class ServerShuttingDownError extends Error {
  constructor() {
    super('server shutting down');
    this.name = 'ServerShuttingDownError';
  }
}

export function isUserCanceled(reason: unknown): reason is UserCanceledError {
  return reason instanceof UserCanceledError;
}
