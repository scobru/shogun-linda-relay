const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const compression = require("compression");
const sqlite3 = require("sqlite3").verbose();
const { ShogunCore } = require("shogun-core");
const Fuse = require("fuse.js");
const { Server } = require("socket.io");
const http = require("http");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});
const PORT = process.env.PORT || 8765;

// Middleware
app.use(helmet());
app.use(compression());
app.use(
  cors({
    origin: "*", // process.env.FRONTEND_URL || 'https://linda.shogun-eco.xyz',
    credentials: true,
  })
);
app.use(express.json({ limit: "50mb" }));

// SQLite database
const db = new sqlite3.Database("./linda_optimization.db");

// Shogun Core connection (same as client)
let gun = null;
let core = null;

// Initialize Shogun Core with same config as client
async function initializeShogunCore() {
  try {
    console.log("🔧 Initializing Shogun Core for server...");

    // Same peers and config as client
    const peers = process.env.GUNDB_PEERS
      ? process.env.GUNDB_PEERS.split(",")
      : [
          "https://relay.shogun-eco.xyz/gun",
          "https://v5g5jseqhgkp43lppgregcfbvi.srv.us/gun",
          "https://peer.wallie.io/gun",
        ];

    core = new ShogunCore({
      appName: "Linda Username Server",
      appDescription: "Username tracking for Linda messaging",
      appUrl: "http://localhost:3001",
      gunOptions: {
        authToken: "shogun2025",
        peers: peers,
        radisk: true,
        localStorage: false,
        ws: true,
      },
    });

    gun = core.gun;

    console.log("✅ Shogun Core initialized for server with peers:", peers);
    return true;
  } catch (error) {
    console.error("❌ Failed to initialize Shogun Core:", error);
    return false;
  }
}

// Configuration
const CONFIG = {
  // Username Index
  MAX_USERNAME_RESULTS: 20,
  FUSE_THRESHOLD: 0.3,
};

// In-memory cache
let usernameIndex = new Map();
let fuseIndex = null;

// Fuse.js configuration for fuzzy search
const fuseOptions = {
  keys: [
    { name: "username", weight: 0.7 },
    { name: "displayName", weight: 0.3 },
  ],
  threshold: CONFIG.FUSE_THRESHOLD,
  includeScore: true,
  minMatchCharLength: 2,
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
      db.run(`ALTER TABLE usernames ADD COLUMN epub TEXT`, (err) => {
        if (err) {
          if (err.message.includes("duplicate column name")) {
            console.log("✅ Epub column already exists in usernames table");
          } else {
            console.error("❌ Error adding epub column:", err);
          }
        } else {
          console.log("✅ Added epub column to usernames table");
        }
      });

      // Indexes for performance
      db.run(`CREATE INDEX IF NOT EXISTS idx_username ON usernames(username)`);
      db.run(
        `CREATE INDEX IF NOT EXISTS idx_display_name ON usernames(display_name)`
      );
      db.run(`CREATE INDEX IF NOT EXISTS idx_user_pub ON usernames(user_pub)`);

      // Load data into memory
      loadUsernamesFromDB();
      console.log("✅ Database initialized");
      resolve();
    });
  });
}

// ============================================================================
// USERNAME INDEX FUNCTIONS
// ============================================================================

