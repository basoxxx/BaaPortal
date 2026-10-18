import { Resvg } from '@resvg/resvg-js';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const build = join(dirname(fileURLToPath(import.meta.url)), '..', 'build');
const svg = readFileSync(join(build, 'icon.svg'));
const png = new Resvg(svg, { fitTo: { mode: 'width', value: 1024 } }).render().asPng();
writeFileSync(join(build, 'icon.png'), png);
console.log(`build/icon.png scritto (${png.length} byte)`);
