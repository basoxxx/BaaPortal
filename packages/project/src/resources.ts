// Risorse del programma (tappa 7A): memoria di caricamento e di lavoro dei blocchi compilati, dati
// locali (stack L) per blocco e lungo i percorsi di chiamata di ogni OB, aree usate contro i limiti della CPU.
import type { CpuType } from '@baaportal/catalog';
import { readBlockFile } from '@baaportal/mc7';
import { blockToMc7File } from './mc7Bridge';
import type { CallGraph } from './callGraph';
import type { AssignAreaList } from './assignment';
import type { PlcDevice } from './model';

/** Dimensioni di un blocco compilato (`readBlockFile`): sono stime, non i valori di STEP 7. */
export interface BlockSize {
  /** Byte del file del blocco: memoria di caricamento. */
  load: number;
  /** Byte della sezione MC7 (codice o dati): memoria di lavoro. */
  work: number;
  /** Dati locali (TEMP) del blocco. */
  local: number;
}

/** Compila ogni blocco del dispositivo e ne misura le dimensioni; i blocchi non compilabili mancano. */
export function blockSizes(dev: PlcDevice, cpu: CpuType | undefined): Map<string, BlockSize> {
  const out = new Map<string, BlockSize>();
  for (const b of dev.blocks) {
    const { file } = blockToMc7File(b, dev, cpu);
    if (!file) continue;
    try {
      const f = readBlockFile(file);
      out.set(b.id, {
        load: file.length,
        work: f.header.mc7Length,
        local: f.header.localDataLength,
      });
    } catch {
      // file illeggibile: resta «da compilare»
    }
  }
  return out;
}

export interface BlockResource {
  key: string;
  name: string;
  blockId: string;
  /** Assente: il blocco non si compila («da compilare»). */
  size?: BlockSize;
}

export interface ObLocalPath {
  /** `OB1`. */
  ob: string;
  /** Il percorso con più dati locali, dall'OB in giù. */
  path: string[];
  bytes: number;
  /** Il percorso contiene blocchi non compilati: il valore è solo una parte. */
  partial: boolean;
  /** Oltre il limite di dati locali per classe di priorità della CPU. */
  overLimit: boolean;
}

export interface ProgramResources {
  blocks: BlockResource[];
  total: BlockSize;
  uncompiled: number;
  /** Memoria di lavoro della CPU in byte. */
  workLimit: number;
  localLimit: number;
  obPaths: ObLocalPath[];
  /** Aree usate (byte per I, Q, M; elementi per T e C) e limite della CPU. */
  areas: { area: string; used: number; limit: number }[];
}

/** Risorse del programma: `sizes` da `blockSizes`, `graph` da `callGraph`, `assign` da `assignmentList`. */
export function programResources(
  dev: PlcDevice,
  cpu: CpuType | undefined,
  sizes: Map<string, BlockSize>,
  graph: CallGraph,
  assign: AssignAreaList[],
): ProgramResources {
  const blocks = dev.blocks.map((b): BlockResource => {
    const size = sizes.get(b.id);
    return {
      key: `${b.kind === 'IDB' ? 'DB' : b.kind}${b.number}`,
      name: b.name,
      blockId: b.id,
      ...(size ? { size } : {}),
    };
  });
  const total = { load: 0, work: 0, local: 0 };
  for (const b of blocks)
    if (b.size) {
      total.load += b.size.load;
      total.work += b.size.work;
    }
  const localLimit = cpu?.limits.localDataBytesPerClass ?? 0;
  const byKey = new Map(blocks.map((b) => [b.key, b]));
  // Il percorso più costoso dall'OB: i suoi dati locali più il massimo dei chiamati; un ciclo si ferma.
  const worst = (
    key: string,
    seen: string[],
  ): { bytes: number; path: string[]; partial: boolean } => {
    const b = byKey.get(key);
    const own = b?.size?.local ?? 0;
    let best = { bytes: 0, path: [] as string[], partial: false };
    if (!seen.includes(key))
      for (const e of graph.calls.get(key) ?? []) {
        const c = worst(e.callee, [...seen, key]);
        if (c.bytes > best.bytes || (c.partial && !best.partial && c.bytes === best.bytes))
          best = c;
      }
    // Un SFC/SFB o un blocco mancante non ha dati locali noti: non rende il percorso parziale.
    return {
      bytes: own + best.bytes,
      path: [key, ...best.path],
      partial: (b !== undefined && !b.size) || best.partial,
    };
  };
  const obPaths = graph.roots.map((ob): ObLocalPath => {
    const w = worst(ob, []);
    return {
      ob,
      path: w.path,
      bytes: w.bytes,
      partial: w.partial,
      overLimit: localLimit > 0 && w.bytes > localLimit,
    };
  });
  return {
    blocks,
    total,
    uncompiled: blocks.filter((b) => !b.size).length,
    workLimit: (cpu?.workMemoryKB ?? 0) * 1024,
    localLimit,
    obPaths,
    areas: assign.map((a) => ({ area: a.area, used: a.used, limit: a.limit })),
  };
}
