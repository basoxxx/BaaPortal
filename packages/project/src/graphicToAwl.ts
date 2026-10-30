// «Converti in AWL»: un blocco KOP/FUP intero (diventa AWL) o un suo segmento grafico (resta AWL
// dentro il blocco grafico). Ogni segmento tiene come testo il suo AWL generato. Il blocco cambia
// solo se i salti portano alle stesse istruzioni e il codice MC7 compilato resta identico byte per byte.
import { findCpu } from '@baaportal/catalog';
import { awlLabels, blockJumps } from '@baaportal/ladfbd';
import { readBlockFile } from '@baaportal/mc7';
import { kopSources } from './kopSources';
import { blockToMc7File } from './mc7Bridge';
import { isGraphic, type CodeBlock, type PlcDevice } from './model';

/** Perché la conversione non si fa: salti diversi, blocco che non compila, MC7 diverso. */
export type GraphicToAwlFailure = 'SHAPE' | 'JUMPS' | 'NOT_COMPILABLE' | 'MC7_DIFFERS';

/** Etichetta automatica dei grafici (`_001`, vedi `networkToAwl`). */
const AUTO_LABEL = /^_\d{3}$/;
// un istante fisso dentro il formato dei blocchi (1984–2163): l'intestazione non si confronta
const FIXED_NOW = new Date('2000-01-01T00:00:00Z');

/** Codice MC7 e interfaccia compilati (senza intestazione: ora e linguaggio cambiano). */
function compiledCode(block: CodeBlock, dev: PlcDevice): string | undefined {
  const { file } = blockToMc7File(block, dev, findCpu(dev.cpu.typeId), FIXED_NOW);
  if (!file) return undefined;
  const f = readBlockFile(file);
  return `${f.mc7.join(',')}/${f.ssb.join(',')}`;
}

/** Rinomina in `source` le etichette `from → to` (solo token interi). */
function renameLabels(source: string, names: Map<string, string>): string {
  if (names.size === 0) return source;
  const re = new RegExp(`(?<![\\w"#.%])(${[...names.keys()].join('|')})(?!\\w)`, 'g');
  return source.replace(re, (m) => names.get(m) ?? m);
}

/**
 * Converte in AWL il blocco KOP/FUP (`index` assente) o il suo segmento grafico `index` (da 0).
 * `null` se è fatto; altrimenti il motivo, e il blocco non cambia. `dev` deve contenere il blocco
 * (o uno con lo stesso id e la stessa interfaccia) e i blocchi che chiama.
 */
export function convertGraphicToAwl(
  block: CodeBlock,
  dev: PlcDevice,
  index?: number,
): GraphicToAwlFailure | null {
  if (!isGraphic(block.language)) return 'SHAPE';
  if (index !== undefined && !block.networks[index]?.lad) return 'SHAPE';
  const before = compiledCode(block, dev);
  if (before === undefined) return 'NOT_COMPILABLE';
  const sources = kopSources(block, dev).map((s) => s.source);
  const saved = { language: block.language, networks: block.networks.map((n) => ({ ...n })) };
  const restore = (why: GraphicToAwlFailure): GraphicToAwlFailure => {
    block.language = saved.language;
    block.networks.forEach((n, i) => Object.assign(n, saved.networks[i]));
    return why;
  };
  if (index === undefined) {
    block.language = 'AWL';
    block.networks.forEach((n, i) => {
      n.source = sources[i] ?? n.source;
      delete n.lad;
    });
  } else {
    // Le etichette automatiche del segmento diventano `M001`…: quelle dei grafici dopo si rinumerano.
    const taken = new Set(sources.flatMap((s) => [...awlLabels(s)]));
    const names = new Map<string, string>();
    let k = 1;
    for (const l of awlLabels(sources[index]!)) {
      if (!AUTO_LABEL.test(l)) continue;
      while (taken.has(`M${String(k).padStart(3, '0')}`)) k++;
      names.set(l, `M${String(k++).padStart(3, '0')}`);
    }
    const n = block.networks[index]!;
    n.source = renameLabels(sources[index]!, names);
    delete n.lad;
    const fresh = kopSources(block, dev);
    block.networks.forEach((x, i) => (x.source = fresh[i]?.source ?? x.source));
  }
  // dopo la rinumerazione ogni salto del blocco porta alla stessa istruzione di prima
  const jumps = blockJumps(sources);
  const jumpsAfter = blockJumps(block.networks.map((x) => x.source));
  if (!jumps || !jumpsAfter || JSON.stringify(jumps) !== JSON.stringify(jumpsAfter)) {
    return restore('JUMPS');
  }
  const after = compiledCode(block, dev);
  if (after === undefined) return restore('NOT_COMPILABLE');
  if (after !== before) return restore('MC7_DIFFERS');
  return null;
}