function loadUsernamesFromDB() {
  db.all("SELECT * FROM usernames", (err, rows) => {
    if (err) {
      console.error("❌ Failed to load usernames from DB:", err);
      return;
    }

    usernameIndex.clear();
    rows.forEach((row) => {
      usernameIndex.set(row.username.toLowerCase(), {
        userId: row.user_pub,
        username: row.username,
        displayName: row.display_name || row.username,
        pub: row.user_pub,
        epub: row.epub,
        lastSeen: row.last_seen || Date.now(),
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

  db.run(
    `
    INSERT OR REPLACE INTO usernames (username, display_name, user_pub, epub, last_seen)
    VALUES (?, ?, ?, ?, ?)
  `,
    [username, displayName, userPub, epub, lastSeen || Date.now()],
    (err) => {
      if (err) {
        console.error("❌ Failed to save username to DB:", err);
      }
    }
  );
}

async function addUsernameToIndex(userData) {
  const key = userData.username.toLowerCase();
  const existing = usernameIndex.get(key);

  usernameIndex.set(key, userData);
  rebuildFuseIndex();
  saveUsernameToDB(userData);

  // Log changes (GunDB handles sync, no Socket.IO needed for persistent data)
  if (!existing) {
    console.log(`✅ Added new user ${userData.username} to index`);
  } else if (existing.epub !== userData.epub && userData.epub) {
    console.log(`✅ Updated epub for ${userData.username}`);
  } else if (existing.displayName !== userData.displayName) {
    console.log(`✅ Updated display name for ${userData.username}`);
  } else {
    console.log(`✅ Updated ${userData.username} in index`);
  }
}

// ============================================================================
// GUNDB SYNC
// ============================================================================

async function syncWithGunDB() {
  console.log("🔄 Starting GunDB sync...");

  try {
    // Listen for username mappings (usernames/username -> userPub)
    gun
      .get("usernames")
      .map()
      .on(async (userPub, username) => {
        if (userPub && username) {
          console.log(
            `📝 Username mapping detected: ${username} -> ${userPub.substring(
              0,
              16
            )}...`
          );

          // Try to get the epub for this user
          let epub = null;
          try {
            epub = await new Promise((resolve) => {
              const timeout = setTimeout(() => resolve(null), 3000);
              gun
                .get(userPub)
                .get("epub")
                .once((data) => {
                  clearTimeout(timeout);
                  resolve(data || null);
                });
            });
          } catch (error) {
            console.log("⚠️ Could not fetch epub for user:", username);
          }

          addUsernameToIndex({
            userId: userPub,
            username: username,
            displayName: username,
            userPub: userPub,
            epub: epub,
            lastSeen: Date.now(),
          });
        }
      });

    // Listen for alias mappings (~@username -> userPub)
    gun
      .get("~@")
      .map()
      .on(async (aliasData, username) => {
        if (aliasData && username) {
          console.log(
            `📝 Alias mapping detected: ~@${username} -> ${aliasData.substring(
              0,
              16
            )}...`
          );

          // Extract userPub from alias data
          const userPub = aliasData
            .replace("~@", "")
            .replace(username, "")
            .replace(/^~/, "");

          if (userPub && userPub.length > 10) {
            // Try to get the epub for this user
            let epub = null;
            try {
              epub = await new Promise((resolve) => {
                const timeout = setTimeout(() => resolve(null), 3000);
                gun
                  .get(userPub)
                  .get("epub")
                  .once((data) => {
                    clearTimeout(timeout);
                    resolve(data || null);
                  });
              });
            } catch (error) {
              console.log("⚠️ Could not fetch epub for user:", username);
            }

            addUsernameToIndex({
              userId: userPub,
              username: username,
              displayName: username,
              userPub: userPub,
              epub: epub,
              lastSeen: Date.now(),
            });
          }
        }
      });

    // Listen for new registered users (legacy path)
    gun
      .get("users")
      .map()
      .on(async (userData, userId) => {
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
                gun
                  .get(userPub)
                  .get("epub")
                  .once((data) => {
                    clearTimeout(timeout);
                    resolve(data || null);
                  });
              });

              // Approach 2: Via user keys if first approach failed
              if (!epub) {
                epub = await new Promise((resolve) => {
                  const timeout = setTimeout(() => resolve(null), 2000);
                  gun
                    .get(userPub)
                    .get("user")
                    .get("epub")
                    .once((data) => {
                      clearTimeout(timeout);
                      resolve(data || null);
                    });
                });
              }
            }
          } catch (error) {
            console.log("⚠️ Could not fetch epub for user:", userData.alias);
          }

          addUsernameToIndex({
            userId,
            username: userData.alias,
            displayName: userData.displayName || userData.alias,
            userPub: userData.pub || userId,
            epub: epub,
            lastSeen: userData.lastSeen || Date.now(),
          });
        }
      });

    // Listen for display name updates
    gun
      .get("displayNames")
      .map()
      .on((displayData, username) => {
        if (displayData && displayData.userPub) {
          console.log(
            `🔄 Display name update received: ${username} for ${displayData.userPub.substring(
              0,
              16
            )}...`
          );

          // Find existing user by userPub (not by username, since username might have changed)
          let existingUser = null;
          for (const [key, userData] of usernameIndex.entries()) {
            if (userData.userPub === displayData.userPub) {
              existingUser = userData;
              // Remove old username from index if it changed
              if (key !== username.toLowerCase()) {
                console.log(
                  `📝 Username changed from "${key}" to "${username.toLowerCase()}"`
                );
                usernameIndex.delete(key);
              }
              break;
            }
          }

          if (existingUser) {
            // Update with new username and display name
            addUsernameToIndex({
              userId: displayData.userPub,
              username: username,
              displayName: username,
              userPub: displayData.userPub,
              pub: displayData.userPub,
              epub: existingUser.epub,
              lastSeen: Date.now(),
            });
          } else {
            console.log(
              `⚠️ User not found in index, adding as new user: ${username}`
            );
            // User not found, add as new entry (might be first time setting display name)
            addUsernameToIndex({
              userId: displayData.userPub,
              username: username,
              displayName: username,
              userPub: displayData.userPub,
              pub: displayData.userPub,
              epub: null,
              lastSeen: Date.now(),
            });
          }
        }
      });

    // Listen for epub key updates (when users publish their encryption keys)
    // This is a more generic approach - listen to all user nodes for epub changes
    let epubListenerActive = false;

    function startEpubListener() {
      if (epubListenerActive) return;
      epubListenerActive = true;

      console.log("🔑 Starting epub key listener...");

      // Listen to all user nodes for epub changes
      gun
        .get("users")
        .map()
        .on(async (userData, userId) => {
          if (userData && userId) {
            const userPub = userData.pub || userId;

            // Listen for epub changes on this specific user
            gun
              .get(userPub)
              .get("epub")
              .on(async (epubData) => {
                if (
                  epubData &&
                  typeof epubData === "string" &&
                  epubData.length > 10
                ) {
                  console.log(
                    `🔑 Epub key published for user: ${userPub.substring(
                      0,
                      16
                    )}...`
                  );

                  // Find user in our index and update epub
                  let foundUser = null;
                  for (const [key, userData] of usernameIndex.entries()) {
                    if (userData.userPub === userPub) {
                      foundUser = userData;
                      break;
                    }
                  }

                  if (foundUser) {
                    console.log(`✅ Updated epub for ${foundUser.username}`);
                    addUsernameToIndex({
                      ...foundUser,
                      epub: epubData,
                      lastSeen: Date.now(),
                    });
                  }
                }
              });
          }
        });
    }

    // Start epub listener after a short delay
    setTimeout(startEpubListener, 2000);

    console.log("✅ GunDB sync active");
  } catch (error) {
    console.error("❌ GunDB sync failed:", error);
  }
}

// ============================================================================
// SOCKET.IO REAL-TIME NOTIFICATIONS
// ============================================================================

// Track online users
const onlineUsers = new Map(); // userPub -> socket.id

io.on("connection", (socket) => {
  console.log(`🔌 Client connected: ${socket.id}`);

  // User joins with their pub key
  socket.on("join", (data) => {
    const userPub = data.userPub;
    console.log(`👤 Client joined: ${userPub?.substring(0, 16)}...`);
    socket.join(`user:${userPub}`);
    onlineUsers.set(userPub, socket.id);

    // Notify others that this user is online
    socket.broadcast.emit("userPresence", {
      userPub,
      isOnline: true,
      lastSeen: Date.now(),
    });
  });

  // Handle disconnect
  socket.on("disconnect", () => {
    console.log(`🔌 Client disconnected: ${socket.id}`);

    // Find and remove user from online list
    for (const [userPub, socketId] of onlineUsers.entries()) {
      if (socketId === socket.id) {
        onlineUsers.delete(userPub);

        // Notify others that this user is offline
        socket.broadcast.emit("userPresence", {
          userPub,
          isOnline: false,
          lastSeen: Date.now(),
        });
        break;
      }
    }
  });

  // === EPHEMERAL EVENTS ===

  // Typing indicator
  socket.on("typing", (data) => {
    const { senderPub, recipientPub, isTyping } = data;
    console.log(
      `⌨️ ${senderPub?.substring(0, 8)}... is ${
        isTyping ? "typing" : "stopped typing"
      } to ${recipientPub?.substring(0, 8)}...`
    );

    // Send only to recipient
    io.to(`user:${recipientPub}`).emit("userTyping", {
      senderPub,
      recipientPub,
      isTyping,
    });
  });

  // Message read receipt
  socket.on("messageRead", (data) => {
    const { messageId, readerPub, senderPub } = data;
    console.log(
      `✓✓ Message ${messageId?.substring(
        0,
        8
      )}... read by ${readerPub?.substring(0, 8)}...`
    );

    // Notify sender that message was read
    io.to(`user:${senderPub}`).emit("messageRead", {
      messageId,
      readerPub,
    });
  });

  // Presence update
  socket.on("presence", (data) => {
    const { userPub, isOnline, lastSeen } = data;
    console.log(
      `👤 Presence update: ${userPub?.substring(0, 8)}... is ${
        isOnline ? "online" : "offline"
      }`
    );

    if (isOnline) {
      onlineUsers.set(userPub, socket.id);
    } else {
      onlineUsers.delete(userPub);
    }

    // Broadcast to all clients
    socket.broadcast.emit("userPresence", {
      userPub,
      isOnline,
      lastSeen,
    });
  });

  // === PERSISTENT EVENTS (for optimization notifications) ===

  // Message sent notification
  socket.on("messageSent", (data) => {
    const { messageId, senderPub, recipientPub, timestamp } = data;
    console.log(
      `📨 Message sent: ${messageId?.substring(0, 8)}... from ${senderPub?.substring(0, 8)}... to ${recipientPub?.substring(0, 8)}...`
    );

    // Notify recipient that a new message was sent
    io.to(`user:${recipientPub}`).emit("messageReceived", {
      messageId,
      senderPub,
      recipientPub,
      timestamp,
    });
  });

  // Chat started notification
  socket.on("startChat", (data) => {
    const { userPub } = data;
    console.log(
      `💬 Chat started with: ${userPub?.substring(0, 16)}...`
    );

    // Could notify the other user that someone wants to chat
    // (optional - currently not used in client)
  });

  // Contact updated notification
  socket.on("contactUpdated", (data) => {
    const { contactPub, contactName, action, timestamp } = data;
    console.log(
      `👤 Contact ${action}: ${contactName} (${contactPub?.substring(0, 8)}...)`
    );

    // Could broadcast to update contact lists
    // (optional - currently GunDB handles sync)
  });

  // === NOTIFICATION EVENTS ===

  // Message notification (when user receives a new message)
  socket.on("messageNotification", (data) => {
    const { messageId, senderPub, recipientPub, messagePreview, timestamp } = data;
    console.log(
      `🔔 Message notification: ${messageId?.substring(0, 8)}... from ${senderPub?.substring(0, 8)}... to ${recipientPub?.substring(0, 8)}...`
    );

    // Send notification to recipient
    io.to(`user:${recipientPub}`).emit("newMessageNotification", {
      messageId,
      senderPub,
      recipientPub,
      messagePreview,
      timestamp,
      type: "message"
    });
  });

  // Message read notification
  socket.on("messageReadNotification", (data) => {
    const { messageId, readerPub, senderPub, timestamp } = data;
    console.log(
      `✓ Message read notification: ${messageId?.substring(0, 8)}... by ${readerPub?.substring(0, 8)}...`
    );

    // Notify sender that message was read
    io.to(`user:${senderPub}`).emit("messageReadNotification", {
      messageId,
      readerPub,
      timestamp,
      type: "read"
    });
  });

  // Typing notification
  socket.on("typingNotification", (data) => {
    const { senderPub, recipientPub, isTyping, timestamp } = data;
    console.log(
      `⌨️ Typing notification: ${senderPub?.substring(0, 8)}... is ${isTyping ? "typing" : "stopped typing"} to ${recipientPub?.substring(0, 8)}...`
    );

    // Send typing indicator to recipient
    io.to(`user:${recipientPub}`).emit("typingNotification", {
      senderPub,
      recipientPub,
      isTyping,
      timestamp,
      type: "typing"
    });
  });
});

// Helper function to get online users count
function getOnlineUsersCount() {
  return onlineUsers.size;
}

// Helper function to check if user is online
function isUserOnline(userPub) {
  return onlineUsers.has(userPub);
}

// ============================================================================
// API ROUTES
// ============================================================================

// Health check
app.get("/api/health", (req, res) => {
  res.json({
    status: "healthy",
    timestamp: Date.now(),
    config: CONFIG,
    stats: {
      usernames: usernameIndex.size,
      onlineUsers: getOnlineUsersCount(),
    },
  });
});

// Get online status for specific user
app.get("/api/presence/:userPub", (req, res) => {
  const { userPub } = req.params;
  res.json({
    success: true,
    userPub,
    isOnline: isUserOnline(userPub),
    timestamp: Date.now(),
  });
});

// ============================================================================
// USERNAME API
// ============================================================================

// Ricerca username
app.get("/api/search/:username", async (req, res) => {
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
      results = results.concat(
        fuseResults.slice(0, remaining).map((r) => r.item)
      );
    }

    if (results.length > 0) {
      return res.json({
        success: true,
        found: true,
        results: results.map((r) => ({
          username: r.username,
          displayName: r.displayName,
          pub: r.pub,
          epub: r.epub,
          lastSeen: r.lastSeen,
        })),
        total: results.length,
      });
    } else {
      return res.status(404).json({
        success: false,
        found: false,
        error: "User not found",
      });
    }
  } catch (error) {
    console.error("❌ Search error:", error);
    res.status(500).json({
      success: false,
      error: "Internal server error",
    });
  }
});

