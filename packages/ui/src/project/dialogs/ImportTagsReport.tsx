import { useTranslation } from 'react-i18next';
import { Dialog } from '../../components/Dialog';
import type { ImportSummary } from '../navigation/tagTableIo';

interface Props {
  fileName: string;
  tableName: string;
  summary: ImportSummary;
  onClose(): void;
}

/** Riepilogo dell'importazione: creati, aggiornati e righe scartate con il motivo. */
export function ImportTagsReport({ fileName, tableName, summary, onClose }: Props) {
  const { t } = useTranslation();
  return (
    <Dialog
      title={t('tagIo.reportTitle')}
      onClose={onClose}
      onOk={onClose}
      testId="import-tags-report"
      footer={
        <button type="button" data-testid="dialog-ok" onClick={onClose}>
          {t('dialog.ok')}
        </button>
      }
    >
      <p>{t('tagIo.reportFile', { file: fileName, table: tableName })}</p>
      <ul>
        <li>{t('tagIo.created', { count: summary.created })}</li>
        <li>{t('tagIo.updated', { count: summary.updated })}</li>
        <li>{t('tagIo.skipped', { count: summary.skipped.length })}</li>
      </ul>
      {summary.skipped.length > 0 ? (
        <ul aria-label={t('tagIo.skippedList')}>
          {summary.skipped.map((e, i) => (
            <li key={i}>
              {t('tagIo.skippedRow', {
                line: e.line,
                sheet: e.sheet ? ` ${t(`tagIo.sheet.${e.sheet}`)}` : '',
                reason: t(`tagIo.err.${e.code}`, { detail: e.detail ?? '' }),
              })}
            </li>
          ))}
        </ul>
      ) : null}
    </Dialog>
  );
}
