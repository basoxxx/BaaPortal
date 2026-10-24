import { parseArgs } from 'node:util';
import { S7Error } from '@baaportal/s7comm';
import { COMMANDS, COMMON_OPTIONS, FileError, UsageError, type Ctx } from './commands';

const OPTIONS = {
  host: { type: 'string' },
  port: { type: 'string' },
  rack: { type: 'string' },
  slot: { type: 'string' },
  tipo: { type: 'string' },
  timeout: { type: 'string' },
  log: { type: 'string' },
  output: { type: 'string', short: 'o' },
  sovrascrivi: { type: 'boolean' },
  'senza-blocchi': { type: 'boolean' },
  porta: { type: 'string' },
  protezione: { type: 'string' },
  modo: { type: 'string' },
  blocchi: { type: 'string' },
  hex: { type: 'boolean' },
  conferma: { type: 'boolean' },
  'non-in-produzione': { type: 'boolean' },
  aiuto: { type: 'boolean', short: 'h' },
} as const;

function usage(): string {
  const w = Math.max(...COMMANDS.map((c) => c.usage.length));
  return [
    's7bench - strumento interno per il banco di prova S7',
    '',
    'uso: s7bench <comando> [argomenti] [opzioni]',
    '',
    'comandi di lettura (non modificano la CPU):',
    ...COMMANDS.filter((c) => !c.writes).map((c) => `  ${c.usage.padEnd(w)}  ${c.summary}`),
    '',
    'comandi di SCRITTURA (modificano la CPU, solo su CPU proprie e mai in produzione):',
    ...COMMANDS.filter((c) => c.writes).map((c) => `  ${c.usage.padEnd(w)}  ${c.summary}`),
    '  ATTENZIONE: prima di agire stampano un riepilogo (cosa, IP, ordine CPU, modo) e procedono',
    '  SOLO con entrambe --conferma e --non-in-produzione; senza, escono con codice 2 senza scrivere.',
    '',
    'opzioni di connessione (comandi che parlano con una CPU):',
    '  --host <indirizzo>   obbligatoria',
    '  --port <n>           porta TCP (102)',
    '  --rack <0-7>         rack (0)',
    '  --slot <0-31>        slot (2)',
    '  --tipo pg|op|base    tipo di connessione (pg)',
    '  --timeout <ms>       attesa massima (5000)',
    '  --log <file.jsonl>   salva la cattura della connessione, anche in caso di errore',
    '',
    '  --aiuto, -h          questo testo',
    '',
    'codici di uscita: 0 ok, 1 errore di comunicazione o della CPU, 2 argomenti sbagliati, 3 errore sui file',
  ].join('\n');
}

const flush = (s: NodeJS.WriteStream): Promise<void> => new Promise((r) => s.write('', () => r()));

async function main(argv: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
  } catch (e) {
    process.stderr.write(`argomenti sbagliati: ${e instanceof Error ? e.message : String(e)}\n`);
    process.stderr.write("usa --aiuto per l'elenco dei comandi\n");
    return 2;
  }
  if (parsed.values['aiuto']) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }
  const [name, ...positionals] = parsed.positionals;
  if (name === undefined) {
    process.stderr.write(`${usage()}\n`);
    return 2;
  }
  const cmd = COMMANDS.find((c) => c.name === name);
  if (!cmd) {
    process.stderr.write(`comando sconosciuto: ${name}\nusa --aiuto per l'elenco dei comandi\n`);
    return 2;
  }
  const allowed = new Set([...(cmd.network ? COMMON_OPTIONS : []), ...cmd.options]);
  for (const k of Object.keys(parsed.values)) {
    if (!allowed.has(k)) {
      process.stderr.write(`argomenti sbagliati: l'opzione --${k} non vale per "${name}"\n`);
      return 2;
    }
  }
  const ctx: Ctx = {
    values: parsed.values,
    positionals,
    out: (l) => void process.stdout.write(`${l}\n`),
    err: (l) => void process.stderr.write(`${l}\n`),
  };
  try {
    await cmd.run(ctx);
    return 0;
  } catch (e) {
    if (e instanceof UsageError) {
      process.stderr.write(`argomenti sbagliati: ${e.message}\n`);
      return 2;
    }
    if (e instanceof FileError) {
      process.stderr.write(`errore file: ${e.message}\n`);
      return 3;
    }
    if (e instanceof S7Error) {
      process.stderr.write(`errore ${e.code}: ${e.message}\n`);
      return 1;
    }
    process.stderr.write(`errore: ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }
}

// Una pipe chiusa a monte (p.es. `| head`) non è un errore del programma.
process.stdout.on('error', () => undefined);
process.stderr.on('error', () => undefined);

const code = await main(process.argv.slice(2));
await flush(process.stdout);
await flush(process.stderr);
process.exit(code);
