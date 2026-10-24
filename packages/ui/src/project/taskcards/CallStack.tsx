import { useTranslation } from 'react-i18next';
import { findDevice } from '@baaportal/project';
import { useAppStore, useServices } from '../../state/AppContext';
import { isDiagError } from './CpuPanel';

export function CallStack() {
  const { t } = useTranslation();
  const { store } = useServices();
  const sim = useAppStore((s) => s.sim);
  const project = useAppStore((s) => s.doc?.project ?? null);
  if (sim.phase !== 'on') return <p className="baa-placeholder">{t('cpuPanel.needSim')}</p>;

  // L'ultima voce di STOP per errore che porta uno stack (le voci più recenti sono in fondo).
  const entry = [...sim.diagnostics].reverse().find((d) => isDiagError(d) && d.stack?.length);
  if (!entry?.stack) return <p className="baa-placeholder">{t('cpuPanel.callStackEmpty')}</p>;

  const dev = project && sim.deviceId ? findDevice(project, sim.deviceId) : undefined;
  return (
    <div>
      <p>{t('cpuPanel.callStackNote')}</p>
      <ol data-testid="call-stack">
        {entry.stack.map((f, i) => {
          const block = dev?.blocks.find((b) => b.kind === f.kind && b.number === f.number);
          const label = `${f.kind}${f.number}, ${t('cpuPanel.offset', { offset: f.offset })}`;
          return (
            <li key={i}>
              {block && sim.deviceId ? (
                <button
                  type="button"
                  onClick={() =>
                    store
                      .getState()
                      .openEditor({ kind: 'block', deviceId: sim.deviceId!, objectId: block.id })
                  }
                >
                  {label}
                </button>
              ) : (
                <span>{label}</span>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
