import type { StoreApi } from 'zustand/vanilla';
import { findDevice } from '@baaportal/project';
import type { BaaBridge } from '../bridge';
import { targetPlcId } from '../project/navigation/treeIds';
import { ONLINE_OFF, type AppState } from '../state/store';
import type { PlcEvent } from './plcTypes';

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const norm = (s: string) => s.replace(/\s+/g, '').toUpperCase();

/**
 * Governa il collegamento online (sola lettura) di un negozio. Come `SimController`, ogni
 * collegamento è una «sessione» (`generation`): risposte ed eventi di una sessione chiusa o
 * sostituita si scartano; il cambio di progetto e la chiusura della finestra scollegano.
 */
export class PlcController {
  private generation = 0;
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

  /** Collega la CPU selezionata (o la prima); senza impostazioni di accesso apre «Dispositivi accessibili». */
  async goOnline(): Promise<void> {
    const st = this.store.getState();
    if (st.online.status !== 'off' || st.sim.phase !== 'off') return;
    const id = targetPlcId(st);
    const dev = st.doc && id ? findDevice(st.doc.project, id) : undefined;
    if (!dev) return;
    const access = dev.properties.access;
    if (!access) {
      st.openDialog({ kind: 'accessibleDevices' });
      return;
    }
    const gen = ++this.generation;
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
    this.push('info', 'plcConnected', { name: dev.name, host: access.host });
    if (norm(result.identity.orderNumber) !== norm(dev.cpu.orderNumber)) {
      this.push('warning', 'plcMismatch', {
        connected: result.identity.orderNumber,
        project: dev.cpu.orderNumber,
      });
    }
  }

  private onEvent(gen: number, e: PlcEvent): void {
    if (gen !== this.generation || this.store.getState().online.status !== 'on') return;
    if (e.kind === 'mode') {
      this.store.getState().patchOnline({ mode: e.mode });
      return;
    }
    this.generation++;
    this.unlisten?.();
    this.unlisten = undefined;
    this.store.getState().setOnline(ONLINE_OFF);
    this.push('error', 'plcLost', { reason: e.reason });
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
