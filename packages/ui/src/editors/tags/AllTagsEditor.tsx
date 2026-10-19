import type { EditorRef } from '../../state/workArea';
import { TagsView } from './TagsView';

export function AllTagsEditor({ editor }: { editor: EditorRef }) {
  return (
    <div className="baa-editor-body baa-tags-editor" data-testid={`editor-body-${editor.key}`}>
      <div className="baa-tags-panel">
        <TagsView deviceId={editor.deviceId} tableId={null} />
      </div>
    </div>
  );
}
