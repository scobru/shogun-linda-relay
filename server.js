const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const sqlite3 = require('sqlite3').verbose();
const { ShogunCore } = require('shogun-core');
const Fuse = require('fuse.js');
const cron = require('node-cron');

const app = express();
const PORT = process.env.PORT || 8766;

// Middleware
app.use(helmet());
app.use(compression());
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:3000',
  credentials: true
}));
app.use(express.json({ limit: '50mb' }));

// SQLite database
const db = new sqlite3.Database('./linda_optimization.db');

// Shogun Core connection (same as client)
let gun = null;
let core = null;

// Initialize Shogun Core with same config as client
async function initializeShogunCore() {
  try {
    console.log('🔧 Initializing Shogun Core for server...');
    
    // Same peers and config as client
    const peers = process.env.GUNDB_PEERS ? process.env.GUNDB_PEERS.split(',') : [
      'https://relay.shogun-eco.xyz/gun',
      'https://v5g5jseqhgkp43lppgregcfbvi.srv.us/gun', 
      'https://peer.wallie.io/gun'
    ];
    
    core = new ShogunCore({
      appName: 'Linda Optimization Server',
      appDescription: 'Server optimization for Linda messaging',
      appUrl: 'http://localhost:3001',
      gunOptions: {
        authToken: 'shogun2025',
        peers: peers,
        radisk: true,
        localStorage: false,
        ws:true,
      }
    });
    
    gun = core.gun;
    
    console.log('✅ Shogun Core initialized for server with peers:', peers);
    return true;
  } catch (error) {
    console.error('❌ Failed to initialize Shogun Core:', error);
    return false;
  }
}


// Configurazione
const CONFIG = {
  // Username Index
  MAX_USERNAME_RESULTS: 20,
  FUSE_THRESHOLD: 0.3,
  
  // Message Cache
  MAX_MESSAGES_PER_CONVERSATION: 100,
  CACHE_TTL_SECONDS: 3600, // 1 ora
  CLEANUP_INTERVAL_MINUTES: 30,
  
  // Enhanced Security
  KEY_ROTATION_INTERVAL_MINUTES: 5,
  MAX_EPHEMERAL_KEYS_PER_CONVERSATION: 5,
  INTEGRITY_HASH_TTL_HOURS: 24,
  SECURITY_CLEANUP_INTERVAL_HOURS: 6
};

// In-memory cache
let usernameIndex = new Map();
let fuseIndex = null;
let conversationCache = new Map();

// Configurazione Fuse.js per ricerca fuzzy
const fuseOptions = {
  keys: [
    { name: 'username', weight: 0.7 },
    { name: 'displayName', weight: 0.3 }
  ],
  threshold: CONFIG.FUSE_THRESHOLD,
  includeScore: true,
  minMatchCharLength: 2
};

// ============================================================================
// INIZIALIZZAZIONE DATABASE
// ============================================================================

async function initDatabase() {
  return new Promise((resolve, reject) => {
    // Crea tabelle se non esistono
    db.serialize(() => {
      // Tabella usernames
      db.run(`
        CREATE TABLE IF NOT EXISTS usernames (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          username TEXT UNIQUE NOT NULL,
          display_name TEXT,
          user_pub TEXT NOT NULL,
          last_seen INTEGER,
          created_at INTEGER DEFAULT (strftime('%s', 'now'))
        )
      `);
      
      // Tabella conversations (chat private)
      db.run(`
        CREATE TABLE IF NOT EXISTS conversations (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user1 TEXT NOT NULL,
          user2 TEXT NOT NULL,
          message_id TEXT NOT NULL,
          message_data TEXT NOT NULL,
          timestamp INTEGER,
          is_encrypted INTEGER DEFAULT 0,
          content_preview TEXT,
          created_at INTEGER DEFAULT (strftime('%s', 'now')),
          UNIQUE(user1, user2, message_id)
        )
      `);
      
      // Add missing columns if they don't exist
      db.run(`ALTER TABLE conversations ADD COLUMN is_encrypted INTEGER DEFAULT 0`, (err) => {
        if (err && !err.message.includes('duplicate column name')) {
          console.error('❌ Failed to add is_encrypted column:', err);
        }
      });
      
      db.run(`ALTER TABLE conversations ADD COLUMN content_preview TEXT`, (err) => {
        if (err && !err.message.includes('duplicate column name')) {
          console.error('❌ Failed to add content_preview column:', err);
        }
      });
      
      
      // Tabella rooms (messaggi di room pubbliche)
      db.run(`
        CREATE TABLE IF NOT EXISTS rooms (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          room_id TEXT NOT NULL,
          message_id TEXT NOT NULL,
          message_data TEXT NOT NULL,
          timestamp INTEGER,
          created_at INTEGER DEFAULT (strftime('%s', 'now')),
          UNIQUE(room_id, message_id)
        )
      `);
      
      // Tabella chiavi effimere per sicurezza avanzata
      db.run(`
        CREATE TABLE IF NOT EXISTS ephemeral_keys (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          conversation_id TEXT NOT NULL,
          key_data TEXT NOT NULL,
          timestamp INTEGER,
          created_at INTEGER DEFAULT (strftime('%s', 'now'))
        )
      `);
      
      // Tabella hash di integrità messaggi
      db.run(`
        CREATE TABLE IF NOT EXISTS message_integrity (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          message_id TEXT UNIQUE NOT NULL,
          integrity_hash TEXT NOT NULL,
          timestamp INTEGER,
          created_at INTEGER DEFAULT (strftime('%s', 'now'))
        )
      `);
      
      // Tabella gruppi per chat di gruppo
      db.run(`
        CREATE TABLE IF NOT EXISTS groups (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          group_id TEXT NOT NULL,
          group_data TEXT NOT NULL,
          created_at INTEGER DEFAULT (strftime('%s', 'now')),
          UNIQUE(group_id)
        )
      `);
      
      // Tabella messaggi di gruppo
      db.run(`
        CREATE TABLE IF NOT EXISTS group_messages (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          group_id TEXT NOT NULL,
          message_id TEXT NOT NULL,
          message_data TEXT NOT NULL,
          timestamp INTEGER,
          created_at INTEGER DEFAULT (strftime('%s', 'now')),
          UNIQUE(group_id, message_id)
        )
      `);
      
      // Indici per performance
      db.run(`CREATE INDEX IF NOT EXISTS idx_username ON usernames(username)`);
      db.run(`CREATE INDEX IF NOT EXISTS idx_display_name ON usernames(display_name)`);
      db.run(`CREATE INDEX IF NOT EXISTS idx_user_pub ON usernames(user_pub)`);
      db.run(`CREATE INDEX IF NOT EXISTS idx_conversation ON conversations(user1, user2)`);
      db.run(`CREATE INDEX IF NOT EXISTS idx_timestamp ON conversations(timestamp)`);
      db.run(`CREATE INDEX IF NOT EXISTS idx_room_id ON rooms(room_id)`);
      db.run(`CREATE INDEX IF NOT EXISTS idx_room_timestamp ON rooms(timestamp)`);
      
      // Indici per sicurezza
      db.run(`CREATE INDEX IF NOT EXISTS idx_ephemeral_conversation ON ephemeral_keys(conversation_id)`);
      db.run(`CREATE INDEX IF NOT EXISTS idx_ephemeral_timestamp ON ephemeral_keys(timestamp)`);
      db.run(`CREATE INDEX IF NOT EXISTS idx_integrity_message ON message_integrity(message_id)`);
      db.run(`CREATE INDEX IF NOT EXISTS idx_integrity_timestamp ON message_integrity(timestamp)`);
      
      // Indici per gruppi
      db.run(`CREATE INDEX IF NOT EXISTS idx_group_id ON groups(group_id)`);
      db.run(`CREATE INDEX IF NOT EXISTS idx_group_messages_group ON group_messages(group_id)`);
      db.run(`CREATE INDEX IF NOT EXISTS idx_group_messages_timestamp ON group_messages(timestamp)`);
      
      // Carica dati in memoria
      loadUsernamesFromDB();
      console.log('✅ Database initialized');
      resolve();
    });
  });
}

