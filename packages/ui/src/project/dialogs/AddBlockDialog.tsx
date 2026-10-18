import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { findCpu, findOb } from '@baaportal/catalog';
import {
  createCodeBlock,
  createGlobalDb,
  createInstanceDb,
  findDevice,
  nextFreeNumber,
  symbolNames,
  uniqueName,
  type Block,
  type Language,
  type ObjectRef,
  type PlcDevice,
} from '@baaportal/project';
import { sameName } from '@baaportal/s7-types';
import { Dialog } from '../../components/Dialog';
import { useAppStore, useServices } from '../../state/AppContext';
import { ids as nodeIds } from '../navigation/treeIds';

type Kind = 'OB' | 'FB' | 'FC' | 'DB';
const KINDS: Kind[] = ['OB', 'FB', 'FC', 'DB'];
const LANGUAGES: { id: Language; enabled: boolean }[] = [
  { id: 'AWL', enabled: true },
  { id: 'KOP', enabled: false },
  { id: 'FUP', enabled: false },
  { id: 'SCL', enabled: false },
];
/** Senza il tipo di CPU nel catalogo si ripiega sul massimo del formato. */
const FALLBACK_MAX = 65535;

interface Props {
  deviceId: string;
  onClose(): void;
  /** Punto di aggancio per l'editor (Task 10): `open` è la casella "Aggiungi e apri". */
  onAdded?(ref: ObjectRef, open: boolean): void;
}

export function AddBlockDialog({ deviceId, onClose, onAdded }: Props) {
  const device = useAppStore((s) => s.doc?.project.devices.find((d) => d.id === deviceId));
  if (!device) return null;
  return <BlockForm device={device} onClose={onClose} {...(onAdded ? { onAdded } : {})} />;
}

