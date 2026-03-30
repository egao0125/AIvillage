// Shared auth helpers — token + userId stored in sessionStorage
// sessionStorage is cleared when the tab is closed and is not accessible to
// scripts in other tabs, reducing the blast radius of an XSS attack compared
// to localStorage (OWASP: "Do not store session identifiers in localStorage").
//
// All storage access is wrapped in try/catch: Firefox strict mode and Safari
// ITP can throw SecurityError when sessionStorage is accessed in private
// browsing windows. (OWASP Web Storage Security Cheat Sheet)

function safeGet(key: string): string | null {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeSet(key: string, value: string): void {
  try {
    sessionStorage.setItem(key, value);
  } catch {
    // Private browsing mode: store silently fails; user will be unauthenticated
  }
}

function safeRemove(...keys: string[]): void {
  try {
    for (const key of keys) sessionStorage.removeItem(key);
  } catch {
    // Ignore — private browsing
  }
}

export function getToken(): string | null {
  return safeGet('ai-village-token');
}

export function setToken(token: string): void {
  safeSet('ai-village-token', token);
}

export function clearToken(): void {
  safeRemove('ai-village-token', 'ai-village-user-id');
}

export function authHeaders(): Record<string, string> {
  const token = getToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export function setUserId(id: string): void {
  safeSet('ai-village-user-id', id);
}

export function getUserId(): string | null {
  return safeGet('ai-village-user-id');
}
