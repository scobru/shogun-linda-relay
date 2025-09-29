const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const sqlite3 = require('sqlite3').verbose();
const { ShogunCore } = require('shogun-core');
const Fuse = require('fuse.js');
const { Server } = require('socket.io');
const http = require('http');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});
const PORT = process.env.PORT || 8765;

// Middleware
app.use(helmet());
app.use(compression());
app.use(cors({
  origin: '*', // process.env.FRONTEND_URL || 'https://linda.shogun-eco.xyz',
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
      appName: 'Linda Username Server',
      appDescription: 'Username tracking for Linda messaging',
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

// Configuration
const CONFIG = {
  // Username Index
  MAX_USERNAME_RESULTS: 20,
  FUSE_THRESHOLD: 0.3
};

// In-memory cache
let usernameIndex = new Map();
let fuseIndex = null;

// Fuse.js configuration for fuzzy search
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
    // Create tables if they don't exist
    db.serialize(() => {
      // Username table
      db.run(`
        CREATE TABLE IF NOT EXISTS usernames (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          username TEXT UNIQUE NOT NULL,
          display_name TEXT,
          user_pub TEXT NOT NULL,
          epub TEXT,
          last_seen INTEGER,
          created_at INTEGER DEFAULT (strftime('%s', 'now'))
        )
      `);
      
      // Add epub column if it doesn't exist (for existing databases)
      db.run(`ALTER TABLE usernames ADD COLUMN epub TEXT`);
      
      
      // Indexes for performance
      db.run(`CREATE INDEX IF NOT EXISTS idx_username ON usernames(username)`);
      db.run(`CREATE INDEX IF NOT EXISTS idx_display_name ON usernames(display_name)`);
      db.run(`CREATE INDEX IF NOT EXISTS idx_user_pub ON usernames(user_pub)`);
      
      // Load data into memory
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
        epub: row.epub,
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
  const { username, displayName, userPub, epub, lastSeen } = usernameData;
  
  db.run(`
    INSERT OR REPLACE INTO usernames (username, display_name, user_pub, epub, last_seen)
    VALUES (?, ?, ?, ?, ?)
  `, [username, displayName, userPub, epub, lastSeen || Date.now()], (err) => {
    if (err) {
      console.error('❌ Failed to save username to DB:', err);
    }
  });
}

async function addUsernameToIndex(userData) {
  const key = userData.username.toLowerCase();
  const existing = usernameIndex.get(key);
  
  usernameIndex.set(key, userData);
  rebuildFuseIndex();
  saveUsernameToDB(userData);
  
  // Notifica via Socket.IO se è un nuovo utente o se l'epub è stato aggiornato
  if (!existing) {
    console.log(`✅ Added new user ${userData.username} to index`);
    notifyUserRegistered(userData);
  } else if (existing.epub !== userData.epub && userData.epub) {
    console.log(`✅ Updated epub for ${userData.username}`);
    notifyEpubUpdated(userData.userPub, userData.epub);
  } else if (existing.displayName !== userData.displayName) {
    console.log(`✅ Updated display name for ${userData.username}`);
    notifyDisplayNameUpdated(userData.userPub, userData.displayName);
  } else {
    console.log(`✅ Updated ${userData.username} in index`);
  }
}


// ============================================================================
// GUNDB SYNC
// ============================================================================

async function syncWithGunDB() {
  console.log('🔄 Starting GunDB sync...');
  
  try {
    // Listen for new registered users
    gun.get('users').map().on(async (userData, userId) => {
      if (userData && userData.alias) {
        // Try to get the epub for this user
        let epub = null;
        try {
          // Try multiple approaches to get epub
          const userPub = userData.pub || userId;
          if (userPub) {
            // Approach 1: Direct epub lookup
            epub = await new Promise((resolve) => {
              const timeout = setTimeout(() => resolve(null), 2000);
              gun.get(userPub).get('epub').once((data) => {
                clearTimeout(timeout);
                resolve(data || null);
              });
            });
            
            // Approach 2: Via user keys if first approach failed
            if (!epub) {
              epub = await new Promise((resolve) => {
                const timeout = setTimeout(() => resolve(null), 2000);
                gun.get(userPub).get('user').get('epub').once((data) => {
                  clearTimeout(timeout);
                  resolve(data || null);
                });
              });
            }
          }
        } catch (error) {
          console.log('⚠️ Could not fetch epub for user:', userData.alias);
        }
        
        addUsernameToIndex({
          userId,
          username: userData.alias,
          displayName: userData.displayName || userData.alias,
          userPub: userData.pub || userId,
          epub: epub,
          lastSeen: userData.lastSeen || Date.now()
        });
      }
    });

    // Listen for display name updates
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

    console.log('✅ GunDB sync active');
  } catch (error) {
    console.error('❌ GunDB sync failed:', error);
  }
}

// ============================================================================
// SOCKET.IO REAL-TIME NOTIFICATIONS
// ============================================================================

io.on('connection', (socket) => {
  console.log(`🔌 Client connected: ${socket.id}`);
  
  // Notifica quando un nuovo utente si registra
  socket.on('join', (data) => {
    console.log(`👤 Client joined: ${data.userPub?.substring(0, 16)}...`);
    socket.join(`user:${data.userPub}`);
  });
  
  // Notifica quando un client si disconnette
  socket.on('disconnect', () => {
    console.log(`🔌 Client disconnected: ${socket.id}`);
  });
  
  // Notifica quando un client inizia una chat
  socket.on('startChat', (data) => {
    console.log(`💬 Client starting chat: ${data.userPub?.substring(0, 16)}...`);
    socket.join(`chat:${data.userPub}`);
  });
  
  // Notifica quando un client invia un messaggio
  socket.on('messageSent', (data) => {
    console.log(`📨 Message sent: ${data.messageId?.substring(0, 16)}...`);
    // Notifica al destinatario se online
    socket.to(`user:${data.recipientPub}`).emit('messageReceived', {
      messageId: data.messageId,
      senderPub: data.senderPub,
      recipientPub: data.recipientPub,
      timestamp: Date.now()
    });
  });
});

// Funzione per notificare tutti i client di un nuovo utente
function notifyUserRegistered(userData) {
  console.log(`📢 Broadcasting new user: ${userData.username}`);
  io.emit('userRegistered', {
    username: userData.username,
    displayName: userData.displayName,
    pub: userData.userPub,
    epub: userData.epub,
    lastSeen: userData.lastSeen,
    timestamp: Date.now()
  });
}

// Funzione per notificare aggiornamenti epub
function notifyEpubUpdated(userPub, epub) {
  console.log(`📢 Broadcasting epub update for: ${userPub.substring(0, 16)}...`);
  io.emit('epubUpdated', {
    userPub,
    epub,
    timestamp: Date.now()
  });
}

// Funzione per notificare aggiornamenti display name
function notifyDisplayNameUpdated(userPub, displayName) {
  console.log(`📢 Broadcasting display name update for: ${userPub.substring(0, 16)}...`);
  io.emit('displayNameUpdated', {
    userPub,
    displayName,
    timestamp: Date.now()
  });
}

// Funzione per notificare nuovo messaggio
function notifyMessageReceived(recipientPub, messageData) {
  console.log(`📢 Broadcasting new message to: ${recipientPub.substring(0, 16)}...`);
  io.to(`user:${recipientPub}`).emit('messageReceived', {
    messageId: messageData.messageId,
    senderPub: messageData.senderPub,
    recipientPub: messageData.recipientPub,
    timestamp: Date.now()
  });
}

// Funzione per notificare aggiornamento contatti
function notifyContactUpdated(userPub, contactData) {
  console.log(`📢 Broadcasting contact update for: ${userPub.substring(0, 16)}...`);
  io.to(`user:${userPub}`).emit('contactUpdated', {
    contactPub: contactData.contactPub,
    contactName: contactData.contactName,
    action: contactData.action, // 'added', 'updated', 'removed'
    timestamp: Date.now()
  });
}

// ============================================================================
// API ROUTES
// ============================================================================

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: Date.now(),
    config: CONFIG,
    stats: {
      usernames: usernameIndex.size
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
          epub: r.epub,
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

app.get('/', async (req, res) => {
  res.send(`
    <div>
      <h1>Shogun Linda Username Server</h1>
      <p>This server provides username tracking and search functionality for Linda messaging.</p>
      <p>Available endpoints:</p>
      <ul>
        <li>GET /api/health - Server health status</li>
        <li>GET /api/search/:username - Search users by username</li>
        <li>GET /api/search/pub/:pubKey - Search user by public key</li>
        <li>POST /api/register - Register new user</li>
      </ul>
    </div>
  `);
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
            epub: userData.epub,
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
    
    server.listen(PORT, () => {
      console.log(`🚀 Linda Username Server running on port ${PORT}`);
      console.log(`📊 Username index: ${usernameIndex.size} entries`);
      console.log(`🔌 Socket.IO server ready for real-time notifications`);
      console.log(`🔧 Config:`, CONFIG);
    });
  } catch (error) {
    console.error('❌ Failed to start server:', error);
    process.exit(1);
  }
}



// Graceful shutdown
process.on('SIGINT', () => {
  console.log('🛑 Shutting down username server...');
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
