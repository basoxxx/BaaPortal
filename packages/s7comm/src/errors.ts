export type S7ErrorCode =
  | 'CONNECT_REFUSED'
  | 'CONNECT_TIMEOUT'
  | 'TIMEOUT'
  | 'CLOSED'
  | 'COTP_REJECTED'
  | 'PROTOCOL'
  | 'CPU_ERROR'
  | 'FORBIDDEN'
  | 'ABORTED';

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
