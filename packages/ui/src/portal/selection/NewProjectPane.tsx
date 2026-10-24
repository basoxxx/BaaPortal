import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { validateProjectName } from '@baaportal/project';
import { isAbsolutePath, joinPath } from '../../services/projectService';
import { getSettings } from '../../settings/settings';
import { useServices } from '../../state/AppContext';

const AUTHOR_KEY = 'baa.lastAuthor';

function readLastAuthor(): string {
  try {
    return localStorage.getItem(AUTHOR_KEY) ?? '';
  } catch {
    return '';
  }
}

/** L'autore predefinito dei nuovi progetti (Impostazioni → Generale), altrimenti l'ultimo usato. */
const defaultAuthor = (): string => getSettings().general.author || readLastAuthor();

function saveLastAuthor(author: string): void {
  try {
    localStorage.setItem(AUTHOR_KEY, author);
  } catch {
    /* storage non disponibile: l'autore non viene ricordato */
  }
}

export function NewProjectPane() {
  const { t } = useTranslation();
  const { bridge, service } = useServices();
  const [name, setName] = useState('');
  const [dir, setDir] = useState('');
  const [author, setAuthor] = useState(defaultAuthor);
  const [comment, setComment] = useState('');
  const [exists, setExists] = useState(false);
  const touched = useRef({ name: false, dir: false });

  // Valori predefiniti: cartella dei progetti e primo ProgettoN libero.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const defaultDir = await bridge.defaultProjectDir();
      let n = 1;
      while (await bridge.fileExists(joinPath(defaultDir, `Progetto${n}.baap`))) n++;
      if (cancelled) return;
      if (!touched.current.dir) setDir(defaultDir);
      if (!touched.current.name) setName(`Progetto${n}`);
    })();
    return () => {
      cancelled = true;
    };
  }, [bridge]);

  const check = validateProjectName(name);
  const nameError =
    name === '' && !touched.current.name
      ? null
      : exists
        ? t('errors.name.EXISTS')
        : check.ok
          ? null
          : t(`errors.name.${check.reason}`);
  const dirError = dir.trim() !== '' && !isAbsolutePath(dir) ? t('errors.pathNotAbsolute') : null;
  const canCreate = check.ok && dir.trim() !== '' && dirError === null && !exists;

  const browse = async () => {
    const picked = await bridge.showSelectFolderDialog();
    if (picked) {
      touched.current.dir = true;
      setDir(picked);
      setExists(false);
    }
  };

  const create = async () => {
    const result = await service.createNew({ name, dir, author, comment });
    if (result.ok) saveLastAuthor(author);
    else if (result.error === 'EXISTS') setExists(true);
  };

  return (
    <>
      <h2>{t('portal.action.new')}</h2>
      <div className="baa-field">
        <label htmlFor="np-name">{t('portal.new.name')}</label>
        <input
          id="np-name"
          value={name}
          onChange={(e) => {
            touched.current.name = true;
            setName(e.target.value);
            setExists(false);
          }}
        />
        {nameError ? (
          <div className="baa-field-error" role="alert">
            {nameError}
          </div>
        ) : null}
      </div>
      <div className="baa-field">
        <label htmlFor="np-dir">{t('portal.new.path')}</label>
        <input
          id="np-dir"
          value={dir}
          onChange={(e) => {
            touched.current.dir = true;
            setDir(e.target.value);
            setExists(false);
          }}
        />
        <button type="button" className="baa-btn" onClick={() => void browse()}>
          {t('portal.browse')}
        </button>
        {dirError ? (
          <div className="baa-field-error" role="alert">
            {dirError}
          </div>
        ) : null}
      </div>
      <div className="baa-field">
        <label htmlFor="np-author">{t('portal.new.author')}</label>
        <input id="np-author" value={author} onChange={(e) => setAuthor(e.target.value)} />
      </div>
      <div className="baa-field">
        <label htmlFor="np-comment">{t('portal.new.comment')}</label>
        <textarea
          id="np-comment"
          rows={3}
          value={comment}
          onChange={(e) => setComment(e.target.value)}
        />
      </div>
      <button
        type="button"
        className="baa-btn baa-btn-primary"
        disabled={!canCreate}
        onClick={() => void create()}
      >
        {t('portal.new.create')}
      </button>
    </>
  );
}
