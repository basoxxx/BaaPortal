// Un FB trascinato in KOP/FUP senza DB di istanza: come TIA, si propone di crearne uno (nome e
// numero suggeriti). OK crea il DB e restituisce il nome; Annulla non inserisce nulla.
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { findCpu } from '@baaportal/catalog';
import { nextFreeNumber, symbolNames, uniqueName, type PlcDevice } from '@baaportal/project';
import { sameName, validateS7Name } from '@baaportal/s7-types';
import { Dialog } from '../../components/Dialog';

/** Senza il tipo di CPU nel catalogo si ripiega sul massimo del formato (come AddBlockDialog). */
const FALLBACK_MAX = 65535;

type Props = {
  device: PlcDevice;
  fb: string;
  onOk: (name: string, number: number) => void;
  onCancel: () => void;
};

export function InstanceDbDialog({ device, fb, onOk, onCancel }: Props) {
  const { t } = useTranslation();
  const fid = { name: useId(), num: useId() };
  const taken = symbolNames(device);
  const max = findCpu(device.cpu.typeId)?.limits?.maxDb ?? FALLBACK_MAX;
  const [name, setName] = useState(() => uniqueName(`${fb}_DB`, taken));
  const [num, setNum] = useState(() => String(nextFreeNumber(device, 'DB', max) ?? ''));
  const trimmed = name.trim();
  const nameError =
    trimmed === ''
      ? t('addBlock.nameEmpty')
      : !validateS7Name(trimmed).ok
        ? t('objects.errInvalid')
        : taken.some((n) => sameName(n, trimmed))
          ? t('addBlock.nameExists')
          : null;
  const number = /^\d+$/.test(num.trim()) ? Number(num.trim()) : null;
  const numberError =
    number === null || number < 1 || number > max
      ? t('addBlock.numberRange', { max })
      : device.blocks.some((b) => (b.kind === 'DB' || b.kind === 'IDB') && b.number === number)
        ? t('addBlock.numberTaken')
        : null;
  const invalid = nameError !== null || numberError !== null;
  return (
    <Dialog
      title={t('lad.instanceDb.title')}
      onClose={onCancel}
      onOk={() => {
        if (!invalid && number !== null) onOk(trimmed, number);
      }}
      okDisabled={invalid}
      testId="dialog-instance-db"
    >
      <div className="baa-dialog-form">
        <p>{t('lad.instanceDb.text', { fb })}</p>
        <div className="baa-dialog-field">
          <label htmlFor={fid.name}>{t('addBlock.name')}</label>
          <input
            id={fid.name}
            type="text"
            value={name}
            aria-invalid={nameError ? true : undefined}
            onChange={(e) => setName(e.target.value)}
          />
          {nameError ? (
            <span role="alert" className="baa-field-error">
              {nameError}
            </span>
          ) : null}
        </div>
        <div className="baa-dialog-field">
          <label htmlFor={fid.num}>{t('addBlock.number')}</label>
          <input
            id={fid.num}
            type="number"
            min={1}
            max={max}
            value={num}
            aria-invalid={numberError ? true : undefined}
            onChange={(e) => setNum(e.target.value)}
          />
          {numberError ? (
            <span role="alert" className="baa-field-error">
              {numberError}
            </span>
          ) : null}
        </div>
      </div>
    </Dialog>
  );
}
