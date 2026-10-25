import { act, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { findCpu } from '@baaportal/catalog';
import { blockFromMc7, blockToMc7File, findDevice, type CodeBlock } from '@baaportal/project';
import { blockText } from '../../src/editors/compare/CompareView';
import { diffNetworks, lineDiff, lineDiffEx, normLine } from '../../src/editors/compare/lineDiff';
import { compileProgram } from '../../src/project/compile/compileActions';
import { ids } from '../../src/project/navigation/treeIds';
import { PLC, setupOnline } from '../online/downloadHelpers';

/** Il file MC7 del blocco dopo `change` (il blocco originale non si tocca). */
function cpuFile(
  app: Awaited<ReturnType<typeof setupOnline>>['app'],
  b: CodeBlock,
  change: (c: CodeBlock) => void,
) {
  const dev = findDevice(app.store.getState().doc!.project, PLC)!;
  const copy = structuredClone(b);
  change(copy);
  return blockToMc7File(
    copy,
    { ...dev, blocks: [...dev.blocks.filter((x) => x.id !== b.id), copy] },
    findCpu(dev.cpu.typeId),
  ).file!;
}

async function openCompare(app: Awaited<ReturnType<typeof setupOnline>>['app'], b: CodeBlock) {
  act(() => app.store.getState().openEditor({ kind: 'compare', deviceId: PLC, objectId: b.id }));
  await screen.findByTestId('compare-view');
}

describe('editor di confronto', () => {
  it('le righe diverse sono evidenziate', async () => {
    const { app, blocks } = await setupOnline([['FC', 1]]);
    const b = blocks[0]!;
    const file = cpuFile(app, b, (c) => {
      c.networks[0]!.source = 'A %I0.0\n= %Q0.1';
    });
    app.bridge.plcUploadBlockResults.set('FC1', { ok: true, bytes: file });
    await openCompare(app, b);
    await waitFor(() => expect(screen.getByTestId('compare-net-0')).toBeInTheDocument());
    const net = screen.getByTestId('compare-net-0');
    const rows = [...net.querySelectorAll('tr')];
    expect(rows.map((r) => r.getAttribute('data-diff'))).toEqual(['same', 'changed']);
    expect(rows[1]!.textContent).toContain('%Q0.0');
    expect(rows[1]!.textContent).toContain('%Q0.1');
    expect(app.bridge.plcUploadBlockCalls).toEqual(['FC1']);
  }, 30_000);

  it('reti in più su un lato', async () => {
    const { app, blocks } = await setupOnline([['FC', 1]]);
    const b = blocks[0]!;
    const file = cpuFile(app, b, (c) => {
      c.networks.push({ id: 'n2', title: 'Extra', comment: '', source: 'A %I0.1\n= %Q0.2' });
    });
    app.bridge.plcUploadBlockResults.set('FC1', { ok: true, bytes: file });
    await openCompare(app, b);
    await waitFor(() => expect(screen.getByTestId('compare-net-1')).toBeInTheDocument());
    expect(screen.getByTestId('compare-net-0').getAttribute('data-presence')).toBe('both');
    expect(screen.getByTestId('compare-net-1').getAttribute('data-presence')).toBe('right');
    expect(
      [...screen.getByTestId('compare-net-1').querySelectorAll('tr')].every(
        (r) => r.getAttribute('data-diff') === 'added',
      ),
    ).toBe(true);
  }, 30_000);

  it('blocco online non decodificabile → si mostra in esadecimale con la nota', async () => {
    const { app, blocks } = await setupOnline([['FC', 1]]);
    app.bridge.plcUploadBlockResults.set('FC1', {
      ok: true,
      bytes: Uint8Array.from([0xde, 0xad, 0xbe, 0xef]),
    });
    await openCompare(app, blocks[0]!);
    expect(await screen.findByTestId('compare-undecodable')).toBeInTheDocument();
    expect(screen.getByTestId('compare-hex').textContent).toContain('de ad be ef');
  }, 30_000);

  it('rete solo nel progetto: presenza left e righe missing', async () => {
    const { app, blocks } = await setupOnline([['FC', 1]]);
    const b = blocks[0]!;
    act(() => {
      app.store.getState().edit('history.addNet', (p) => {
        const target = findDevice(p, PLC)!.blocks.find((x) => x.id === b.id) as CodeBlock;
        target.networks.push({ id: 'n2', title: '', comment: '', source: 'A %I0.1\n= %Q0.2' });
      });
    });
    app.bridge.plcUploadBlockResults.set('FC1', { ok: true, bytes: cpuFile(app, b, () => {}) });
    await openCompare(app, b);
    await waitFor(() => expect(screen.getByTestId('compare-net-1')).toBeInTheDocument());
    const net = screen.getByTestId('compare-net-1');
    expect(net.getAttribute('data-presence')).toBe('left');
    expect(
      [...net.querySelectorAll('tr')].every((r) => r.getAttribute('data-diff') === 'missing'),
    ).toBe(true);
  }, 30_000);

  it('rete uguale: marcatore «uguale»; blocco non compilato: nota nell’intestazione', async () => {
    const { app, blocks } = await setupOnline([['FC', 1]]);
    const b = blocks[0]!;
    app.bridge.plcUploadBlockResults.set('FC1', { ok: true, bytes: cpuFile(app, b, () => {}) });
    await openCompare(app, b);
    await waitFor(() => expect(screen.getByTestId('compare-net-0')).toBeInTheDocument());
    expect(within(screen.getByTestId('compare-net-0')).getByRole('heading').textContent).toContain(
      'uguale',
    );
    act(() => app.store.setState({ compile: { ...app.store.getState().compile, files: {} } }));
    expect((await screen.findAllByText('non compilato')).length).toBe(4);
  }, 30_000);

  it('fuori linea: nota e nessuna richiesta; errore del caricamento con role=alert e Ricarica', async () => {
    const { app, blocks } = await setupOnline([['FC', 1]]);
    const b = blocks[0]!;
    await openCompare(app, b);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('nessun blocco');
    app.bridge.plcUploadBlockResults.set('FC1', { ok: true, bytes: cpuFile(app, b, () => {}) });
    await app.user.click(screen.getByRole('button', { name: 'Ricarica dalla CPU' }));
    await waitFor(() => expect(screen.getByTestId('compare-net-0')).toBeInTheDocument());
    expect(app.bridge.plcUploadBlockCalls).toEqual(['FC1', 'FC1']);
    act(() => app.store.getState().patchOnline({ status: 'off' }));
    expect(await screen.findByTestId('compare-offline')).toBeInTheDocument();
    expect(app.bridge.plcUploadBlockCalls).toHaveLength(2);
  }, 30_000);

  it('un OB compilato, decodificato e confrontato col sorgente: nessuna riga diversa', async () => {
    const { app } = await setupOnline([['OB', 1]]);
    const dev = findDevice(app.store.getState().doc!.project, PLC)!;
    const ob = dev.blocks.find((b) => b.kind === 'OB') as CodeBlock;
    act(() => {
      app.store.getState().edit('history.src', (p) => {
        (findDevice(p, PLC)!.blocks.find((b) => b.id === ob.id) as CodeBlock).networks[0]!.source =
          'A %I0.0\nAN %I0.1\nO %M1.0\n= %Q0.0\nL 10\nT %MW10\nL MW10\nL 5\n+I\nT %MW12';
      });
    });
    const cur = findDevice(app.store.getState().doc!.project, PLC)!;
    const b = cur.blocks.find((x) => x.id === ob.id) as CodeBlock;
    const r = blockToMc7File(b, cur, findCpu(cur.cpu.typeId));
    expect(r.diagnostics.filter((x) => x.severity === 'error')).toEqual([]);
    const file = r.file!;
    const back = blockFromMc7(cur, file).block;
    const d = diffNetworks(blockText(b), blockText(back));
    expect(d.flatMap((n) => n.rows).filter((r) => r.kind !== 'same')).toEqual([]);
  }, 30_000);

  async function symbolic() {
    const { app, blocks } = await setupOnline([['OB', 1]]);
    act(() => {
      app.store.getState().edit('history.sym', (p) => {
        const d = findDevice(p, PLC)!;
        for (const [name, address] of [
          ['Start', '%I0.0'],
          ['Lamp', '%Q0.0'],
          ['Lamp2', '%Q0.1'],
        ] as const) {
          d.tagTables[0]!.tags.push({
            id: `tg${name}`,
            name,
            type: 'Bool',
            address,
            hmi: false,
            comment: '',
          });
        }
        (d.blocks.find((b) => b.id === blocks[0]!.id) as CodeBlock).networks[0]!.source =
          'A "Start"\n= "Lamp"';
      });
    });
    await act(async () => {
      await compileProgram(
        { store: app.store, service: app.service, bridge: app.bridge },
        PLC,
        'full',
      );
    });
    const b = findDevice(app.store.getState().doc!.project, PLC)!.blocks.find(
      (x) => x.id === blocks[0]!.id,
    ) as CodeBlock;
    return { app, b };
  }

  it('operandi simbolici: compilato scaricato nella CPU → nessuna riga diversa', async () => {
    const { app, b } = await symbolic();
    app.bridge.plcUploadBlockResults.set('OB1', {
      ok: true,
      bytes: app.store.getState().compile.files[b.id]!,
    });
    await openCompare(app, b);
    await waitFor(() => expect(screen.getByTestId('compare-net-0')).toBeInTheDocument());
    expect(screen.queryByTestId('compare-source-note')).toBeNull();
    const rows = [...screen.getByTestId('compare-net-0').querySelectorAll('tr')];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.filter((r) => r.getAttribute('data-diff') !== 'same')).toHaveLength(0);
  }, 30_000);

  it('operando cambiato → esattamente una riga diversa', async () => {
    const { app, b } = await symbolic();
    app.bridge.plcUploadBlockResults.set('OB1', {
      ok: true,
      bytes: cpuFile(app, b, (c) => {
        c.networks[0]!.source = 'A "Start"\n= "Lamp2"';
      }),
    });
    await openCompare(app, b);
    await waitFor(() => expect(screen.getByTestId('compare-net-0')).toBeInTheDocument());
    const rows = [...screen.getByTestId('compare-net-0').querySelectorAll('tr')];
    expect(rows.filter((r) => r.getAttribute('data-diff') === 'changed')).toHaveLength(1);
  }, 30_000);

  it('senza compilato: confronto sul sorgente con la nota', async () => {
    const { app, b } = await symbolic();
    act(() => app.store.setState({ compile: { ...app.store.getState().compile, files: {} } }));
    app.bridge.plcUploadBlockResults.set('OB1', { ok: true, bytes: cpuFile(app, b, () => {}) });
    await openCompare(app, b);
    expect(await screen.findByTestId('compare-source-note')).toBeInTheDocument();
  }, 30_000);

  it('menu contestuale: attivo solo per «diverso»; assente fuori linea o su un altro dispositivo', async () => {
    const { app, blocks } = await setupOnline([
      ['FC', 1],
      ['FC', 2],
    ]);
    const [a, b] = blocks;
    const state = app.store.getState();
    act(() =>
      state.patchOnline({
        compare: {
          deviceId: PLC,
          hashes: state.online.compare!.hashes,
          rows: [
            { type: 'FC', number: 1, blockId: a!.id, state: 'different' },
            { type: 'FC', number: 2, blockId: b!.id, state: 'same' },
          ],
        },
      }),
    );
    const item = async (blk: CodeBlock) => {
      await app.user.pointer({
        keys: '[MouseRight]',
        target: screen.getByTestId(`tree-node-${ids.block(PLC, blk.id)}`),
      });
      return screen.queryByRole('menuitem', { name: 'Confronta online/offline' });
    };
    expect(await item(a!)).not.toHaveAttribute('aria-disabled', 'true');
    expect((await item(a!))!.hasAttribute('disabled')).toBe(false);
    await app.user.keyboard('{Escape}');
    const same = await item(b!);
    expect(same!.getAttribute('aria-disabled') === 'true' || same!.hasAttribute('disabled')).toBe(
      true,
    );
    await app.user.keyboard('{Escape}');
    act(() => app.store.getState().patchOnline({ deviceId: 'altro' }));
    expect(await item(a!)).toBeNull();
    await app.user.keyboard('{Escape}');
    act(() => app.store.getState().patchOnline({ deviceId: PLC, status: 'off' }));
    expect(await item(a!)).toBeNull();
  }, 30_000);

  it('normalizzazione: solo il codice ignora spazi, maiuscole e «;»', () => {
    const changed = (a: string, b: string) => lineDiff([a], [b])[0]!.kind;
    expect(changed("L 'abc'", "L 'ABC'")).toBe('changed');
    expect(changed('A I0.0;', 'A I0.0')).toBe('same');
    expect(changed('"Motor"', '"MOTOR"')).toBe('changed');
    expect(changed('a   i0.0', 'A I0.0;  ')).toBe('same');
    expect(changed('L "MW1"', 'L "%MW1"')).toBe('changed');
    expect(changed('A I0.0 // Uno', 'A I0.0 // UNO')).toBe('changed');
    expect(normLine('A I0.0; // x')).toBe(normLine('A I0.0 // x'));
  });

  it('grande input: veloce e corretto, e oltre il tetto per posizione con nota', () => {
    const a = Array.from({ length: 20000 }, (_, i) => `A M${i}.0`);
    const b = [...a];
    b[10000] = 'A M99.0';
    const t0 = Date.now();
    const r = lineDiffEx(a, b);
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(r.approximate).toBe(false);
    expect(r.rows.filter((x) => x.kind !== 'same')).toHaveLength(1);
    // tutte diverse: nessun prefisso né suffisso comune, 3000 x 3000 oltre il tetto
    const c = Array.from({ length: 3000 }, (_, i) => `A X${i}`);
    const d = Array.from({ length: 3000 }, (_, i) => `A Y${i}`);
    const big = lineDiffEx(c, d);
    expect(big.approximate).toBe(true);
    expect(big.rows.every((x) => x.kind === 'changed')).toBe(true);
    expect(diffNetworks([{ title: '', lines: c }], [{ title: '', lines: d }])[0]!.approximate).toBe(
      true,
    );
  });

  it('diff per righe: reti allineate per posizione', () => {
    const d = diffNetworks([{ title: 'a', lines: ['x'] }], []);
    expect(d[0]!.presence).toBe('left');
    expect(d[0]!.rows[0]!.kind).toBe('missing');
  });
});
