import { expect, launchApp, test } from './helpers';

test("l'app si avvia con titolo BaaPortal e bridge disponibile", async () => {
  const { app, page } = await launchApp();
  expect(await page.title()).toBe('BaaPortal');
  expect(
    await page.evaluate(
      () => typeof (window as unknown as { baa: { readFile: unknown } }).baa.readFile,
    ),
  ).toBe('function');
  await app.close();
});

test('macOS: il menu Modifica ha Annulla e Ripeti nativi (per i campi di testo)', async () => {
  test.skip(process.platform !== 'darwin', "il menu dell'applicazione esiste solo su macOS");
  const { app } = await launchApp();
  const edit = await app.evaluate(({ Menu }) =>
    Menu.getApplicationMenu()
      ?.items.find((i) => i.label === 'Modifica')
      ?.submenu?.items.map((i) => [i.type === 'separator' ? 'separator' : i.role, i.label]),
  );
  expect(edit).toEqual([
    ['undo', 'Annulla'],
    ['redo', 'Ripeti'],
    ['separator', ''],
    ['cut', 'Taglia'],
    ['copy', 'Copia'],
    ['paste', 'Incolla'],
    ['selectall', 'Seleziona tutto'],
  ]);
});
