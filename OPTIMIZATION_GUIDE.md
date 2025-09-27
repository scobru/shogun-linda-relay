# Linda Optimization Server - Guida Completa

## Panoramica

Il server di ottimizzazione di Linda è progettato per migliorare significativamente le performance delle chat utilizzando **GunDB come storage finale di riferimento** e **SQLite come cache locale** per accessi rapidi.

## Architettura

```
Client (React) ←→ Optimization Server (SQLite Cache) ←→ GunDB (Storage Finale)
```

### Principi Fondamentali

1. **GunDB è la fonte di verità**: Tutti i dati vengono sempre sincronizzati con GunDB
2. **SQLite è solo cache**: Il server agisce come cache intelligente per migliorare le performance
3. **Sincronizzazione automatica**: Il server si sincronizza automaticamente con GunDB
4. **Fallback robusto**: Se il server non è disponibile, il client funziona direttamente con GunDB

## Tipi di Ottimizzazione

### 1. Chat di Gruppo

#### API Disponibili:
- `GET /api/groups/:userPub` - Ottieni tutti i gruppi di un utente
- `GET /api/groups/:groupId/messages` - Ottieni messaggi di un gruppo (con cache)
- `POST /api/groups` - Crea un nuovo gruppo
- `POST /api/groups/:groupId/messages` - Salva un messaggio di gruppo

#### Ottimizzazioni:
- **Cache automatica**: I messaggi vengono cachati automaticamente quando viene creato un gruppo
- **Sincronizzazione real-time**: Il server ascolta GunDB e aggiorna la cache automaticamente
- **Chiavi di crittografia**: Le chiavi criptate vengono salvate per supportare la decrittazione

#### Utilizzo nel Client:
```typescript
// Prima prova a ottenere dal server di ottimizzazione
const response = await fetch(`http://localhost:3001/api/groups/${groupId}/messages`);
if (response.ok) {
  const data = await response.json();
  return data.messages; // Messaggi già cachati e ottimizzati
}

