export function Busy({ active }: { active: boolean }) {
  return <span aria-hidden="true" className={active ? "busy-slot active" : "busy-slot"}>…</span>;
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
