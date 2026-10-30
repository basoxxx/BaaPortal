import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { parseAddress } from '@baaportal/s7-types';
import { findDevice, type PlcDevice } from '@baaportal/project';
import { useAppStore, useServices } from '../../state/AppContext';
import { simControllerFor } from '../../sim/simController';
import type { WriteItemReq } from '../../sim/protocol';

type Dir = 'inputs' | 'outputs';

interface ByteInfo {
  byte: number;
  /** Simbolo per bit (solo dai tag di tipo Bool). */
  bits: (string | undefined)[];
  /** Simboli dei tag che coprono più byte (Byte, Word, DWord). */
  names: string[];
}

const BYTES_OF = { X: 1, B: 1, W: 2, D: 4 } as const;

/**
 * Byte usati dai tag delle tabelle delle variabili, per area. Gli accessi di periferia (PI/PQ)
 * contano come I e Q: nel simulatore condividono i byte delle immagini fisiche.
 */
export function usedBytes(dev: PlcDevice | undefined): Record<Dir, Map<number, ByteInfo>> {
  const out = { inputs: new Map<number, ByteInfo>(), outputs: new Map<number, ByteInfo>() };
  for (const table of dev?.tagTables ?? [])
    for (const tag of table.tags) {
      const p = parseAddress(tag.address);
      if (!p.ok || !('size' in p.address)) continue;
      const a = p.address;
      const dir: Dir | undefined =
        a.area === 'I' || a.area === 'PI'
          ? 'inputs'
          : a.area === 'Q' || a.area === 'PQ'
            ? 'outputs'
            : undefined;
      if (!dir) continue;
      for (let i = 0; i < BYTES_OF[a.size]; i++) {
        const byte = a.byte + i;
        const info = out[dir].get(byte) ?? { byte, bits: [], names: [] };
        out[dir].set(byte, info);
        if (a.size === 'X') info.bits[a.bit] ??= tag.name;
        else info.names.push(tag.name);
      }
    }
  return out;
}

const parseIntStrict = (text: string): number | undefined =>
  /^\s*-?\d+\s*$/.test(text) ? Number(text) : undefined;

