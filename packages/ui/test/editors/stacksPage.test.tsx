import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { initI18n } from '../../src/i18n';
import type { DiagPart, PlcDiagData, PlcStacksResult } from '../../src/online/plcTypes';
import { DEFAULT_SETTINGS, saveSettings, updateSettings } from '../../src/settings/settings';
import { PLC, setupOnline } from '../online/downloadHelpers';

const ref = (blockType: string, typeCode: number, number: number, address: number) => ({
  blockType,
  typeCode,
  number,
  address,
});
const OK: Extract<PlcStacksResult, { ok: true }> = {
  ok: true,
  mode: 'STOP',
  bstack: {
    ok: true,
    value: {
      entries: [
        {
          typeCode: 8,
          blockType: 'OB',
          number: 1,
          returnAddress: 0x20,
          db1: { type: 0, number: 0 },
          db2: { type: 0, number: 0 },
          ob: { priority: 1, rawTime: '0102' },
        },
        {
          typeCode: 0x0c,
          blockType: 'FC',
          number: 10,
          returnAddress: 8,
          db1: { type: 0, number: 0 },
          db2: { type: 0, number: 0 },
        },
      ],
    },
  },
  ustack: {
    ok: true,
    value: {
      resume: ref('OB', 8, 1, 0x22),
      db1: { type: 0, number: 0 },
      db2: { type: 0, number: 0 },
      accu1: 0x11111111,
      accu2: 0x22222222,
      accu3: 0,
      accu4: 0,
      ar1: 0x84000000,
      ar2: 0,
      stw: 0x0106,
      interrupted: ref('FC', 0x0c, 10, 0x10),
      obStartInfo: '110101010000000000000000',
    },
  },
  lstack: [
    {
      depth: 0,
      value: {
        ok: true,
        value: {
          block: ref('OB', 8, 1, 0),
          address: 0,
          local: 'aabbccdd',
          priority: 1,
        },
      },
    },
    { depth: 1, value: { ok: false, why: 'LSTACK di 3 byte', hex: '0a0b0c' } },
  ],
};

async function open(mode: 'RUN' | 'STOP', force = false) {
  const r = await setupOnline([], mode);
  r.app.bridge.plcDiagnosticsImpl = (parts: DiagPart[]) => ({
    ok: true,
    data: Object.fromEntries(
      parts.map((p) => [
        p,
        p === 'mode'
          ? { ok: true, value: mode }
          : p === 'force'
            ? { ok: true, value: force }
            : { ok: false, unavailable: true },
      ]),
    ) as Partial<PlcDiagData>,
  });
  act(() => r.app.store.getState().openEditor({ kind: 'onlineDiag', deviceId: PLC, objectId: '' }));
  await screen.findByTestId('diag-view');
  return r.app;
}
const goStacks = async () => {
  fireEvent.click(screen.getByTestId('diag-page-stacks'));
  await screen.findByTestId('diag-stacks');
};

afterEach(async () => {
  saveSettings(DEFAULT_SETTINGS);
  await initI18n('it');
});

describe('pagina Stack di chiamata', () => {
  it('impostazione spenta → invito alle impostazioni, nessuna chiamata', async () => {
    const app = await open('STOP');
    await goStacks();
    expect(screen.getByTestId('stacks-off')).toHaveTextContent(
      'Attivare le funzioni sperimentali in Opzioni → Impostazioni',
    );
    expect(screen.queryByTestId('stacks-read')).toBeNull();
    expect(screen.getByTestId('stacks-note')).toHaveTextContent('mai visto su una CPU reale');
    expect(app.bridge.plcReadStacksCalls).toEqual([]);
  });

  it('in RUN → «disponibile solo in STOP», pulsante disabilitato', async () => {
    const app = await open('RUN');
    act(() => updateSettings({ online: { experimental: true } }));
    await goStacks();
    expect(screen.getByTestId('stacks-run-only')).toHaveTextContent('disponibile solo in STOP');
    expect(screen.getByTestId('stacks-read')).toBeDisabled();
    expect(app.bridge.plcReadStacksCalls).toEqual([]);
  });

  it('in STOP il pulsante legge una volta e mostra BSTACK, USTACK e LSTACK', async () => {
    const app = await open('STOP');
    app.bridge.plcReadStacksImpl = () => OK;
    act(() => updateSettings({ online: { experimental: true } }));
    await goStacks();
    fireEvent.click(screen.getByTestId('stacks-read'));
    const b = await screen.findByTestId('stack-bstack');
    expect(b).toHaveTextContent('OB 1');
    expect(b).toHaveTextContent('FC 10');
    expect(screen.getByTestId('stack-ustack')).toHaveTextContent('0x11111111');
    expect(screen.getByTestId('stack-ustack')).toHaveTextContent('RLO=1');
    expect(screen.getByTestId('stack-lstack')).toHaveTextContent('AA BB CC DD');
    // la seconda voce non si riconosce: testo ed esadecimale
    fireEvent.change(screen.getByTestId('stacks-entry'), { target: { value: '1' } });
    expect(screen.getByTestId('stack-unrecognized')).toHaveTextContent('risposta non riconosciuta');
    expect(screen.getByTestId('stack-unrecognized')).toHaveTextContent('0A 0B 0C');
    expect(app.bridge.plcReadStacksCalls).toEqual([true]);
    await new Promise((r) => setTimeout(r, 1300)); // nessuna interrogazione periodica
    expect(app.bridge.plcReadStacksCalls).toHaveLength(1);
  });

  it('esito non riuscito → il motivo', async () => {
    const app = await open('STOP');
    app.bridge.plcReadStacksImpl = () => ({ ok: false, reason: 'run', error: 'x' });
    act(() => updateSettings({ online: { experimental: true } }));
    await goStacks();
    fireEvent.click(screen.getByTestId('stacks-read'));
    await waitFor(() =>
      expect(screen.getByTestId('stacks-error')).toHaveTextContent('disponibile solo in STOP'),
    );
  });
});

describe('Generale: forzamento', () => {
  it('FRCE acceso → riga e nota su TIA/STEP 7', async () => {
    await open('RUN', true);
    expect(await screen.findByTestId('diag-force')).toHaveTextContent(
      'Forzamento attivo sulla CPU',
    );
    expect(screen.getByTestId('diag-force')).toHaveTextContent('TIA Portal o STEP 7');
  });

  it('FRCE spento → nessuna riga', async () => {
    await open('RUN', false);
    await screen.findByTestId('diag-general');
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByTestId('diag-force')).toBeNull();
  });
});
