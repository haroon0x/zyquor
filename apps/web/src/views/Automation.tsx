import { AutomationPanel } from "../components/AutomationPanel.js";
import { ManualSourcePanel, SourcePacketsPanel, type SourcePacketsState } from "../components/SourcePacketsPanel.js";
import { WorkerPanel } from "../components/WorkerPanel.js";
import type { PanelProps } from "../types.js";

export function AutomationView({
  automationPanel,
  sourcePanel,
  sourceState,
  workerPanel
}: {
  automationPanel: PanelProps;
  sourcePanel: PanelProps;
  sourceState: SourcePacketsState;
  workerPanel: PanelProps;
}) {
  return (
    <div className="automation-view">
      <div className="automation-column">
        <AutomationPanel panel={automationPanel} />
        <ManualSourcePanel panel={sourcePanel} />
      </div>
      <div className="automation-column">
        <WorkerPanel panel={workerPanel} />
        <SourcePacketsPanel panel={sourcePanel} state={sourceState} />
      </div>
    </div>
  );
}
