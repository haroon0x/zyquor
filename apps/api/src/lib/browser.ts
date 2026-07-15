import type { AppDeps } from "../deps.js";

export function browserOptions(deps: AppDeps) {
  const b = deps.browser;
  return {
    ...(b.actionDelayMs !== undefined ? { actionDelayMs: b.actionDelayMs } : {}),
    ...(b.channel !== undefined ? { browserChannel: b.channel } : {}),
    ...(b.cdpUrl !== undefined ? { cdpUrl: b.cdpUrl } : {}),
    ...(b.typingDelayMs !== undefined ? { typingDelayMs: b.typingDelayMs } : {})
  };
}
