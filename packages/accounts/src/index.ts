import type { Account } from "@zyquor/core";

const blockedProfileFragments = [
  ".config/google-chrome",
  ".config/chromium",
  "Library/Application Support/Google/Chrome",
  "AppData/Local/Google/Chrome"
];

export function isAccountRunnable(account: Account) {
  return account.enabled && account.postingMode !== "draft_only";
}

export function assertDedicatedProfileDir(profileDir: string) {
  const normalized = profileDir.replaceAll("\\", "/");

  if (!normalized.startsWith("profiles/") && !normalized.includes("/profiles/")) {
    throw new Error(`Profile directory must live under profiles/: ${profileDir}`);
  }

  if (blockedProfileFragments.some((fragment) => normalized.includes(fragment))) {
    throw new Error(`Refusing to use everyday browser profile: ${profileDir}`);
  }
}
