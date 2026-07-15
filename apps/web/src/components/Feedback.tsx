export function Busy({ active }: { active: boolean }) {
  return <span aria-hidden="true" className={active ? "busy-slot active" : "busy-slot"} />;
}

export type PanelIconName = "activity" | "clock" | "edit" | "inbox" | "layers" | "list-checks" | "pencil" | "settings" | "zap";

export function PanelIcon({ name }: { name: PanelIconName }) {
  const paths: Record<PanelIconName, ReactNode> = {
    activity: <path d="M3 12h4l2.5-7 5 14 2.5-7h4" />,
    clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
    edit: <><path d="M4 20h4l11-11a2.8 2.8 0 0 0-4-4L4 16v4Z" /><path d="m13.5 6.5 4 4" /></>,
    inbox: <><path d="M4 4h16v13H4z" /><path d="M4 13h4l2 3h4l2-3h4" /></>,
    layers: <><path d="m12 3 9 5-9 5-9-5 9-5Z" /><path d="m3 12 9 5 9-5" /><path d="m3 16 9 5 9-5" /></>,
    "list-checks": <><path d="m3 6 1.5 1.5L7 5" /><path d="M10 6h11" /><path d="m3 12 1.5 1.5L7 11" /><path d="M10 12h11" /><path d="m3 18 1.5 1.5L7 17" /><path d="M10 18h11" /></>,
    pencil: <><path d="m4 20 4-.8L19 8.2a2.8 2.8 0 0 0-4-4L4 15.2V20Z" /><path d="m13.5 5.7 4.8 4.8" /></>,
    settings: <><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1A1.7 1.7 0 0 0 9 4.6 1.7 1.7 0 0 0 10 3v-.2h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1Z" /></>,
    zap: <path d="M13 2 4 14h7l-1 8 9-12h-7l1-8Z" />
  };

  return <svg aria-hidden="true" className="panel-icon" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" viewBox="0 0 24 24">{paths[name]}</svg>;
}

export function InlineError({ message }: { message: string | null }) {
  return message ? <p className="notice error" role="alert">{message}</p> : null;
}

export function StatusBadge({ status }: { status: string }) {
  return <span className={`status ${status.toLowerCase().replaceAll("_", "-")}`}>{status}</span>;
}

export function errorMessage(caught: unknown, fallback: string) {
  return caught instanceof Error ? caught.message : fallback;
}
import type { ReactNode } from "react";
