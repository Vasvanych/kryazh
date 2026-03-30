const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const isRailway = process.env.RAILWAY_VOLUME_MOUNT_PATH || process.env.RAILWAY_ENVIRONMENT;
let dbPath;

if (isRailway) {
    dbPath = '/data/kryazh.db';
    console.log('🚀 Railway режим');
} else {
    dbPath = path.join(__dirname, 'kryazh.db');
    console.log('💻 Локальный режим');
}

const dbDir = path.dirname(dbPath);
if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
}

let db;
try {
    db = new Database(dbPath);
    const integrity = db.pragma('integrity_check', { simple: true });
    if (integrity !== 'ok') throw new Error('Corrupted');
    console.log('✅ База открыта');
} catch (err) {
    console.log('⚠️ Создаём новую базу...');
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
    db = new Database(dbPath);
}

db.exec(`
    CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        avatar TEXT,
        online INTEGER DEFAULT 0,
        last_seen DATETIME DEFAULT CURRENT_TIMESTAMP,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS chats (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT,
        type TEXT DEFAULT 'private',
        creator_id INTEGER,
        description TEXT,
        avatar TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS chat_participants (
        chat_id INTEGER,
        user_id INTEGER,
        role TEXT DEFAULT 'member',
        joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (chat_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        content TEXT,
        image_url TEXT,
        voice_url TEXT,
        forwarded_from TEXT,
        reply_to INTEGER,
        parent_id INTEGER,
        edited INTEGER DEFAULT 0,
        edited_at DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS message_reads (
        message_id INTEGER,
        user_id INTEGER,
        read_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (message_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS message_reactions (
        message_id INTEGER,
        user_id INTEGER,
        emoji TEXT,
        PRIMARY KEY (message_id, user_id)
    );
`);

// Добавляем колонки, если их нет
try {
    db.exec('ALTER TABLE chats ADD COLUMN creator_id INTEGER');
} catch (err) {}
try {
    db.exec('ALTER TABLE chats ADD COLUMN description TEXT');
} catch (err) {}
try {
    db.exec('ALTER TABLE chats ADD COLUMN avatar TEXT');
} catch (err) {}
try {
    db.exec('ALTER TABLE chat_participants ADD COLUMN role TEXT DEFAULT "member"');
} catch (err) {}
try {
    db.exec('ALTER TABLE messages ADD COLUMN reply_to INTEGER');
} catch (err) {}
try {
    db.exec('ALTER TABLE messages ADD COLUMN edited INTEGER DEFAULT 0');
} catch (err) {}
try {
    db.exec('ALTER TABLE messages ADD COLUMN edited_at DATETIME');
} catch (err) {}
try {
    db.exec('ALTER TABLE messages ADD COLUMN voice_url TEXT');
} catch (err) {}
try {
    db.exec('ALTER TABLE messages ADD COLUMN parent_id INTEGER');
} catch (err) {}

try {
    db.exec(`
        CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id);
        CREATE INDEX IF NOT EXISTS idx_messages_user ON messages(user_id);
        CREATE INDEX IF NOT EXISTS idx_participants_user ON chat_participants(user_id);
        CREATE INDEX IF NOT EXISTS idx_reads ON message_reads(message_id);
    `);
} catch (err) {}

console.log('✅ База данных готова');

module.exports = db;
