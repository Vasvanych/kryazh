const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const db = new sqlite3.Database(path.join(__dirname, 'kryazh.db'));

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        avatar TEXT,
        online INTEGER DEFAULT 0,
        last_seen DATETIME DEFAULT CURRENT_TIMESTAMP,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS chats (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT,
        type TEXT DEFAULT 'private',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS chat_participants (
        chat_id INTEGER,
        user_id INTEGER,
        joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (chat_id, user_id)
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        content TEXT,
        image_url TEXT,
        forwarded_from TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // Прочитанность сообщений
    db.run(`CREATE TABLE IF NOT EXISTS message_reads (
        message_id INTEGER,
        user_id INTEGER,
        read_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (message_id, user_id)
    )`);

    // Реакции на сообщения
    db.run(`CREATE TABLE IF NOT EXISTS message_reactions (
        message_id INTEGER,
        user_id INTEGER,
        emoji TEXT,
        PRIMARY KEY (message_id, user_id)
    )`);

    db.run(`CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_messages_user ON messages(user_id)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_participants_user ON chat_participants(user_id)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_reads ON message_reads(message_id)`);

    console.log('✅ База данных готова');
});

module.exports = db;