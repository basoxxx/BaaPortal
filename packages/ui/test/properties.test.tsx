import { act, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { findCpu } from '@baaportal/catalog';
import {
  applyImport,
  blockToMc7File,
  findDevice,
  planImport,
  type PlcDevice,
} from '@baaportal/project';
import { ids } from '../src/project/navigation/treeIds';
import { dev, fb, fc, globalDb, instanceDb, mem, past, PLC, udt } from './blockFixtures';
import { renderApp, type RenderedApp } from './renderApp';

async function open(setup: (d: PlcDevice) => void, node: (d: PlcDevice) => string) {
  const app = await renderApp({ view: 'project', withProject: true, withPlc: true });
  act(() => {
    app.store.getState().edit('history.addRow', (p) => setup(findDevice(p, PLC)!));
    app.store.getState().select(node(dev(app)));
  });
  return app;
}
const plcApp = (setup: (d: PlcDevice) => void = () => {}) => open(setup, () => ids.plc(PLC));
const field = (label: string) => screen.getByLabelText(label);
/** Il messaggio che segue immediatamente il campo (errore sotto il campo). */
const under = (label: string) => {
  const n = field(label).nextElementSibling;
  return n?.classList.contains('baa-field-error') ? n : null;
};
const nodeOf = (name: string) => (d: PlcDevice) =>
  ids.block(PLC, d.blocks.find((b) => b.name === name)!.id);
const type = async (app: RenderedApp, label: string, text: string) => {
  const el = field(label);
  await app.user.clear(el);
  if (text) await app.user.type(el, text);
  await app.user.tab();
};

describe('proprietà del PLC', () => {
  it('riquadro "non caricate nel PLC" e valori predefiniti', async () => {
    await plcApp();
    const note = screen.getByRole('note');
    expect(note).toHaveTextContent(
      'Queste proprietà servono al simulatore e ai controlli offline. Fino alla tappa 6 non vengono caricate nel PLC.',
    );
    expect(field('Nome')).toHaveValue('PLC_1');
    expect(field('Numero di articolo')).toHaveValue('6ES7 315-2EH14-0AB0');
    expect(field('Numero di articolo')).toHaveAttribute('readonly');
    expect(field('Indirizzo IP')).toHaveValue('192.168.0.1');
    expect(field('Maschera di sottorete')).toHaveValue('255.255.255.0');
    expect(field('Tempo di ciclo massimo (ms)')).toHaveValue('150');
    expect(field('Tempo di ciclo minimo (ms)')).toHaveValue('0');
    expect(field('Carico del ciclo dovuto alla comunicazione (%)')).toHaveValue('20');
    expect(field('Byte di memoria')).toHaveValue('0');
    expect(field('Numero di byte di merker a partire da MB0')).toHaveValue('16');
    expect(field('Periodo OB35 (ms)')).toHaveValue('100');
    // Nessun errore sui valori predefiniti.
    expect(document.querySelectorAll('.baa-field-error')).toHaveLength(0);
  });

  it('IP non valido: errore sotto il campo, valore conservato', async () => {
    const app = await plcApp();
    await type(app, 'Indirizzo IP', '192.168.0.0');
    expect(dev(app).properties.pn?.ipAddress).toBe('192.168.0.0');
    expect(under('Indirizzo IP')).toHaveTextContent('Il valore della proprietà non è valido.');
    await type(app, 'Indirizzo IP', '192.168.0.5');
    expect(under('Indirizzo IP')).toBeNull();
  });

  it('campo numerico: accetta solo interi, il fuori intervallo resta salvato con errore', async () => {
    const app = await plcApp();
    const before = past(app);
    await app.user.clear(field('Tempo di ciclo massimo (ms)'));
    await app.user.type(field('Tempo di ciclo massimo (ms)'), '12.5');
    expect(screen.getByRole('alert')).toHaveTextContent('Inserisci un numero intero.');
    await app.user.tab();
    expect(dev(app).properties.cycle.maxCycleMs).toBe(150);
    expect(past(app)).toBe(before);
    await type(app, 'Tempo di ciclo massimo (ms)', '9000');
    expect(dev(app).properties.cycle.maxCycleMs).toBe(9000);
    expect(past(app)).toBe(before + 1);
    expect(under('Tempo di ciclo massimo (ms)')).toHaveTextContent(
      'Il valore della proprietà non è valido.',
    );
  });

  it('Indirizzo router attivo solo con Utilizza router', async () => {
    const app = await plcApp();
    expect(field('Indirizzo router')).toBeDisabled();
    await app.user.click(field('Utilizza router'));
    expect(dev(app).properties.pn?.useRouter).toBe(true);
    expect(field('Indirizzo router')).toBeEnabled();
    await type(app, 'Indirizzo router', '192.168.0.254');
    expect(dev(app).properties.pn?.routerAddress).toBe('192.168.0.254');
    await app.user.click(field('Utilizza router'));
    expect(field('Indirizzo router')).toBeDisabled();
  });

  it('CPU senza PN: niente sezione PROFINET', async () => {
    await plcApp((d) => {
      d.cpu = { typeId: 'cpu-315-2-dp', orderNumber: '6ES7 315-2AH14-0AB0', firmware: 'V3.3' };
      delete d.properties.pn;
    });
    expect(screen.queryByRole('button', { name: 'Interfaccia PROFINET' })).toBeNull();
    expect(screen.queryByLabelText('Indirizzo IP')).toBeNull();
    expect(screen.getByRole('button', { name: 'Interfaccia MPI' })).toBeInTheDocument();
  });

  it('DP solo per CPU DP; MPI sempre', async () => {
    const app = await plcApp((d) => {
      d.properties.dpAddress = 2;
    });
    expect(screen.getByRole('button', { name: 'Interfaccia DP' })).toBeInTheDocument();
    await type(app, 'Indirizzo DP', '200');
    expect(dev(app).properties.dpAddress).toBe(200);
    expect(under('Indirizzo DP')).toHaveTextContent('Il valore della proprietà non è valido.');
  });

  it("sezioni comprimibili, aperte all'inizio", async () => {
    const app = await plcApp();
    const head = screen.getByRole('button', { name: 'Ciclo' });
    expect(head).toHaveAttribute('aria-expanded', 'true');
    expect(field('Tempo di ciclo massimo (ms)')).toBeVisible();
    await app.user.click(head);
    expect(head).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByLabelText('Tempo di ciclo massimo (ms)')).toBeNull();
    await app.user.click(head);
    expect(field('Tempo di ciclo massimo (ms)')).toBeVisible();
  });

  it('versione firmware: elenco dal numero di articolo, una sola modifica', async () => {
    const app = await plcApp((d) => void (d.cpu.firmware = 'V3.2.1'));
    const sel = field('Versione firmware') as HTMLSelectElement;
    expect([...sel.options].map((o) => o.value)).toEqual(['V3.2.1', 'V3.2']);
    const before = past(app);
    await app.user.selectOptions(sel, 'V3.2');
    expect(dev(app).cpu.firmware).toBe('V3.2');
    expect(past(app)).toBe(before + 1);
  });

  it("Nome e Commento: stesso controllo della rinomina nell'albero", async () => {
    const app = await plcApp();
    await app.user.click(field('Commento'));
    await app.user.type(field('Commento'), 'Linea 3');
    await app.user.tab();
    expect(dev(app).properties.comment).toBe('Linea 3');
    await app.user.clear(field('Nome'));
    await app.user.type(field('Nome'), 'a"b');
    expect(screen.getByRole('alert')).toHaveTextContent('Il nome non è valido.');
    await app.user.clear(field('Nome'));
    await app.user.type(field('Nome'), 'Pompe');
    await app.user.tab();
    expect(dev(app).name).toBe('Pompe');
  });
});

