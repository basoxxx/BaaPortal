import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { parseBlockFile } from '@baaportal/s7comm';
import {
  blockFromMc7,
  findDevice,
  type Block,
  type Member,
  type PlcDevice,
} from '@baaportal/project';
import { useAppStore, useServices } from '../../state/AppContext';
import type { EditorRef } from '../../state/workArea';
import { diffNetworks, hexDump, type NetworkText } from './lineDiff';
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
export function blockText(b: Block): NetworkText[] {
  if (b.kind === 'DB') return [{ title: '', lines: memberLines(b.members) }];
  if (b.kind === 'IDB') {
    const ov = Object.entries(b.overrides).map(([k, v]) => `${k} := ${v}`);
    return [{ title: '', lines: [b.instanceOf, ...ov] }];
  }
  return b.networks.map((n) => ({ title: n.title, lines: n.source.split('\n') }));
}

type Online =
  | { state: 'loading' }
  | { state: 'error'; message: string }
  | { state: 'ready'; bytes: Uint8Array };

function decodeOnline(device: PlcDevice, bytes: Uint8Array): NetworkText[] | null {
  try {
    return blockText(blockFromMc7(device, bytes).block);
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
  const [online, setOnline] = useState<Online>({ state: 'loading' });

  useEffect(() => {
    if (!type || number === undefined) return;
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
  }, [bridge, type, number]);

  const offlineFile = block ? compile.files[block.id] : undefined;
  const left = useMemo(() => (block ? blockText(block) : []), [block]);
  const decoded = useMemo(
    () => (online.state === 'ready' && device ? decodeOnline(device, online.bytes) : null),
    [online, device],
  );
  const diffs = useMemo(() => (decoded ? diffNetworks(left, decoded) : []), [left, decoded]);
  const offSide = useMemo(() => sideOf(offlineFile), [offlineFile]);
  const onSide = useMemo(() => (online.state === 'ready' ? sideOf(online.bytes) : {}), [online]);

  if (!block) return null;
  const dash = '-';
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
              ['checksum', hex(offSide.checksum), hex(onSide.checksum)],
              ['mc7Length', num(offSide.mc7Length), num(onSide.mc7Length)],
              ['loadLength', num(offSide.loadLength), num(onSide.loadLength)],
              ['codeTime', offSide.codeTime ?? dash, onSide.codeTime ?? dash],
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
      {status !== 'on' ? <p className="baa-compare-note">{t('compareView.offline')}</p> : null}
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
            {t('compareView.network', { n: d.index + 1 })}
            {d.leftTitle || d.rightTitle ? ` - ${d.leftTitle || d.rightTitle}` : ''}
            {d.presence === 'left' ? ` (${t('compareView.onlyProject')})` : ''}
            {d.presence === 'right' ? ` (${t('compareView.onlyCpu')})` : ''}
            {!d.different ? ` (${t('compareView.identical')})` : ''}
          </h4>
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
