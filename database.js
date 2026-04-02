const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcrypt');

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
    console.log('✅ База открыта');
} catch (err) {
    console.log('⚠️ Ошибка открытия:', err.message);
    process.exit(1);
}

db.pragma('journal_mode = WAL');

// ============= СОЗДАНИЕ ТАБЛИЦ =============
db.exec(`



        -- КОММЕНТАРИИ К ПОСТАМ
    CREATE TABLE IF NOT EXISTS post_comments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        post_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        content TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (post_id) REFERENCES channel_posts(id) ON DELETE CASCADE,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );


        -- НОВЫЕ ТАБЛИЦЫ ДЛЯ ЛАЙКОВ И РЕПУТАЦИИ
    
    -- Лайки к постам
    CREATE TABLE IF NOT EXISTS post_likes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        post_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (post_id) REFERENCES channel_posts(id) ON DELETE CASCADE,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        UNIQUE(post_id, user_id)
    );
    
    -- Репутация пользователей (сумма полученных лайков)
    CREATE TABLE IF NOT EXISTS user_reputation (
        user_id INTEGER PRIMARY KEY,
        points INTEGER DEFAULT 0,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    
    -- История репутации (кто и когда поставил)
    CREATE TABLE IF NOT EXISTS reputation_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        from_user_id INTEGER NOT NULL,
        to_user_id INTEGER NOT NULL,
        post_id INTEGER,
        points INTEGER DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (from_user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (to_user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (post_id) REFERENCES channel_posts(id) ON DELETE SET NULL
    );


      CREATE TABLE IF NOT EXISTS friends (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        friend_id INTEGER NOT NULL,
        status TEXT DEFAULT 'pending', -- pending, accepted, rejected
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (friend_id) REFERENCES users(id) ON DELETE CASCADE,
        UNIQUE(user_id, friend_id)
    );

    CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        avatar TEXT,
        role TEXT DEFAULT 'user',
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
        is_channel INTEGER DEFAULT 0,
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

    -- НОВАЯ ТАБЛИЦА: посты каналов
    CREATE TABLE IF NOT EXISTS channel_posts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        channel_id INTEGER NOT NULL,
        author_id INTEGER NOT NULL,
        content TEXT,
        media_url TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (channel_id) REFERENCES chats(id) ON DELETE CASCADE,
        FOREIGN KEY (author_id) REFERENCES users(id) ON DELETE CASCADE
    );

        CREATE TABLE IF NOT EXISTS friend_posts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        content TEXT NOT NULL,
        media_url TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

        -- АДМИНСКИЕ СООБЩЕНИЯ
    CREATE TABLE IF NOT EXISTS admin_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        admin_id INTEGER NOT NULL,
        message TEXT NOT NULL,
        is_read INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (admin_id) REFERENCES users(id) ON DELETE CASCADE
    );
`);

// ============= ДОБАВЛЯЕМ НЕДОСТАЮЩИЕ КОЛОНКИ =============
const columns = [
    'ALTER TABLE chats ADD COLUMN creator_id INTEGER',
    'ALTER TABLE chats ADD COLUMN description TEXT',
    'ALTER TABLE chats ADD COLUMN avatar TEXT',
    'ALTER TABLE chats ADD COLUMN is_channel INTEGER DEFAULT 0',
    'ALTER TABLE chat_participants ADD COLUMN role TEXT DEFAULT "member"',
    'ALTER TABLE messages ADD COLUMN reply_to INTEGER',
    'ALTER TABLE messages ADD COLUMN edited INTEGER DEFAULT 0',
    'ALTER TABLE messages ADD COLUMN edited_at DATETIME',
    'ALTER TABLE messages ADD COLUMN voice_url TEXT',
    'ALTER TABLE messages ADD COLUMN parent_id INTEGER'
];

columns.forEach(sql => {
    try {
        db.exec(sql);
    } catch (err) {
        // Колонка уже существует - игнорируем
    }
});

// ============= СОЗДАЁМ ИНДЕКСЫ =============
try {
    db.exec(`
        CREATE INDEX IF NOT EXISTS idx_admin_messages_user ON admin_messages(user_id);
CREATE INDEX IF NOT EXISTS idx_admin_messages_created ON admin_messages(created_at);

        CREATE INDEX IF NOT EXISTS idx_post_comments_post ON post_comments(post_id);
        CREATE INDEX IF NOT EXISTS idx_post_comments_user ON post_comments(user_id);
        CREATE INDEX IF NOT EXISTS idx_post_comments_created ON post_comments(created_at);

        CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id);
        CREATE INDEX IF NOT EXISTS idx_messages_user ON messages(user_id);
        CREATE INDEX IF NOT EXISTS idx_messages_parent ON messages(parent_id);
        CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at);
        CREATE INDEX IF NOT EXISTS idx_participants_user ON chat_participants(user_id);
        CREATE INDEX IF NOT EXISTS idx_participants_chat ON chat_participants(chat_id);
        CREATE INDEX IF NOT EXISTS idx_reads_message ON message_reads(message_id);
        CREATE INDEX IF NOT EXISTS idx_reads_user ON message_reads(user_id);
        CREATE INDEX IF NOT EXISTS idx_chats_type ON chats(type);
        CREATE INDEX IF NOT EXISTS idx_chats_creator ON chats(creator_id);
        
        -- Индексы для лайков и репутации
        CREATE INDEX IF NOT EXISTS idx_post_likes_post ON post_likes(post_id);
        CREATE INDEX IF NOT EXISTS idx_post_likes_user ON post_likes(user_id);
        CREATE INDEX IF NOT EXISTS idx_reputation_history_from ON reputation_history(from_user_id);
        CREATE INDEX IF NOT EXISTS idx_reputation_history_to ON reputation_history(to_user_id);

        CREATE INDEX IF NOT EXISTS idx_friend_posts_user ON friend_posts(user_id);
        CREATE INDEX IF NOT EXISTS idx_friend_posts_created ON friend_posts(created_at);

        // В блоке с индексами добавьте:
       CREATE INDEX IF NOT EXISTS idx_friends_user ON friends(user_id);
       CREATE INDEX IF NOT EXISTS idx_friends_friend ON friends(friend_id);
       CREATE INDEX IF NOT EXISTS idx_friends_status ON friends(status);

        -- НОВЫЕ ИНДЕКСЫ ДЛЯ ПОСТОВ
        CREATE INDEX IF NOT EXISTS idx_posts_channel ON channel_posts(channel_id);
        CREATE INDEX IF NOT EXISTS idx_posts_author ON channel_posts(author_id);
        CREATE INDEX IF NOT EXISTS idx_posts_created ON channel_posts(created_at);
    `);
} catch (err) {
    console.log('⚠️ Ошибка создания индексов:', err.message);
}

