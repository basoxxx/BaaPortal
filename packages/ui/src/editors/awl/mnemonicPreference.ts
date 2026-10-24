import type { Mnemonic } from '@baaportal/awl';
import { getSettings, updateSettings, useSettings } from '../../settings/settings';

const fromSetting = (m: 'de' | 'int'): Mnemonic => (m === 'de' ? 'german' : 'international');

/** La mnemonica mostrata nei segmenti AWL, scelta nelle Impostazioni: una sola per tutte le finestre. */
export function useMnemonic(): [Mnemonic, (m: Mnemonic) => void] {
  const [s] = useSettings();
  return [
    fromSetting(s.editor.mnemonic),
    (m) => updateSettings({ editor: { mnemonic: m === 'german' ? 'de' : 'int' } }),
  ];
}

/** La mnemonica scelta adesso, nella forma che usa la ricerca. */
export function currentMnemonic(): 'de' | 'int' {
  return getSettings().editor.mnemonic;
}
