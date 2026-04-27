import { createHash, randomUUID } from "node:crypto";

export function row(value: unknown): Record<string, unknown> | null {
  return value ? (value as Record<string, unknown>) : null;
}

export function rows(value: unknown[]): Record<string, unknown>[] {
  return value as Record<string, unknown>[];
}

export function id(prefix: string) {
  return `${prefix}_${randomUUID()}`;
}

export function normalizePostText(text: string) {
  return text.trim().toLowerCase().replace(/\s+/g, " ");
}

export function hashPostText(text: string) {
  return createHash("sha256").update(normalizePostText(text)).digest("hex");
}
