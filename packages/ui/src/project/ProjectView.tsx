import { EditorBar } from './EditorBar';
import { MenuBar } from './MenuBar';
import { DetailsView } from './navigation/DetailsView';
import { ProjectTree } from './navigation/ProjectTree';
import { ReferenceProjects } from './navigation/ReferenceProjects';
import { Inspector } from './inspector/Inspector';
import { TaskCards } from './taskcards/TaskCards';
import { PanelLayout } from './PanelLayout';
import { WorkArea } from './workarea/WorkArea';
import { StatusBar } from './StatusBar';
import { Toolbar } from './Toolbar';
import './project.css';

/** Cornice della vista progetto. */
export function ProjectView() {
  return (
    <div className="baa-project">
      <MenuBar />
      <Toolbar />
      <PanelLayout
        navigation={<ProjectTree />}
        referenceProjects={<ReferenceProjects />}
        details={<DetailsView />}
        workArea={<WorkArea />}
        inspector={<Inspector />}
        taskCards={<TaskCards />}
      />
      <EditorBar />
      <StatusBar />
    </div>
  );
}
