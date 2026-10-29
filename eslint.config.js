import tseslint from 'typescript-eslint';

// I trasporti grezzi (TCP e porta seriale) non escono da packages/s7comm/src/node/: fuori si
// usano solo `openTcp`, `connectTcp` e `mpiSerialLink`, che passano dal filtro di sola lettura.
const TCP_TRANSPORT_PATTERNS = [
  {
    group: ['**/tcpTransport', '**/tcpTransport.ts', '**/tcpTransport.js'],
    message: 'tcpTransport è interno a packages/s7comm/src/node/: usa openTcp o connectTcp.',
  },
  {
    group: ['**/serialTransport', '**/serialTransport.ts', '**/serialTransport.js'],
    message:
      'serialTransport è interno a packages/s7comm/src/node/: usa mpiSerialLink o listMpiNodesSerial.',
  },
];
const SERIAL_PATHS = [
  { name: 'serialport', message: 'usa @baaportal/s7comm/node (mpiSerialLink, listSerialPorts)' },
];

// La rete la usa solo @baaportal/s7comm/node (connectTcp/collectTcp), che passa dal filtro di
// sola lettura: né le app né la UI importano socket direttamente.
const NETWORK_MESSAGE = 'usa @baaportal/s7comm/node (connectTcp/collectTcp)';
const NETWORK_MODULES = ['net', 'node:net', 'tls', 'node:tls', 'dgram', 'node:dgram'];

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/out/**',
      '**/dist/**',
      '**/coverage/**',
      'docs/**',
      '.superpowers/**',
    ],
  },
  ...tseslint.configs.recommended,
  {
    // Il nucleo di s7comm è neutro rispetto alla piattaforma: sockets e Node solo in src/node/.
    files: ['packages/s7comm/src/**/*.ts'],
    ignores: ['packages/s7comm/src/node/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            ...TCP_TRANSPORT_PATTERNS,
            {
              group: [
                'node:*',
                'net',
                'tls',
                'dgram',
                'http',
                'https',
                'fs',
                'child_process',
                'serialport',
              ],
              message: 'Solo packages/s7comm/src/node/ può importare moduli di Node.',
            },
          ],
        },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: 'ImportExpression',
          message: 'import() dinamico vietato nel nucleo di s7comm.',
        },
        {
          selector: "CallExpression[callee.name='require']",
          message: 'require() vietato nel nucleo di s7comm.',
        },
      ],
    },
  },
  {
    // Ovunque tranne dentro src/node/ (e il test del trasporto stesso).
    files: ['**/*.{ts,tsx,mjs,js}'],
    ignores: [
      'packages/s7comm/src/node/**',
      'packages/s7comm/test/tcpTransport.test.ts',
      'packages/s7comm/test/serialTransport.test.ts',
      'packages/s7comm/src/**',
    ],
    rules: {
      'no-restricted-imports': ['error', { paths: SERIAL_PATHS, patterns: TCP_TRANSPORT_PATTERNS }],
    },
  },
  {
    // Come s7comm: il nucleo del finto PLC è neutro rispetto alla piattaforma, sockets solo in src/node/.
    files: ['packages/s7-server/src/**/*.ts'],
    ignores: ['packages/s7-server/src/node/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            ...TCP_TRANSPORT_PATTERNS,
            {
              group: ['node:*', 'net', 'tls', 'dgram', 'http', 'https', 'fs', 'child_process'],
              message: 'Solo packages/s7-server/src/node/ può importare moduli di Node.',
            },
          ],
        },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: 'ImportExpression',
          message: 'import() dinamico vietato nel nucleo di s7-server.',
        },
        {
          selector: "CallExpression[callee.name='require']",
          message: 'require() vietato nel nucleo di s7-server.',
        },
      ],
    },
  },
  {
    // Nessuna eccezione nelle app: nemmeno il processo principale di desktop importa socket.
    files: ['apps/**/src/**/*.{ts,tsx,mjs,js}', 'packages/ui/**/*.{ts,tsx,mjs,js}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            ...NETWORK_MODULES.map((name) => ({ name, message: NETWORK_MESSAGE })),
            ...SERIAL_PATHS,
          ],
          patterns: TCP_TRANSPORT_PATTERNS,
        },
      ],
    },
  },
);
