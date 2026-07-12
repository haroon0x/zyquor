declare global {
  interface Window {
    zyquor?: { apiBaseUrl: string; appVersion?: string };
  }
}

export const API_BASE_URL: string = window.zyquor?.apiBaseUrl ?? "";

export function apiUrl(path: string): string {
  if (API_BASE_URL) {
    return `${API_BASE_URL}${path}`;
  }
  return `/api${path}`;
}