// ============================================================================
// USERNAME INDEX FUNCTIONS
// ============================================================================

function loadUsernamesFromDB() {
  db.all('SELECT * FROM usernames', (err, rows) => {
    if (err) {
      console.error('❌ Failed to load usernames from DB:', err);
      return;
    }
    
    usernameIndex.clear();
    rows.forEach(row => {
      usernameIndex.set(row.username.toLowerCase(), {
        userId: row.user_pub,
        username: row.username,
        displayName: row.display_name || row.username,
        pub: row.user_pub,
        lastSeen: row.last_seen || Date.now()
      });
    });
    
    rebuildFuseIndex();
    console.log(`📚 Loaded ${usernameIndex.size} usernames from SQLite`);
  });
}

function rebuildFuseIndex() {
  const indexArray = Array.from(usernameIndex.values());
  fuseIndex = new Fuse(indexArray, fuseOptions);
}

function saveUsernameToDB(usernameData) {
  const { username, displayName, userPub, lastSeen } = usernameData;
  
  db.run(`
    INSERT OR REPLACE INTO usernames (username, display_name, user_pub, last_seen)
    VALUES (?, ?, ?, ?)
  `, [username, displayName, userPub, lastSeen || Date.now()], (err) => {
    if (err) {
      console.error('❌ Failed to save username to DB:', err);
    }
  });
}

async function addUsernameToIndex(userData) {
  const key = userData.username.toLowerCase();
  usernameIndex.set(key, userData);
  rebuildFuseIndex();
  saveUsernameToDB(userData);
  console.log(`✅ Added ${userData.username} to index`);
}

// ============================================================================
// MESSAGE CACHE FUNCTIONS
// ============================================================================

function getConversationCacheKey(user1, user2) {
  const [master, slave] = user1 < user2 ? [user1, user2] : [user2, user1];
  return `conv:${master}:${slave}`;
}

function saveMessagesToDB(user1, user2, messages) {
  const [master, slave] = user1 < user2 ? [user1, user2] : [user2, user1];
  
  // Prima cancella i messaggi esistenti per questa conversazione
  db.run('DELETE FROM conversations WHERE user1 = ? AND user2 = ?', [master, slave], (err) => {
    if (err) {
      console.error('❌ Failed to clear old messages:', err);
      return;
    }
    
    // Inserisci i nuovi messaggi
    const stmt = db.prepare(`
      INSERT INTO conversations (user1, user2, message_id, message_data, timestamp)
      VALUES (?, ?, ?, ?, ?)
    `);
    
    messages.forEach(message => {
      stmt.run([master, slave, message.id, JSON.stringify(message), message.timestamp]);
    });
    
    stmt.finalize((err) => {
      if (err) {
        console.error('❌ Failed to save messages to DB:', err);
      } else {
        console.log(`✅ Saved ${messages.length} messages to SQLite`);
      }
    });
  });
}


// Salva messaggi di room nel database
function saveRoomMessagesToDB(roomId, messages) {
  // Prima cancella i messaggi esistenti per questa room
  db.run('DELETE FROM rooms WHERE room_id = ?', [roomId], (err) => {
    if (err) {
      console.error('❌ Failed to clear old room messages:', err);
      return;
    }
    
    // Inserisci i nuovi messaggi con INSERT OR REPLACE per evitare constraint violations
    const stmt = db.prepare(`
      INSERT OR REPLACE INTO rooms (room_id, message_id, message_data, timestamp)
      VALUES (?, ?, ?, ?)
    `);
    
    messages.forEach(message => {
      stmt.run([roomId, message.id, JSON.stringify(message), message.timestamp], (err) => {
        if (err && !err.message.includes('UNIQUE constraint failed')) {
          console.error('❌ Failed to save room message:', err);
        }
      });
    });
    
    stmt.finalize((err) => {
      if (err) {
        console.error('❌ Failed to finalize room messages statement:', err);
      } else {
        console.log(`✅ Saved ${messages.length} room messages to SQLite`);
      }
    });
  });
}

