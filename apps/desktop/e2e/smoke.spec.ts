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
