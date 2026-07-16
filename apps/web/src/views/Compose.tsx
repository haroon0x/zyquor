import { CandidatesPanel, type CandidatesState } from "../components/CandidatesPanel.js";
import { Composer, type ComposerState } from "../components/Composer.js";
import type { PanelProps } from "../types.js";

export function ComposeView({
  candidatesPanel,
  candidatesState,
  composerPanel,
  composerState
}: {
  candidatesPanel: PanelProps;
  candidatesState: CandidatesState;
  composerPanel: PanelProps;
  composerState: ComposerState;
}) {
  return (
    <div className="compose-view">
      <Composer panel={composerPanel} state={composerState} />
      <CandidatesPanel panel={candidatesPanel} state={candidatesState} />
    </div>
  );
}