try {
    db.exec(`CREATE INDEX IF NOT EXISTS idx_post_comments_post ON post_comments(post_id)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_post_comments_user ON post_comments(user_id)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_post_comments_created ON post_comments(created_at)`);
} catch (err) {}

// ============= СОЗДАНИЕ АДМИНА =============
try {
    const row = db.prepare("SELECT id FROM users WHERE username = 'kryazh'").get();
    
    if (!row) {
        const hash = bcrypt.hashSync('123MaTeYsH123', 10);
        db.prepare("INSERT INTO users (username, password, role) VALUES ('kryazh', ?, 'admin')").run(hash);
        console.log('✅ Админ kryazh создан');
    } else {
        db.prepare("UPDATE users SET role = 'admin' WHERE username = 'kryazh'").run();
        console.log('✅ Админ kryazh назначен');
    }
} catch (err) {
    console.log('⚠️ Ошибка создания админа:', err.message);
}

// ============= ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ДЛЯ ПОСТОВ =============
// Эти функции используют db.prepare() и будут доступны через db.имяФункции

// Создать пост
db.createPost = function(channelId, authorId, content, mediaUrl = null) {
    const stmt = db.prepare(`
        INSERT INTO channel_posts (channel_id, author_id, content, media_url)
        VALUES (?, ?, ?, ?)
    `);
    const info = stmt.run(channelId, authorId, content, mediaUrl);
    return db.getPostById(info.lastInsertRowid);
};

// Получить пост по ID
db.getPostById = function(postId) {
    const stmt = db.prepare(`
        SELECT 
            p.*,
            u.username,
            u.avatar as avatar_url,
            c.name as channel_name
        FROM channel_posts p
        LEFT JOIN users u ON p.author_id = u.id
        LEFT JOIN chats c ON p.channel_id = c.id
        WHERE p.id = ?
    `);
    return stmt.get(postId);
};

// Получить ленту для пользователя
db.getFeedForUser = function(userId, limit = 50, offset = 0) {
    const stmt = db.prepare(`
        SELECT 
            p.*,
            u.username,
            u.avatar as avatar_url,
            c.name as channel_name
        FROM channel_posts p
        INNER JOIN chats c ON p.channel_id = c.id
        INNER JOIN chat_participants cp ON c.id = cp.chat_id
        LEFT JOIN users u ON p.author_id = u.id
        WHERE cp.user_id = ?
          AND c.type = 'channel'
        ORDER BY p.created_at DESC
        LIMIT ? OFFSET ?
    `);
    return stmt.all(userId, limit, offset);
};

// Получить посты канала
db.getChannelPosts = function(channelId, limit = 50, offset = 0) {
    const stmt = db.prepare(`
        SELECT 
            p.*,
            u.username,
            u.avatar as avatar_url
        FROM channel_posts p
        LEFT JOIN users u ON p.author_id = u.id
        WHERE p.channel_id = ?
        ORDER BY p.created_at DESC
        LIMIT ? OFFSET ?
    `);
    return stmt.all(channelId, limit, offset);
};

// Удалить пост
db.deletePost = function(postId, userId, isAdmin = false) {
    const post = db.getPostById(postId);
    if (!post) return false;
    
    if (post.author_id === userId || isAdmin) {
        const stmt = db.prepare('DELETE FROM channel_posts WHERE id = ?');
        stmt.run(postId);
        return true;
    }
    return false;
};

// Проверить, является ли чат каналом
db.isChatChannel = function(chatId) {
    const stmt = db.prepare('SELECT is_channel FROM chats WHERE id = ?');
    const row = stmt.get(chatId);
    return row && row.is_channel === 1;
};

// Получить участников чата
db.getChatMembers = function(chatId) {
    const stmt = db.prepare('SELECT user_id FROM chat_participants WHERE chat_id = ?');
    return stmt.all(chatId);
};

// Получить чат по ID
db.getChatById = function(chatId) {
    const stmt = db.prepare('SELECT * FROM chats WHERE id = ?');
    return stmt.get(chatId);
};

console.log('✅ База данных готова, все функции добавлены');

// ПРИНУДИТЕЛЬНОЕ СОЗДАНИЕ ТАБЛИЦЫ КОММЕНТАРИЕВ (для старых баз)
try {
    db.exec(`
        CREATE TABLE IF NOT EXISTS post_comments (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            post_id INTEGER NOT NULL,
            user_id INTEGER NOT NULL,
            content TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (post_id) REFERENCES channel_posts(id) ON DELETE CASCADE,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        )
    `);
    console.log('✅ Таблица post_comments проверена/создана');
} catch (err) {
    console.log('⚠️ Ошибка создания post_comments:', err.message);
}

// Экспортируем сам объект db (со всеми добавленными методами)
module.exports = db;
