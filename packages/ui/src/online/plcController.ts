import type { StoreApi } from 'zustand/vanilla';
import { findDevice } from '@baaportal/project';
import type { BaaBridge } from '../bridge';
import { targetPlcId } from '../project/navigation/treeIds';
import { compileProgram, contextHashOf, hashOf } from '../project/compile/compileActions';
import { beginProgress, getProgress } from '../project/progress';
import { ONLINE_OFF, type AppState } from '../state/store';
import { compareBlocks, type CompareProjectBlock } from './compare';
import type { PlcControlOp, PlcEvent, PlcLostReason } from './plcTypes';

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const norm = (s: string) => s.replace(/\s+/g, '').toUpperCase();

/**
 * Governa il collegamento online (sola lettura) di un negozio. Come `SimController`, ogni
 * collegamento è una «sessione» (`generation`): risposte ed eventi di una sessione chiusa o
 * sostituita si scartano; il cambio di progetto e la chiusura della finestra scollegano.
 */
export class PlcController {
  private generation = 0;
  /** Un numero per confronto: chi non è più il corrente non tocca `comparing`. */
  private compareToken = 0;
  private unlisten: (() => void) | undefined;

  constructor(
    private readonly store: StoreApi<AppState>,
    private readonly bridge: BaaBridge,
  ) {
    let load = store.getState().docLoadId;
    store.subscribe((s) => {
      if (s.docLoadId === load) return;
      load = s.docLoadId;
      this.shutdown();
    });
  }

  private push(
    severity: 'info' | 'warning' | 'error',
    key: string,
    params?: Record<string, string>,
  ): void {
    this.store.getState().pushMessage({
      severity,
      textKey: `messages.${key}`,
      ...(params ? { params } : {}),
    });
  }

  /**
   * Collega la CPU `deviceId` (predefinita: quella selezionata nell'albero, o la prima); senza
   * impostazioni di accesso apre «Dispositivi accessibili».
   */
  async goOnline(deviceId?: string): Promise<void> {
    const st = this.store.getState();
    if (st.online.status !== 'off') return;
    if (st.sim.phase !== 'off') {
      this.push('warning', 'plcBlockedBySim');
      return;
    }
    const id = deviceId ?? targetPlcId(st);
    const dev = st.doc && id ? findDevice(st.doc.project, id) : undefined;
    if (!dev) return;
    const access = dev.properties.access;
    if (!access) {
      st.openDialog({ kind: 'accessibleDevices' });
      return;
    }
    const gen = ++this.generation;
    this.compareToken++;
    this.unlisten?.();
    this.unlisten = this.bridge.onPlcEvent((e) => this.onEvent(gen, e));
    st.setOnline({ status: 'connecting', access, deviceId: dev.id });
    let result: Awaited<ReturnType<BaaBridge['plcConnect']>>;
    try {
      result = await this.bridge.plcConnect(access);
    } catch (e) {
      result = { ok: false, error: errorText(e) };
    }
    if (gen !== this.generation) {
      // Scollegato mentre si collegava: se nessun'altra sessione è subentrata, si chiude quella nata.
      if (result.ok && this.store.getState().online.status === 'off') {
        this.bridge.plcDisconnect().catch(() => undefined);
      }
      return;
    }
    if (!result.ok) {
      this.unlisten?.();
      this.unlisten = undefined;
      this.store.getState().setOnline(ONLINE_OFF);
      this.push('error', 'plcConnectFailed', { message: result.error });
      return;
    }
    this.store.getState().setOnline({
      status: 'on',
      access,
      deviceId: dev.id,
      identity: result.identity,
      mode: result.mode,
    });
    // Verifica: l'esito dice «collegato», ma il processo principale potrebbe aver già perso il PLC.
    const status = await this.bridge.plcStatus().catch(() => undefined);
    if (gen !== this.generation) return;
    if (status && !status.connected) {
      this.lose(gen, 'closed');
      return;
    }
    this.push('info', 'plcConnected', { name: dev.name, host: access.host });
    if (norm(result.identity.orderNumber) !== norm(dev.cpu.orderNumber)) {
      this.push('warning', 'plcMismatch', {
        connected: result.identity.orderNumber,
        project: dev.cpu.orderNumber,
      });
    }
    void this.compare(false);
  }

