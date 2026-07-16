import { JobsPanel } from "../components/JobsPanel.js";
import type { PanelProps } from "../types.js";

export function QueueView({ panel }: { panel: PanelProps }) {
  return <JobsPanel panel={panel} />;
}