async function cacheConversationMessages(user1, user2) {
  try {
    // Usa lo stesso path del frontend: conv_msg_${sanitizedKey1}_msg_${sanitizedKey2}
    const [masterUser, slaveUser] = user1 < user2 ? [user1, user2] : [user2, user1];
    
    // Sanitizza le chiavi come nel frontend
    const sanitizeKey = (key) => key.replace(/[^a-zA-Z0-9_-]/g, '_');
    const masterPath = `conv_msg_${sanitizeKey(masterUser)}_msg_${sanitizeKey(slaveUser)}`;
    
    return new Promise((resolve) => {
      const messages = [];
      let messageCount = 0;
      
      gun.get(masterPath)
        .map()
        .once((messageData, messageId) => {
          if (messageData && messageData.id && messageCount < CONFIG.MAX_MESSAGES_PER_CONVERSATION) {
            messages.push({
              id: messageData.id,
              from: messageData.from,
              content: messageData.content,
              timestamp: messageData.timestamp,
              isEncrypted: messageData.isEncrypted || false,
              // Enhanced security fields
              integrityHash: messageData.integrityHash,
              securityLevel: messageData.securityLevel,
              keyRotationTimestamp: messageData.keyRotationTimestamp,
              signature: messageData.signature,
              signedAt: messageData.signedAt
            });
            messageCount++;
          }
        }, { wait: 2000 });
      
      setTimeout(() => {
        messages.sort((a, b) => a.timestamp - b.timestamp);
        saveMessagesToDB(user1, user2, messages);
        console.log(`📚 Cached ${messages.length} messages for conversation ${user1}-${user2}`);
        resolve(messages);
      }, 3000);
    });
  } catch (error) {
    console.error('❌ Failed to cache conversation:', error);
    return [];
  }
}


// Cache messaggi di room
async function cacheRoomMessages(roomId) {
  try {
    // Path per messaggi di room in GunDB - usa lo stesso path del RoomManager
    const roomPath = `publicrooms.${roomId}.messages`;
    
    return new Promise((resolve) => {
      const messages = [];
      let messageCount = 0;
      
      gun.get(roomPath)
        .map()
        .once((messageData, messageId) => {
          if (messageData && messageData.id && messageCount < CONFIG.MAX_MESSAGES_PER_CONVERSATION) {
            messages.push({
              id: messageData.id,
              from: messageData.from,
              content: messageData.content,
              timestamp: messageData.timestamp,
              roomId: roomId,
              isEncrypted: messageData.isEncrypted || false
            });
            messageCount++;
          }
        }, { wait: 2000 });
      
      setTimeout(() => {
        messages.sort((a, b) => a.timestamp - b.timestamp);
        saveRoomMessagesToDB(roomId, messages);
        console.log(`📚 Cached ${messages.length} messages for room ${roomId}`);
        resolve(messages);
      }, 3000);
    });
  } catch (error) {
    console.error('❌ Failed to cache room messages:', error);
    return [];
  }
}

// Cache messaggi di gruppo
async function cacheGroupMessages(groupId) {
  try {
    // Path per messaggi di gruppo in GunDB
    const groupPath = `groups.${groupId}.messages`;
    
    return new Promise((resolve) => {
      const messages = [];
      let messageCount = 0;
      
      gun.get(groupPath)
        .map()
        .once((messageData, messageId) => {
          if (messageData && messageData.id && messageCount < CONFIG.MAX_MESSAGES_PER_CONVERSATION) {
            messages.push({
              id: messageData.id,
              from: messageData.from,
              content: messageData.content,
              timestamp: messageData.timestamp,
              groupId: groupId,
              isEncrypted: messageData.isEncrypted || false,
              username: messageData.username,
              // Include encrypted keys for group messages
              encryptedKeys: messageData.encryptedKeys,
              senderEncryptionKey: messageData.senderEncryptionKey
            });
            messageCount++;
          }
        }, { wait: 2000 });
      
      setTimeout(() => {
        messages.sort((a, b) => a.timestamp - b.timestamp);
        saveGroupMessagesToDB(groupId, messages);
        console.log(`📚 Cached ${messages.length} messages for group ${groupId}`);
        resolve(messages);
      }, 3000);
    });
  } catch (error) {
    console.error('❌ Failed to cache group messages:', error);
    return [];
  }
}

// Salva messaggi di gruppo nel database
function saveGroupMessagesToDB(groupId, messages) {
  // Prima cancella i messaggi esistenti per questo gruppo
  db.run('DELETE FROM group_messages WHERE group_id = ?', [groupId], (err) => {
    if (err) {
      console.error('❌ Failed to clear old group messages:', err);
      return;
    }
    
    // Inserisci i nuovi messaggi
    const stmt = db.prepare(`
      INSERT INTO group_messages (group_id, message_id, message_data, timestamp, created_at)
      VALUES (?, ?, ?, ?, ?)
    `);
    
    messages.forEach(message => {
      stmt.run([groupId, message.id, JSON.stringify(message), message.timestamp, Math.floor(Date.now() / 1000)]);
    });
    
    stmt.finalize((err) => {
      if (err) {
        console.error('❌ Failed to save group messages to DB:', err);
      } else {
        console.log(`✅ Saved ${messages.length} group messages to SQLite`);
      }
    });
  });
}

// ============================================================================
// GUNDB SYNC
// ============================================================================

async function syncWithGunDB() {
  console.log('🔄 Starting GunDB sync...');
  
  try {
    // Ascolta per nuovi utenti registrati
    gun.get('users').map().on((userData, userId) => {
      if (userData && userData.alias) {
        addUsernameToIndex({
          userId,
          username: userData.alias,
          displayName: userData.displayName || userData.alias,
          pub: userData.pub,
          lastSeen: userData.lastSeen || Date.now()
        });
      }
    });

    // Ascolta per aggiornamenti display name
    gun.get('displayNames').map().on((displayData, username) => {
      if (displayData && displayData.userPub) {
        const key = username.toLowerCase();
        const existing = usernameIndex.get(key);
        
        if (existing) {
          existing.displayName = username;
          existing.lastSeen = Date.now();
          addUsernameToIndex(existing);
        }
      }
    });

    // Ascolta per nuove room e cachare automaticamente i messaggi
    gun.get('publicrooms').map().on((roomData, roomId) => {
      if (roomData && roomId) {
        console.log(`🏠 New room detected: ${roomId}`);
        // Cacha automaticamente i messaggi della room
        cacheRoomMessages(roomId).then(messages => {
          console.log(`📚 Auto-cached ${messages.length} messages for room ${roomId}`);
        }).catch(error => {
          console.error(`❌ Failed to auto-cache room ${roomId}:`, error);
        });
      }
    });

    // Ascolta per nuovi gruppi e cachare automaticamente i messaggi
    gun.get('groups').map().on((groupData, groupId) => {
      if (groupData && groupId) {
        console.log(`👥 New group detected: ${groupId}`);
        // Cacha automaticamente i messaggi del gruppo
        cacheGroupMessages(groupId).then(messages => {
          console.log(`📚 Auto-cached ${messages.length} messages for group ${groupId}`);
        }).catch(error => {
          console.error(`❌ Failed to auto-cache group ${groupId}:`, error);
        });
      }
    });


    console.log('✅ GunDB sync active');
  } catch (error) {
    console.error('❌ GunDB sync failed:', error);
  }
}