describe('proprietà dei blocchi', () => {
  const two = (d: PlcDevice) => void d.blocks.push(fb('Uno'), fc('Due'));
  const second = nodeOf('Due');
  const blk = (app: RenderedApp, name: string) => dev(app).blocks.find((b) => b.name === name)!;

  it('Numero doppio segnalato; Automatico assegna il primo libero', async () => {
    const app = await open((d) => {
      d.blocks.push(fb('Uno'), fb('Due'));
      d.blocks.find((b) => b.name === 'Due')!.number = 11;
    }, second);
    const before = past(app);
    await app.user.clear(field('Numero'));
    await app.user.type(field('Numero'), '10');
    expect(screen.getByRole('alert')).toHaveTextContent('Questo numero è già in uso.');
    await app.user.tab();
    expect(blk(app, 'Due').number).toBe(11);
    await app.user.clear(field('Numero'));
    await app.user.type(field('Numero'), '8000');
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Il numero deve essere compreso tra 1 e 7999.',
    );
    await app.user.tab();
    expect(past(app)).toBe(before);
    await app.user.click(screen.getByRole('button', { name: 'Automatico' }));
    expect(blk(app, 'Due').number).toBe(1);
    expect(past(app)).toBe(before + 1);
  });

  it('Tipo e Linguaggio in sola lettura; OB con numero fisso', async () => {
    await open(two, second);
    expect(field('Tipo')).toHaveAttribute('readonly');
    expect(field('Linguaggio')).toHaveAttribute('readonly');
  });

  it('Famiglia di 9 caratteri: HEADER_INVALID', async () => {
    const app = await open(two, second);
    await type(app, 'Famiglia', 'ABCDEFGHI');
    expect(blk(app, 'Due').header.family).toBe('ABCDEFGHI');
    expect(under('Famiglia')).toHaveTextContent("L'intestazione non è valida.");
    await type(app, 'Famiglia', 'ABCDEFGH');
    expect(under('Famiglia')).toBeNull();
  });

  it("Informazioni: titolo, commento, versione, autore, nome nell'intestazione", async () => {
    const app = await open(two, second);
    await type(app, 'Titolo', 'Pompa');
    await type(app, 'Versione', '99.9');
    await type(app, 'Autore', 'Mario');
    await type(app, "Nome nell'intestazione", 'POMPA');
    await type(app, 'Commento', 'x');
    expect(blk(app, 'Due').header).toMatchObject({
      title: 'Pompa',
      version: '99.9',
      author: 'Mario',
      headerName: 'POMPA',
      comment: 'x',
    });
    expect(under('Versione')).toHaveTextContent("L'intestazione non è valida.");
  });

  it('Protezione know-how e attributi del DB, una modifica ciascuno', async () => {
    const app = await open(
      (d) => void d.blocks.push(globalDb('Dati', [mem('a', 'Bool')])),
      nodeOf('Dati'),
    );
    const before = past(app);
    await app.user.click(field('Protezione know-how'));
    expect(blk(app, 'Dati').knowHowProtected).toBe(true);
    await app.user.click(field('Solo nella memoria di caricamento'));
    await app.user.click(field('Protetto da scrittura nel dispositivo'));
    await app.user.click(field('Non ritentivo'));
    expect(blk(app, 'Dati')).toMatchObject({
      attributes: { unlinked: true, readOnly: true, nonRetain: true },
    });
    expect(past(app)).toBe(before + 4);
  });

  it('blocco protetto know-how importato: la casella è disattivata', async () => {
    await open((d) => {
      const b = globalDb('Dati', [mem('a', 'Bool')]);
      b.knowHowProtected = true;
      b.mc7 = {
        exact: false,
        knowHowLocked: true,
        sourceHash: '',
        interfaceHash: '',
        headerRaw: '',
        addRaw: '',
        checksum: 0,
        original: '7070',
        mc7Hash: '',
        footerRaw: '',
        times: { code: '', iface: '' },
      };
      d.blocks.push(b);
    }, nodeOf('Dati'));
    expect(field('Protezione know-how')).toBeDisabled();
    expect(field('Protezione know-how')).toBeChecked();
  });

  it('DB protetto know-how importato senza blocco di libreria: la casella resta disattivata', async () => {
    await open((d) => {
      const b = globalDb('Dati', [mem('a', 'Bool')]);
      b.knowHowProtected = true;
      b.mc7 = {
        exact: true,
        knowHowLocked: false,
        sourceHash: '',
        interfaceHash: '',
        headerRaw: '',
        addRaw: '',
        checksum: 0,
        original: '7070',
        mc7Hash: '',
        footerRaw: '',
        times: { code: '', iface: '' },
      };
      d.blocks.push(b);
    }, nodeOf('Dati'));
    expect(field('Protezione know-how')).toBeDisabled();
    expect(field('Protezione know-how')).toBeChecked();
  });

  it('DB importato e ricaricato protetto know-how (stesso SSB): nomi tenuti e casella bloccata', async () => {
    const app = await renderApp({ view: 'project', withProject: true, withPlc: true });
    const cpu = findCpu('cpu-315-2-pn-dp')!;
    const friend: PlcDevice = { ...structuredClone(dev(app)), blocks: [] };
    const src = globalDb('Dati', [mem('a', 'Int'), mem('b', 'Int')]);
    friend.blocks.push(src);
    const at = new Date('2026-10-20T10:00:00Z');
    const plain = blockToMc7File(src, friend, cpu, at).file!;
    src.knowHowProtected = true;
    const locked = blockToMc7File(src, friend, cpu, at).file!;
    // come l'azione Importa blocchi: il piano sul progetto, poi un solo passo che lo applica
    const load = (file: Uint8Array) =>
      act(() => {
        const plan = planImport(dev(app), [file]);
        app.store.getState().edit('history.addRow', (p) => applyImport(findDevice(p, PLC)!, plan));
      });
    load(plain);
    act(() => {
      app.store.getState().edit('history.addRow', (p) => {
        const b = findDevice(p, PLC)!.blocks.find((x) => x.name === 'DB5')!;
        if (b.kind === 'DB') b.members[1]!.comment = 'contatore';
      });
    });
    load(locked);
    act(() => app.store.getState().select(nodeOf('DB5')(dev(app))));
    expect(field('Protezione know-how')).toBeDisabled();
    expect(field('Protezione know-how')).toBeChecked();
    const b = dev(app).blocks.find((x) => x.name === 'DB5')!;
    expect(b.kind === 'DB' && b.members[1]!.comment).toBe('contatore');
  });

  it('DB protetto know-how creato nel progetto (non importato): la casella è attiva', async () => {
    const app = await open((d) => {
      const b = globalDb('Dati', [mem('a', 'Bool')]);
      b.knowHowProtected = true;
      d.blocks.push(b);
    }, nodeOf('Dati'));
    expect(field('Protezione know-how')).toBeEnabled();
    await app.user.click(field('Protezione know-how'));
    expect(blk(app, 'Dati').knowHowProtected).toBe(false);
  });

  it("DB di istanza: mostra l'FB di appartenenza", async () => {
    await open(
      (d) => void d.blocks.push(fb('Motore'), instanceDb('Motore_DB', 'Motore')),
      nodeOf('Motore_DB'),
    );
    expect(field('DB di istanza di')).toHaveValue('Motore');
    expect(field('DB di istanza di')).toHaveAttribute('readonly');
  });

  it('Rinomina di un blocco dalle proprietà aggiorna i riferimenti', async () => {
    const app = await open(
      (d) => void d.blocks.push(fb('Motore'), instanceDb('Motore_DB', 'Motore')),
      nodeOf('Motore'),
    );
    const before = past(app);
    await type(app, 'Nome', 'Pompa');
    expect(blk(app, 'Pompa')).toBeDefined();
    expect(blk(app, 'Motore_DB')).toMatchObject({ instanceOf: 'Pompa' });
    expect(past(app)).toBe(before + 1);
  });
});