// Fallback a GunDB diretto
return await lindaLib.getGroupMessages(groupId);
```

### 2. Room Pubbliche

#### API Disponibili:
- `GET /api/room/:roomId` - Ottieni messaggi di una room (con cache)
- `POST /api/room/:roomId/preload` - Pre-carica i messaggi di una room
- `DELETE /api/room/:roomId` - Invalida cache di una room

#### Ottimizzazioni:
- **Pre-caricamento automatico**: Tutte le room vengono pre-caricate all'avvio del server
- **Cache persistente**: I messaggi vengono salvati in SQLite per accessi rapidi
- **Aggiornamento automatico**: Il server si sincronizza con GunDB in tempo reale

#### Utilizzo nel Client:
```typescript
// Carica messaggi ottimizzati
const response = await fetch(`http://localhost:3001/api/room/${roomId}`);
if (response.ok) {
  const data = await response.json();
  if (data.cached) {
    console.log(`Messaggi caricati da cache: ${data.messages.length}`);
  }
  return data.messages;
}
```

### 3. Chat Private

#### API Disponibili:
- `GET /api/private-conversation/:user1/:user2` - Ottieni conversazione privata (con cache)
- `GET /api/conversation/:user1/:user2` - API legacy per compatibilità

#### Ottimizzazioni:
- **Content Preview**: Per i messaggi criptati, viene salvato un preview leggibile
- **Indicizzazione**: I messaggi vengono indicizzati per ricerche rapide
- **Crittografia-aware**: Il server gestisce correttamente i messaggi criptati

#### Utilizzo nel Client:
```typescript
// Carica conversazione privata ottimizzata
const response = await fetch(`http://localhost:3001/api/private-conversation/${user1}/${user2}`);
if (response.ok) {
  const data = await response.json();
  return data.messages.map(msg => ({
    ...msg,
    contentPreview: msg.contentPreview, // Preview per messaggi criptati
    isEncrypted: msg.isEncrypted
  }));
}
```

## Funzionalità Avanzate

### 1. Ricerca Full-Text

#### API:
- `GET /api/search/messages?query=testo&type=all&limit=20`

#### Tipi di Ricerca:
- `all` - Cerca in tutti i tipi di messaggi
- `private` - Solo chat private
- `group` - Solo chat di gruppo
- `room` - Solo room pubbliche

#### Utilizzo:
```typescript
const response = await fetch(`http://localhost:3001/api/search/messages?query=ciao&type=private`);
const data = await response.json();
console.log(`Trovati ${data.total} messaggi contenenti "ciao"`);
```

### 2. Statistiche e Analytics

#### API:
- `GET /api/stats/conversations?userPub=chiave_utente`

#### Statistiche Disponibili:
- Numero totale di messaggi
- Numero di contatti/gruppi/room
- Ultima attività
- Messaggi criptati vs non criptati

#### Utilizzo:
```typescript
const response = await fetch(`http://localhost:3001/api/stats/conversations?userPub=${userPub}`);
const data = await response.json();
console.log(`Statistiche:`, data.stats);
```

### 3. Gestione Cache

#### API di Gestione:
- `DELETE /api/conversation/:user1/:user2` - Invalida cache conversazione
- `DELETE /api/room/:roomId` - Invalida cache room
- `POST /api/room/:roomId/preload` - Forza ricaricamento cache

## Configurazione

### Variabili d'Ambiente:
```bash
PORT=3001
FRONTEND_URL=http://localhost:3000
GUNDB_PEERS=https://relay.shogun-eco.xyz/gun,https://v5g5jseqhgkp43lppgregcfbvi.srv.us/gun
```

### Configurazione Performance:
```javascript
const CONFIG = {
  MAX_MESSAGES_PER_CONVERSATION: 100,
  CACHE_TTL_SECONDS: 3600,
  CLEANUP_INTERVAL_MINUTES: 30,
  KEY_ROTATION_INTERVAL_MINUTES: 5,
  MAX_EPHEMERAL_KEYS_PER_CONVERSATION: 5
};
```

## Integrazione nel Client

### 1. Hook Personalizzato

```typescript
// useOptimizedMessages.ts
export function useOptimizedMessages(type: 'group' | 'room' | 'private', id: string) {
  const [messages, setMessages] = useState([]);
  const [loading, setLoading] = useState(false);
  const [cached, setCached] = useState(false);

  useEffect(() => {
    loadOptimizedMessages();
  }, [type, id]);

  const loadOptimizedMessages = async () => {
    setLoading(true);
    try {
      const endpoint = getEndpoint(type, id);
      const response = await fetch(endpoint);
      const data = await response.json();
      
      setMessages(data.messages);
      setCached(data.cached);
    } catch (error) {
      // Fallback a GunDB diretto
      const fallbackMessages = await lindaLib.getMessages(id);
      setMessages(fallbackMessages);
      setCached(false);
    } finally {
      setLoading(false);
    }
  };

  return { messages, loading, cached, refresh: loadOptimizedMessages };
}
```

### 2. Service Worker per Cache Offline

```javascript
// sw.js
self.addEventListener('fetch', event => {
  if (event.request.url.includes('/api/')) {
    event.respondWith(
      caches.open('linda-cache').then(cache => {
        return cache.match(event.request).then(response => {
          if (response) {
            return response; // Ritorna dalla cache
          }
          
          return fetch(event.request).then(fetchResponse => {
            cache.put(event.request, fetchResponse.clone());
            return fetchResponse;
          });
        });
      })
    );
  }
});
```

## Benefici delle Performance

### Prima dell'Ottimizzazione:
- ⏱️ Caricamento messaggi: 2-5 secondi
- 🔍 Ricerca: Non disponibile
- 📊 Statistiche: Non disponibili
- 🔄 Sincronizzazione: Lenta

### Dopo l'Ottimizzazione:
- ⏱️ Caricamento messaggi: 100-300ms (da cache)
- 🔍 Ricerca: 50-100ms (full-text)
- 📊 Statistiche: 200-500ms (pre-calcolate)
- 🔄 Sincronizzazione: Real-time automatica

## Monitoraggio e Debug

### Health Check:
```bash
curl http://localhost:3001/health
```

### Log del Server:
```bash
# Avvia il server con log dettagliati
DEBUG=linda:* npm start
```

### Metriche Performance:
- Tempo di risposta API
- Hit rate della cache
- Sincronizzazione GunDB
- Utilizzo memoria SQLite

## Best Practices

### 1. Gestione Errori
- Sempre implementare fallback a GunDB diretto
- Gestire timeout delle API
- Loggare errori per debug

### 2. Cache Strategy
- Invalidare cache quando necessario
- Implementare TTL appropriati
- Monitorare dimensioni database

### 3. Sicurezza
- Validare input delle API
- Implementare rate limiting
- Proteggere endpoint sensibili

### 4. Performance
- Usare indici database appropriati
- Implementare paginazione
- Ottimizzare query SQL

## Conclusione

Il server di ottimizzazione di Linda fornisce un significativo miglioramento delle performance mantenendo **GunDB come storage finale di riferimento**. Questo approccio garantisce:

- ✅ **Performance migliorate** (10x più veloce)
- ✅ **Ricerca avanzata** (full-text search)
- ✅ **Analytics** (statistiche dettagliate)
- ✅ **Affidabilità** (fallback a GunDB)
- ✅ **Sincronizzazione automatica** (real-time)

Il server agisce come un layer di ottimizzazione intelligente senza compromettere l'architettura decentralizzata di Linda.
