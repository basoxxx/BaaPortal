import { useTranslation } from 'react-i18next';
import { findCpu } from '@baaportal/catalog';
import { findBlock, findDevice, nextFreeNumber, type Block } from '@baaportal/project';
import { useAppStore } from '../../../state/AppContext';
import { useDeviceDiagnostics } from '../../../state/diagnostics';
import { ids } from '../../navigation/treeIds';
import { NameField } from './NameField';
import { PropertySection } from './PropertySection';
import { AutoNumberField, CheckField, TextAreaField, TextField } from './fields';
import { useDeviceEdit, useDiagText } from './useDeviceEdit';

const FALLBACK_MAX = 65535;
type Header = Block['header'];
type HeaderText = Exclude<keyof Header, 'comment' | 'title'>;

export function BlockProperties({ deviceId, blockId }: { deviceId: string; blockId: string }) {
  const { t } = useTranslation();
  const dev = useAppStore((s) => (s.doc ? findDevice(s.doc.project, deviceId) : undefined));
  const diag = useDiagText(useDeviceDiagnostics(deviceId));
  const edit = useDeviceEdit(deviceId);
  const block = dev ? findBlock(dev, blockId) : undefined;
  if (!dev || !block) return <p className="baa-placeholder">{t('inspector.noProperties')}</p>;

  const limits = findCpu(dev.cpu.typeId)?.limits;
  const max =
    block.kind === 'FB'
      ? (limits?.maxFb ?? FALLBACK_MAX)
      : block.kind === 'FC'
        ? (limits?.maxFc ?? FALLBACK_MAX)
        : (limits?.maxDb ?? FALLBACK_MAX);
  // DB e DB di istanza condividono la numerazione.
  const shared: string[] =
    block.kind === 'DB' || block.kind === 'IDB' ? ['DB', 'IDB'] : [block.kind];
  const numberError = (n: number): string | null => {
    if (n < 1 || n > max) return t('addBlock.numberRange', { max });
    return dev.blocks.some((b) => b.id !== block.id && shared.includes(b.kind) && b.number === n)
      ? t('addBlock.numberTaken')
      : null;
  };
  const setBlock = (recipe: (b: Block) => void) =>
    edit((d) => {
      const b = findBlock(d, blockId);
      if (b) recipe(b);
    });
  const free =
    block.kind === 'OB' ? null : nextFreeNumber(dev, block.kind === 'IDB' ? 'DB' : block.kind, max);
  const bad = (property: string) =>
    diag(
      (d) =>
        d.code === 'HEADER_INVALID' &&
        d.property === property &&
        d.ref.kind === 'block' &&
        d.ref.id === blockId,
    );
  const text = (label: string, key: HeaderText) => (
    <TextField
      label={label}
      value={block.header[key]}
      diag={bad(key)}
      onCommit={(v) => setBlock((b) => void (b.header[key] = v))}
    />
  );
  const attr = (label: string, key: 'unlinked' | 'readOnly' | 'nonRetain', hint?: string) =>
    block.kind === 'DB' || block.kind === 'IDB' ? (
      <CheckField
        label={label}
        checked={block.attributes[key]}
        {...(hint ? { hint } : {})}
        onChange={(v) =>
          setBlock((b) => {
            if (b.kind === 'DB' || b.kind === 'IDB') b.attributes[key] = v;
          })
        }
      />
    ) : null;

  // un blocco importato e protetto non può perdere la protezione: la casella resta bloccata
  const knowHowFixed =
    block.mc7?.knowHowLocked === true || (block.mc7 !== undefined && block.knowHowProtected);

  return (
    <div className="baa-prop-panel">
      <PropertySection title={t('props.section.general')}>
        <NameField nodeId={ids.block(deviceId, blockId)} fallback={block.name} />
        <TextField label={t('details.type')} value={t(`details.blockKind.${block.kind}`)} />
        {block.kind === 'OB' ? (
          <TextField label={t('addBlock.number')} value={String(block.number)} />
        ) : (
          <AutoNumberField
            label={t('addBlock.number')}
            value={block.number}
            validate={numberError}
            free={free}
            onCommit={(n) => setBlock((b) => void (b.number = n))}
          />
        )}
        {block.kind === 'IDB' ? (
          <TextField label={t('addBlock.instanceDb')} value={block.instanceOf} />
        ) : block.kind !== 'DB' ? (
          <TextField label={t('addBlock.language')} value={block.language} />
        ) : null}
      </PropertySection>
      <PropertySection title={t('props.section.info')}>
        <TextField
          label={t('props.title')}
          value={block.header.title}
          onCommit={(v) => setBlock((b) => void (b.header.title = v))}
        />
        <TextAreaField
          label={t('inspector.comment')}
          value={block.header.comment}
          onCommit={(v) => setBlock((b) => void (b.header.comment = v))}
        />
        {text(t('props.version'), 'version')}
        {text(t('inspector.author'), 'author')}
        {text(t('props.family'), 'family')}
        {text(t('props.headerName'), 'headerName')}
      </PropertySection>
      <PropertySection title={t('props.section.attributes')}>
        <CheckField
          label={t('props.knowHow')}
          checked={block.knowHowProtected}
          hint={knowHowFixed ? t('props.knowHowLockedHint') : t('props.knowHowHint')}
          disabled={knowHowFixed}
          onChange={(v) => setBlock((b) => void (b.knowHowProtected = v))}
        />
        {attr(t('props.unlinked'), 'unlinked')}
        {attr(t('props.readOnly'), 'readOnly', t('props.readOnlyHint'))}
        {attr(t('props.nonRetain'), 'nonRetain')}
      </PropertySection>
    </div>
  );
}