function BlockForm({
  device,
  onClose,
  onAdded,
}: {
  device: PlcDevice;
  onClose(): void;
  onAdded?: Props['onAdded'];
}) {
  const { t } = useTranslation();
  const { store } = useServices();
  const fid = { name: useId(), lang: useId(), num: useId(), event: useId(), fb: useId() };
  const cpu = findCpu(device.cpu.typeId);

  const [kind, setKind] = useState<Kind>('FB');
  const [dbType, setDbType] = useState<'global' | 'instance'>('global');
  const [nameEdit, setNameEdit] = useState<string | null>(null);
  const [auto, setAuto] = useState(true);
  const [manual, setManual] = useState('');
  const [event, setEvent] = useState<number | null>(null);
  const [fbName, setFbName] = useState<string | null>(null);
  const [openAfter, setOpenAfter] = useState(true);

  // OB ammessi dalla CPU e non ancora presenti.
  const usedObs = new Set(device.blocks.filter((b) => b.kind === 'OB').map((b) => b.number));
  const events = (cpu?.obs ?? []).filter((n) => !usedObs.has(n) && findOb(n));
  const obNumber = event !== null && events.includes(event) ? event : (events[0] ?? null);
  const fbs = device.blocks.filter((b) => b.kind === 'FB');
  const instanceFb = fbs.find((b) => b.name === fbName) ?? fbs[0];
  const isInstance = kind === 'DB' && dbType === 'instance';

  const defaultName =
    kind === 'OB'
      ? (findOb(obNumber ?? 0)?.defaultName ?? '')
      : isInstance
        ? `${instanceFb?.name ?? ''}_DB`
        : t(kind === 'DB' ? 'defaults.dataBlock' : 'defaults.block');
  const taken = symbolNames(device);
  const baseName = uniqueName(defaultName, taken);
  const name = nameEdit ?? baseName;
  const trimmed = name.trim();

  const limits = cpu?.limits;
  const max =
    kind === 'FB'
      ? (limits?.maxFb ?? FALLBACK_MAX)
      : kind === 'FC'
        ? (limits?.maxFc ?? FALLBACK_MAX)
        : (limits?.maxDb ?? FALLBACK_MAX);

  // Numero e relativo errore.
  const sharedKinds: string[] = kind === 'DB' ? ['DB', 'IDB'] : [kind];
  let number: number | null;
  let numberError: string | null = null;
  if (kind === 'OB') number = obNumber;
  else if (auto) {
    number = nextFreeNumber(device, kind, max);
    if (number === null) numberError = t('addBlock.numberNone');
  } else {
    number = /^\d+$/.test(manual.trim()) ? Number(manual.trim()) : null;
    if (number === null || number < 1 || number > max) {
      numberError = t('addBlock.numberRange', { max });
      number = null;
    } else if (device.blocks.some((b) => sharedKinds.includes(b.kind) && b.number === number)) {
      numberError = t('addBlock.numberTaken');
    }
  }

  const nameError =
    trimmed === ''
      ? t('addBlock.nameEmpty')
      : taken.some((n) => sameName(n, trimmed))
        ? t('addBlock.nameExists')
        : null;
  const missing =
    kind === 'OB' ? events.length === 0 : isInstance ? instanceFb === undefined : false;
  const invalid = nameError !== null || numberError !== null || number === null || missing;

  const submit = () => {
    if (invalid || number === null) return;
    let block: Block;
    if (kind === 'OB' || kind === 'FB' || kind === 'FC') {
      block = createCodeBlock({ kind, number, name: trimmed, language: 'AWL' });
    } else if (isInstance && instanceFb) {
      block = createInstanceDb({ number, name: trimmed, instanceOf: instanceFb.name });
    } else {
      block = createGlobalDb({ number, name: trimmed });
    }
    store.getState().edit('history.addBlock', (p) => {
      findDevice(p, device.id)?.blocks.push(block);
    });
    store.getState().select(nodeIds.block(device.id, block.id));
    onClose();
    onAdded?.({ kind: 'block', deviceId: device.id, id: block.id }, openAfter);
  };

  return (
    <Dialog
      title={t('addBlock.title')}
      onClose={onClose}
      onOk={submit}
      okDisabled={invalid}
      testId="dialog-add-block"
    >
      <fieldset className="baa-dialog-side baa-dialog-list">
        <legend>{t('addBlock.type')}</legend>
        {KINDS.map((k) => (
          <label key={k} className="baa-dialog-row">
            <input
              type="radio"
              name="block-kind"
              checked={kind === k}
              onChange={() => {
                setKind(k);
                setNameEdit(null);
              }}
            />
            {t(`addBlock.kind.${k}`)} ({k})
          </label>
        ))}
      </fieldset>
      <div className="baa-dialog-form">
        <div className="baa-dialog-field">
          <label htmlFor={fid.name}>{t('addBlock.name')}</label>
          <input
            id={fid.name}
            type="text"
            value={name}
            aria-invalid={nameError ? true : undefined}
            onChange={(e) => setNameEdit(e.target.value)}
          />
          {nameError ? (
            <span role="alert" className="baa-field-error">
              {nameError}
            </span>
          ) : null}
        </div>
        {kind !== 'DB' ? (
          <div className="baa-dialog-field">
            <label htmlFor={fid.lang}>{t('addBlock.language')}</label>
            <select id={fid.lang} defaultValue="AWL">
              {LANGUAGES.map((l) => (
                <option key={l.id} value={l.id} disabled={!l.enabled}>
                  {l.id}
                </option>
              ))}
            </select>
          </div>
        ) : null}
        {kind === 'OB' ? (
          <div className="baa-dialog-field">
            <label htmlFor={fid.event}>{t('addBlock.event')}</label>
            <select
              id={fid.event}
              value={obNumber ?? ''}
              onChange={(e) => {
                setEvent(Number(e.target.value));
                setNameEdit(null);
              }}
            >
              {events.map((n) => (
                <option key={n} value={n}>
                  {t(findOb(n)!.eventKey)} (OB{n})
                </option>
              ))}
            </select>
            {events.length === 0 ? (
              <span role="alert" className="baa-field-error">
                {t('addBlock.noEvent')}
              </span>
            ) : null}
          </div>
        ) : null}
        {kind === 'DB' ? (
          <fieldset className="baa-dialog-field">
            <legend>{t('addBlock.dbKind')}</legend>
            <label className="baa-dialog-row">
              <input
                type="radio"
                name="db-type"
                checked={dbType === 'global'}
                onChange={() => {
                  setDbType('global');
                  setNameEdit(null);
                }}
              />
              {t('addBlock.globalDb')}
            </label>
            <label className="baa-dialog-row">
              <input
                type="radio"
                name="db-type"
                checked={dbType === 'instance'}
                onChange={() => {
                  setDbType('instance');
                  setNameEdit(null);
                }}
              />
              {t('addBlock.instanceDb')}
            </label>
            {isInstance ? (
              <>
                <label htmlFor={fid.fb}>{t('addBlock.instanceOf')}</label>
                <select
                  id={fid.fb}
                  value={instanceFb?.name ?? ''}
                  onChange={(e) => {
                    setFbName(e.target.value);
                    setNameEdit(null);
                  }}
                >
                  {fbs.map((b) => (
                    <option key={b.id} value={b.name}>
                      {b.name} (FB{b.number})
                    </option>
                  ))}
                </select>
                {fbs.length === 0 ? (
                  <span role="alert" className="baa-field-error">
                    {t('addBlock.noFb')}
                  </span>
                ) : null}
              </>
            ) : null}
          </fieldset>
        ) : null}
        <div className="baa-dialog-field">
          <label htmlFor={fid.num}>{t('addBlock.number')}</label>
          <div className="baa-dialog-row">
            <input
              id={fid.num}
              type="number"
              min={1}
              max={max}
              value={kind === 'OB' || auto ? (number ?? '') : manual}
              disabled={kind === 'OB' || auto}
              aria-invalid={numberError ? true : undefined}
              onChange={(e) => setManual(e.target.value)}
            />
            {kind !== 'OB' ? (
              <label className="baa-dialog-row">
                <input
                  type="checkbox"
                  checked={auto}
                  onChange={(e) => {
                    setAuto(e.target.checked);
                    // Passando a manuale si parte dal numero proposto.
                    if (!e.target.checked) setManual(number === null ? '' : String(number));
                  }}
                />
                {t('addBlock.auto')}
              </label>
            ) : null}
          </div>
          {numberError ? (
            <span role="alert" className="baa-field-error">
              {numberError}
            </span>
          ) : null}
        </div>
        <label className="baa-dialog-row">
          <input
            type="checkbox"
            checked={openAfter}
            onChange={(e) => setOpenAfter(e.target.checked)}
          />
          {t('addBlock.openAfter')}
        </label>
      </div>
    </Dialog>
  );
}