app.get("/", async (req, res) => {
  res.send(`
    <div>
      <h1>Shogun Linda Username Server</h1>
      <p>This server provides username tracking and search functionality for Linda messaging.</p>
      <p>Available endpoints:</p>
      <ul>
        <li>GET /api/health - Server health status</li>
        <li>GET /api/search/:username - Search users by username</li>
        <li>GET /api/search/pub/:pubKey - Search user by public key</li>
        <li>GET /api/users/:username - Check if username exists</li>
        <li>GET /api/users/pub/:pubKey - Check if user exists by public key</li>
        <li>POST /api/register - Register new user</li>
      </ul>
    </div>
  `);
});

// Ricerca per public key
app.get("/api/search/pub/:pubKey", async (req, res) => {
  try {
    const { pubKey } = req.params;

    console.log(`🔍 Searching for public key: ${pubKey.substring(0, 16)}...`);

    // Cerca nell'indice per public key
    for (const [username, userData] of usernameIndex.entries()) {
      if (userData.pub === pubKey) {
        return res.json({
          success: true,
          found: true,
          results: [
            {
              username: userData.username,
              displayName: userData.displayName,
              pub: userData.pub,
              epub: userData.epub,
              lastSeen: userData.lastSeen,
            },
          ],
          total: 1,
        });
      }
    }

    return res.status(404).json({
      success: false,
      found: false,
      error: "Public key not found",
    });
  } catch (error) {
    console.error("❌ Pub key search error:", error);
    res.status(500).json({
      success: false,
      error: "Internal server error",
    });
  }
});

