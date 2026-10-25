import type { StoreApi } from 'zustand/vanilla';
import { findDevice, type PlcDevice } from '@baaportal/project';
import type { BaaBridge } from '../../bridge';
import type { AppState } from '../../state/store';
import { compileProgram, contextHashOf, hashOf } from './compileActions';

/** Un blocco pronto da caricare: il compilato è quello del contenuto e del contesto di adesso. */
export interface PreparedBlock {
  id: string;
  kind: PlcDevice['blocks'][number]['kind'];
  number: number;
  file: Uint8Array;
}

export type PreparedBlocks =
  /** Compilazione non eseguita, interrotta o sessione finita (già segnalato, se serviva). */
  | { status: 'aborted' }
  | { status: 'errors'; errors: number }
  | { status: 'stale'; count: number }
  | { status: 'ok'; dev: PlcDevice; context: string; blocks: PreparedBlock[] };

/**
 * Parte comune dei caricamenti (simulatore e PLC vero): compila le modifiche e prende i compilati
 * aggiornati. Si carica solo ciò che è stato compilato con il contenuto e il contesto di adesso:
 * una compilazione interrotta da un'eccezione lascia blocchi vecchi, che non vanno caricati, e un
 * blocco non attuale ferma tutto. `isCurrent` dice se la sessione di chi chiama è ancora quella.
 * Con `only` (id di blocchi) si compilano e si controllano solo quelli.
 */
export async function prepareCompiledBlocks(
  ctx: { store: StoreApi<AppState>; bridge: BaaBridge },
  deviceId: string,
  isCurrent: () => boolean,
  only?: string[],
): Promise<PreparedBlocks> {
  const { store } = ctx;
  const stateNow = () => {
    const { doc, compile } = store.getState();
    return { dev: doc && findDevice(doc.project, deviceId), compile };
  };
  const before = stateNow();
  const wanted = (dev: PlcDevice) =>
    only ? dev.blocks.filter((b) => only.includes(b.id)) : dev.blocks;
  let needCompile = true;
  if (only && before.dev) {
    const ctx0 = contextHashOf(before.dev);
    needCompile = wanted(before.dev).some((b) => before.compile.hashes[b.id] !== hashOf(b, ctx0));
  }
  if (needCompile) {
    await compileProgram(
      ctx,
      deviceId,
      'changes',
      only ? wanted(before.dev!).map((b) => b.id) : undefined,
    );
  }
  if (!isCurrent()) return { status: 'aborted' };
  const { dev, compile } = stateNow();
  if (!dev) return { status: 'aborted' };
  if (needCompile) {
    if (!compile.summary) return { status: 'aborted' }; // non eseguita o fallita (già segnalata)
    if (compile.interrupted) return { status: 'aborted' };
    if (compile.summary.errors > 0) return { status: 'errors', errors: compile.summary.errors };
  }
  const context = contextHashOf(dev);
  const items = wanted(dev).map((b) => ({
    id: b.id,
    kind: b.kind,
    number: b.number,
    file: compile.hashes[b.id] === hashOf(b, context) ? compile.files[b.id] : undefined,
  }));
  const stale = items.filter((i) => !i.file).length;
  if (stale > 0) return { status: 'stale', count: stale };
  return {
    status: 'ok',
    dev,
    context,
    blocks: items.map((i) => ({ ...i, file: i.file! })),
  };
}
