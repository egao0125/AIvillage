// Shared auth helpers — token + userId stored in localStorage
export function getToken(): string | null {
  return localStorage.getItem('ai-village-token');
}

export function setToken(token: string): void {
  localStorage.setItem('ai-village-token', token);
}

export function clearToken(): void {
  localStorage.removeItem('ai-village-token');
  localStorage.removeItem('ai-village-user-id');
}

export function authHeaders(): Record<string, string> {
  const token = getToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export function setUserId(id: string): void {
  localStorage.setItem('ai-village-user-id', id);
}

export function getUserId(): string | null {
  return localStorage.getItem('ai-village-user-id');
}