// Check if user exists by username
app.get("/api/users/:username", async (req, res) => {
  try {
    const { username } = req.params;
    
    console.log(`🔍 Checking if username exists: ${username}`);
    
    const userData = usernameIndex.get(username.toLowerCase());
    
    if (userData) {
      return res.json({
        exists: true,
        username: userData.username,
        displayName: userData.displayName,
        pub: userData.pub,
        epub: userData.epub,
        lastSeen: userData.lastSeen,
      });
    } else {
      return res.status(404).json({
        exists: false,
        error: "User not found",
      });
    }
  } catch (error) {
    console.error("❌ User existence check error:", error);
    return res.status(500).json({
      exists: false,
      error: "Internal server error",
    });
  }
});

// Check if user exists by pub key
app.get("/api/users/pub/:pubKey", async (req, res) => {
  try {
    const { pubKey } = req.params;
    
    console.log(`🔍 Checking if user exists by pub: ${pubKey.substring(0, 16)}...`);
    
    // Search through all users to find one with matching pub
    let foundUser = null;
    for (const [username, userData] of usernameIndex.entries()) {
      if (userData.userPub === pubKey || userData.pub === pubKey) {
        foundUser = userData;
        break;
      }
    }
    
    if (foundUser) {
      return res.json({
        exists: true,
        username: foundUser.username,
        displayName: foundUser.displayName,
        pub: foundUser.pub,
        epub: foundUser.epub,
        lastSeen: foundUser.lastSeen,
      });
    } else {
      return res.status(404).json({
        exists: false,
        error: "User not found",
      });
    }
  } catch (error) {
    console.error("❌ User existence check by pub error:", error);
    return res.status(500).json({
      exists: false,
      error: "Internal server error",
    });
  }
});

