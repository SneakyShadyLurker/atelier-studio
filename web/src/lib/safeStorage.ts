export function storageGet(storage: Storage | undefined, key: string): string | null {
  if (!storage) return null;
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

export function storageSet(storage: Storage | undefined, key: string, value: string): boolean {
  if (!storage) return false;
  try {
    storage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

export function storageRemove(storage: Storage | undefined, key: string): boolean {
  if (!storage) return false;
  try {
    storage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

export function localStorageOrUndefined(): Storage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

export function sessionStorageOrUndefined(): Storage | undefined {
  try {
    return window.sessionStorage;
  } catch {
    return undefined;
  }
}
