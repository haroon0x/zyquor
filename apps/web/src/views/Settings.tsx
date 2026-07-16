import { DesktopSettingsPanel } from "../components/DesktopSettingsPanel.js";
import { GenerationPanel, type GenerationState } from "../components/GenerationPanel.js";
import { StylePanel } from "../components/StylePanel.js";
import type { PanelProps } from "../types.js";

export function SettingsView({
  desktopPanel,
  generationPanel,
  generationState,
  isElectron,
  stylePanel,
  styleProfileId
}: {
  desktopPanel: PanelProps;
  generationPanel: PanelProps;
  generationState: GenerationState;
  isElectron: boolean;
  stylePanel: PanelProps;
  styleProfileId: string | null;
}) {
  return (
    <div className="settings-view">
      <GenerationPanel panel={generationPanel} state={generationState} />
      {styleProfileId ? <StylePanel panel={stylePanel} styleProfileId={styleProfileId} /> : null}
      {isElectron ? <DesktopSettingsPanel panel={desktopPanel} /> : null}
    </div>
  );
}
