const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const compression = require("compression");
const sqlite3 = require("sqlite3").verbose();
const Gun = require("gun");
const Fuse = require("fuse.js");
const { Server } = require("socket.io");
const http = require("http");
const Relays = require("shogun-relays");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});
const PORT = process.env.PORT || 8766;
const SERVER_VERSION = "v1.0.0";

app.use(Gun.serve);

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

// Initialize Shogun Core with same config as client
async function initializeGun() {
  try {
    console.log("🔧 Initializing Shogun Core for server...");

    const relays = await Relays.forceListUpdate();

    console.log("🔧 Relays:", relays);

    // Same peers and config as client
    const peers = process.env.GUNDB_PEERS
      ? process.env.GUNDB_PEERS.split(",")
      : relays;

    gun = Gun({
      web: server,
      peers: peers,
      radisk: true,
      file: "linda-data",
      localStorage: false,
      wire: true,
      axe: true
    });

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

// Rate limiting for user sync
let lastSyncTime = 0;
const SYNC_COOLDOWN = 10000; // 10 seconds between syncs

// Protocol statistics cache
let protocolStatsCache = {
  totalMessages: 0,
  totalGroups: 0,
  totalTokenRooms: 0,
  totalPublicRooms: 0,
  totalConversations: 0,
  totalContacts: 0,
  lastUpdated: Date.now(),
};

// Notification system
const NOTIFICATION_TYPES = {
  CACHE_UPDATED: "cache_updated",
  STATS_UPDATED: "stats_updated",
  SYSTEM_ALERT: "system_alert",
};
const MAX_NOTIFICATIONS_PER_USER = 100;
const userNotificationQueues = new Map();

function queueNotificationForUser(userPub, notification) {
  if (!userPub || !notification) {
    return;
  }

  const type = Object.values(NOTIFICATION_TYPES).includes(notification.type)
    ? notification.type
    : NOTIFICATION_TYPES.SYSTEM_ALERT;

  const normalizedNotification = {
    type,
    data: notification.data !== undefined ? notification.data : {},
    timestamp:
      typeof notification.timestamp === "number"
        ? notification.timestamp
        : Date.now(),
  };

  if (!userNotificationQueues.has(userPub)) {
    userNotificationQueues.set(userPub, []);
  }

  const queue = userNotificationQueues.get(userPub);
  queue.push(normalizedNotification);

  if (queue.length > MAX_NOTIFICATIONS_PER_USER) {
    queue.splice(0, queue.length - MAX_NOTIFICATIONS_PER_USER);
  }
}

function getAndClearNotificationsForUser(userPub, limit) {
  if (!userNotificationQueues.has(userPub)) {
    return [];
  }

  const queue = userNotificationQueues.get(userPub);
  let notifications = [...queue];

  if (
    typeof limit === "number" &&
    !Number.isNaN(limit) &&
    limit > 0 &&
    notifications.length > limit
  ) {
    notifications = notifications.slice(notifications.length - limit);
  }

  userNotificationQueues.set(userPub, []);
  return notifications;
}

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

      // Protocol statistics table
      db.run(`
        CREATE TABLE IF NOT EXISTS protocol_stats (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          stat_type TEXT UNIQUE NOT NULL,
          stat_value INTEGER DEFAULT 0,
          last_updated INTEGER DEFAULT (strftime('%s', 'now')),
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
      loadProtocolStatsFromDB();
      console.log("✅ Database initialized");
      resolve();
    });
  });
}

// ============================================================================
// PROTOCOL STATISTICS FUNCTIONS
// ============================================================================

function loadProtocolStatsFromDB() {
  db.all("SELECT stat_type, stat_value FROM protocol_stats", (err, rows) => {
    if (err) {
      console.error("❌ Failed to load protocol stats from DB:", err);
      return;
    }

    // Reset cache with default values
    protocolStatsCache = {
      totalMessages: 0,
      totalGroups: 0,
      totalTokenRooms: 0,
      totalPublicRooms: 0,
      totalConversations: 0,
      totalContacts: 0,
      lastUpdated: Date.now(),
    };

    // Load values from database
    rows.forEach((row) => {
      switch (row.stat_type) {
        case "totalMessages":
          protocolStatsCache.totalMessages = row.stat_value || 0;
          break;
        case "totalGroups":
          protocolStatsCache.totalGroups = row.stat_value || 0;
          break;
        case "totalTokenRooms":
          protocolStatsCache.totalTokenRooms = row.stat_value || 0;
          break;
        case "totalPublicRooms":
          protocolStatsCache.totalPublicRooms = row.stat_value || 0;
          break;
        case "totalConversations":
          protocolStatsCache.totalConversations = row.stat_value || 0;
          break;
      }
    });

    console.log(`📊 Loaded protocol stats from DB:`, protocolStatsCache);
  });
}

function saveProtocolStatToDB(statType, statValue) {
  db.run(
    `
    INSERT OR REPLACE INTO protocol_stats (stat_type, stat_value, last_updated)
    VALUES (?, ?, ?)
  `,
    [statType, statValue, Date.now()],
    (err) => {
      if (err) {
        console.error(`❌ Failed to save ${statType} to DB:`, err);
      } else {
        console.log(`✅ Saved ${statType}: ${statValue} to database`);
      }
    }
  );
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
  const now = Date.now();

  // Rate limiting: don't sync too frequently
  if (now - lastSyncTime < SYNC_COOLDOWN) {
    return;
  }
  lastSyncTime = now;

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
    // Only sync users who are actively using the app (recent activity)
    gun
      .get("usernames")
      .map()
      .on(async (userPub, username) => {
        if (userPub && username) {
          // Check if this user has recent activity (last 24 hours)
          try {
            const userData = await new Promise((resolve) => {
              const timeout = setTimeout(() => resolve(null), 2000);
              gun.get(userPub).once((data) => {
                clearTimeout(timeout);
                resolve(data || null);
              });
            });

            if (userData && userData.lastSeen) {
              const lastSeen = userData.lastSeen;
              const now = Date.now();
              const dayInMs = 24 * 60 * 60 * 1000;

              // Only sync users with activity in the last 24 hours
              if (now - lastSeen < dayInMs) {
                console.log(
                  `📝 Active user detected: ${username} -> ${userPub.substring(
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
              } else {
                console.log(
                  `⏰ Skipping inactive user: ${username} (last seen: ${new Date(
                    lastSeen
                  ).toISOString()})`
                );
              }
            }
          } catch (error) {
            console.log("⚠️ Could not check user activity:", username);
          }
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

// Track room presence
const roomPresence = new Map(); // roomId -> { roomType, users: Set<userPub>, lastSeen: Map<userPub, timestamp> }

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

  // User joins a room for presence tracking
  socket.on("joinRoom", (data) => {
    const { roomId, roomType, userPub } = data;
    if (!roomId || !roomType || !userPub) return;

    console.log(
      `🏠 User joined room: ${userPub?.substring(
        0,
        8
      )}... -> ${roomId} (${roomType})`
    );

    // Join socket room for targeted notifications
    socket.join(`room:${roomId}`);

    // Update room presence tracking
    if (!roomPresence.has(roomId)) {
      roomPresence.set(roomId, {
        roomType,
        users: new Set(),
        lastSeen: new Map(),
      });
    }

    const room = roomPresence.get(roomId);
    room.users.add(userPub);
    room.lastSeen.set(userPub, Date.now());

    // Notify room members of new presence
    socket.to(`room:${roomId}`).emit("roomPresence", {
      roomId,
      roomType,
      userPubs: Array.from(room.users),
      onlineCount: room.users.size,
      lastSeen: Object.fromEntries(room.lastSeen),
    });
  });

  // User leaves a room
  socket.on("leaveRoom", (data) => {
    const { roomId, userPub } = data;
    if (!roomId || !userPub) return;

    console.log(
      `🏠 User left room: ${userPub?.substring(0, 8)}... -> ${roomId}`
    );

    // Leave socket room
    socket.leave(`room:${roomId}`);

    // Update room presence tracking
    const room = roomPresence.get(roomId);
    if (room) {
      room.users.delete(userPub);
      room.lastSeen.set(userPub, Date.now()); // Update last seen time

      // Notify room members of presence change
      socket.to(`room:${roomId}`).emit("roomPresence", {
        roomId,
        roomType: room.roomType,
        userPubs: Array.from(room.users),
        onlineCount: room.users.size,
        lastSeen: Object.fromEntries(room.lastSeen),
      });
    }
  });

  // Update room presence status
  socket.on("updateRoomPresence", (data) => {
    const { roomId, roomType, userPub, status } = data;
    if (!roomId || !userPub) return;

    console.log(
      `🏠 Room presence update: ${userPub?.substring(
        0,
        8
      )}... -> ${roomId} (${status})`
    );

    const room = roomPresence.get(roomId);
    if (room) {
      if (status === "online") {
        room.users.add(userPub);
      } else if (status === "offline") {
        room.users.delete(userPub);
      }
      room.lastSeen.set(userPub, Date.now());

      // Notify room members
      socket.to(`room:${roomId}`).emit("roomPresence", {
        roomId,
        roomType: room.roomType,
        userPubs: Array.from(room.users),
        onlineCount: room.users.size,
        lastSeen: Object.fromEntries(room.lastSeen),
      });
    }
  });

  // Handle disconnect
  socket.on("disconnect", () => {
    console.log(`🔌 Client disconnected: ${socket.id}`);

    // Find and remove user from online list and all rooms
    for (const [userPub, socketId] of onlineUsers.entries()) {
      if (socketId === socket.id) {
        onlineUsers.delete(userPub);

        // Remove user from all rooms
        for (const [roomId, room] of roomPresence.entries()) {
          if (room.users.has(userPub)) {
            room.users.delete(userPub);
            room.lastSeen.set(userPub, Date.now());

            // Notify room members of presence change
            socket.to(`room:${roomId}`).emit("roomPresence", {
              roomId,
              roomType: room.roomType,
              userPubs: Array.from(room.users),
              onlineCount: room.users.size,
              lastSeen: Object.fromEntries(room.lastSeen),
            });
          }
        }

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

  // Typing indicator - DEPRECATED: Now handled P2P via GunDB
  socket.on("typing", (data) => {
    // Typing notifications are now handled directly between peers via GunDB
    // This event is kept for backward compatibility but does nothing
    if (process.env.NODE_ENV === "development") {
      console.log(
        "⚠️ Typing event received but ignored - use P2P TypingManager instead"
      );
    }
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
      `📨 Message sent: ${messageId?.substring(
        0,
        8
      )}... from ${senderPub?.substring(0, 8)}... to ${recipientPub?.substring(
        0,
        8
      )}...`
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
    console.log(`💬 Chat started with: ${userPub?.substring(0, 16)}...`);

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
    const { messageId, senderPub, recipientPub, messagePreview, timestamp } =
      data;
    console.log(
      `🔔 Message notification: ${messageId?.substring(
        0,
        8
      )}... from ${senderPub?.substring(0, 8)}... to ${recipientPub?.substring(
        0,
        8
      )}...`
    );

    // Send notification to recipient
    io.to(`user:${recipientPub}`).emit("newMessageNotification", {
      messageId,
      senderPub,
      recipientPub,
      messagePreview,
      timestamp,
      type: "message",
    });
  });

  // Message read notification
  socket.on("messageReadNotification", (data) => {
    const { messageId, readerPub, senderPub, timestamp } = data;
    console.log(
      `✓ Message read notification: ${messageId?.substring(
        0,
        8
      )}... by ${readerPub?.substring(0, 8)}...`
    );

    // Notify sender that message was read
    io.to(`user:${senderPub}`).emit("messageReadNotification", {
      messageId,
      readerPub,
      timestamp,
      type: "read",
    });
  });

  // Typing notification - DEPRECATED: Now handled P2P via GunDB
  socket.on("typingNotification", (data) => {
    // Typing notifications are now handled directly between peers via GunDB
    // This event is kept for backward compatibility but does nothing
    if (process.env.NODE_ENV === "development") {
      console.log(
        "⚠️ Typing notification received but ignored - use P2P TypingManager instead"
      );
    }
  });

  // === GROUP NOTIFICATION EVENTS ===

  // Group message notification (when user receives a new group message)
  socket.on("groupMessageNotification", (data) => {
    const {
      messageId,
      senderPub,
      groupId,
      groupName,
      messagePreview,
      timestamp,
      memberPubs,
    } = data;
    console.log(
      `🔔 Group message notification: ${messageId?.substring(
        0,
        8
      )}... from ${senderPub?.substring(
        0,
        8
      )}... in group ${groupName} (${groupId?.substring(0, 8)}...)`
    );

    // Send notification to all group members except sender
    memberPubs.forEach((memberPub) => {
      if (memberPub !== senderPub) {
        io.to(`user:${memberPub}`).emit("newGroupMessageNotification", {
          messageId,
          senderPub,
          groupId,
          groupName,
          messagePreview,
          timestamp,
          type: "group_message",
        });
      }
    });
  });

  // Group typing notification
  socket.on("groupTypingNotification", (data) => {
    const { senderPub, groupId, groupName, isTyping, timestamp, memberPubs } =
      data;
    console.log(
      `⌨️ Group typing notification: ${senderPub?.substring(0, 8)}... is ${
        isTyping ? "typing" : "stopped typing"
      } in group ${groupName}`
    );

    // Send typing indicator to all group members except sender
    memberPubs.forEach((memberPub) => {
      if (memberPub !== senderPub) {
        io.to(`user:${memberPub}`).emit("groupTypingNotification", {
          senderPub,
          groupId,
          groupName,
          isTyping,
          timestamp,
          type: "group_typing",
        });
      }
    });
  });

  // Group member added notification
  socket.on("groupMemberAddedNotification", (data) => {
    const { groupId, groupName, newMemberPub, addedByPub, memberPubs } = data;
    console.log(
      `👥 Group member added: ${newMemberPub?.substring(
        0,
        8
      )}... to group ${groupName} by ${addedByPub?.substring(0, 8)}...`
    );

    // Notify all group members
    memberPubs.forEach((memberPub) => {
      io.to(`user:${memberPub}`).emit("groupMemberAddedNotification", {
        groupId,
        groupName,
        newMemberPub,
        addedByPub,
        type: "group_member_added",
      });
    });
  });

  // Group member removed notification
  socket.on("groupMemberRemovedNotification", (data) => {
    const { groupId, groupName, removedMemberPub, removedByPub, memberPubs } =
      data;
    console.log(
      `👥 Group member removed: ${removedMemberPub?.substring(
        0,
        8
      )}... from group ${groupName} by ${removedByPub?.substring(0, 8)}...`
    );

    // Notify all group members
    memberPubs.forEach((memberPub) => {
      io.to(`user:${memberPub}`).emit("groupMemberRemovedNotification", {
        groupId,
        groupName,
        removedMemberPub,
        removedByPub,
        type: "group_member_removed",
      });
    });
  });

  // === ADDITIONAL NOTIFICATION EVENTS ===

  // Message notification (when user receives a new message)
  socket.on("messageNotification", (data) => {
    const { messageId, senderPub, recipientPub, messagePreview, timestamp } =
      data;
    console.log(
      `🔔 Message notification: ${messageId?.substring(
        0,
        8
      )}... from ${senderPub?.substring(0, 8)}... to ${recipientPub?.substring(
        0,
        8
      )}...`
    );

    // Send notification to recipient
    io.to(`user:${recipientPub}`).emit("newMessageNotification", {
      messageId,
      senderPub,
      recipientPub,
      messagePreview,
      timestamp,
      type: "message",
    });
  });

  // Message read notification
  socket.on("messageReadNotification", (data) => {
    const { messageId, readerPub, senderPub, timestamp } = data;
    console.log(
      `✓ Message read notification: ${messageId?.substring(
        0,
        8
      )}... by ${readerPub?.substring(0, 8)}...`
    );

    // Notify sender that message was read
    io.to(`user:${senderPub}`).emit("messageReadNotification", {
      messageId,
      readerPub,
      timestamp,
      type: "read",
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

// Get protocol statistics from GunDB
async function getProtocolStatisticsFromGunDB() {
  return new Promise((resolve) => {
    let totalMessages = 0;
    let totalGroups = 0;
    let totalTokenRooms = 0;
    let totalPublicRooms = 0;
    let totalConversations = 0;
    let completed = 0;
    const totalChecks = 5;

    const checkComplete = () => {
      completed++;
      if (completed >= totalChecks) {
        resolve({
          totalMessages,
          totalGroups,
          totalTokenRooms,
          totalPublicRooms,
          totalConversations,
        });
      }
    };

    // Count messages from conversations
    gun
      .get("conversations")
      .map()
      .once((conversationData, conversationId) => {
        if (conversationData && conversationData.messages) {
          totalMessages += Object.keys(conversationData.messages).length;
        }
        if (conversationId) {
          totalConversations++;
        }
        checkComplete();
      });

    // Count groups
    gun
      .get("groups")
      .map()
      .once((groupData, groupId) => {
        if (groupId) {
          totalGroups++;
        }
        checkComplete();
      });

    // Count token rooms
    gun
      .get("tokenRooms")
      .map()
      .once((roomData, roomId) => {
        if (roomId) {
          totalTokenRooms++;
        }
        checkComplete();
      });

    // Count public rooms
    gun
      .get("publicRooms")
      .map()
      .once((roomData, roomId) => {
        if (roomId) {
          totalPublicRooms++;
        }
        checkComplete();
      });

    // Count conversations (alternative path)
    gun
      .get("users")
      .map()
      .once((userData, userId) => {
        if (userData && userData.conversations) {
          totalConversations += Object.keys(userData.conversations).length;
        }
        checkComplete();
      });

    // Timeout fallback
    setTimeout(() => {
      if (completed < totalChecks) {
        console.log("⚠️ Protocol stats timeout, returning partial data");
        resolve({
          totalMessages,
          totalGroups,
          totalTokenRooms,
          totalPublicRooms,
          totalConversations,
        });
      }
    }, 5000);
  });
}

// ============================================================================
// API ROUTES
// ============================================================================

// Health check
app.get("/api/health", (req, res) => {
  res.json({
    status: "healthy",
    version: SERVER_VERSION,
    timestamp: Date.now(),
    config: CONFIG,
    stats: {
      usernames: usernameIndex.size,
      onlineUsers: getOnlineUsersCount(),
    },
  });
});

// Protocol statistics endpoint
app.get("/api/stats/protocol", async (req, res) => {
  try {
    console.log("📊 Protocol statistics requested");

    // Return cached stats (updated by notifications)
    res.json({
      success: true,
      timestamp: Date.now(),
      stats: {
        ...protocolStatsCache,
        totalContacts: usernameIndex.size, // Always fresh from our index
        lastUpdated: Date.now(),
      },
    });
  } catch (error) {
    console.error("❌ Protocol stats error:", error);
    res.status(500).json({
      success: false,
      error: "Failed to fetch protocol statistics",
    });
  }
});

// User notification endpoint
app.get("/api/notifications/:userPub", (req, res) => {
  try {
    const { userPub } = req.params;
    if (!userPub) {
      return res.status(400).json({
        success: false,
        error: "userPub is required",
      });
    }

    const limitParam = req.query.limit;
    const parsedLimit = limitParam ? parseInt(limitParam, 10) : undefined;
    const limit =
      typeof parsedLimit === "number" && !Number.isNaN(parsedLimit) && parsedLimit > 0
        ? parsedLimit
        : undefined;

    const notifications = getAndClearNotificationsForUser(userPub, limit);
    res.json(notifications);
  } catch (error) {
    console.error("❌ Notifications fetch error:", error);
    res.status(500).json({
      success: false,
      error: "Failed to fetch notifications",
    });
  }
});

// Message notification (for cache/stat updates)
app.post("/api/notify/message", (req, res) => {
  try {
    const { userPub, messageData, timestamp } = req.body || {};

    if (!userPub || !messageData) {
      return res.status(400).json({
        success: false,
        error: "userPub and messageData are required",
      });
    }

    const eventTimestamp =
      typeof timestamp === "number" ? timestamp : Date.now();

    const recipientPub =
      typeof messageData?.recipientPub === "string"
        ? messageData.recipientPub
        : null;
    const senderPub =
      typeof messageData?.senderPub === "string" ? messageData.senderPub : null;
    const messageId =
      typeof messageData?.messageId === "string" ? messageData.messageId : null;
    const messagePreview =
      typeof messageData?.messagePreview === "string"
        ? messageData.messagePreview
        : null;

    if (recipientPub) {
      queueNotificationForUser(recipientPub, {
        type: NOTIFICATION_TYPES.CACHE_UPDATED,
        data: {
          event: "message",
          messageId,
          senderPub: senderPub || userPub,
          recipientPub,
          messagePreview,
          meta: {
            contentLength: messageData.contentLength,
          },
        },
        timestamp: eventTimestamp,
      });
    }

    queueNotificationForUser(userPub, {
      type: NOTIFICATION_TYPES.CACHE_UPDATED,
      data: {
        event: "message",
        messageId,
        senderPub: userPub,
        recipientPub: recipientPub || senderPub,
        messagePreview,
        meta: {
          contentLength: messageData.contentLength,
        },
      },
      timestamp: eventTimestamp,
    });

    protocolStatsCache.totalMessages++;
    protocolStatsCache.lastUpdated = Date.now();
    saveProtocolStatToDB("totalMessages", protocolStatsCache.totalMessages);

    queueNotificationForUser(userPub, {
      type: NOTIFICATION_TYPES.STATS_UPDATED,
      data: {
        totalMessages: protocolStatsCache.totalMessages,
        totalConversations: protocolStatsCache.totalConversations,
        totalContacts: protocolStatsCache.totalContacts,
        lastUpdated: protocolStatsCache.lastUpdated,
      },
    });

    res.json({
      success: true,
      message: "Message notification queued",
      timestamp: eventTimestamp,
    });
  } catch (error) {
    console.error("❌ Message notification error:", error);
    res.status(500).json({
      success: false,
      error: "Failed to queue message notification",
    });
  }
});

// Conversation notification (for cache/stat updates)
app.post("/api/notify/conversation", (req, res) => {
  try {
    const { userPub, conversationData, timestamp } = req.body || {};

    if (!userPub || !conversationData) {
      return res.status(400).json({
        success: false,
        error: "userPub and conversationData are required",
      });
    }

    const eventTimestamp =
      typeof timestamp === "number" ? timestamp : Date.now();

    const contactPub =
      typeof conversationData?.contactPub === "string"
        ? conversationData.contactPub
        : null;
    const contactName =
      typeof conversationData?.contactName === "string"
        ? conversationData.contactName
        : null;

    if (contactPub && contactPub !== userPub) {
      queueNotificationForUser(contactPub, {
        type: NOTIFICATION_TYPES.CACHE_UPDATED,
        data: {
          event: "conversation",
          initiatorPub: userPub,
          contactPub,
          contactName,
        },
        timestamp: eventTimestamp,
      });
    }

    queueNotificationForUser(userPub, {
      type: NOTIFICATION_TYPES.CACHE_UPDATED,
      data: {
        event: "conversation",
        initiatorPub: userPub,
        contactPub: contactPub || userPub,
        contactName,
      },
      timestamp: eventTimestamp,
    });

    protocolStatsCache.totalConversations++;
    protocolStatsCache.lastUpdated = Date.now();
    saveProtocolStatToDB(
      "totalConversations",
      protocolStatsCache.totalConversations
    );

    queueNotificationForUser(userPub, {
      type: NOTIFICATION_TYPES.STATS_UPDATED,
      data: {
        totalMessages: protocolStatsCache.totalMessages,
        totalConversations: protocolStatsCache.totalConversations,
        totalContacts: protocolStatsCache.totalContacts,
        lastUpdated: protocolStatsCache.lastUpdated,
      },
    });

    res.json({
      success: true,
      message: "Conversation notification queued",
      timestamp: eventTimestamp,
    });
  } catch (error) {
    console.error("❌ Conversation notification error:", error);
    res.status(500).json({
      success: false,
      error: "Failed to queue conversation notification",
    });
  }
});

// Protocol statistics notification endpoint
app.post("/api/stats/notify", (req, res) => {
  try {
    const { type, data, timestamp } = req.body;

    console.log(
      `📊 Protocol notification: ${type}`,
      data ? `(${JSON.stringify(data).substring(0, 100)}...)` : ""
    );

    // Update cached statistics based on notification type
    let statType = null;
    switch (type) {
      case "message":
        protocolStatsCache.totalMessages++;
        statType = "totalMessages";
        break;
      case "group":
        protocolStatsCache.totalGroups++;
        statType = "totalGroups";
        break;
      case "tokenRoom":
        protocolStatsCache.totalTokenRooms++;
        statType = "totalTokenRooms";
        break;
      case "publicRoom":
        protocolStatsCache.totalPublicRooms++;
        statType = "totalPublicRooms";
        break;
      case "conversation":
        protocolStatsCache.totalConversations++;
        statType = "totalConversations";
        break;
      default:
        console.log(`⚠️ Unknown notification type: ${type}`);
        return res.status(400).json({
          success: false,
          error: `Unknown notification type: ${type}`,
        });
    }

    // Save to database
    if (statType) {
      saveProtocolStatToDB(statType, protocolStatsCache[statType]);
    }

    protocolStatsCache.lastUpdated = Date.now();

    res.json({
      success: true,
      message: `Updated ${type} count`,
      timestamp: Date.now(),
    });
  } catch (error) {
    console.error("❌ Protocol notification error:", error);
    res.status(500).json({
      success: false,
      error: "Failed to process notification",
    });
  }
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
      <h1>Shogun Linda Relay</h1>
      <p>This server provides username tracking, search functionality, and real-time notifications for Linda messaging.</p>
      <p>Available endpoints:</p>
      <ul>
        <li>GET /api/health - Server health status</li>
        <li>GET /api/search/:username - Search users by username</li>
        <li>GET /api/search/pub/:pubKey - Search user by public key</li>
        <li>GET /api/users/:username - Check if username exists</li>
        <li>GET /api/users/pub/:pubKey - Check if user exists by public key</li>
        <li>POST /api/register - Register new user</li>
      </ul>
      <h3>Real-time Features:</h3>
      <ul>
        <li>Socket.IO notifications for new messages</li>
        <li>Typing indicators</li>
        <li>Read receipts</li>
        <li>User presence tracking</li>
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

    console.log(
      `🔍 Checking if user exists by pub: ${pubKey.substring(0, 16)}...`
    );

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
    const gunInitialized = await initializeGun();
    if (!gunInitialized) {
      console.error("❌ Failed to initialize Gun, exiting...");
      process.exit(1);
    }

    await syncWithGunDB();

    // Periodic save of protocol stats to database (every 5 minutes)
    setInterval(() => {
      console.log("💾 Periodic save of protocol stats to database");
      saveProtocolStatToDB("totalMessages", protocolStatsCache.totalMessages);
      saveProtocolStatToDB("totalGroups", protocolStatsCache.totalGroups);
      saveProtocolStatToDB(
        "totalTokenRooms",
        protocolStatsCache.totalTokenRooms
      );
      saveProtocolStatToDB(
        "totalPublicRooms",
        protocolStatsCache.totalPublicRooms
      );
      saveProtocolStatToDB(
        "totalConversations",
        protocolStatsCache.totalConversations
      );
    }, 5 * 60 * 1000); // 5 minutes

    server.listen(PORT, () => {
      console.log(
        `🚀 Linda Username Server ${SERVER_VERSION} running on port ${PORT}`
      );
      console.log(`📊 Username index: ${usernameIndex.size} entries`);
      console.log(`📊 Protocol stats: ${JSON.stringify(protocolStatsCache)}`);
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

  // Save final protocol stats before shutdown
  console.log("💾 Saving final protocol stats to database...");
  saveProtocolStatToDB("totalMessages", protocolStatsCache.totalMessages);
  saveProtocolStatToDB("totalGroups", protocolStatsCache.totalGroups);
  saveProtocolStatToDB("totalTokenRooms", protocolStatsCache.totalTokenRooms);
  saveProtocolStatToDB("totalPublicRooms", protocolStatsCache.totalPublicRooms);
  saveProtocolStatToDB(
    "totalConversations",
    protocolStatsCache.totalConversations
  );

  // Wait a moment for database writes to complete
  setTimeout(() => {
    db.close((err) => {
      if (err) {
        console.error("❌ Error closing database:", err);
      } else {
        console.log("✅ Database connection closed");
      }
      process.exit(0);
    });
  }, 1000);
});

startServer().catch(console.error);
