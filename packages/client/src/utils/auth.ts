// Shared auth helpers — token + userId stored in sessionStorage
// sessionStorage is cleared when the tab is closed and is not accessible to
// scripts in other tabs, reducing the blast radius of an XSS attack compared
// to localStorage (OWASP: "Do not store session identifiers in localStorage").
//
// All storage access is wrapped in try/catch: Firefox strict mode and Safari
// ITP can throw SecurityError when sessionStorage is accessed in private
// browsing windows. (OWASP Web Storage Security Cheat Sheet)

/**
 * Decode JWT payload and return expiry timestamp (seconds since epoch), or 0 on failure.
 * No library needed — JWT payload is base64url encoded JSON.
 */
function getTokenExp(token: string): number {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return 0;
    // base64url → base64 → JSON
    const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
    return typeof payload.exp === 'number' ? payload.exp : 0;
  } catch {
    return 0;
  }
}

/** Returns true if the stored JWT is expired (or malformed). */
export function isTokenExpired(token: string): boolean {
  const exp = getTokenExp(token);
  if (exp === 0) return true;
  // 30s clock-skew buffer (OWASP ASVS §3.5.2)
  return Date.now() / 1000 > exp - 30;
}

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
  const token = safeGet('ai-village-token');
  if (!token) return null;
  // Auto-clear expired tokens so callers always receive a usable token or null.
  if (isTokenExpired(token)) {
    safeRemove('ai-village-token', 'ai-village-user-id');
    return null;
  }
  return token;
}

export function setToken(token: string): void {
  safeSet('ai-village-token', token);
}

export function clearToken(): void {
  safeRemove('ai-village-token', 'ai-village-user-id', 'ai-village-email');
}

/** Store email for use in /api/auth/refresh (needed for Cognito SECRET_HASH). */
export function setEmail(email: string): void {
  safeSet('ai-village-email', email);
}

export function getEmail(): string | null {
  return safeGet('ai-village-email');
}

/**
 * Exchange the httpOnly refresh-token cookie for a new access token.
 * The refresh token is sent automatically via cookie — not from JS.
 * Returns the new access token on success, or null on failure.
 */
export async function refreshAccessToken(): Promise<string | null> {
  const email = getEmail();
  try {
    const res = await fetch('/api/auth/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: email ?? '' }),
    });
    if (!res.ok) return null;
    const data = await res.json() as { token?: string };
    if (typeof data.token === 'string') {
      setToken(data.token);
      return data.token;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Returns a valid access token, refreshing automatically if expired.
 * Returns null if refresh also fails (user must re-login).
 */
export async function getValidToken(): Promise<string | null> {
  const token = getToken();
  if (token) return token;
  // Token is null (expired or absent) — try silent refresh via httpOnly cookie
  return refreshAccessToken();
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
