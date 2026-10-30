import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import {
  addHmiScreen,
  checkDevice,
  createHmiObject,
  createHmiScreen,
  deleteHmiScreen,
  hmiTagProblem,
  readBaap,
  renameWithReferences,
  watchResolverFor,
  writeBaap,
  type Project,
} from '../src/index';
import { cpu315pn, makeProject, seq } from './fixtures';

function withScreens(): Project {
  const p = makeProject();
  const dev = p.devices[0]!;
  const id = seq('h');
  const main = createHmiScreen('Principale', id);
  const other = createHmiScreen('Dettagli', id);
  const btn = createHmiObject('button', 10, 20, id);
  btn.tag = '"Start"';
  btn.action = 'jog';
  const lamp = createHmiObject('lamp', 120, 20, id);
  lamp.tag = 'Q 4.0';
  const io = createHmiObject('ioField', 10, 80, id);
  io.tag = 'DB1.DBW 0';
  io.input = true;
  const nav = createHmiObject('screenButton', 10, 140, id);
  nav.screen = other.id;
  main.objects.push(btn, lamp, io, nav, createHmiObject('text', 0, 0, id));
  addHmiScreen(dev, main);
  addHmiScreen(dev, other);
  return p;
}

const save = (p: Project) => writeBaap(p, { appVersion: '1.9.0' });

/** Riscrive device.json del primo PLC con `patch`. */
function patchDevice(bytes: Uint8Array, patch: (d: Record<string, unknown>) => void): Uint8Array {
  const files = unzipSync(bytes);
  const path = Object.keys(files).find((k) => k.endsWith('/device.json'))!;
  const d = JSON.parse(strFromU8(files[path]!)) as Record<string, unknown>;
  patch(d);
  files[path] = strToU8(JSON.stringify(d));
  return zipSync(files);
}

describe('schermate HMI nel modello', () => {
  it('andata e ritorno nel .baap', () => {
    const p = withScreens();
    expect(readBaap(save(p))).toEqual(p);
  });

  it('un progetto senza HMI resta senza la chiave', () => {
    const p = makeProject();
    const back = readBaap(save(p));
    expect('hmi' in back.devices[0]!).toBe(false);
  });

  it('forma non valida → INVALID_SCHEMA (colore, tipo, dimensioni, id doppi)', () => {
    const bad: ((d: Record<string, unknown>) => void)[] = [
      (d) => ((d.hmi as { screens: { background: string }[] }).screens[0]!.background = 'red'),
      (d) =>
        ((d.hmi as { screens: { objects: { kind: string }[] }[] }).screens[0]!.objects[0]!.kind =
          'alarm'),
      (d) => ((d.hmi as { screens: { width: number }[] }).screens[0]!.width = 0),
      (d) =>
        ((d.hmi as { screens: { objects: { id: string }[] }[] }).screens[0]!.objects[1]!.id = 'h1'),
      (d) => (d.hmi = { screens: 'x' }),
    ];
    for (const b of bad) {
      expect(() => readBaap(patchDevice(save(withScreens()), b))).toThrow(
        expect.objectContaining({ code: 'INVALID_SCHEMA' }),
      );
    }
  });

  it('eliminare una schermata toglie la destinazione dei pulsanti che la aprivano', () => {
    const p = withScreens();
    const dev = p.devices[0]!;
    const other = dev.hmi!.screens[1]!;
    deleteHmiScreen(dev, other.id);
    expect(dev.hmi!.screens).toHaveLength(1);
    expect(dev.hmi!.screens[0]!.objects.find((o) => o.kind === 'screenButton')!.screen).toBe(
      undefined,
    );
  });

  it('rinominare una variabile aggiorna le variabili degli oggetti', () => {
    const p = withScreens();
    const dev = p.devices[0]!;
    const start = dev.tagTables[0]!.tags[0]!;
    renameWithReferences(
      dev,
      { kind: 'tag', deviceId: dev.id, tableId: dev.tagTables[0]!.id, id: start.id },
      'Avvio',
    );
    expect(dev.hmi!.screens[0]!.objects[0]!.tag).toBe('"Avvio"');
  });

  it('hmiTagProblem: bit per lampade e pulsanti, formato per il campo, aree scrivibili', () => {
    const dev = withScreens().devices[0]!;
    const r = watchResolverFor(dev, cpu315pn);
    const ok = (t: string) => {
      const x = r(t);
      if (!x.ok) throw new Error(t);
      return x;
    };
    expect(hmiTagProblem({ kind: 'lamp' }, ok('MW 0'))).toBe('BIT_REQUIRED');
    expect(hmiTagProblem({ kind: 'lamp' }, ok('M 0.0'))).toBe(null);
    expect(hmiTagProblem({ kind: 'button', action: 'set' }, ok('MW 0'))).toBe('BIT_REQUIRED');
    expect(hmiTagProblem({ kind: 'button', action: 'write' }, ok('MW 0'))).toBe(null);
    expect(hmiTagProblem({ kind: 'button', action: 'set' }, ok('T 1'))).toBe('NOT_WRITABLE');
    expect(hmiTagProblem({ kind: 'ioField', format: 'REAL' }, ok('MW 0'))).toBe('FORMAT_SIZE');
    expect(hmiTagProblem({ kind: 'ioField', format: 'DINT' }, ok('MD 0'))).toBe(null);
    expect(hmiTagProblem({ kind: 'ioField', format: 'INT', input: true }, ok('PIW 0'))).toBe(
      'NOT_WRITABLE',
    );
    expect(hmiTagProblem({ kind: 'bar' }, ok('M 0.0'))).toBe('NUMBER_REQUIRED');
  });

  it('controlli: variabile sconosciuta, vuota o non adatta → avviso sulla schermata', () => {
    const p = withScreens();
    const dev = p.devices[0]!;
    const objs = dev.hmi!.screens[0]!.objects;
    objs[1]!.tag = 'MW 2'; // lampada su una parola
    objs[2]!.tag = '"Ignoto"';
    const lamp2 = createHmiObject('lamp', 0, 0, () => 'x1');
    objs.push(lamp2); // variabile vuota
    const hmiDiags = checkDevice(dev, cpu315pn).filter((d) => d.code === 'HMI_TAG_INVALID');
    expect(hmiDiags.map((d) => d.params?.reason)).toEqual(['BIT_REQUIRED', 'UNKNOWN', 'EMPTY']);
    expect(hmiDiags[0]!.ref).toEqual({
      kind: 'hmiScreen',
      deviceId: dev.id,
      id: dev.hmi!.screens[0]!.id,
    });
  });
});
