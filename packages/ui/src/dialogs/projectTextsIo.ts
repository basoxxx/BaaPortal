import {
  decodeSourceBytes,
  parseTextsCsv,
  parseTextsXlsx,
  textsToCsv,
  textsToXlsx,
  XlsxFormatError,
} from '@baaportal/importers';
import { applyTranslations } from '@baaportal/project';
import type { StoreApi } from 'zustand/vanilla';
import type { BaaBridge, FileFilter } from '../bridge';
import { flushPendingEdits } from '../flushPendingEdits';
import { t } from '../i18n';
import type { AppState } from '../state/store';

export interface TextsIoCtx {
  store: StoreApi<AppState>;
  bridge: BaaBridge;
}

export type TextsFormat = 'xlsx' | 'csv';

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const extOf = (path: string): string => path.slice(path.lastIndexOf('.') + 1).toLowerCase();
const filters = (first: TextsFormat): FileFilter[] => {
  const all: Record<TextsFormat, FileFilter> = {
    xlsx: { name: t('tagIo.filterXlsx'), extensions: ['xlsx'] },
    csv: { name: t('tagIo.filterCsv'), extensions: ['csv'] },
  };
  return [all[first], all[first === 'xlsx' ? 'csv' : 'xlsx']];
};

const fail = (store: StoreApi<AppState>, textKey: string, message: string) => {
  const s = store.getState();
  s.pushMessage({ severity: 'error', textKey, params: { message } });
  s.setInspectorTab('info');
  s.setPanel('inspector', { open: true });
};

/** «Esporta…»: tutti i testi traducibili del progetto, con le traduzioni già scritte. */
export async function exportProjectTexts(format: TextsFormat, ctx: TextsIoCtx): Promise<void> {
  const { store, bridge } = ctx;
  flushPendingEdits();
  const doc = store.getState().doc;
  if (!doc) return;
  try {
    const path = await bridge.showSaveFileDialog({
      defaultName: `${doc.project.meta.name}-texts.${format}`,
      filters: filters(format),
    });
    if (!path) return;
    // Il contenuto si rilegge dopo la finestra: è quello di adesso.
    const project = store.getState().doc?.project ?? doc.project;
    const bytes =
      extOf(path) === 'csv' || (extOf(path) !== 'xlsx' && format === 'csv')
        ? new TextEncoder().encode(textsToCsv(project))
        : textsToXlsx(project);
    await bridge.writeFileAtomic(path, bytes);
    store
      .getState()
      .pushMessage({ severity: 'info', textKey: 'messages.textsExported', params: { path } });
  } catch (e) {
    fail(store, 'messages.textsIoFailed', errorText(e));
  }
}

/** «Importa…»: legge xlsx o csv e applica in un solo passo le traduzioni valide. */
export async function importProjectTexts(ctx: TextsIoCtx): Promise<void> {
  const { store, bridge } = ctx;
  flushPendingEdits();
  if (!store.getState().doc) return;
  try {
    const path = (await bridge.showOpenFileDialog({ filters: filters('xlsx') }))[0];
    if (!path) return;
    const others = store.getState().doc?.project.languages?.others ?? [];
    const bytes = await bridge.readFile(path);
    const parsed =
      extOf(path) === 'csv'
        ? parseTextsCsv(decodeSourceBytes(bytes).text, others)
        : parseTextsXlsx(bytes, others);
    if (parsed.errors.some((e) => e.code === 'COLONNA_MANCANTE')) {
      fail(store, 'messages.textsIoFailed', t('texts.noColumns'));
      return;
    }
    let result = { applied: 0, skipped: 0 };
    store.getState().edit('history.importTexts', (p) => {
      result = applyTranslations(p, parsed.translations);
    });
    store.getState().pushMessage({
      severity: result.skipped > 0 ? 'warning' : 'info',
      textKey: 'messages.textsImported',
      params: { applied: String(result.applied), skipped: String(result.skipped) },
    });
  } catch (e) {
    fail(
      store,
      'messages.textsIoFailed',
      e instanceof XlsxFormatError ? t(`tagIo.formatErr.${e.code}`) : errorText(e),
    );
  }
}