  /**
   * Confronta i blocchi del progetto con quelli della CPU collegata: compila ciò che è cambiato,
   * elenca i blocchi della CPU (sola lettura) e tiene l'esito in `online.compare`. Parte da sola
   * al collegamento (`explicit` falso: compila in silenzio, senza aprire la scheda Compila e solo
   * se serve) e col comando «Confronta» (`explicit`: come la compilazione normale); non a ogni
   * modifica. Se un'altra operazione lunga impedisce di compilare, si confronta con ciò che c'è e
   * i blocchi cambiati risultano da compilare.
   */
  async compare(explicit = true): Promise<void> {
    const st = this.store.getState();
    const { status, deviceId, comparing } = st.online;
    if (status !== 'on' || !deviceId || comparing) return;
    const gen = this.generation;
    const token = ++this.compareToken;
    const live = () => gen === this.generation && this.store.getState().online.status === 'on';
    st.patchOnline({ comparing: true });
    try {
      const dev0 = st.doc && findDevice(st.doc.project, deviceId);
      if (!dev0) return;
      const ctx0 = contextHashOf(dev0);
      const upToDate = dev0.blocks.every((b) => st.compile.hashes[b.id] === hashOf(b, ctx0));
      if (explicit || !upToDate) {
        if (getProgress()) this.push('warning', 'plcCompareSkipped');
        else {
          await compileProgram(
            { store: this.store, bridge: this.bridge },
            deviceId,
            'changes',
            undefined,
            {
              silent: !explicit,
            },
          );
          if (!live()) return;
        }
      }
      let res: Awaited<ReturnType<BaaBridge['plcBlocks']>>;
      try {
        res = await this.bridge.plcBlocks();
      } catch (e) {
        res = { ok: false, error: errorText(e) };
      }
      if (!live()) return;
      if (!res.ok) {
        this.push('error', 'plcCompareFailed', { message: res.error });
        return;
      }
      const { doc, compile } = this.store.getState();
      const dev = doc && findDevice(doc.project, deviceId);
      if (!dev) return;
      const context = contextHashOf(dev);
      const hashes: Record<string, string> = {};
      const project: CompareProjectBlock[] = dev.blocks.map((b) => {
        const hash = hashOf(b, context);
        hashes[b.id] = hash;
        const file = compile.hashes[b.id] === hash ? compile.files[b.id] : undefined;
        return {
          id: b.id,
          type: b.kind === 'IDB' ? 'DB' : b.kind,
          number: b.number,
          ...(file ? { file } : {}),
        };
      });
      this.store.getState().patchOnline({
        compare: { deviceId, rows: compareBlocks(project, res.blocks), hashes },
      });
    } finally {
      if (token === this.compareToken && this.store.getState().online.status !== 'off') {
        this.store.getState().patchOnline({ comparing: false });
      }
    }
  }

  /**
   * Comando della CPU (RUN, STOP, copia RAM in ROM, comprimi). La conferma è nativa, nel processo
   * principale; il modo non si forza: lo porta l'evento `mode` della sorveglianza.
   */
  async control(op: PlcControlOp): Promise<void> {
    const st = this.store.getState();
    const { status, downloading, commanding } = st.online;
    if (status !== 'on' || downloading || commanding) return;
    const gen = this.generation;
    st.patchOnline({ commanding: true });
    let res: Awaited<ReturnType<BaaBridge['plcControl']>>;
    try {
      res = await this.bridge.plcControl(op);
    } catch (e) {
      res = { ok: false, error: errorText(e) };
    }
    if (gen !== this.generation) return;
    this.store.getState().patchOnline({ commanding: false });
    if (!res.ok) {
      if (!('cancelled' in res)) this.push('error', 'plcCommandFailed', { message: res.error });
      return;
    }
    if (op === 'COPY_RAM_TO_ROM') this.push('info', 'plcCopiedRamToRom');
    else if (op === 'COMPRESS') this.push('info', 'plcCompressed');
  }