// ============================================================================
// CLEANUP
// ============================================================================

function cleanupOldData() {
  console.log('🧹 Cleaning up old data...');
  
  // Cleanup conversazioni vecchie (più di 7 giorni)
  const sevenDaysAgo = Date.now() - (7 * 24 * 60 * 60 * 1000);
  const timestamp = Math.floor(sevenDaysAgo / 1000);
  
  // Cleanup conversations
  db.run('DELETE FROM conversations WHERE created_at < ?', [timestamp], (err) => {
    if (err) {
      console.error('❌ Failed to cleanup old conversations:', err);
    } else {
      console.log('✅ Cleaned up old conversations');
    }
  });
  
  // Cleanup rooms
  db.run('DELETE FROM rooms WHERE created_at < ?', [timestamp], (err) => {
    if (err) {
      console.error('❌ Failed to cleanup old rooms:', err);
    } else {
      console.log('✅ Cleaned up old rooms');
    }
  });
  
  // Enhanced Security Cleanup
  const securityCleanupInterval = CONFIG.SECURITY_CLEANUP_INTERVAL_HOURS * 60 * 60 * 1000;
  const securityTimestamp = Math.floor((Date.now() - securityCleanupInterval) / 1000);
  
  // Cleanup old ephemeral keys
  db.run('DELETE FROM ephemeral_keys WHERE created_at < ?', [securityTimestamp], (err) => {
    if (err) {
      console.error('❌ Failed to cleanup old ephemeral keys:', err);
    } else {
      console.log('✅ Cleaned up old ephemeral keys');
    }
  });
  
  // Cleanup old integrity hashes
  db.run('DELETE FROM message_integrity WHERE created_at < ?', [securityTimestamp], (err) => {
    if (err) {
      console.error('❌ Failed to cleanup old integrity hashes:', err);
    } else {
      console.log('✅ Cleaned up old integrity hashes');
    }
  });
}

// ============================================================================
// API ROUTES
// ============================================================================

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: Date.now(),
    config: CONFIG,
    stats: {
      usernames: usernameIndex.size,
      conversations: conversationCache.size,
      rooms: 'N/A'   // Will be updated when we add room cache tracking
    }
  });
});

// ============================================================================
// USERNAME API
// ============================================================================

