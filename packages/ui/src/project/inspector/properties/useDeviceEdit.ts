import { useTranslation } from 'react-i18next';
import { findDevice, type Diagnostic, type PlcDevice } from '@baaportal/project';
import { useServices } from '../../../state/AppContext';
import { diagnosticText } from '../../../state/diagnostics';

/** Una modifica delle proprietà = un solo `edit`. */
export function useDeviceEdit(deviceId: string) {
  const { store } = useServices();
  return (recipe: (dev: PlcDevice) => void) =>
    store.getState().edit('history.editProperty', (p) => {
      const dev = findDevice(p, deviceId);
      if (dev) recipe(dev);
    });
}

/** Testo della diagnostica che soddisfa `match`, se c'è. */
export function useDiagText(diagnostics: Diagnostic[]) {
  const { t } = useTranslation();
  return (match: (d: Diagnostic) => boolean): string | null => {
    const d = diagnostics.find(match);
    return d ? diagnosticText(d, t) : null;
  };
}
