// L'unico punto che apre socket: il nucleo del pacchetto è neutro rispetto alla piattaforma.
export { listen } from './listen';
export type { ListenOptions, ListeningCpu } from './listen';