function ByteGroup({ dir }: { dir: Dir }) {
  const { t } = useTranslation();
  const { store } = useServices();
  const sim = useAppStore((s) => s.sim);
  const project = useAppStore((s) => s.doc?.project ?? null);
  const [text, setText] = useState('');
  const [bad, setBad] = useState(false);
  const ctrl = simControllerFor(store);
  const values = sim[dir];
  const dev = project && sim.deviceId ? findDevice(project, sim.deviceId) : undefined;
  const used = usedBytes(dev)[dir];
  for (const byte of sim.ioExtra[dir])
    if (!used.has(byte)) used.set(byte, { byte, bits: [], names: [] });
  const bytes = [...used.values()]
    .filter((b) => b.byte < values.length)
    .sort((a, b) => a.byte - b.byte);
  const area = dir === 'inputs' ? 'I' : 'Q';

  const add = () => {
    const n = parseIntStrict(text);
    if (n === undefined || n < 0 || n >= values.length) {
      setBad(true);
      return;
    }
    setBad(false);
    setText('');
    if (!sim.ioExtra[dir].includes(n))
      store.getState().setSim({ ioExtra: { ...sim.ioExtra, [dir]: [...sim.ioExtra[dir], n] } });
  };

  return (
    <div data-testid={`io-${dir}`}>
      <h4>{t(`ioPanel.${dir}`)}</h4>
      {bytes.length === 0 ? (
        <p className="baa-placeholder">{t('ioPanel.noBytes')}</p>
      ) : (
        <div className="baa-io-bytes">
          {bytes.map((b) => (
            <div key={b.byte} className="baa-io-byte" title={b.names.join(', ') || undefined}>
              <span>{t('ioPanel.byteLabel', { byte: b.byte })}</span>
              <div className="baa-io-bits">
                {[7, 6, 5, 4, 3, 2, 1, 0].map((bit) => {
                  const on = ((values[b.byte] ?? 0) >> bit) & 1;
                  const sym = b.bits[bit];
                  const label = sym
                    ? t('ioPanel.bitSym', { area, byte: b.byte, bit, symbol: sym })
                    : t('ioPanel.bitLabel', { area, byte: b.byte, bit });
                  const common = {
                    className: 'baa-io-bit',
                    'data-on': on === 1,
                    'data-testid': `${dir === 'inputs' ? 'in' : 'out'}-bit-${b.byte}-${bit}`,
                    title: label,
                  };
                  return dir === 'inputs' ? (
                    <button
                      key={bit}
                      type="button"
                      {...common}
                      aria-pressed={on === 1}
                      aria-label={label}
                      onClick={() =>
                        void ctrl.setInputs(
                          b.byte,
                          Uint8Array.of((values[b.byte] ?? 0) ^ (1 << bit)),
                        )
                      }
                    >
                      {t(on ? 'ioPanel.on' : 'ioPanel.off')}
                    </button>
                  ) : (
                    <span key={bit} {...common} role="img" aria-label={`${label}: ${on}`}>
                      {t(on ? 'ioPanel.on' : 'ioPanel.off')}
                    </span>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
      <div className="baa-io-add">
        <input
          type="text"
          inputMode="numeric"
          size={5}
          value={text}
          aria-label={t('ioPanel.byteInput')}
          data-testid={`io-add-${dir}`}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && add()}
        />
        <button type="button" onClick={add} data-testid={`io-add-${dir}-btn`}>
          {t('ioPanel.addByte')}
        </button>
      </div>
      {bad ? <p role="alert">{t('ioPanel.byteInvalid')}</p> : null}
    </div>
  );
}

/** Parola di periferia in ingresso (PIW), in decimale come INT, scritta big-endian. */
function AnalogInput() {
  const { t } = useTranslation();
  const { store } = useServices();
  const size = useAppStore((s) => s.sim.inputs.length);
  const [addr, setAddr] = useState('PIW 0');
  const [value, setValue] = useState('0');
  const [error, setError] = useState<string | null>(null);

  const write = () => {
    // Un numero solo vale come indirizzo di byte della parola.
    const p = parseAddress(/^\s*\d+\s*$/.test(addr) ? `PIW ${addr.trim()}` : addr);
    if (
      !p.ok ||
      !('size' in p.address) ||
      p.address.size !== 'W' ||
      !['PI', 'I'].includes(p.address.area)
    )
      return setError('piwBadAddress');
    const n = parseIntStrict(value);
    if (n === undefined || n < -32768 || n > 32767) return setError('piwBadValue');
    const byte = p.address.byte;
    if (byte + 2 > size) return setError('piwOutOfArea');
    setError(null);
    const w = n & 0xffff;
    void simControllerFor(store).setInputs(byte, Uint8Array.of(w >> 8, w & 0xff));
  };

  return (
    <div data-testid="io-analog">
      <h4>{t('ioPanel.analog')}</h4>
      <div className="baa-io-add">
        <label>
          {t('ioPanel.piwAddress')}{' '}
          <input
            type="text"
            size={8}
            value={addr}
            data-testid="piw-address"
            onChange={(e) => setAddr(e.target.value)}
          />
        </label>
        <label>
          {t('ioPanel.piwValue')}{' '}
          <input
            type="text"
            inputMode="numeric"
            size={7}
            value={value}
            data-testid="piw-value"
            onChange={(e) => setValue(e.target.value)}
          />
        </label>
        <button type="button" onClick={write} data-testid="piw-write">
          {t('ioPanel.piwWrite')}
        </button>
      </div>
      {error ? <p role="alert">{t(`ioPanel.${error}`)}</p> : null}
    </div>
  );
}

/** «Simula guasto»: OB82 e OB86 per il modulo all'indirizzo logico dato (hanno effetto solo in RUN). */
function FaultSimulation() {
  const { t } = useTranslation();
  const { store } = useServices();
  const run = useAppStore((s) => s.sim.mode === 'RUN');
  const [text, setText] = useState('0');
  const [bad, setBad] = useState(false);

  const fire = (ob: 82 | 86) => {
    const n = parseIntStrict(text);
    if (n === undefined || n < 0 || n > 0xffff) return setBad(true);
    setBad(false);
    void simControllerFor(store).interrupt(ob, n);
  };

  return (
    <div data-testid="io-fault">
      <h4>{t('ioPanel.fault')}</h4>
      <div className="baa-io-fault">
        <label>
          {t('ioPanel.moduleAddress')}{' '}
          <input
            type="text"
            inputMode="numeric"
            size={7}
            value={text}
            data-testid="fault-address"
            onChange={(e) => setText(e.target.value)}
          />
        </label>
        {([82, 86] as const).map((ob) => (
          <button
            key={ob}
            type="button"
            disabled={!run}
            title={run ? undefined : t('ioPanel.needRun')}
            data-testid={`fault-ob${ob}`}
            onClick={() => fire(ob)}
          >
            {t(`ioPanel.ob${ob}`)}
          </button>
        ))}
      </div>
      {bad ? <p role="alert">{t('ioPanel.addressBad')}</p> : null}
    </div>
  );
}

const SIZE_LETTER = { X: '', B: 'B', W: 'W', D: 'D' } as const;

/** Testo dell'operando forzato: `I 0.1`, `MW 10`. */
export function forceLabel(f: WriteItemReq): string {
  return f.size === 'X'
    ? `${f.area} ${f.byte}.${f.bit ?? 0}`
    : `${f.area}${SIZE_LETTER[f.size]} ${f.byte}`;
}

/** Voce di forzamento da operando (I, Q, M) e valore (0/1, TRUE/FALSE, intero o 16#…); errore come chiave. */
export function parseForce(addr: string, value: string): WriteItemReq | string {
  const p = parseAddress(addr);
  if (!p.ok || !('size' in p.address) || !['I', 'Q', 'M'].includes(p.address.area))
    return 'forceBadAddress';
  const a = p.address;
  const v = value.trim().toUpperCase();
  const len = BYTES_OF[a.size];
  let n: number | undefined;
  if (a.size === 'X')
    n = v === '1' || v === 'TRUE' ? 1 : v === '0' || v === 'FALSE' ? 0 : undefined;
  else if (/^16#[0-9A-F]+$/.test(v)) n = parseInt(v.slice(3), 16);
  else n = parseIntStrict(v);
  const max = 2 ** (8 * len);
  if (n === undefined || n >= max || n < -max / 2) return 'forceBadValue';
  const u = n < 0 ? n + max : n;
  const data = new Uint8Array(len);
  for (let i = 0; i < len; i++) data[i] = Math.floor(u / 2 ** (8 * (len - 1 - i))) & 255;
  return {
    area: a.area as 'I' | 'Q' | 'M',
    byte: a.byte,
    ...(a.size === 'X' ? { bit: a.bit } : {}),
    size: a.size,
    data,
  };
}

const forceValue = (f: WriteItemReq): string =>
  f.size === 'X'
    ? String(f.data[0] ? 1 : 0)
    : `16#${[...f.data]
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('')
        .toUpperCase()}`;

/**
 * Forzamento sul simulatore: la tabella vale finché non la si termina, anche in STOP. Gli ingressi
 * e i merker forzati si scrivono all'inizio del ciclo, le uscite prima di passare ai moduli.
 */
function ForceTable() {
  const { t } = useTranslation();
  const { store } = useServices();
  const forces = useAppStore((s) => s.sim.forces);
  const [addr, setAddr] = useState('');
  const [value, setValue] = useState('1');
  const [error, setError] = useState<string | null>(null);
  const ctrl = simControllerFor(store);

  const add = () => {
    const f = parseForce(addr, value);
    if (typeof f === 'string') return setError(f);
    setError(null);
    const label = forceLabel(f);
    void ctrl.setForce([...forces.filter((x) => forceLabel(x) !== label), f]);
  };

  return (
    <div data-testid="io-force">
      <h4>{t('ioPanel.force')}</h4>
      <div className="baa-io-add">
        <label>
          {t('ioPanel.forceAddress')}{' '}
          <input
            type="text"
            size={8}
            value={addr}
            data-testid="force-address"
            onChange={(e) => setAddr(e.target.value)}
          />
        </label>
        <label>
          {t('ioPanel.forceValue')}{' '}
          <input
            type="text"
            size={10}
            value={value}
            data-testid="force-value"
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && add()}
          />
        </label>
        <button type="button" onClick={add} data-testid="force-add">
          {t('ioPanel.forceAdd')}
        </button>
      </div>
      {error ? <p role="alert">{t(`ioPanel.${error}`)}</p> : null}
      {forces.length > 0 ? (
        <>
          <ul className="baa-io-forces">
            {forces.map((f) => {
              const label = forceLabel(f);
              return (
                <li key={label} data-testid={`force-row-${label}`}>
                  {label} = {forceValue(f)}{' '}
                  <button
                    type="button"
                    aria-label={t('ioPanel.forceRemove', { operand: label })}
                    onClick={() =>
                      void ctrl.setForce(forces.filter((x) => forceLabel(x) !== label))
                    }
                  >
                    ×
                  </button>
                </li>
              );
            })}
          </ul>
          <button type="button" data-testid="force-clear" onClick={() => void ctrl.setForce([])}>
            {t('ioPanel.forceClear')}
          </button>
        </>
      ) : null}
    </div>
  );
}

export function IoPanel() {
  const { t } = useTranslation();
  const phase = useAppStore((s) => s.sim.phase);
  if (phase !== 'on') return <p className="baa-placeholder">{t('cpuPanel.needSim')}</p>;
  return (
    <div className="baa-io-panel">
      <ByteGroup dir="inputs" />
      <AnalogInput />
      <ByteGroup dir="outputs" />
      <ForceTable />
      <FaultSimulation />
    </div>
  );
}
