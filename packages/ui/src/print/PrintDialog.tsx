import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { findDevice } from '@baaportal/project';
import { Dialog } from '../components/Dialog';
import { useMnemonic } from '../editors/awl/mnemonicPreference';
import { useAppStore, useServices } from '../state/AppContext';
import { buildPrintDocument } from './buildPrintDocument';
import { selectionsFromNodes } from './selection';

interface Props {
  nodeIds: string[];
  mode: 'print' | 'pdf';
  onClose(): void;
}

/** Scelta del contenuto, dei mnemonici e della carta; poi stampa o salva il PDF dal processo principale. */
export function PrintDialog({ nodeIds, mode, onClose }: Props) {
  const { t, i18n } = useTranslation();
  const { bridge, store } = useServices();
  const doc = useAppStore((s) => s.doc);
  const [defaultMnemonic] = useMnemonic();
  const [comments, setComments] = useState(true);
  const [iface, setIface] = useState(true);
  const [code, setCode] = useState(true);
  const [xref, setXref] = useState(false);
  const [mnemonic, setMnemonic] = useState(defaultMnemonic);
  const [paper, setPaper] = useState<'A4' | 'Letter'>('A4');
  const [landscape, setLandscape] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);

  const project = doc?.project;
  // Una selezione senza oggetti stampabili (nodo statico, sorgenti) vale il primo PLC.
  const firstDev = project?.devices[0];
  const picked = project ? selectionsFromNodes(project, nodeIds) : [];
  const sels =
    picked.length > 0 || !project || !firstDev
      ? picked
      : selectionsFromNodes(project, [`plc:${firstDev.id}`]);
  if (!project || sels.length === 0 || sels.some((s) => !findDevice(project, s.deviceId))) {
    return (
      <Dialog title={t('print.title')} onClose={onClose} onOk={onClose}>
        <p>{t('print.nothing')}</p>
      </Dialog>
    );
  }

  const build = async () =>
    buildPrintDocument(project, sels, {
      t: (k, v) => t(k, v) as string,
      lang: i18n.language,
      appVersion: await bridge.appVersion(),
      now: new Date(),
      mnemonic,
      includeComments: comments,
      includeInterface: iface,
      includeCode: code,
      includeXref: xref,
    });

  /** Anteprima nella finestra: lo stesso HTML della stampa, in un iframe senza permessi. */
  const showPreview = async () => {
    setError(null);
    try {
      setPreview(await build());
    } catch (e) {
      setError(t('print.failed', { message: e instanceof Error ? e.message : String(e) }));
    }
  };

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const html = await build();
      const r = await bridge.printDocument({
        html,
        mode,
        paper,
        landscape,
        title: project.meta.name,
        defaultName: `${project.meta.name.replace(/[\\/:*?"<>|]/g, '_') || 'BaaPortal'}.pdf`,
      });
      if (r.status === 'error') setError(t('print.failed', { message: r.message }));
      else {
        if (r.status !== 'cancelled')
          store.getState().pushMessage({
            severity: 'info',
            textKey: r.status === 'saved' ? 'print.saved' : 'print.printed',
            params: r.status === 'saved' ? { path: r.path } : {},
          });
        if (r.status !== 'cancelled') onClose();
      }
    } catch (e) {
      setError(t('print.failed', { message: e instanceof Error ? e.message : String(e) }));
    } finally {
      setBusy(false);
    }
  };

  const check = (label: string, value: boolean, set: (v: boolean) => void) => (
    <label style={{ display: 'block' }}>
      <input type="checkbox" checked={value} onChange={(e) => set(e.target.checked)} /> {label}
    </label>
  );

  return (
    <Dialog
      title={t(mode === 'pdf' ? 'print.titlePdf' : 'print.title')}
      onClose={onClose}
      onOk={() => void run()}
      okDisabled={busy}
      testId="print-dialog"
      footer={
        <>
          <button type="button" disabled={busy} onClick={() => void showPreview()}>
            {t('print.preview')}
          </button>
          <button type="button" disabled={busy} onClick={() => void run()}>
            {t(mode === 'pdf' ? 'print.okPdf' : 'print.ok')}
          </button>
          <button type="button" onClick={onClose}>
            {t('kit.cancel')}
          </button>
        </>
      }
    >
      <fieldset>
        <legend>{t('print.include')}</legend>
        {check(t('print.comments'), comments, setComments)}
        {check(t('print.interface'), iface, setIface)}
        {check(t('print.code'), code, setCode)}
        {check(t('print.xref'), xref, setXref)}
      </fieldset>
      <p>
        <label>
          {t('print.mnemonic')}{' '}
          <select value={mnemonic} onChange={(e) => setMnemonic(e.target.value as typeof mnemonic)}>
            <option value="international">{t('print.international')}</option>
            <option value="german">{t('print.german')}</option>
          </select>
        </label>
      </p>
      <p>
        <label>
          {t('print.paper')}{' '}
          <select value={paper} onChange={(e) => setPaper(e.target.value as typeof paper)}>
            <option value="A4">A4</option>
            <option value="Letter">Letter</option>
          </select>
        </label>{' '}
        <label>
          {t('print.orientation')}{' '}
          <select
            value={landscape ? 'landscape' : 'portrait'}
            onChange={(e) => setLandscape(e.target.value === 'landscape')}
          >
            <option value="portrait">{t('print.portrait')}</option>
            <option value="landscape">{t('print.landscape')}</option>
          </select>
        </label>
      </p>
      <p>{t('print.graphicNote')}</p>
      {error ? <p role="alert">{error}</p> : null}
      {preview !== null ? (
        // Senza `allow-*`: nessuno script, nessun modulo, origine opaca. Il documento ha anche la sua CSP.
        <iframe
          title={t('print.preview')}
          data-testid="print-preview"
          sandbox=""
          srcDoc={preview}
          style={{ width: '100%', height: '50vh', border: '1px solid #888', background: '#fff' }}
        />
      ) : null}
    </Dialog>
  );
}