// Ricerca username
app.get('/api/search/:username', async (req, res) => {
  try {
    const { username } = req.params;
    const { limit = CONFIG.MAX_USERNAME_RESULTS } = req.query;
    
    console.log(`🔍 Searching for username: ${username}`);
    
    let results = [];
    
    // 1. Ricerca esatta per username
    const exactMatch = usernameIndex.get(username.toLowerCase());
    if (exactMatch) {
      results.push(exactMatch);
    }
    
    // 2. Ricerca fuzzy con Fuse.js
    if (fuseIndex && results.length < limit) {
      const fuseResults = fuseIndex.search(username);
      const remaining = limit - results.length;
      results = results.concat(fuseResults.slice(0, remaining).map(r => r.item));
    }
    
    if (results.length > 0) {
      return res.json({
        success: true,
        found: true,
        results: results.map(r => ({
          username: r.username,
          displayName: r.displayName,
          pub: r.pub,
          lastSeen: r.lastSeen
        })),
        total: results.length
      });
    } else {
      return res.status(404).json({
        success: false,
        found: false,
        error: "User not found"
      });
    }
  } catch (error) {
    console.error('❌ Search error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

// Ricerca per public key
app.get('/api/search/pub/:pubKey', async (req, res) => {
  try {
    const { pubKey } = req.params;
    
    console.log(`🔍 Searching for public key: ${pubKey.substring(0, 16)}...`);
    
    // Cerca nell'indice per public key
    for (const [username, userData] of usernameIndex.entries()) {
      if (userData.pub === pubKey) {
        return res.json({
          success: true,
          found: true,
          results: [{
            username: userData.username,
            displayName: userData.displayName,
            pub: userData.pub,
            lastSeen: userData.lastSeen
          }],
          total: 1
        });
      }
    }
    
    return res.status(404).json({
      success: false,
      found: false,
      error: "Public key not found"
    });
  } catch (error) {
    console.error('❌ Pub key search error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

// Registra nuovo utente
app.post('/api/register', async (req, res) => {
  try {
    const { username, displayName, pub } = req.body;
    
    if (!username || !pub) {
      return res.status(400).json({
        success: false,
        error: 'Username and pub are required'
      });
    }

    await addUsernameToIndex({
      userId: pub,
      username,
      displayName: displayName || username,
      pub,
      userPub: pub, // Aggiungi userPub per compatibilità
      lastSeen: Date.now()
    });

    res.json({
      success: true,
      message: 'User registered successfully'
    });
  } catch (error) {
    console.error('❌ Registration error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

// ============================================================================
// MESSAGE CACHE API
// ============================================================================

// Ottieni messaggi di una conversazione privata (ottimizzato)
app.get('/api/private-conversation/:user1/:user2', async (req, res) => {
  try {
    const { user1, user2 } = req.params;
    const { limit = 50, offset = 0 } = req.query;
    
    const [master, slave] = user1 < user2 ? [user1, user2] : [user2, user1];
    
    // 1. Prova a prendere da SQLite (cache)
    db.all(`
      SELECT message_data, timestamp, is_encrypted, content_preview
      FROM conversations 
      WHERE user1 = ? AND user2 = ? 
      ORDER BY timestamp ASC 
      LIMIT ? OFFSET ?
    `, [master, slave, parseInt(limit), parseInt(offset)], (err, rows) => {
      if (err) {
        console.error('❌ Failed to load private conversation from SQLite:', err);
        return res.status(500).json({ success: false, error: 'Database error' });
      }
      
      if (rows && rows.length > 0) {
        const messages = rows.map(row => {
          const messageData = JSON.parse(row.message_data);
          return {
            ...messageData,
            cached: true,
            contentPreview: row.content_preview,
            isEncrypted: row.is_encrypted === 1
          };
        });
        
        return res.json({
          success: true,
          messages,
          total: rows.length,
          cached: true,
          cachedAt: Date.now()
        });
      }
      
      // 2. Se non in cache, carica da GunDB e metti in cache
      cachePrivateConversation(user1, user2).then(messages => {
        const limitedMessages = messages.slice(-limit - offset, -offset || undefined);
        
        res.json({
          success: true,
          messages: limitedMessages,
          total: messages.length,
          cached: false,
          cachedAt: Date.now()
        });
      }).catch(error => {
        console.error('❌ Failed to cache private conversation:', error);
        res.status(500).json({ success: false, error: 'Failed to load conversation' });
      });
    });
    
  } catch (error) {
    console.error('❌ Get private conversation error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

// Cache conversazione privata
async function cachePrivateConversation(user1, user2) {
  try {
    const [masterUser, slaveUser] = user1 < user2 ? [user1, user2] : [user2, user1];
    
    // Sanitizza le chiavi come nel frontend
    const sanitizeKey = (key) => key.replace(/[^a-zA-Z0-9_-]/g, '_');
    const masterPath = `conv_msg_${sanitizeKey(masterUser)}_msg_${sanitizeKey(slaveUser)}`;
    
    return new Promise((resolve) => {
      const messages = [];
      let messageCount = 0;
      
      gun.get(masterPath)
        .map()
        .once((messageData, messageId) => {
          if (messageData && messageData.id && messageCount < CONFIG.MAX_MESSAGES_PER_CONVERSATION) {
            const isEncrypted = messageData.isEncrypted || false;
            const contentPreview = isEncrypted ? 
              (messageData.content && messageData.content.startsWith('SEA{') ? 'Encrypted message' : messageData.content) :
              messageData.content;
            
            messages.push({
              id: messageData.id,
              from: messageData.from,
              content: messageData.content,
              timestamp: messageData.timestamp,
              isEncrypted,
              contentPreview,
              // Enhanced security fields
              integrityHash: messageData.integrityHash,
              securityLevel: messageData.securityLevel,
              keyRotationTimestamp: messageData.keyRotationTimestamp,
              signature: messageData.signature,
              signedAt: messageData.signedAt
            });
            messageCount++;
          }
        }, { wait: 2000 });
      
      setTimeout(() => {
        messages.sort((a, b) => a.timestamp - b.timestamp);
        savePrivateMessagesToDB(user1, user2, messages);
        console.log(`📚 Cached ${messages.length} messages for private conversation ${user1}-${user2}`);
        resolve(messages);
      }, 3000);
    });
  } catch (error) {
    console.error('❌ Failed to cache private conversation:', error);
    return [];
  }
}

// Salva messaggi privati nel database
function savePrivateMessagesToDB(user1, user2, messages) {
  const [master, slave] = user1 < user2 ? [user1, user2] : [user2, user1];
  
  // Prima cancella i messaggi esistenti per questa conversazione
  db.run('DELETE FROM conversations WHERE user1 = ? AND user2 = ?', [master, slave], (err) => {
    if (err) {
      console.error('❌ Failed to clear old private messages:', err);
      return;
    }
    
    // Inserisci i nuovi messaggi con INSERT OR REPLACE per evitare constraint violations
    const stmt = db.prepare(`
      INSERT OR REPLACE INTO conversations (user1, user2, message_id, message_data, timestamp, is_encrypted, content_preview)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    
    messages.forEach(message => {
      stmt.run([
        master, 
        slave, 
        message.id, 
        JSON.stringify(message), 
        message.timestamp,
        message.isEncrypted ? 1 : 0,
        message.contentPreview
      ], (err) => {
        if (err && !err.message.includes('UNIQUE constraint failed')) {
          console.error('❌ Failed to save private message:', err);
        }
      });
    });
    
    stmt.finalize((err) => {
      if (err) {
        console.error('❌ Failed to finalize private messages statement:', err);
      } else {
        console.log(`✅ Saved ${messages.length} private messages to SQLite`);
      }
    });
  });
}

// Ottieni messaggi di una conversazione
app.get('/api/conversation/:user1/:user2', async (req, res) => {
  try {
    const { user1, user2 } = req.params;
    const { limit = 50, offset = 0 } = req.query;
    
    const [master, slave] = user1 < user2 ? [user1, user2] : [user2, user1];
    
    // 1. Prova a prendere da SQLite
    db.all(`
      SELECT message_data, timestamp 
      FROM conversations 
      WHERE user1 = ? AND user2 = ? 
      ORDER BY timestamp ASC 
      LIMIT ? OFFSET ?
    `, [master, slave, parseInt(limit), parseInt(offset)], (err, rows) => {
      if (err) {
        console.error('❌ Failed to load from SQLite:', err);
        return res.status(500).json({ success: false, error: 'Database error' });
      }
      
      if (rows && rows.length > 0) {
        const messages = rows.map(row => JSON.parse(row.message_data));
        
        return res.json({
          success: true,
          messages,
          total: rows.length,
          cached: true,
          cachedAt: Date.now()
        });
      }
      
      // 2. Se non in cache, carica da GunDB e metti in cache
      cacheConversationMessages(user1, user2).then(messages => {
        const limitedMessages = messages.slice(-limit - offset, -offset || undefined);
        
        res.json({
          success: true,
          messages: limitedMessages,
          total: messages.length,
          cached: false,
          cachedAt: Date.now()
        });
      }).catch(error => {
        console.error('❌ Failed to cache conversation:', error);
        res.status(500).json({ success: false, error: 'Failed to load conversation' });
      });
    });
    
  } catch (error) {
    console.error('❌ Get conversation error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

// Preload conversazione
app.post('/api/conversation/:user1/:user2/preload', async (req, res) => {
  try {
    const { user1, user2 } = req.params;
    
    const messages = await cacheConversationMessages(user1, user2);
    
    res.json({
      success: true,
      message: `Preloaded ${messages.length} messages`,
      count: messages.length
    });
  } catch (error) {
    console.error('❌ Preload error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to preload conversation'
    });
  }
});

// Invalida cache conversazione
app.delete('/api/conversation/:user1/:user2', async (req, res) => {
  try {
    const { user1, user2 } = req.params;
    const [master, slave] = user1 < user2 ? [user1, user2] : [user2, user1];
    
    db.run('DELETE FROM conversations WHERE user1 = ? AND user2 = ?', [master, slave], (err) => {
      if (err) {
        console.error('❌ Failed to delete conversation:', err);
        return res.status(500).json({ success: false, error: 'Database error' });
      }
      
      res.json({
        success: true,
        message: 'Conversation cache invalidated'
      });
    });
  } catch (error) {
    console.error('❌ Invalidate cache error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});


// ============================================================================
// ROOM CACHE API
// ============================================================================

// Ottieni messaggi di una room
app.get('/api/room/:roomId', async (req, res) => {
  try {
    const { roomId } = req.params;
    const { limit = 50, offset = 0 } = req.query;
    
    // 1. Prova a prendere da SQLite
    db.all(`
      SELECT message_data, timestamp 
      FROM rooms 
      WHERE room_id = ? 
      ORDER BY timestamp ASC 
      LIMIT ? OFFSET ?
    `, [roomId, parseInt(limit), parseInt(offset)], (err, rows) => {
      if (err) {
        console.error('❌ Failed to load room from SQLite:', err);
        return res.status(500).json({ success: false, error: 'Database error' });
      }
      
      if (rows && rows.length > 0) {
        const messages = rows.map(row => JSON.parse(row.message_data));
        
        return res.json({
          success: true,
          messages,
          total: rows.length,
          cached: true,
          cachedAt: Date.now()
        });
      }
      
      // 2. Se non in cache, carica da GunDB e metti in cache
      cacheRoomMessages(roomId).then(messages => {
        const limitedMessages = messages.slice(-limit - offset, -offset || undefined);
        
        res.json({
          success: true,
          messages: limitedMessages,
          total: messages.length,
          cached: false,
          cachedAt: Date.now()
        });
      }).catch(error => {
        console.error('❌ Failed to cache room:', error);
        res.status(500).json({ success: false, error: 'Failed to load room' });
      });
    });
    
  } catch (error) {
    console.error('❌ Get room error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

// Preload room
app.post('/api/room/:roomId/preload', async (req, res) => {
  try {
    const { roomId } = req.params;
    
    const messages = await cacheRoomMessages(roomId);
    
    res.json({
      success: true,
      message: `Preloaded ${messages.length} room messages`,
      count: messages.length
    });
  } catch (error) {
    console.error('❌ Room preload error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to preload room'
    });
  }
});

// Invalida cache room
app.delete('/api/room/:roomId', async (req, res) => {
  try {
    const { roomId } = req.params;
    
    db.run('DELETE FROM rooms WHERE room_id = ?', [roomId], (err) => {
      if (err) {
        console.error('❌ Failed to delete room:', err);
        return res.status(500).json({ success: false, error: 'Database error' });
      }
      
      res.json({
        success: true,
        message: 'Room cache invalidated'
      });
    });
  } catch (error) {
    console.error('❌ Invalidate room cache error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

// Cancella messaggi di una room (sincronizzazione con client)
app.delete('/api/room/:roomId/messages', async (req, res) => {
  try {
    const { roomId } = req.params;
    
    console.log(`🗑️ Clearing messages for room ${roomId} from server cache`);
    
    db.run('DELETE FROM rooms WHERE room_id = ?', [roomId], (err) => {
      if (err) {
        console.error('❌ Failed to clear room messages:', err);
        return res.status(500).json({ success: false, error: 'Database error' });
      }
      
      console.log(`✅ Cleared messages for room ${roomId} from server cache`);
      res.json({
        success: true,
        message: `Messages cleared for room ${roomId}`,
        roomId: roomId
      });
    });
  } catch (error) {
    console.error('❌ Clear room messages error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

// ============================================================================
// GROUP CHAT API
// ============================================================================

// Ottieni tutti i gruppi di un utente
app.get('/api/groups/:userPub', (req, res) => {
  try {
    const { userPub } = req.params;
    
    db.all('SELECT * FROM groups WHERE group_data LIKE ?', [`%"${userPub}"%`], (err, rows) => {
      if (err) {
        console.error('❌ Error fetching groups:', err);
        return res.status(500).json({ error: 'Failed to fetch groups' });
      }
      
      const groups = rows.map(row => {
        try {
          const groupData = JSON.parse(row.group_data);
          return {
            groupId: row.group_id,
            ...groupData,
            createdAt: row.created_at
          };
        } catch (parseError) {
          console.error('❌ Error parsing group data:', parseError);
          return null;
        }
      }).filter(Boolean);
      
      res.json({ success: true, groups });
    });
  } catch (error) {
    console.error('❌ Error in groups API:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Ottieni messaggi di un gruppo
app.get('/api/groups/:groupId/messages', (req, res) => {
  try {
    const { groupId } = req.params;
    const { limit = 50, offset = 0 } = req.query;
    
    db.all(
      'SELECT * FROM group_messages WHERE group_id = ? ORDER BY timestamp DESC LIMIT ? OFFSET ?',
      [groupId, parseInt(limit), parseInt(offset)],
      (err, rows) => {
        if (err) {
          console.error('❌ Error fetching group messages:', err);
          return res.status(500).json({ error: 'Failed to fetch group messages' });
        }
        
        const messages = rows.map(row => {
          try {
            const messageData = JSON.parse(row.message_data);
            return {
              ...messageData,
              timestamp: row.timestamp,
              createdAt: row.created_at
            };
          } catch (parseError) {
            console.error('❌ Error parsing message data:', parseError);
            return null;
          }
        }).filter(Boolean);
        
        res.json({ success: true, data: messages, cached: true });
      }
    );
  } catch (error) {
    console.error('❌ Error in group messages API:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Crea un nuovo gruppo
app.post('/api/groups', (req, res) => {
  try {
    const { groupId, groupData } = req.body;
    
    if (!groupId || !groupData) {
      return res.status(400).json({ error: 'Group ID and data are required' });
    }
    
    db.run(
      'INSERT OR REPLACE INTO groups (group_id, group_data, created_at) VALUES (?, ?, ?)',
      [groupId, JSON.stringify(groupData), Math.floor(Date.now() / 1000)],
      function(err) {
        if (err) {
          console.error('❌ Error creating group:', err);
          return res.status(500).json({ error: 'Failed to create group' });
        }
        
        res.json({ success: true, groupId });
      }
    );
  } catch (error) {
    console.error('❌ Error in create group API:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Salva un messaggio di gruppo
app.post('/api/groups/:groupId/messages', (req, res) => {
  try {
    const { groupId } = req.params;
    const { messageId, messageData, timestamp } = req.body;
    
    if (!messageId || !messageData) {
      return res.status(400).json({ error: 'Message ID and data are required' });
    }
    
    db.run(
      'INSERT OR REPLACE INTO group_messages (group_id, message_id, message_data, timestamp, created_at) VALUES (?, ?, ?, ?, ?)',
      [groupId, messageId, JSON.stringify(messageData), timestamp || Date.now(), Math.floor(Date.now() / 1000)],
      function(err) {
        if (err) {
          console.error('❌ Error saving group message:', err);
          return res.status(500).json({ error: 'Failed to save group message' });
        }
        
        res.json({ success: true, messageId });
      }
    );
  } catch (error) {
    console.error('❌ Error in save group message API:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ============================================================================
// SEARCH AND ANALYTICS API
// ============================================================================

// Ricerca full-text nei messaggi
app.get('/api/search/messages', async (req, res) => {
  try {
    const { query, type = 'all', limit = 20 } = req.query;
    
    if (!query || query.length < 2) {
      return res.status(400).json({
        success: false,
        error: 'Query must be at least 2 characters long'
      });
    }
    
    let searchQuery = '';
    let params = [];
    
    if (type === 'private') {
      searchQuery = `
        SELECT message_data, timestamp, content_preview, 'private' as type
        FROM conversations 
        WHERE content_preview LIKE ? 
        ORDER BY timestamp DESC 
        LIMIT ?
      `;
      params = [`%${query}%`, parseInt(limit)];
    } else if (type === 'group') {
      searchQuery = `
        SELECT message_data, timestamp, group_id, 'group' as type
        FROM group_messages 
        WHERE message_data LIKE ? 
        ORDER BY timestamp DESC 
        LIMIT ?
      `;
      params = [`%${query}%`, parseInt(limit)];
    } else if (type === 'room') {
      searchQuery = `
        SELECT message_data, timestamp, room_id, 'room' as type
        FROM rooms 
        WHERE message_data LIKE ? 
        ORDER BY timestamp DESC 
        LIMIT ?
      `;
      params = [`%${query}%`, parseInt(limit)];
    } else {
      // Search all types
      searchQuery = `
        SELECT message_data, timestamp, content_preview, 'private' as type FROM conversations WHERE content_preview LIKE ?
        UNION ALL
        SELECT message_data, timestamp, NULL as content_preview, 'group' as type FROM group_messages WHERE message_data LIKE ?
        UNION ALL
        SELECT message_data, timestamp, NULL as content_preview, 'room' as type FROM rooms WHERE message_data LIKE ?
        ORDER BY timestamp DESC 
        LIMIT ?
      `;
      params = [`%${query}%`, `%${query}%`, `%${query}%`, parseInt(limit)];
    }
    
    db.all(searchQuery, params, (err, rows) => {
      if (err) {
        console.error('❌ Search error:', err);
        return res.status(500).json({ success: false, error: 'Database error' });
      }
      
      const results = rows.map(row => {
        const messageData = JSON.parse(row.message_data);
        return {
          id: messageData.id,
          content: messageData.content,
          contentPreview: row.content_preview || messageData.content,
          from: messageData.from,
          timestamp: row.timestamp,
          type: row.type,
          groupId: row.group_id || messageData.groupId,
          roomId: row.room_id || messageData.roomId,
          username: messageData.username
        };
      });
      
      res.json({
        success: true,
        results,
        total: results.length,
        query,
        type
      });
    });
    
  } catch (error) {
    console.error('❌ Search error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

// Statistiche delle conversazioni
app.get('/api/stats/conversations', async (req, res) => {
  try {
    const { userPub } = req.query;
    
    if (!userPub) {
      return res.status(400).json({
        success: false,
        error: 'User public key is required'
      });
    }
    
    // Statistiche per conversazioni private
    db.all(`
      SELECT 
        COUNT(*) as total_messages,
        COUNT(DISTINCT CASE WHEN user1 = ? THEN user2 ELSE user1 END) as total_contacts,
        MAX(timestamp) as last_activity,
        SUM(CASE WHEN is_encrypted = 1 THEN 1 ELSE 0 END) as encrypted_messages
      FROM conversations 
      WHERE user1 = ? OR user2 = ?
    `, [userPub, userPub, userPub], (err, privateStats) => {
      if (err) {
        console.error('❌ Stats error:', err);
        return res.status(500).json({ success: false, error: 'Database error' });
      }
      
      // Statistiche per gruppi
      db.all(`
        SELECT 
          COUNT(*) as total_group_messages,
          COUNT(DISTINCT group_id) as total_groups,
          MAX(timestamp) as last_group_activity
        FROM group_messages 
        WHERE message_data LIKE ?
      `, [`%"${userPub}"%`], (err, groupStats) => {
        if (err) {
          console.error('❌ Group stats error:', err);
          return res.status(500).json({ success: false, error: 'Database error' });
        }
        
        // Statistiche per room
        db.all(`
          SELECT 
            COUNT(*) as total_room_messages,
            COUNT(DISTINCT room_id) as total_rooms,
            MAX(timestamp) as last_room_activity
          FROM rooms
        `, [], (err, roomStats) => {
          if (err) {
            console.error('❌ Room stats error:', err);
            return res.status(500).json({ success: false, error: 'Database error' });
          }
          
          const stats = {
            private: privateStats[0] || { total_messages: 0, total_contacts: 0, last_activity: 0, encrypted_messages: 0 },
            groups: groupStats[0] || { total_group_messages: 0, total_groups: 0, last_group_activity: 0 },
            rooms: roomStats[0] || { total_room_messages: 0, total_rooms: 0, last_room_activity: 0 },
            total: {
              messages: (privateStats[0]?.total_messages || 0) + 
                      (groupStats[0]?.total_group_messages || 0) + 
                      (roomStats[0]?.total_room_messages || 0),
              encrypted: privateStats[0]?.encrypted_messages || 0
            }
          };
          
          res.json({
            success: true,
            stats,
            generatedAt: Date.now()
          });
        });
      });
    });
    
  } catch (error) {
    console.error('❌ Stats error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

// ============================================================================
// SECURITY API
// ============================================================================

// Ottieni stato sicurezza
app.get('/api/security/status', (req, res) => {
  try {
    const securityStatus = {
      keyRotationEnabled: true,
      integrityCheckEnabled: true,
      doubleLayerEncryption: true,
      ephemeralKeysCount: 0, // Will be updated when we track this
      lastSecurityCleanup: Date.now(),
      config: {
        keyRotationInterval: CONFIG.KEY_ROTATION_INTERVAL_MINUTES,
        maxEphemeralKeys: CONFIG.MAX_EPHEMERAL_KEYS_PER_CONVERSATION,
        integrityHashTTL: CONFIG.INTEGRITY_HASH_TTL_HOURS
      }
    };
    
    res.json({
      success: true,
      status: securityStatus
    });
  } catch (error) {
    console.error('❌ Security status error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

// Pulisci chiavi effimere vecchie
app.post('/api/security/cleanup-keys', (req, res) => {
  try {
    const { conversationId } = req.body;
    
    if (conversationId) {
      // Pulisci chiavi per una conversazione specifica
      db.run('DELETE FROM ephemeral_keys WHERE conversation_id = ? AND created_at < ?', 
        [conversationId, Math.floor((Date.now() - CONFIG.INTEGRITY_HASH_TTL_HOURS * 60 * 60 * 1000) / 1000)], 
        (err) => {
          if (err) {
            console.error('❌ Failed to cleanup ephemeral keys:', err);
            return res.status(500).json({ success: false, error: 'Database error' });
          }
          
          res.json({
            success: true,
            message: `Cleaned up ephemeral keys for conversation ${conversationId}`
          });
        });
    } else {
      // Pulisci tutte le chiavi vecchie
      db.run('DELETE FROM ephemeral_keys WHERE created_at < ?', 
        [Math.floor((Date.now() - CONFIG.INTEGRITY_HASH_TTL_HOURS * 60 * 60 * 1000) / 1000)], 
        (err) => {
          if (err) {
            console.error('❌ Failed to cleanup ephemeral keys:', err);
            return res.status(500).json({ success: false, error: 'Database error' });
          }
          
          res.json({
            success: true,
            message: 'Cleaned up all old ephemeral keys'
          });
        });
    }
  } catch (error) {
    console.error('❌ Security cleanup error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

// Verifica integrità messaggio
app.post('/api/security/verify-integrity', (req, res) => {
  try {
    const { messageId, integrityHash } = req.body;
    
    if (!messageId || !integrityHash) {
      return res.status(400).json({
        success: false,
        error: 'Message ID and integrity hash are required'
      });
    }
    
    db.get('SELECT integrity_hash FROM message_integrity WHERE message_id = ?', [messageId], (err, row) => {
      if (err) {
        console.error('❌ Failed to verify integrity:', err);
        return res.status(500).json({ success: false, error: 'Database error' });
      }
      
      if (!row) {
        return res.json({
          success: true,
          verified: false,
          message: 'Message not found in integrity database'
        });
      }
      
      const isVerified = row.integrity_hash === integrityHash;
      
      res.json({
        success: true,
        verified: isVerified,
        message: isVerified ? 'Message integrity verified' : 'Message integrity failed'
      });
    });
  } catch (error) {
    console.error('❌ Integrity verification error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

// Registra hash di integrità
app.post('/api/security/register-integrity', (req, res) => {
  try {
    const { messageId, integrityHash } = req.body;
    
    if (!messageId || !integrityHash) {
      return res.status(400).json({
        success: false,
        error: 'Message ID and integrity hash are required'
      });
    }
    
    db.run('INSERT OR REPLACE INTO message_integrity (message_id, integrity_hash, timestamp) VALUES (?, ?, ?)', 
      [messageId, integrityHash, Date.now()], (err) => {
        if (err) {
          console.error('❌ Failed to register integrity hash:', err);
          return res.status(500).json({ success: false, error: 'Database error' });
        }
        
        res.json({
          success: true,
          message: 'Integrity hash registered successfully'
        });
      });
  } catch (error) {
    console.error('❌ Integrity registration error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

// ============================================================================
// SERVER STARTUP
// ============================================================================

async function startServer() {
  try {
    await initDatabase();
    
    // Initialize Shogun Core with same config as client
    const shogunInitialized = await initializeShogunCore();
    if (!shogunInitialized) {
      console.error('❌ Failed to initialize Shogun Core, exiting...');
      process.exit(1);
    }
    
    await syncWithGunDB();
    
    // Pre-cacha tutte le room esistenti
    await preloadExistingRooms();
    
    
    // Cleanup periodico
    cron.schedule(`*/${CONFIG.CLEANUP_INTERVAL_MINUTES} * * * *`, cleanupOldData);
    
    app.listen(PORT, () => {
      console.log(`🚀 Linda Optimization Server running on port ${PORT}`);
      console.log(`📊 Username index: ${usernameIndex.size} entries`);
      console.log(`🔧 Config:`, CONFIG);
    });
  } catch (error) {
    console.error('❌ Failed to start server:', error);
    process.exit(1);
  }
}

// Pre-cacha tutte le room esistenti all'avvio
async function preloadExistingRooms() {
  try {
    console.log('🏠 Pre-loading existing rooms...');
    
    return new Promise((resolve) => {
      const rooms = [];
      
      gun.get('publicrooms').map().once((roomData, roomId) => {
        if (roomData && roomId) {
          rooms.push(roomId);
        }
      }, { wait: 3000 });
      
      setTimeout(async () => {
        console.log(`📚 Found ${rooms.length} existing rooms`);
        
        // Cacha i messaggi per ogni room trovata
        for (const roomId of rooms) {
          try {
            await cacheRoomMessages(roomId);
          } catch (error) {
            console.error(`❌ Failed to pre-cache room ${roomId}:`, error);
          }
        }
        
        console.log('✅ Room pre-loading completed');
        resolve();
      }, 5000);
    });
  } catch (error) {
    console.error('❌ Failed to preload rooms:', error);
  }
}


// Graceful shutdown
process.on('SIGINT', () => {
  console.log('🛑 Shutting down optimization server...');
  db.close((err) => {
    if (err) {
      console.error('❌ Error closing database:', err);
    } else {
      console.log('✅ Database connection closed');
    }
    process.exit(0);
  });
});

startServer().catch(console.error);
