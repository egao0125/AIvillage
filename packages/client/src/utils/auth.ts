// Shared auth helpers — token + userId stored in sessionStorage
// sessionStorage is cleared when the tab is closed and is not accessible to
// scripts in other tabs, reducing the blast radius of an XSS attack compared
// to localStorage (OWASP: "Do not store session identifiers in localStorage").
export function getToken(): string | null {
  return sessionStorage.getItem('ai-village-token');
}

export function setToken(token: string): void {
  sessionStorage.setItem('ai-village-token', token);
}

export function clearToken(): void {
  sessionStorage.removeItem('ai-village-token');
  sessionStorage.removeItem('ai-village-user-id');
}

export function authHeaders(): Record<string, string> {
  const token = getToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export function setUserId(id: string): void {
  sessionStorage.setItem('ai-village-user-id', id);
}

export function getUserId(): string | null {
  return sessionStorage.getItem('ai-village-user-id');
}
