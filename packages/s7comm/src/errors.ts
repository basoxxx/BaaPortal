export type S7ErrorCode =
  | 'CONNECT_REFUSED'
  | 'CONNECT_TIMEOUT'
  | 'TIMEOUT'
  | 'CLOSED'
  | 'COTP_REJECTED'
  | 'PROTOCOL'
  | 'CPU_ERROR'
  | 'FORBIDDEN'
  | 'ABORTED'
  /** Frame dell'adattatore MPI illeggibile (BCC, DLE, lunghezza) o fuori sequenza. */
  | 'MPI_FRAME'
  /** L'adattatore MPI non risponde (porta, velocità, parità o cavo). */
  | 'MPI_NO_ADAPTER'
  /** L'adattatore risponde ma la CPU all'indirizzo MPI scelto no. */
  | 'MPI_NO_CPU';

export interface S7ErrorDetail {
  errorClass?: number;
  errorCode?: number;
  returnCode?: number;
}

export class S7Error extends Error {
  readonly code: S7ErrorCode;
  readonly detail?: S7ErrorDetail;

  constructor(code: S7ErrorCode, message: string, detail?: S7ErrorDetail) {
    super(message);
    this.name = 'S7Error';
    this.code = code;
    this.detail = detail;
  }
}
