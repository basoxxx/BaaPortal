import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { parseBlockFile } from '@baaportal/s7comm';
import {
  blockFromMc7,
  blockSources,
  findDevice,
  type Block,
  type Member,
  type PlcDevice,
} from '@baaportal/project';
import { useAppStore, useServices } from '../../state/AppContext';
import type { EditorRef } from '../../state/workArea';
import { diffNetworks, hexDump, type NetworkText } from './lineDiff';
import { contextHashOf, hashOf } from '../../project/compile/compileActions';
import './compare.css';

interface Side {
  checksum?: number;
  mc7Length?: number;
  loadLength?: number;
  codeTime?: string;
}

const two = (n: number) => String(n).padStart(2, '0');

/** Intestazione di un file MC7: checksum, lunghezze e data del codice; vuota se non si legge. */
function sideOf(file: Uint8Array | undefined): Side {
  if (!file) return {};
  try {
    const p = parseBlockFile(file);
    const t = p.header.codeTime;
    return {
      ...(p.footer ? { checksum: p.footer.checksum } : {}),
      mc7Length: p.header.mc7Length,
      loadLength: p.header.loadLength,
      ...(t
        ? {
            codeTime: `${t.year}-${two(t.month)}-${two(t.day)} ${two(t.hour)}:${two(t.minute)}:${two(t.second)}`,
          }
        : {}),
    };
  } catch {
    return {};
  }
}

function memberLines(ms: Member[], depth = 0): string[] {
  return ms.flatMap((m) => [
    `${'  '.repeat(depth)}${m.name} : ${m.type}${m.initial ? ` := ${m.initial}` : ''}`,
    ...(m.members ? memberLines(m.members, depth + 1) : []),
  ]);
}

/** Forma testuale di un blocco: una voce per rete; un DB è una sola voce con i suoi membri. */
export function blockText(b: Block, device: PlcDevice): NetworkText[] {
  if (b.kind === 'DB') return [{ title: '', lines: memberLines(b.members) }];
  if (b.kind === 'IDB') {
    const ov = Object.entries(b.overrides).map(([k, v]) => `${k} := ${v}`);
    return [{ title: '', lines: [b.instanceOf, ...ov] }];
  }
  const sources = blockSources(b, device);
  return b.networks.map((n, k) => ({
    title: n.title,
    comment: n.comment,
    lines: sources[k]!.split('\n'),
  }));
}

type Online =
  | { state: 'idle' }
  | { state: 'loading' }
  | { state: 'error'; message: string }
  | { state: 'ready'; bytes: Uint8Array };

function decodeOnline(device: PlcDevice, bytes: Uint8Array): NetworkText[] | null {
  try {
    return blockText(blockFromMc7(device, bytes).block, device);
  } catch {
    return null;
  }
}

