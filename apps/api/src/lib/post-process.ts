import { formatTweetText, postProcessTweetText } from "@zyquor/generation";

let traceSeq = 0;

export function tracePostProcessTweetText(label: string, text: string, preserveCase = false) {
  traceSeq += 1;
  const traceId = `pp-${Date.now().toString(36)}-${traceSeq}`;
  const before = text;
  const after = (preserveCase ? formatTweetText : postProcessTweetText)(text);
  const beforeHasUpper = /[A-Z]/.test(before);
  const afterHasUpper = /[A-Z]/.test(after);
  const changed = before !== after;
  console.log(
    `[trace=${traceId}] [post-process] label=${label} ` +
      `beforeLen=${before.length} afterLen=${after.length} changed=${changed} ` +
      `beforeHasUpper=${beforeHasUpper} afterHasUpper=${afterHasUpper} ` +
      `beforeHead=${JSON.stringify(before.slice(0, 60))} afterHead=${JSON.stringify(after.slice(0, 60))}`
  );
  return after;
}
