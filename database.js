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

-- ТАБЛИЦА ДОСТИЖЕНИЙ (что за ачивки)
CREATE TABLE IF NOT EXISTS achievements (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT NOT NULL,
    icon TEXT DEFAULT '🏆',
    rarity TEXT DEFAULT 'common',
    type TEXT DEFAULT 'auto',        -- 'auto' = автоматическая, 'manual' = ручная (выдаёт админ)
    condition TEXT DEFAULT '',       -- условие для автоматических (например: 'messages:100')
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

    -- ТАБЛИЦА ВЫДАННЫХ АЧИВОК
    CREATE TABLE IF NOT EXISTS user_achievements (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        achievement_id INTEGER NOT NULL,
        awarded_by INTEGER,
        awarded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        is_viewed INTEGER DEFAULT 0,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (achievement_id) REFERENCES achievements(id) ON DELETE CASCADE,
        FOREIGN KEY (awarded_by) REFERENCES users(id) ON DELETE SET NULL,
        UNIQUE(user_id, achievement_id)
    );

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

        CREATE INDEX IF NOT EXISTS idx_user_achievements_user ON user_achievements(user_id);
        CREATE INDEX IF NOT EXISTS idx_user_achievements_viewed ON user_achievements(is_viewed);
        CREATE INDEX IF NOT EXISTS idx_achievements_rarity ON achievements(rarity); 

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

// Добавь в конец database.js
try {
    // Удаляем старые колонки (если есть) и добавляем новые
    db.exec(`ALTER TABLE users ADD COLUMN social_vk TEXT DEFAULT ''`);
    db.exec(`ALTER TABLE users ADD COLUMN social_tg TEXT DEFAULT ''`);
    db.exec(`ALTER TABLE users ADD COLUMN social_custom TEXT DEFAULT ''`);
    db.exec(`ALTER TABLE users ADD COLUMN social_custom_name TEXT DEFAULT ''`);
    console.log('✅ Добавлены колонки для соцсетей (ВК, Telegram, сайт)');
} catch(e) {
    console.log('Колонки уже существуют или ошибка:', e.message);
}

// ============= ДОБАВЛЕНИЕ НОВЫХ КОЛОНОК ДЛЯ КАСТОМИЗАЦИИ ПРОФИЛЯ =============
try {
    db.exec(`ALTER TABLE users ADD COLUMN status_text TEXT DEFAULT ''`);
    console.log('✅ Добавлена колонка status_text');
} catch(e) { console.log('status_text уже существует'); }

try {
    db.exec(`ALTER TABLE users ADD COLUMN status_emoji TEXT DEFAULT '🟢'`);
    console.log('✅ Добавлена колонка status_emoji');
} catch(e) { console.log('status_emoji уже существует'); }

try {
    db.exec(`ALTER TABLE users ADD COLUMN status_type TEXT DEFAULT 'online'`);
    console.log('✅ Добавлена колонка status_type');
} catch(e) { console.log('status_type уже существует'); }

try {
    db.exec(`ALTER TABLE users ADD COLUMN bio TEXT DEFAULT ''`);
    console.log('✅ Добавлена колонка bio');
} catch(e) { console.log('bio уже существует'); }

try {
    db.exec(`ALTER TABLE users ADD COLUMN banner TEXT DEFAULT ''`);
    console.log('✅ Добавлена колонка banner');
} catch(e) { console.log('banner уже существует'); }

try {
    db.exec(`ALTER TABLE users ADD COLUMN city TEXT DEFAULT ''`);
    console.log('✅ Добавлена колонка city');
} catch(e) { console.log('city уже существует'); }

try {
    db.exec(`ALTER TABLE users ADD COLUMN birthday DATE`);
    console.log('✅ Добавлена колонка birthday');
} catch(e) { console.log('birthday уже существует'); }

try {
    db.exec(`ALTER TABLE users ADD COLUMN website TEXT DEFAULT ''`);
    console.log('✅ Добавлена колонка website');
} catch(e) { console.log('website уже существует'); }

try {
    db.exec(`ALTER TABLE users ADD COLUMN social_vk TEXT DEFAULT ''`);
    console.log('✅ Добавлена колонка social_vk');
} catch(e) { console.log('social_vk уже существует'); }

try {
    db.exec(`ALTER TABLE users ADD COLUMN social_tg TEXT DEFAULT ''`);
    console.log('✅ Добавлена колонка social_tg');
} catch(e) { console.log('social_tg уже существует'); }

try {
    db.exec(`ALTER TABLE users ADD COLUMN social_custom TEXT DEFAULT ''`);
    console.log('✅ Добавлена колонка social_custom');
} catch(e) { console.log('social_custom уже существует'); }

try {
    db.exec(`ALTER TABLE users ADD COLUMN social_custom_name TEXT DEFAULT ''`);
    console.log('✅ Добавлена колонка social_custom_name');
} catch(e) { console.log('social_custom_name уже существует'); }

// Добавляем недостающие колонки (если таблица уже была)
try {
    db.exec(`ALTER TABLE achievements ADD COLUMN type TEXT DEFAULT 'auto'`);
} catch(e) {}
try {
    db.exec(`ALTER TABLE achievements ADD COLUMN condition TEXT DEFAULT ''`);
} catch(e) {}

// ============= ДОБАВЛЕНИЕ БАЗОВЫХ ДОСТИЖЕНИЙ =============
try {
    const count = db.prepare('SELECT COUNT(*) as count FROM achievements').get();
    if (count.count === 0) {
        db.exec(`
            INSERT INTO achievements (name, description, icon, rarity, type, condition) VALUES
            -- Автоматические ачивки
            ('Первый шаг', 'Зарегистрироваться на платформе', '👋', 'common', 'auto', 'registration'),
            ('Говорун', 'Отправить 100 сообщений', '💬', 'common', 'auto', 'messages:100'),
            ('Мастер диалога', 'Отправить 1000 сообщений', '🎙️', 'rare', 'auto', 'messages:1000'),
            ('Легенда чатов', 'Отправить 10000 сообщений', '👑', 'legendary', 'auto', 'messages:10000'),
            ('Постмейкер', 'Создать первый пост', '📝', 'common', 'auto', 'first_post'),
            ('Популярный автор', 'Получить 100 лайков', '❤️', 'rare', 'auto', 'likes:100'),
            ('Звезда канала', 'Создать канал с 50+ подписчиками', '⭐', 'epic', 'auto', 'channel_subscribers:50'),
            ('Душа компании', 'Пригласить 10 друзей', '👥', 'rare', 'auto', 'referrals:10'),
            ('Коллекционер', 'Получить 5 разных ачивок', '🏆', 'epic', 'auto', 'collector'),
            
            -- Ручные ачивки (выдаются админом)
            ('Помощник проекта', 'Помочь в развитии мессенджера', '🤝', 'rare', 'manual', ''),
            ('Бета-тестер', 'Участвовать в тестировании', '🧪', 'epic', 'manual', ''),
            ('Основатель', 'Быть среди первых пользователей', '👑', 'legendary', 'manual', '');
        `);
        console.log('✅ Добавлены базовые достижения');
    }
} catch(e) {
    console.log('⚠️ Ошибка добавления достижений:', e.message);
}

// ============= ОБНОВЛЕНИЕ УСЛОВИЙ АЧИВОК =============
try {
    // Обновляем существующие ачивки
    const updates = [
        { name: 'Говорун', condition: 'messages:50' },
        { name: 'Мастер диалога', condition: 'messages:150' },
        { name: 'Легенда чатов', condition: 'messages:500' },
        { name: 'Популярный автор', condition: 'likes:50' },
        { name: 'Душа компании', condition: 'referrals:5' },
        { name: 'Коллекционер', condition: 'collector' },
        { name: 'Звезда канала', condition: 'channel_subscribers:20' }
    ];
    
    for (const ach of updates) {
        const result = db.prepare('UPDATE achievements SET condition = ? WHERE name = ?').run(ach.condition, ach.name);
        if (result.changes > 0) {
            console.log(`✅ Обновлена ачивка "${ach.name}" → ${ach.condition}`);
        }
    }
    
    // Добавляем новые ачивки, если их нет
    const newAchievements = [
        { name: 'На связи', description: 'Отправить 10 сообщений за день', icon: '📱', rarity: 'common', type: 'auto', condition: 'daily:10' },
        { name: 'Сплетник', description: 'Написать 20 комментариев', icon: '💬', rarity: 'common', type: 'auto', condition: 'comments:20' },
        { name: 'Лайкомания', description: 'Поставить 100 лайков', icon: '👍', rarity: 'rare', type: 'auto', condition: 'likes_given:100' },
        { name: 'Ранний пташка', description: 'Написать сообщение до 9 утра', icon: '🌅', rarity: 'epic', type: 'auto', condition: 'morning_message' }
    ];
    
    for (const ach of newAchievements) {
        const exists = db.prepare('SELECT id FROM achievements WHERE name = ?').get(ach.name);
        if (!exists) {
            db.prepare(`
                INSERT INTO achievements (name, description, icon, rarity, type, condition)
                VALUES (?, ?, ?, ?, ?, ?)
            `).run(ach.name, ach.description, ach.icon, ach.rarity, ach.type, ach.condition);
            console.log(`✅ Добавлена новая ачивка "${ach.name}"`);
        }
    }
    
} catch(e) {
    console.log('⚠️ Ошибка обновления ачивок:', e.message);
}

// ============= ОБНОВЛЕНИЕ ОПИСАНИЙ АЧИВОК =============
try {
    const updates = [
        { name: 'Говорун', description: 'Отправить 50 сообщений' },
        { name: 'Мастер диалога', description: 'Отправить 150 сообщений' },
        { name: 'Легенда чатов', description: 'Отправить 500 сообщений' },
        { name: 'Популярный автор', description: 'Получить 50 лайков на постах' },
        { name: 'Звезда канала', description: 'Создать канал с 20+ подписчиками' },
        { name: 'Душа компании', description: 'Пригласить 5 друзей' },
        { name: 'Коллекционер', description: 'Получить 3 разных ачивки' },
        { name: 'На связи', description: 'Отправить 10 сообщений за день' },
        { name: 'Сплетник', description: 'Написать 20 комментариев' },
        { name: 'Лайкомания', description: 'Поставить 100 лайков' },
        { name: 'Ранний пташка', description: 'Написать сообщение до 9 утра' }
    ];
    
    for (const ach of updates) {
        const result = db.prepare('UPDATE achievements SET description = ? WHERE name = ?').run(ach.description, ach.name);
        if (result.changes > 0) {
            console.log(`✅ Обновлено описание ачивки "${ach.name}": ${ach.description}`);
        }
    }
} catch(e) {
    console.log('⚠️ Ошибка обновления описаний ачивок:', e.message);
}

// Экспортируем сам объект db (со всеми добавленными методами)
module.exports = db;
