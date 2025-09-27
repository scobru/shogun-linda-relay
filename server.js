const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const sqlite3 = require('sqlite3').verbose();
const { ShogunCore } = require('shogun-core');
const Fuse = require('fuse.js');

const app = express();
const PORT = process.env.PORT || 8765;

// Middleware
app.use(helmet());
app.use(compression());
/* app.use(cors({
  origin: process.env.FRONTEND_URL || 'https://linda.shogun-eco.xyz',
  credentials: true
})); */
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
      // Username table only
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
// GUNDB SYNC
// ============================================================================

async function syncWithGunDB() {
  console.log('🔄 Starting GunDB sync...');
  
  try {
    // Listen for new registered users
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
    
    app.listen(PORT, () => {
      console.log(`🚀 Linda Username Server running on port ${PORT}`);
      console.log(`📊 Username index: ${usernameIndex.size} entries`);
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