/** Confronto di un blocco del progetto con quello della CPU: sola lettura, reti affiancate. */
export function CompareView({ editor }: { editor: EditorRef }) {
  const { t } = useTranslation();
  const { bridge } = useServices();
  const doc = useAppStore((s) => s.doc);
  const compile = useAppStore((s) => s.compile);
  const status = useAppStore((s) => s.online.status);
  const device = doc ? findDevice(doc.project, editor.deviceId) : undefined;
  const block = device?.blocks.find((b) => b.id === editor.objectId);
  const type = block ? (block.kind === 'IDB' ? 'DB' : block.kind) : undefined;
  const number = block?.number;
  const [online, setOnline] = useState<Online>({ state: 'idle' });
  const [reload, setReload] = useState(0);

  useEffect(() => {
    if (!type || number === undefined || status !== 'on') {
      setOnline({ state: 'idle' });
      return;
    }
    let live = true;
    setOnline({ state: 'loading' });
    bridge
      .plcUploadBlock(type, number)
      .then((r) => {
        if (live)
          setOnline(
            r.ok ? { state: 'ready', bytes: r.bytes } : { state: 'error', message: r.error },
          );
      })
      .catch((e: unknown) => {
        if (live)
          setOnline({ state: 'error', message: e instanceof Error ? e.message : String(e) });
      });
    return () => {
      live = false;
    };
  }, [bridge, type, number, status, reload]);

  // Compilato aggiornato del progetto (stessa impronta del sorgente attuale), altrimenti nessuno.
  const offlineFile =
    block && device && compile.hashes[block.id] === hashOf(block, contextHashOf(device))
      ? compile.files[block.id]
      : undefined;
  // Lato progetto: il compilato decodificato come quello della CPU (stessa notazione); se manca
  // o non si decodifica, il testo sorgente.
  const leftDecoded = useMemo(
    () => (offlineFile && device ? decodeOnline(device, offlineFile) : null),
    [offlineFile, device],
  );
  const left = useMemo(
    () => leftDecoded ?? (block && device ? blockText(block, device) : []),
    [leftDecoded, block, device],
  );
  const decoded = useMemo(
    () => (online.state === 'ready' && device ? decodeOnline(device, online.bytes) : null),
    [online, device],
  );
  const diffs = useMemo(() => (decoded ? diffNetworks(left, decoded) : []), [left, decoded]);
  const offSide = useMemo(() => sideOf(offlineFile), [offlineFile]);
  const onSide = useMemo(() => (online.state === 'ready' ? sideOf(online.bytes) : {}), [online]);

  if (!block) return null;
  const dash = '-';
  const fromSource = leftDecoded === null;
  // Un compilato c'è ma non è più quello del sorgente: «non aggiornata», non «non compilato».
  const notCompiled =
    offlineFile !== undefined
      ? undefined
      : t(compile.files[block.id] ? 'compareView.staleCompile' : 'compareView.notCompiled');
  const num = (v: number | undefined) => (v === undefined ? dash : String(v));
  const hex = (v: number | undefined) =>
    v === undefined ? dash : `0x${v.toString(16).toUpperCase().padStart(4, '0')}`;

  return (
    <div className="baa-compare" data-testid="compare-view">
      <table className="baa-compare-head">
        <thead>
          <tr>
            <th />
            <th>{t('compareView.project')}</th>
            <th>{t('compareView.cpu')}</th>
          </tr>
        </thead>
        <tbody>
          {(
            [
              ['checksum', notCompiled ?? hex(offSide.checksum), hex(onSide.checksum)],
              ['mc7Length', notCompiled ?? num(offSide.mc7Length), num(onSide.mc7Length)],
              ['loadLength', notCompiled ?? num(offSide.loadLength), num(onSide.loadLength)],
              ['codeTime', notCompiled ?? offSide.codeTime ?? dash, onSide.codeTime ?? dash],
            ] as const
          ).map(([k, a, b]) => (
            <tr key={k}>
              <th scope="row">{t(`compareView.${k}`)}</th>
              <td>{a}</td>
              <td>{b}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {fromSource ? (
        <p className="baa-compare-note" data-testid="compare-source-note">
          {t('compareView.sourceFallback')}
        </p>
      ) : null}
      {status !== 'on' ? (
        <p className="baa-compare-note" data-testid="compare-offline">
          {t('compareView.offline')}
        </p>
      ) : (
        <button
          type="button"
          className="baa-compare-reload"
          disabled={online.state === 'loading'}
          onClick={() => setReload((n) => n + 1)}
        >
          {t('compareView.reload')}
        </button>
      )}
      {online.state === 'loading' ? (
        <p className="baa-compare-note">{t('compareView.loading')}</p>
      ) : null}
      {online.state === 'error' ? (
        <p className="baa-compare-note is-error" role="alert">
          {t('compareView.failed', { message: online.message })}
        </p>
      ) : null}
      {online.state === 'ready' && !decoded ? (
        <>
          <p className="baa-compare-note" data-testid="compare-undecodable">
            {t('compareView.undecodable')}
          </p>
          <pre className="baa-compare-hex" data-testid="compare-hex">
            {hexDump(online.bytes).join('\n')}
          </pre>
        </>
      ) : null}
      {diffs.map((d) => (
        <section
          key={d.index}
          className="baa-compare-net"
          data-testid={`compare-net-${d.index}`}
          data-presence={d.presence}
        >
          <h4>
            {t('compareView.network', { n: d.leftNo ?? d.rightNo })}
            {d.leftNo && d.rightNo && d.leftNo !== d.rightNo
              ? ` (${t('compareView.networkOnCpu', { n: d.rightNo })})`
              : ''}
            {d.leftTitle || d.rightTitle ? ` - ${d.leftTitle || d.rightTitle}` : ''}
            {d.presence === 'left' ? ` (${t('compareView.onlyProject')})` : ''}
            {d.presence === 'right' ? ` (${t('compareView.onlyCpu')})` : ''}
            {!d.different ? ` (${t('compareView.identical')})` : ''}
          </h4>
          {d.approximate ? (
            <p className="baa-compare-note" data-testid="compare-approximate">
              {t('compareView.approximate')}
            </p>
          ) : null}
          {(
            [
              ['title', d.titleDiff],
              ['comment', d.commentDiff],
            ] as const
          ).map(([k, x]) =>
            x ? (
              <p key={k} className="baa-compare-note" data-testid={`compare-${k}-diff`}>
                {t(`compareView.${k}Diff`, { left: x.left, right: x.right })}
              </p>
            ) : null,
          )}
          <table>
            <tbody>
              {d.rows.map((r, i) => (
                <tr key={i} className={`is-${r.kind}`} data-diff={r.kind}>
                  <td className="baa-compare-l">{r.left ?? ''}</td>
                  <td className="baa-compare-r">{r.right ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ))}
    </div>
  );
}
