/** Ricorda se l'uscita ha già chiuso il collegamento online; un'uscita annullata lo riapre. */
export class OnlineCloseLatch {
  closed = false;

  /** Uscita annullata: se il collegamento era stato chiuso, si riabilitano le operazioni online. */
  cancel(resume: () => void): void {
    if (!this.closed) return;
    this.closed = false;
    resume();
  }
}
