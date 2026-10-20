# Catture cisagov (BSD 3-Clause)

Due catture di traffico S7comm, copiate senza modifiche dal repository
[cisagov/icsnpp-s7comm](https://github.com/cisagov/icsnpp-s7comm) (Battelle Energy Alliance, LLC),
distribuito con licenza **BSD 3-Clause**. Il testo della licenza è in `LICENSE.txt`.

| file           | URL                                                                                        | SHA-256                                                            |
| -------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| `snap7.pcap`   | <https://raw.githubusercontent.com/cisagov/icsnpp-s7comm/main/testing/traces/snap7.pcap>   | `2b91f6a8a203ec83e4f2dbb69d5e61602845f23da0baa31d95d029fb24cbd427` |
| `s7ident.pcap` | <https://raw.githubusercontent.com/cisagov/icsnpp-s7comm/main/testing/traces/s7ident.pcap> | `7a2ae7f2992669a3eb36a878f0e4f124c86ecdf3fc3a284f78e2e6e1deeea680` |

- `snap7.pcap`: CPU S7-300 reale (315-2PN/DP, `6ES7 315-2EH14-0AB0`) interrogata con snap7: setup, SZL,
  upload di SDB0 (l'unico upload riuscito; quello di OB0 è rifiutato con `D20C`), lettura e
  scrittura variabili. La cattura inizia a connessione già aperta
  (niente handshake TCP né CR/CC).
- `s7ident.pcap`: client e server di tipo snap7 che emulano una CPU 315-2EH14: setup, SZL, upload rifiutato.

Servono ai test `packages/s7comm/test/{pcap,realCaptures}.test.ts`, che girano sempre, anche in CI.
Le altre catture pubbliche (Wireshark, automayt, gymgit), senza licenza dichiarata, non sono nel
repository: le scarica `scripts/fetch-s7-captures.mjs` in `.cache/s7-captures/` (vedi `../public.json`).