// Registra nuovo utente o aggiorna username esistente
app.post("/api/register", async (req, res) => {
  try {
    const { username, displayName, pub } = req.body;

    if (!username || !pub) {
      return res.status(400).json({
        success: false,
        error: "Username and pub are required",
      });
    }

    console.log(
      `📝 Register/Update request: username="${username}" pub="${pub.substring(
        0,
        16
      )}..."`
    );

    // **NEW: Check if user already exists with different username**
    let oldUsername = null;
    for (const [key, userData] of usernameIndex.entries()) {
      if (userData.userPub === pub && key !== username.toLowerCase()) {
        oldUsername = key;
        console.log(
          `📝 Found existing user with old username "${oldUsername}", updating to "${username}"`
        );
        usernameIndex.delete(oldUsername);
        break;
      }
    }

    // Get existing user data to preserve epub
    let existingEpub = null;
    const existingData = usernameIndex.get(username.toLowerCase());
    if (existingData && existingData.userPub === pub) {
      existingEpub = existingData.epub;
    }

    await addUsernameToIndex({
      userId: pub,
      username,
      displayName: displayName || username,
      pub,
      userPub: pub,
      epub: existingEpub,
      lastSeen: Date.now(),
    });

    res.json({
      success: true,
      message: oldUsername
        ? `Username updated from "${oldUsername}" to "${username}"`
        : "User registered successfully",
    });
  } catch (error) {
    console.error("❌ Registration error:", error);
    res.status(500).json({
      success: false,
      error: "Internal server error",
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
      console.error("❌ Failed to initialize Shogun Core, exiting...");
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
    console.error("❌ Failed to start server:", error);
    process.exit(1);
  }
}

// Graceful shutdown
process.on("SIGINT", () => {
  console.log("🛑 Shutting down username server...");
  db.close((err) => {
    if (err) {
      console.error("❌ Error closing database:", err);
    } else {
      console.log("✅ Database connection closed");
    }
    process.exit(0);
  });
});

startServer().catch(console.error);
