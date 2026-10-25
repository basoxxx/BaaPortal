# Online: dispositivi accessibili e collegamento

Guida breve al collegamento in sola lettura a una CPU S7-300 (piano 3A). Per la rete e i parametri della CPU si vedano i manuali della CPU e del CP usati.

1. **Dispositivi accessibili.** Il comando si apre dalla barra degli strumenti o dal menu _Online_. Scegli l'interfaccia di rete e avvia la ricerca: compaiono i dispositivi con indirizzo IPv4 nella stessa sottorete. Non compaiono le CPU senza indirizzo IP.
2. **Indirizzo manuale.** Scrivi `192.0.2.10` oppure `192.0.2.10:102` e premi _Aggiungi indirizzo_. Sono ammessi solo indirizzi IPv4, non nomi.
3. **Rack e slot.** Rack da 0 a 7 e slot da 0 a 31. Per una CPU S7-300 diretta di solito sono rack 0 e slot 2; si vedano i manuali.
4. **Tipo di collegamento.** _Diretto_ per una CPU con interfaccia PN o per un CP 343-1; _Gateway RFC 1006_ per raggiungere una CPU MPI/DP, con il TSAP remoto in esadecimale.
5. **Collega.** Seleziona una riga e premi _Collega_. L'accesso si salva nelle proprietà della CPU del progetto. Online la barra di stato mostra il modulo e il modo, e l'interfaccia diventa arancione.
6. **Pannello CPU.** Nella task card _Test_ i LED RUN e STOP seguono il modo della CPU, che si aggiorna ogni secondo. Il collegamento è in sola lettura: caricamento, RUN/STOP e MRES sono disabilitati.
7. **Collegamento interrotto.** Se la CPU non risponde più, l'app torna offline e mostra il messaggio «Collegamento interrotto». _Interrompi collegamento online_ chiude il collegamento a mano.
8. **Simulazione.** La simulazione e il collegamento a un PLC si escludono: va spenta una prima di accendere l'altro.

I limiti noti sono in `docs/limiti-noti.md`, sezione «Online (piano 3A)».
