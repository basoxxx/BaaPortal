import { useId } from 'react';
import { useTranslation } from 'react-i18next';
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
      <input
        id={`${uid}-author`}
        value={m.author}
        onChange={(e) => store.getState().updateMeta({ author: e.target.value })}
      />
      <label htmlFor={`${uid}-comment`}>{t('inspector.comment')}</label>
      <textarea
        id={`${uid}-comment`}
        rows={4}
        value={m.comment}
        onChange={(e) => store.getState().updateMeta({ comment: e.target.value })}
      />
    </form>
  );
}