  /**
   * Backup online: il processo principale chiede il file, carica OB, FB, FC, DB e SDB su un
   * collegamento proprio (sola lettura) e scrive il `.baapbak`. L'avanzamento sta nella barra di
   * stato con Interrompi; il backup non cambia nulla nel progetto.
   */
  async backup(): Promise<void> {
    const { online } = this.store.getState();
    if (online.status !== 'on' || online.comparing || online.downloading || online.commanding) {
      return;
    }
    if (getProgress()) return;
    const bar = beginProgress('status.backup', () => void this.bridge.plcBackupCancel());
    const off = this.bridge.onPlcUploadProgress((p) => bar.update(p.done, p.total));
    let res: Awaited<ReturnType<BaaBridge['plcBackup']>>;
    try {
      res = await this.bridge.plcBackup();
    } catch (e) {
      res = { ok: false, error: errorText(e) };
    } finally {
      off();
      bar.end();
    }
    if (!res.ok) {
      if (!('cancelled' in res)) this.push('error', 'backupFailed', { message: res.error });
      return;
    }
    const list = res.failed.map((f) => `${f.type}${f.number}`).join(', ');
    if (res.failed.length === 0) {
      this.push('info', 'backupDone', { path: res.path, count: String(res.count) });
    } else {
      this.push('warning', 'backupDonePartial', {
        path: res.path,
        count: String(res.count),
        missing: String(res.failed.length),
        list,
      });
    }
  }

  private onEvent(gen: number, e: PlcEvent): void {
    if (gen !== this.generation || this.store.getState().online.status !== 'on') return;
    if (e.kind === 'mode') {
      this.store.getState().patchOnline({ mode: e.mode });
      return;
    }
    this.lose(gen, e.reason);
  }

  private lose(gen: number, reason: PlcLostReason): void {
    if (gen !== this.generation) return;
    this.generation++;
    this.compareToken++;
    this.unlisten?.();
    this.unlisten = undefined;
    this.store.getState().setOnline(ONLINE_OFF);
    this.push(
      'error',
      reason === 'timeout'
        ? 'plcLostTimeout'
        : reason === 'errors'
          ? 'plcLostErrors'
          : 'plcLostClosed',
    );
  }

  /** «Interrompi collegamento online». */
  goOffline(): void {
    const wasOn = this.store.getState().online.status === 'on';
    this.shutdown();
    if (wasOn) this.push('info', 'plcDisconnected');
  }

  /** Chiude il collegamento (progetto chiuso o cambiato, finestra in chiusura). */
  shutdown(): void {
    this.generation++;
    this.compareToken++;
    this.unlisten?.();
    this.unlisten = undefined;
    if (this.store.getState().online.status === 'off') return;
    this.store.getState().setOnline(ONLINE_OFF);
    this.bridge.plcDisconnect().catch(() => undefined);
  }
}

const controllers = new WeakMap<StoreApi<AppState>, PlcController>();

/** Il controllore del negozio (creato alla prima richiesta; `bridge` conta solo in quel momento). */
export function plcControllerFor(store: StoreApi<AppState>, bridge: BaaBridge): PlcController {
  let c = controllers.get(store);
  if (!c) {
    c = new PlcController(store, bridge);
    controllers.set(store, c);
  }
  return c;
}

/** Scollega se esiste un collegamento (chiusura della finestra). */
export function shutdownOnline(store: StoreApi<AppState>): void {
  controllers.get(store)?.shutdown();
}
