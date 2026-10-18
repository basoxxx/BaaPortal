import { EditorBar } from './EditorBar';
import { MenuBar } from './MenuBar';
import { PanelLayout } from './PanelLayout';
import { StatusBar } from './StatusBar';
import { Toolbar } from './Toolbar';
import './project.css';

/** Cornice della vista progetto; il Task 6 sostituisce i segnaposto con i componenti veri. */
export function ProjectView() {
  return (
    <div className="baa-project">
      <MenuBar />
      <Toolbar />
      <PanelLayout
        navigation={<div />}
        referenceProjects={<div />}
        details={<div />}
        workArea={<div />}
        inspector={<div />}
        taskCards={<div />}
      />
      <EditorBar />
      <StatusBar />
    </div>
  );
}
