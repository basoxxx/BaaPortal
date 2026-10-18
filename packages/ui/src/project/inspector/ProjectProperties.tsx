import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import { CommitInput, CommitTextarea } from '../../components/CommitField';
import { useAppStore, useServices } from '../../state/AppContext';

export function useDateTimeFormat() {
  const { i18n } = useTranslation();
  const locale = i18n.language.startsWith('it') ? 'it-IT' : 'en-GB';
  return (d: Date) =>
    new Intl.DateTimeFormat(locale, { dateStyle: 'short', timeStyle: 'medium' }).format(d);
}

export function ProjectProperties() {
  const { t } = useTranslation();
  const { store } = useServices();
  const doc = useAppStore((s) => s.doc);
  const selection = useAppStore((s) => s.selection);
  const fmt = useDateTimeFormat();
  const uid = useId();
  if (selection !== 'project' || !doc)
    return <p className="baa-placeholder">{t('inspector.noProperties')}</p>;
  const m = doc.project.meta;
  const ro = (key: string, label: string, value: string) => (
    <>
      <label htmlFor={`${uid}-${key}`}>{label}</label>
      <input id={`${uid}-${key}`} readOnly value={value} />
    </>
  );
  return (
    <form className="baa-props" onSubmit={(e) => e.preventDefault()}>
      {ro('name', t('inspector.name'), m.name)}
      {ro('path', t('inspector.path'), doc.filePath)}
      {ro('created', t('inspector.created'), fmt(new Date(m.createdAt)))}
      {ro('modified', t('inspector.modified'), fmt(new Date(m.modifiedAt)))}
      <label htmlFor={`${uid}-author`}>{t('inspector.author')}</label>
      <CommitInput
        id={`${uid}-author`}
        value={m.author}
        onCommit={(v) =>
          store.getState().edit('history.author', (p) => {
            p.meta.author = v;
          })
        }
      />
      <label htmlFor={`${uid}-comment`}>{t('inspector.comment')}</label>
      <CommitTextarea
        id={`${uid}-comment`}
        rows={4}
        value={m.comment}
        onCommit={(v) =>
          store.getState().edit('history.comment', (p) => {
            p.meta.comment = v;
          })
        }
      />
    </form>
  );
}