describe('proprietà di UDT e tabelle', () => {
  const blk = (app: RenderedApp, name: string) => dev(app).blocks.find((b) => b.name === name)!;
  it('rinomina di un UDT dalle proprietà aggiorna i riferimenti, un passo di annulla', async () => {
    const app = await open(
      (d) => {
        d.udts.push(udt('Asse', []));
        d.blocks.push(globalDb('Dati', [mem('a', '"Asse"')]));
      },
      (d) => ids.udt(PLC, d.udts[0]!.id),
    );
    const before = past(app);
    await type(app, 'Nome', 'Motore');
    expect(dev(app).udts[0]!.name).toBe('Motore');
    const db = blk(app, 'Dati');
    expect(db.kind === 'DB' && db.members[0]!.type).toBe('"Motore"');
    expect(past(app)).toBe(before + 1);
    act(() => app.store.getState().undo());
    expect(dev(app).udts[0]!.name).toBe('Asse');
    const back = blk(app, 'Dati');
    expect(back.kind === 'DB' && back.members[0]!.type).toBe('"Asse"');
  });

  it('UDT: numero con controlli, commento, autore, famiglia, versione', async () => {
    const app = await open(
      (d) => {
        const a = udt('A', []);
        const b = udt('B', []);
        b.number = 2;
        d.udts.push(a, b);
      },
      (d) => ids.udt(PLC, d.udts[1]!.id),
    );
    await app.user.clear(field('Numero'));
    await app.user.type(field('Numero'), '1');
    expect(screen.getByRole('alert')).toHaveTextContent('Questo numero è già in uso.');
    await app.user.tab();
    expect(dev(app).udts[1]!.number).toBe(2);
    await type(app, 'Numero', '70000');
    expect(dev(app).udts[1]!.number).toBe(2);
    await type(app, 'Numero', '30');
    expect(dev(app).udts[1]!.number).toBe(30);
    await app.user.click(screen.getByRole('button', { name: 'Automatico' }));
    expect(dev(app).udts[1]!.number).toBe(2);
    await type(app, 'Famiglia', 'Assi');
    await type(app, 'Autore', 'Ugo');
    await type(app, 'Versione', '1.2');
    await type(app, 'Commento', 'asse');
    expect(dev(app).udts[1]).toMatchObject({
      family: 'Assi',
      author: 'Ugo',
      version: '1.2',
      comment: 'asse',
    });
  });

  it('tabella standard: nome non modificabile; conteggi in sola lettura', async () => {
    await open(
      () => {},
      (d) => ids.tagTable(PLC, d.tagTables[0]!.id),
    );
    expect(field('Nome')).toHaveAttribute('readonly');
    expect(field('Nome')).toHaveValue('Tabella delle variabili standard');
    expect(field('Gruppo')).toHaveAttribute('readonly');
    expect(field('Numero di variabili')).toHaveValue('0');
    expect(field('Numero di costanti')).toHaveValue('0');
  });

  it('altra tabella: nome rinominabile', async () => {
    const app = await open(
      (d) => void d.tagTables.push({ id: 't2', name: 'Pompe', group: '', tags: [], constants: [] }),
      () => ids.tagTable(PLC, 't2'),
    );
    await type(app, 'Nome', 'Valvole');
    expect(dev(app).tagTables[1]!.name).toBe('Valvole');
  });

  it('altri nodi: nessuna proprietà', async () => {
    await open(
      () => {},
      () => ids.folder(PLC, 'blocks'),
    );
    expect(
      within(screen.getByRole('tabpanel', { name: 'Proprietà' })).getByText(
        'Nessuna proprietà disponibile',
      ),
    ).toBeInTheDocument();
  });
});
