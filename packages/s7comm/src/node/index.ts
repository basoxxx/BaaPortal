// Solo funzioni di alto livello con il filtro di sola lettura: il trasporto TCP grezzo
// (`tcpTransport`) è interno a questa cartella e non esce da nessun punto di ingresso.
export { connectTcp, openTcp } from './tcpTransport';
export { collectTcp } from './collectTcp';
export { connectWriteTcp } from './connectWrite';
export { connectTestTcp } from './connectTest';
export { probePort } from './probePort';
