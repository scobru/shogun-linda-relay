# Linda Optimization Server

Server di ottimizzazione per Linda/gIRC che funge da layer di caching intelligente tra i client e GunDB. Usa **SQLite** come cache locale mantenendo GunDB come single source of truth, riducendo drasticamente la latenza per messaggi, ricerche e statistiche.

## Caratteristiche principali
- Cache persistente per messaggi di room pubbliche, chat private e conversazioni storiche.
- Sincronizzazione continua con GunDB (peers gestiti tramite `shogun-relays`).
- Indicizzazione fuzzy dei nomi utente con Fuse.js e archivio locale su SQLite.
- API per notifiche real-time via Socket.IO e webhooks (`/api/notify/...`).
- Endpoint di health check e statistiche del protocollo (`/api/health`, `/api/stats/protocol`).
- Job pianificati per mantenere la cache aggiornata e statistiche salvate su SQLite.

Consulta `OPTIMIZATION_GUIDE.md` per una descrizione completa dell'architettura, strategie di caching e linee guida avanzate:  
`./OPTIMIZATION_GUIDE.md`

## Requisiti
- Node.js >= 18
- SQLite3 (il database viene creato automaticamente come `linda_optimization.db`)

## Installazione
```bash
yarn install
```

## Configurazione
Imposta le variabili d'ambiente (puoi usare un file `.env` se usi un process manager):

```bash
PORT=8766
FRONTEND_URL=http://localhost:3000
GUNDB_PEERS=https://relay.shogun-eco.xyz/gun,https://v5g5jseqhgkp43lppgregcfbvi.srv.us/gun
```

Se `GUNDB_PEERS` non è valorizzata viene usata automaticamente la lista aggiornata da `shogun-relays`.

## Avvio

- **Produzione**
  ```bash
  yarn start
  ```
- **Sviluppo con reload**
  ```bash
  yarn dev
  ```

Il server espone le API su `http://localhost:${PORT}` (default `8766`).

## Endpoints utili
- `GET /api/health` – stato del server, versione e statistiche di base.
- `GET /api/stats/protocol` – statistiche aggregate del protocollo (cache + SQLite).
- `GET /api/notifications/:userPub` – recupera (e svuota) la coda notifiche per un utente.
- `POST /api/notify/message` – webhook per aggiornare cache/statistiche su nuovi messaggi.

Endpoint aggiuntivi per conversazioni, room pubbliche, ricerca full-text e gestione cache sono documentati in `OPTIMIZATION_GUIDE.md`.

## Debug & monitoraggio
- Avvio con log verbosi:
  ```bash
  DEBUG=linda:* yarn start
  ```
- Health check rapido:
  ```bash
  curl http://localhost:${PORT}/api/health
  ```

## Struttura del progetto
- `server.js` – entrypoint Express + Socket.IO, logica cache & sincronizzazione GunDB.
- `OPTIMIZATION_GUIDE.md` – guida approfondita con flussi, esempi client e best practice.
- `linda_optimization.db` – database SQLite generato automaticamente.
- `linda-data/` – storage locale usato da Gun.

## Contributi
1. Apri una branch dedicata.
2. Esegui `yarn lint` (se disponibile) e verifica gli endpoint principali.
3. Aggiorna `OPTIMIZATION_GUIDE.md` se modifichi i flussi di caching o API pubbliche.

---
Per domande o chiarimenti consulta la guida o apri un ticket interno nel progetto gIRC.

