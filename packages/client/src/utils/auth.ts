// Shared auth helpers — token stored in localStorage
export function getToken(): string | null {
  return localStorage.getItem('ai-village-token');
}

export function setToken(token: string): void {
  localStorage.setItem('ai-village-token', token);
}

export function clearToken(): void {
  localStorage.removeItem('ai-village-token');
}

export function authHeaders(): Record<string, string> {
  const token = getToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export function getUserId(): string | null {
  const token = getToken();
  if (!token) return null;
  try {
    // JWT payload is the second segment, base64-encoded
    const payload = JSON.parse(atob(token.split('.')[1]));
    return payload.userId ?? payload.sub ?? null;
  } catch {
    return null;
  }
}
