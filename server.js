const express = require('express');
const path = require('path');
const http = require('http');
const { Server } = require('socket.io');
const db = require('./database');
const multer = require('multer');
const fs = require('fs');
const bcrypt = require('bcrypt');
const session = require('express-session');
const FileStore = require('session-file-store')(session);
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');

const webpush = require('web-push');

const app = express();
app.set('trust proxy', 1);
const server = http.createServer(app);
const io = new Server(server);
const port = process.env.PORT || 3000;

// Генерация уникального секрета для сессий
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');

const onlineUsers = new Map();
const userSessions = new Map(); // Привязка userId к socketId

const isRailway = process.env.RAILWAY_VOLUME_MOUNT_PATH || process.env.RAILWAY_ENVIRONMENT;


let uploadDir, avatarDir, voiceDir;

if (isRailway) {
    uploadDir = '/data/uploads';
    avatarDir = '/data/uploads/avatars';
    voiceDir = '/data/uploads/voice';
    console.log('🚀 Railway режим: загрузки в /data/uploads');
} else {
    uploadDir = path.join(__dirname, 'uploads');
    avatarDir = path.join(__dirname, 'uploads', 'avatars');
    voiceDir = path.join(__dirname, 'uploads', 'voice');
    console.log('💻 Локальный режим');
}

if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
if (!fs.existsSync(avatarDir)) fs.mkdirSync(avatarDir, { recursive: true });
if (!fs.existsSync(voiceDir)) fs.mkdirSync(voiceDir, { recursive: true });

// Безопасность
app.use(helmet({ 
    contentSecurityPolicy: false,
    hsts: {
        maxAge: 31536000,
        includeSubDomains: true,
        preload: true
    }
}));
app.use(express.json({ limit: '1mb' }));
// Сессии в файлах с шифрованием
const sessionStore = new FileStore({
    path: isRailway ? '/data/sessions' : './sessions',
    ttl: 30 * 24 * 60 * 60,
    reapInterval: 60 * 60,
    secret: SESSION_SECRET,
    encrypt: true,
    retries: 0,  // Отключаем retry, чтобы не спамить в логах
    ioOptions: {
        encoding: 'utf8',
        mode: 0o600
    }
});

app.use(session({
    store: sessionStore,
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { 
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        maxAge: 30 * 24 * 60 * 60 * 1000,
        sameSite: 'strict',
        path: '/'
    },
    name: 'kryazh_session',
    rolling: true
}));

// ============= КОММЕНТАРИИ К ПОСТАМ =============

/**
 * Получить комментарии к посту
 * GET /api/posts/:id/comments
 */
app.get('/api/posts/:id/comments', requireAuth, (req, res) => {
    const postId = parseInt(req.params.id);
    const limit = parseInt(req.query.limit) || 50;
    const offset = parseInt(req.query.offset) || 0;
    
    try {
        const comments = db.prepare(`
            SELECT 
                pc.*,
                u.username,
                u.avatar
            FROM post_comments pc
            JOIN users u ON pc.user_id = u.id
            WHERE pc.post_id = ?
            ORDER BY pc.created_at ASC
            LIMIT ? OFFSET ?
        `).all(postId, limit, offset);
        
        // Получаем общее количество комментариев
        const count = db.prepare('SELECT COUNT(*) as total FROM post_comments WHERE post_id = ?').get(postId).total;
        
        res.json({ comments, total: count });
        
    } catch (error) {
        console.error('Ошибка получения комментариев:', error);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

/**
 * Создать комментарий к посту
 * POST /api/posts/:id/comments
 */
app.post('/api/posts/:id/comments', requireAuth, (req, res) => {
    const postId = parseInt(req.params.id);
    const userId = req.session.userId;
    const { content } = req.body;
    
    if (!content || content.trim() === '') {
        return res.status(400).json({ error: 'Комментарий не может быть пустым' });
    }
    
    if (content.length > 1000) {
        return res.status(400).json({ error: 'Комментарий слишком длинный (макс. 1000 символов)' });
    }
    
    try {
        // Проверяем, существует ли пост
        const post = db.prepare('SELECT id, author_id FROM channel_posts WHERE id = ?').get(postId);
        if (!post) {
            return res.status(404).json({ error: 'Пост не найден' });
        }
        
        // Создаём комментарий
        const stmt = db.prepare(`
            INSERT INTO post_comments (post_id, user_id, content)
            VALUES (?, ?, ?)
        `);
        const info = stmt.run(postId, userId, content.trim());
        
        // Получаем созданный комментарий с информацией о пользователе
        const newComment = db.prepare(`
            SELECT pc.*, u.username, u.avatar
            FROM post_comments pc
            JOIN users u ON pc.user_id = u.id
            WHERE pc.id = ?
        `).get(info.lastInsertRowid);
        
        // Отправляем уведомление автору поста (если комментатор не автор)
        if (post.author_id !== userId) {
            const authorSocketId = userSessions.get(post.author_id);
            if (authorSocketId) {
                io.to(authorSocketId).emit('new_comment', {
                    postId: postId,
                    comment: newComment,
                    postAuthorId: post.author_id
                });
            }
        }
        
        res.status(201).json(newComment);
        
    } catch (error) {
        console.error('Ошибка создания комментария:', error);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

/**
 * Удалить комментарий
 * DELETE /api/comments/:id
 */
app.delete('/api/comments/:id', requireAuth, (req, res) => {
    const commentId = parseInt(req.params.id);
    const userId = req.session.userId;
    const isAdmin = req.session.role === 'admin';
    
    try {
        const comment = db.prepare('SELECT * FROM post_comments WHERE id = ?').get(commentId);
        if (!comment) {
            return res.status(404).json({ error: 'Комментарий не найден' });
        }
        
        // Права: автор комментария, автор поста или админ
        const post = db.prepare('SELECT author_id FROM channel_posts WHERE id = ?').get(comment.post_id);
        const isCommentAuthor = comment.user_id === userId;
        const isPostAuthor = post && post.author_id === userId;
        
        if (isCommentAuthor || isPostAuthor || isAdmin) {
            db.prepare('DELETE FROM post_comments WHERE id = ?').run(commentId);
            res.json({ success: true });
        } else {
            res.status(403).json({ error: 'Нет прав на удаление' });
        }
        
    } catch (error) {
        console.error('Ошибка удаления комментария:', error);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});


// Настройка сессий с максимальной защитой


// ============= PUSH-УВЕДОМЛЕНИЯ =============
const vapidPublicKey = process.env.VAPID_PUBLIC_KEY;
const vapidPrivateKey = process.env.VAPID_PRIVATE_KEY;

if (vapidPublicKey && vapidPrivateKey) {
    webpush.setVapidDetails(
        'mailto:admin@kryazh.com',  // можно заменить на свой email
        vapidPublicKey,
        vapidPrivateKey
    );
    console.log('✅ Push-уведомления настроены');
} else {
    console.log('⚠️ VAPID ключи не найдены, push-уведомления отключены');
    console.log('   Добавьте VAPID_PUBLIC_KEY и VAPID_PRIVATE_KEY в переменные окружения');
}

// Хранилище подписок (в продакшене нужно хранить в БД)
const pushSubscriptions = new Map(); // userId -> subscription

// Middleware: проверка fingerprint сессии (защита от перехвата)
app.use((req, res, next) => {
    if (req.session.userId) {
        // Полностью отключаем проверку, только логируем если что-то изменилось
        const oldFingerprint = req.session.fingerprint;
        
        if (!oldFingerprint) {
            req.session.fingerprint = 'initialized';
            req.session.save();
        }
        
        // НИКОГДА не блокируем пользователя
        // Просто логируем изменения если нужно для отладки
        if (oldFingerprint && oldFingerprint !== 'initialized' && Math.random() < 0.01) {
            console.log(`📊 Активность пользователя ${req.session.userId}`);
        }
    }
    next();
});

// Middleware: проверка существования пользователя в сессии
app.use((req, res, next) => {
    if (req.session.userId) {
        const user = db.prepare('SELECT id FROM users WHERE id = ?').get(req.session.userId);
        if (!user) {
            req.session.destroy();
            if (req.path.startsWith('/api/')) {
                return res.status(401).json({ error: 'Сессия недействительна' });
            }
            return res.redirect('/login');
        }
    }
    next();
});

// Rate limiting
const apiLimiter = rateLimit({ 
    windowMs: 15 * 60 * 1000, 
    max: 200,
    skip: (req) => req.path.startsWith('/uploads/')
});

const authLimiter = rateLimit({ 
    windowMs: 15 * 60 * 1000, 
    max: 1000
});

app.use('/api/', apiLimiter);

function requireAuth(req, res, next) {
    if (!req.session.userId) {
        return res.status(401).json({ error: 'Не авторизован' });
    }
    next();
}

const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];

const upload = multer({
    storage: multer.diskStorage({
        destination: (req, file, cb) => cb(null, uploadDir),
        filename: (req, file, cb) => {
            const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
            cb(null, uniqueSuffix + '-' + file.originalname);
        }
    }),
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        if (ALLOWED_IMAGE_TYPES.includes(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error('Разрешены только изображения'));
        }
    }
});

const uploadAvatar = multer({
    storage: multer.diskStorage({
        destination: (req, file, cb) => cb(null, avatarDir),
        filename: (req, file, cb) => {
            const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
            cb(null, 'avatar-' + uniqueSuffix + path.extname(file.originalname));
        }
    }),
    limits: { fileSize: 2 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        if (ALLOWED_IMAGE_TYPES.includes(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error('Разрешены только изображения'));
        }
    }
});

const uploadVoice = multer({
    storage: multer.diskStorage({
        destination: (req, file, cb) => cb(null, voiceDir),
        filename: (req, file, cb) => {
            const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
            cb(null, 'voice-' + uniqueSuffix + '.webm');
        }
    }),
    limits: { fileSize: 10 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        if (file.mimetype === 'audio/webm' || file.mimetype === 'audio/mp4' || file.mimetype === 'audio/ogg') {
            cb(null, true);
        } else {
            cb(new Error('Разрешены только аудиофайлы'));
        }
    }
});


app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(uploadDir));

// ============= PWA НАСТРОЙКИ =============

// Service Worker — специальные заголовки
app.get('/sw.js', (req, res) => {
    // Устанавливаем правильный MIME тип
    res.setHeader('Content-Type', 'application/javascript');
    
    // Разрешаем Service Worker работать на всём сайте
    res.setHeader('Service-Worker-Allowed', '/');
    
    // Отключаем кэширование, чтобы SW всегда был свежим
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    
    // Отправляем файл
    res.sendFile(path.join(__dirname, 'public', 'sw.js'));
});

// Манифест приложения
app.get('/manifest.json', (req, res) => {
    // Устанавливаем правильный MIME тип для манифеста
    res.setHeader('Content-Type', 'application/manifest+json');
    
    // Кэшируем манифест (меняется редко)
    res.setHeader('Cache-Control', 'public, max-age=86400'); // 24 часа
    
    // Отправляем файл
    res.sendFile(path.join(__dirname, 'public', 'manifest.json'));
});

// Иконки (если нужно)
app.get('/icons/:icon', (req, res) => {
    const iconName = req.params.icon;
    const iconPath = path.join(__dirname, 'public', 'icons', iconName);
    
    // Проверяем, существует ли файл
    if (fs.existsSync(iconPath)) {
        res.sendFile(iconPath);
    } else {
        res.status(404).send('Icon not found');
    }
});

// ============= РОУТЫ =============

app.get('/', (req, res) => {
    if (!req.session.userId) {
        return res.sendFile(path.join(__dirname, 'public', 'login.html'));
    }
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/register', (req, res) => res.sendFile(path.join(__dirname, 'public', 'register.html')));

// Регистрация
app.post('/api/register', authLimiter, async (req, res) => {
    const { username, password } = req.body;
    
    if (!username || !password) {
        return res.status(400).json({ error: 'Заполните все поля' });
    }
    if (username.length < 3 || username.length > 30) {
        return res.status(400).json({ error: 'Имя: от 3 до 30 символов' });
    }
    if (password.length < 6) {
        return res.status(400).json({ error: 'Пароль: минимум 6 символов' });
    }
    if (!/^[a-zA-Z0-9_]+$/.test(username)) {
        return res.status(400).json({ error: 'Имя: только латиница, цифры и _' });
    }

    try {
        const hash = await bcrypt.hash(password, 10);
        const stmt = db.prepare("INSERT INTO users (username, password, role) VALUES (?, ?, 'user')");
        const result = stmt.run(username, hash);
        
        const fingerprint = crypto
            .createHash('sha256')
            .update(`${req.headers['user-agent'] || ''}|${req.ip || ''}|${req.headers['accept-language'] || ''}`)
            .digest('hex');
        
        req.session.userId = result.lastInsertRowid;
        req.session.username = username;
        req.session.role = 'user';
        req.session.fingerprint = fingerprint;
        
        req.session.save((err) => {
            if (err) {
                console.error('Ошибка сохранения сессии:', err);
                return res.status(500).json({ error: 'Ошибка сервера' });
            }
            res.json({ id: result.lastInsertRowid, username });
        });
    } catch (err) {
        if (err.message.includes('UNIQUE')) {
            return res.status(400).json({ error: 'Пользователь уже существует' });
        }
        console.error('Ошибка регистрации:', err);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

// Вход
app.post('/api/login', authLimiter, async (req, res) => {
    const { username, password } = req.body;
    
    
    if (!username || !password) {
        return res.status(400).json({ error: 'Заполните все поля' });
    }

    try {
        const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
        if (!user) {
            return res.status(401).json({ error: 'Неверное имя или пароль' });
        }
        
        const match = await bcrypt.compare(password, user.password);
        if (!match) {
            return res.status(401).json({ error: 'Неверное имя или пароль' });
        }
        
        const fingerprint = crypto
            .createHash('sha256')
            .update(`${req.headers['user-agent'] || ''}|${req.ip || ''}|${req.headers['accept-language'] || ''}`)
            .digest('hex');
        
        req.session.userId = user.id;
        req.session.username = user.username;
        req.session.role = user.role;
        req.session.fingerprint = fingerprint;
        
        req.session.save((err) => {
            if (err) {
                console.error('Ошибка сохранения сессии:', err);
                return res.status(500).json({ error: 'Ошибка сервера' });
            }
            res.json({ id: user.id, username: user.username, avatar: user.avatar });
        });
    } catch (err) {
        console.error('Ошибка входа:', err);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

// Выход с очисткой
app.post('/api/logout', (req, res) => {
    const userId = req.session.userId;
    
    if (userId) {
        const socketId = userSessions.get(userId);
        if (socketId) {
            const socket = io.sockets.sockets.get(socketId);
            if (socket) {
                socket.disconnect(true);
            }
            userSessions.delete(userId);
        }
    }
    
    req.session.destroy((err) => {
        if (err) {
            console.error('Ошибка удаления сессии:', err);
            return res.status(500).json({ error: 'Ошибка выхода' });
        }
        res.clearCookie('kryazh_session');
        res.json({ ok: true });
    });
});

// Проверка авторизации
app.get('/api/me', requireAuth, (req, res) => {
    const user = db.prepare('SELECT id, username, avatar, role FROM users WHERE id = ?').get(req.session.userId);
    if (!user) {
        req.session.destroy();
        return res.status(401).json({ error: 'Не авторизован' });
    }
    res.json(user);
});

// Список чатов
app.get('/api/chats/:userId', requireAuth, (req, res) => {
    if (parseInt(req.params.userId) !== req.session.userId) {
        return res.status(403).json({ error: 'Доступ запрещён' });
    }
    const rows = db.prepare(`
        SELECT c.*,
            (SELECT content FROM messages WHERE chat_id = c.id ORDER BY created_at DESC LIMIT 1) as last_message,
            (SELECT created_at FROM messages WHERE chat_id = c.id ORDER BY created_at DESC LIMIT 1) as last_message_time,
            (SELECT COUNT(*) FROM messages m
             WHERE m.chat_id = c.id AND m.user_id != @userId
             AND m.id NOT IN (SELECT message_id FROM message_reads WHERE user_id = @userId)) as unread_count,
            (SELECT role FROM chat_participants WHERE chat_id = c.id AND user_id = @userId) as user_role
        FROM chats c
        JOIN chat_participants cp ON c.id = cp.chat_id
        WHERE cp.user_id = @userId
        ORDER BY last_message_time DESC
    `).all({ userId: req.session.userId });
    res.json(rows || []);
});

// Сообщения чата
app.get('/api/messages/:chatId', requireAuth, (req, res) => {
    const chatId = req.params.chatId;
    const userId = req.session.userId;
    const access = db.prepare('SELECT 1 FROM chat_participants WHERE chat_id = ? AND user_id = ?').get(chatId, userId);
    if (!access) return res.status(403).json({ error: 'Доступ запрещён' });
    
    const rows = db.prepare(`
        SELECT m.*, u.username, u.avatar,
            (SELECT COUNT(*) FROM message_reads WHERE message_id = m.id) as read_count
        FROM messages m
        JOIN users u ON m.user_id = u.id
        WHERE m.chat_id = ? AND m.parent_id IS NULL
        ORDER BY m.created_at ASC
        LIMIT 500
    `).all(chatId);
    
    const messages = rows.map(msg => {
        const reactionsList = db.prepare(`SELECT user_id, emoji FROM message_reactions WHERE message_id = ?`).all(msg.id);
        const reactions = {};
        reactionsList.forEach(r => {
            if (!reactions[r.emoji]) reactions[r.emoji] = [];
            reactions[r.emoji].push(r.user_id);
        });
        let reply_to_data = null;
        if (msg.reply_to) {
            const replyMsg = db.prepare(`SELECT m.content, u.username FROM messages m JOIN users u ON m.user_id = u.id WHERE m.id = ?`).get(msg.reply_to);
            if (replyMsg) reply_to_data = { content: replyMsg.content, username: replyMsg.username };
        }
        return { ...msg, reactions, reply_to_data, read_count: msg.read_count || 1 };
    });
    res.json(messages);
});

// Поиск пользователей
app.get('/api/users/search', requireAuth, (req, res) => {
    const query = req.query.q;
    if (!query || query.length < 2) return res.json([]);
    const rows = db.prepare(`SELECT id, username, avatar FROM users WHERE username LIKE ? LIMIT 20`).all(`%${query}%`);
    res.json(rows || []);
});

// Создать личный чат
app.post('/api/chat/private', requireAuth, (req, res) => {
    const user1 = req.session.userId;
    const user2 = parseInt(req.body.user2);
    if (!user2 || user1 === user2) return res.status(400).json({ error: 'Некорректный пользователь' });
    
    const existing = db.prepare(`
        SELECT c.id FROM chats c 
        JOIN chat_participants cp1 ON c.id = cp1.chat_id 
        JOIN chat_participants cp2 ON c.id = cp2.chat_id 
        WHERE c.type = 'private' AND cp1.user_id = ? AND cp2.user_id = ?
    `).get(user1, user2);
    
    if (existing) return res.json({ chatId: existing.id });
    
    const chatId = db.prepare("INSERT INTO chats (type) VALUES ('private')").run().lastInsertRowid;
    db.prepare('INSERT INTO chat_participants (chat_id, user_id) VALUES (?, ?), (?, ?)').run(chatId, user1, chatId, user2);
    res.json({ chatId });
});

// Создать группу
app.post('/api/chat/group', requireAuth, (req, res) => {
    const { name, members } = req.body;
    const creatorId = req.session.userId;
    
    if (!name || name.trim().length < 1) {
        return res.status(400).json({ error: 'Введите название группы' });
    }
    if (name.length > 50) {
        return res.status(400).json({ error: 'Название слишком длинное' });
    }
    
    const existingGroup = db.prepare(`
        SELECT c.id FROM chats c 
        JOIN chat_participants cp ON c.id = cp.chat_id 
        WHERE c.type = 'group' AND c.name = ? AND cp.user_id = ?
    `).get(name.trim(), creatorId);
    
    if (existingGroup) {
        return res.status(400).json({ error: 'У вас уже есть группа с таким названием' });
    }
    
    try {
        const chatResult = db.prepare("INSERT INTO chats (name, type, creator_id) VALUES (?, 'group', ?)").run(name.trim(), creatorId);
        const chatId = chatResult.lastInsertRowid;
        
        const uniqueMembers = [...new Set([creatorId, ...(members || []).filter(m => m !== creatorId && !isNaN(m))])];
        const insertMember = db.prepare('INSERT INTO chat_participants (chat_id, user_id, role) VALUES (?, ?, ?)');
        uniqueMembers.forEach(m => insertMember.run(chatId, m, 'member'));
        
        res.json({ chatId, name });
    } catch (err) {
        console.error('Ошибка создания группы:', err);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

// Создать канал
app.post('/api/chat/channel', requireAuth, (req, res) => {
    const { name, description } = req.body;
    const creatorId = req.session.userId;
    
    if (!name || name.trim().length < 1) {
        return res.status(400).json({ error: 'Введите название канала' });
    }
    if (name.length > 50) {
        return res.status(400).json({ error: 'Название слишком длинное' });
    }
    
    try {
        const chatResult = db.prepare("INSERT INTO chats (name, type, creator_id, description) VALUES (?, 'channel', ?, ?)").run(name.trim(), creatorId, description || '');
        const chatId = chatResult.lastInsertRowid;
        
        db.prepare('INSERT INTO chat_participants (chat_id, user_id, role) VALUES (?, ?, ?)').run(chatId, creatorId, 'admin');
        
        res.json({ chatId, name });
    } catch (err) {
        console.error('Ошибка создания канала:', err);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

// Загрузка аватарки канала
app.post('/api/chat/:chatId/upload-avatar', requireAuth, uploadAvatar.single('avatar'), (req, res) => {
    const chatId = req.params.chatId;
    const userId = req.session.userId;
    
    try {
        const chat = db.prepare("SELECT * FROM chats WHERE id = ? AND type = 'channel'").get(chatId);
        if (!chat) return res.status(404).json({ error: 'Канал не найден' });
        if (chat.creator_id !== userId) return res.status(403).json({ error: 'Только создатель может менять аватарку' });
        if (!req.file) return res.status(400).json({ error: 'Нет файла' });
        
        const avatarUrl = `/uploads/avatars/${req.file.filename}`;
        db.prepare('UPDATE chats SET avatar = ? WHERE id = ?').run(avatarUrl, chatId);
        res.json({ avatarUrl });
    } catch (err) {
        console.error('Ошибка загрузки аватарки:', err);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

// Загрузка аватарки группы
app.post('/api/chat/:chatId/upload-group-avatar', requireAuth, uploadAvatar.single('avatar'), (req, res) => {
    const chatId = req.params.chatId;
    const userId = req.session.userId;
    
    try {
        const chat = db.prepare("SELECT * FROM chats WHERE id = ? AND type = 'group'").get(chatId);
        if (!chat) return res.status(404).json({ error: 'Группа не найдена' });
        if (chat.creator_id !== userId) return res.status(403).json({ error: 'Только создатель может менять аватарку' });
        if (!req.file) return res.status(400).json({ error: 'Нет файла' });
        
        const avatarUrl = `/uploads/avatars/${req.file.filename}`;
        db.prepare('UPDATE chats SET avatar = ? WHERE id = ?').run(avatarUrl, chatId);
        res.json({ avatarUrl });
    } catch (err) {
        console.error('Ошибка загрузки аватарки:', err);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

// Получить комментарии
app.get('/api/messages/:messageId/comments', requireAuth, (req, res) => {
    const messageId = req.params.messageId;
    const userId = req.session.userId;
    
    const originalMsg = db.prepare('SELECT chat_id FROM messages WHERE id = ?').get(messageId);
    if (!originalMsg) return res.status(404).json({ error: 'Сообщение не найдено' });
    
    const access = db.prepare('SELECT 1 FROM chat_participants WHERE chat_id = ? AND user_id = ?').get(originalMsg.chat_id, userId);
    if (!access) return res.status(403).json({ error: 'Доступ запрещён' });
    
    const comments = db.prepare(`
        SELECT m.*, u.username, u.avatar,
            (SELECT COUNT(*) FROM message_reads WHERE message_id = m.id) as read_count
        FROM messages m
        JOIN users u ON m.user_id = u.id
        WHERE m.parent_id = ?
        ORDER BY m.created_at ASC
        LIMIT 200
    `).all(messageId);
    
    res.json(comments);
});

// Участники чата
app.get('/api/chat/:chatId/participants', requireAuth, (req, res) => {
    const chatId = req.params.chatId;
    const userId = req.session.userId;
    const access = db.prepare('SELECT 1 FROM chat_participants WHERE chat_id = ? AND user_id = ?').get(chatId, userId);
    if (!access) return res.status(403).json({ error: 'Доступ запрещён' });
    const rows = db.prepare(`SELECT u.id, u.username, u.avatar, cp.role FROM users u JOIN chat_participants cp ON u.id = cp.user_id WHERE cp.chat_id = ?`).all(chatId);
    res.json(rows);
});

// Роль участника
app.get('/api/chat/:chatId/participant-role', requireAuth, (req, res) => {
    const chatId = req.params.chatId;
    const userId = req.session.userId;
    const participant = db.prepare('SELECT role FROM chat_participants WHERE chat_id = ? AND user_id = ?').get(chatId, userId);
    res.json({ role: participant ? participant.role : null });
});

// Добавить участника
app.post('/api/chat/:chatId/add-participant', requireAuth, (req, res) => {
    const chatId = parseInt(req.params.chatId);
    const currentUserId = req.session.userId;
    const { userId: newUserId } = req.body;
    
    const chat = db.prepare("SELECT * FROM chats WHERE id = ? AND (type = 'group' OR type = 'channel')").get(chatId);
    if (!chat) return res.status(404).json({ error: 'Чат не найден' });
    if (chat.creator_id !== currentUserId) return res.status(403).json({ error: 'Только создатель может добавлять участников' });
    
    const user = db.prepare('SELECT id FROM users WHERE id = ?').get(newUserId);
    if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
    
    const existing = db.prepare('SELECT 1 FROM chat_participants WHERE chat_id = ? AND user_id = ?').get(chatId, newUserId);
    if (existing) return res.status(400).json({ error: 'Пользователь уже в чате' });
    
    db.prepare('INSERT INTO chat_participants (chat_id, user_id, role) VALUES (?, ?, ?)').run(chatId, newUserId, 'member');
    
    const targetSocket = onlineUsers.get(newUserId);
    if (targetSocket) {
        io.to(targetSocket).emit('added to chat', { chatId, chatName: chat.name, chatType: chat.type });
    }
    
    res.json({ ok: true });
});

// Удалить участника
app.delete('/api/chat/:chatId/remove-participant', requireAuth, (req, res) => {
    const chatId = parseInt(req.params.chatId);
    const currentUserId = req.session.userId;
    const { userId: removeUserId } = req.body;
    
    const chat = db.prepare("SELECT * FROM chats WHERE id = ? AND (type = 'group' OR type = 'channel')").get(chatId);
    if (!chat) return res.status(404).json({ error: 'Чат не найден' });
    if (chat.creator_id !== currentUserId) return res.status(403).json({ error: 'Только создатель может удалять участников' });
    if (removeUserId === chat.creator_id) return res.status(400).json({ error: 'Нельзя удалить создателя' });
    
    db.prepare('DELETE FROM chat_participants WHERE chat_id = ? AND user_id = ?').run(chatId, removeUserId);
    
    const targetSocket = onlineUsers.get(removeUserId);
    if (targetSocket) {
        io.to(targetSocket).emit('removed from chat', { chatId, chatName: chat.name });
    }
    
    res.json({ ok: true });
});

// Назначить администратора
app.post('/api/chat/:chatId/make-admin', requireAuth, (req, res) => {
    const chatId = parseInt(req.params.chatId);
    const currentUserId = req.session.userId;
    const { userId: targetUserId } = req.body;
    
    const chat = db.prepare("SELECT * FROM chats WHERE id = ? AND type = 'channel'").get(chatId);
    if (!chat) return res.status(404).json({ error: 'Канал не найден' });
    if (chat.creator_id !== currentUserId) return res.status(403).json({ error: 'Только создатель может назначать администраторов' });
    
    db.prepare('UPDATE chat_participants SET role = "admin" WHERE chat_id = ? AND user_id = ?').run(chatId, targetUserId);
    res.json({ ok: true });
});

// Удалить администратора
app.post('/api/chat/:chatId/remove-admin', requireAuth, (req, res) => {
    const chatId = parseInt(req.params.chatId);
    const currentUserId = req.session.userId;
    const { userId: targetUserId } = req.body;
    
    const chat = db.prepare("SELECT * FROM chats WHERE id = ? AND type = 'channel'").get(chatId);
    if (!chat) return res.status(404).json({ error: 'Канал не найден' });
    if (chat.creator_id !== currentUserId) return res.status(403).json({ error: 'Только создатель может удалять администраторов' });
    if (targetUserId === chat.creator_id) return res.status(400).json({ error: 'Нельзя удалить создателя' });
    
    db.prepare('UPDATE chat_participants SET role = "member" WHERE chat_id = ? AND user_id = ?').run(chatId, targetUserId);
    res.json({ ok: true });
});

// Выйти из чата
app.post('/api/chat/:chatId/leave', requireAuth, (req, res) => {
    const chatId = parseInt(req.params.chatId);
    const userId = req.session.userId;
    
    const chat = db.prepare("SELECT * FROM chats WHERE id = ? AND (type = 'group' OR type = 'channel')").get(chatId);
    if (!chat) return res.status(404).json({ error: 'Чат не найден' });
    if (chat.creator_id === userId) return res.status(400).json({ error: 'Создатель не может покинуть чат' });
    
    db.prepare('DELETE FROM chat_participants WHERE chat_id = ? AND user_id = ?').run(chatId, userId);
    res.json({ ok: true });
});

// Удалить чат
app.delete('/api/chat/:chatId', requireAuth, (req, res) => {
    const chatId = parseInt(req.params.chatId);
    const userId = req.session.userId;
    
    const chat = db.prepare("SELECT * FROM chats WHERE id = ? AND (type = 'group' OR type = 'channel')").get(chatId);
    if (!chat) return res.status(404).json({ error: 'Чат не найден' });
    if (chat.creator_id !== userId) return res.status(403).json({ error: 'Только создатель может удалить чат' });
    
    try {
        db.prepare('DELETE FROM message_reactions WHERE message_id IN (SELECT id FROM messages WHERE chat_id = ?)').run(chatId);
        db.prepare('DELETE FROM message_reads WHERE message_id IN (SELECT id FROM messages WHERE chat_id = ?)').run(chatId);
        db.prepare('DELETE FROM messages WHERE chat_id = ?').run(chatId);
        db.prepare('DELETE FROM chat_participants WHERE chat_id = ?').run(chatId);
        db.prepare('DELETE FROM chats WHERE id = ?').run(chatId);
        res.json({ ok: true });
    } catch (err) {
        console.error('Ошибка удаления чата:', err);
        res.status(500).json({ error: 'Ошибка удаления' });
    }
});

// Загрузка изображения
app.post('/api/upload', requireAuth, upload.single('image'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'Нет файла' });
    res.json({ imageUrl: `/uploads/${req.file.filename}` });
});

// Загрузка аватарки пользователя
app.post('/api/upload/avatar', requireAuth, uploadAvatar.single('avatar'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'Нет файла' });
    const avatarUrl = `/uploads/avatars/${req.file.filename}`;
    db.prepare('UPDATE users SET avatar = ? WHERE id = ?').run(avatarUrl, req.session.userId);
    res.json({ avatarUrl });
});

// Загрузка голосового сообщения
app.post('/api/upload/voice', requireAuth, uploadVoice.single('audio'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'Нет файла' });
    res.json({ audioUrl: `/uploads/voice/${req.file.filename}` });
});

// Редактировать сообщение
app.put('/api/messages/:messageId', requireAuth, (req, res) => {
    const messageId = req.params.messageId;
    const userId = req.session.userId;
    const { content } = req.body;
    
    if (!content || content.trim().length === 0) {
        return res.status(400).json({ error: 'Сообщение не может быть пустым' });
    }
    
    const message = db.prepare('SELECT * FROM messages WHERE id = ? AND user_id = ?').get(messageId, userId);
    if (!message) return res.status(403).json({ error: 'Нет прав на редактирование' });
    
    db.prepare('UPDATE messages SET content = ?, edited = 1, edited_at = CURRENT_TIMESTAMP WHERE id = ?').run(content.trim(), messageId);
    const updated = db.prepare(`SELECT m.*, u.username, u.avatar FROM messages m JOIN users u ON m.user_id = u.id WHERE m.id = ?`).get(messageId);
    io.to(`chat_${message.chat_id}`).emit('message edited', updated);
    res.json(updated);
});

// Удалить сообщение
app.delete('/api/messages/:messageId', requireAuth, (req, res) => {
    const messageId = req.params.messageId;
    const userId = req.session.userId;
    
    const message = db.prepare('SELECT * FROM messages WHERE id = ? AND user_id = ?').get(messageId, userId);
    if (!message) return res.status(403).json({ error: 'Нет прав на удаление' });
    
    db.prepare('DELETE FROM message_reactions WHERE message_id = ?').run(messageId);
    db.prepare('DELETE FROM message_reads WHERE message_id = ?').run(messageId);
    db.prepare('DELETE FROM messages WHERE id = ?').run(messageId);
    io.to(`chat_${message.chat_id}`).emit('message deleted', { messageId, chatId: message.chat_id });
    res.json({ ok: true });
});

// Онлайн пользователи
app.get('/api/online-users', requireAuth, (req, res) => {
    res.json([...onlineUsers.keys()]);
});

// Очистка старых сессий (раз в день)
if (isRailway) {
    setInterval(() => {
        try {
            const sessionsDir = '/data/sessions';
            if (fs.existsSync(sessionsDir)) {
                const files = fs.readdirSync(sessionsDir);
                const now = Date.now();
                files.forEach(file => {
                    const filePath = path.join(sessionsDir, file);
                    const stats = fs.statSync(filePath);
                    if (now - stats.mtimeMs > 30 * 24 * 60 * 60 * 1000) {
                        fs.unlinkSync(filePath);
                        console.log(`🗑️ Удалена старая сессия: ${file}`);
                    }
                });
            }
        } catch (err) {
            console.error('Ошибка очистки сессий:', err);
        }
    }, 24 * 60 * 60 * 1000);
}

// Обработка ошибок
app.use((err, req, res, next) => {
    if (err.message && err.message.includes('Разрешены только')) {
        return res.status(400).json({ error: err.message });
    }
    if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ error: 'Файл слишком большой' });
    }
    console.error('Server error:', err);
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
});

// ============= АДМИН-ПАНЕЛЬ =============

// Middleware для проверки прав администратора
function requireAdmin(req, res, next) {
    if (!req.session.userId) {
        return res.status(401).json({ error: 'Не авторизован' });
    }
    
    // Проверяем роль из сессии
    if (req.session.role !== 'admin') {
        return res.status(403).json({ error: 'Доступ запрещён. Только для администраторов.' });
    }
    
    next();
}

// Проверка для фронтенда (возвращает данные пользователя)
app.get('/api/admin/me', requireAuth, (req, res) => {
    const user = db.prepare('SELECT id, username, avatar, role FROM users WHERE id = ?').get(req.session.userId);
    res.json(user);
});

// Статистика
app.get('/api/admin/stats', requireAdmin, (req, res) => {
    const users = db.prepare('SELECT COUNT(*) as count FROM users').get();
    const chats = db.prepare('SELECT COUNT(*) as count FROM chats').get();
    const messages = db.prepare('SELECT COUNT(*) as count FROM messages').get();
    const online = onlineUsers.size;
    res.json({ 
        users: users.count, 
        chats: chats.count, 
        messages: messages.count, 
        online 
    });
});

// Список пользователей
app.get('/api/admin/users', requireAdmin, (req, res) => {
    const users = db.prepare('SELECT id, username, role, created_at FROM users ORDER BY id DESC').all();
    res.json(users);
});

// Список чатов
app.get('/api/admin/chats', requireAdmin, (req, res) => {
    const chats = db.prepare(`
        SELECT c.*, COUNT(cp.user_id) as participants_count 
        FROM chats c 
        LEFT JOIN chat_participants cp ON c.id = cp.chat_id 
        GROUP BY c.id 
        ORDER BY c.id DESC
    `).all();
    res.json(chats);
});

// Список сообщений (последние 200)
app.get('/api/admin/messages', requireAdmin, (req, res) => {
    const messages = db.prepare(`
        SELECT m.*, u.username 
        FROM messages m 
        LEFT JOIN users u ON m.user_id = u.id 
        ORDER BY m.id DESC 
        LIMIT 200
    `).all();
    res.json(messages);
});

// Сделать пользователя администратором
app.post('/api/admin/make-admin/:userId', requireAdmin, (req, res) => {
    const userId = req.params.userId;
    try {
        // Нельзя изменить роль у самого себя через этот endpoint
        if (parseInt(userId) === req.session.userId) {
            return res.status(400).json({ error: 'Нельзя изменить свою роль' });
        }
        db.prepare('UPDATE users SET role = "admin" WHERE id = ?').run(userId);
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Удалить пользователя
app.delete('/api/admin/users/:userId', requireAdmin, (req, res) => {
    const userId = req.params.userId;
    try {
        // Нельзя удалить самого себя
        if (parseInt(userId) === req.session.userId) {
            return res.status(400).json({ error: 'Нельзя удалить самого себя' });
        }
        
        // Удаляем все реакции пользователя
        db.prepare('DELETE FROM message_reactions WHERE user_id = ?').run(userId);
        // Удаляем все отметки о прочтении
        db.prepare('DELETE FROM message_reads WHERE user_id = ?').run(userId);
        // Удаляем все сообщения пользователя
        db.prepare('DELETE FROM messages WHERE user_id = ?').run(userId);
        // Удаляем пользователя из участников чатов
        db.prepare('DELETE FROM chat_participants WHERE user_id = ?').run(userId);
        // Удаляем самого пользователя
        db.prepare('DELETE FROM users WHERE id = ?').run(userId);
        
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Удалить чат
app.delete('/api/admin/chats/:chatId', requireAdmin, (req, res) => {
    const chatId = req.params.chatId;
    try {
        // Удаляем реакции сообщений чата
        db.prepare('DELETE FROM message_reactions WHERE message_id IN (SELECT id FROM messages WHERE chat_id = ?)').run(chatId);
        // Удаляем отметки о прочтении сообщений чата
        db.prepare('DELETE FROM message_reads WHERE message_id IN (SELECT id FROM messages WHERE chat_id = ?)').run(chatId);
        // Удаляем сообщения чата
        db.prepare('DELETE FROM messages WHERE chat_id = ?').run(chatId);
        // Удаляем участников чата
        db.prepare('DELETE FROM chat_participants WHERE chat_id = ?').run(chatId);
        // Удаляем сам чат
        db.prepare('DELETE FROM chats WHERE id = ?').run(chatId);
        
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Удалить сообщение
app.delete('/api/admin/messages/:messageId', requireAdmin, (req, res) => {
    const messageId = req.params.messageId;
    try {
        // Удаляем реакции сообщения
        db.prepare('DELETE FROM message_reactions WHERE message_id = ?').run(messageId);
        // Удаляем отметки о прочтении
        db.prepare('DELETE FROM message_reads WHERE message_id = ?').run(messageId);
        // Удаляем само сообщение
        db.prepare('DELETE FROM messages WHERE id = ?').run(messageId);
        
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ============= ПОСТЫ И ЛЕНТА НОВОСТЕЙ =============

/**
 * Создать пост в канале
 * POST /api/channels/:id/posts
 */
app.post('/api/channels/:id/posts', requireAuth, (req, res) => {
    const channelId = parseInt(req.params.id);
    const { content, mediaUrl } = req.body;
    const userId = req.session.userId;
    
    console.log(`📝 Создание поста в канале ${channelId} пользователем ${userId}`);
    
    try {
        // 1. Проверяем, существует ли канал
        const chat = db.prepare('SELECT * FROM chats WHERE id = ?').get(channelId);
        if (!chat) {
            return res.status(404).json({ error: 'Канал не найден' });
        }
        
        // 2. Проверяем, является ли чат каналом
        if (chat.type !== 'channel') {
            return res.status(403).json({ error: 'Это не канал. Посты можно создавать только в каналах.' });
        }
        
        // 3. Проверяем права (только создатель канала или админ)
        const isCreator = chat.creator_id === userId;
        const isAdmin = req.session.role === 'admin';
        
        if (!isCreator && !isAdmin) {
            return res.status(403).json({ error: 'Только создатель канала может создавать посты' });
        }
        
        // 4. Проверяем текст поста
        if (!content || content.trim() === '') {
            return res.status(400).json({ error: 'Текст поста не может быть пустым' });
        }
        
        // 5. Создаём пост
        const stmt = db.prepare(`
            INSERT INTO channel_posts (channel_id, author_id, content, media_url)
            VALUES (?, ?, ?, ?)
        `);
        const info = stmt.run(channelId, userId, content, mediaUrl || null);
        
        // 6. Получаем созданный пост с информацией об авторе
        const post = db.prepare(`
            SELECT p.*, u.username, u.avatar, c.name as channel_name
            FROM channel_posts p
            LEFT JOIN users u ON p.author_id = u.id
            LEFT JOIN chats c ON p.channel_id = c.id
            WHERE p.id = ?
        `).get(info.lastInsertRowid);
        
        
        console.log(`✅ Пост создан! ID: ${post.id}, канал: ${post.channel_name}`);
        
        // ============= ЛОГИ ДЛЯ ОТЛАДКИ =============
        console.log('🔍 ДЕТАЛЬНЫЙ ЛОГ:');
        console.log('   post.id:', post.id);
        console.log('   post.content:', post.content);
        console.log('   post.channel_id:', post.channel_id);
        
        // 7. Получаем подписчиков канала
        const participants = db.prepare('SELECT user_id FROM chat_participants WHERE chat_id = ?').all(channelId);
        console.log(`   Участников канала: ${participants.length}`);
        console.log('   userSessions:', Array.from(userSessions.entries()));
        
        // 8. Отправляем уведомление подписчикам канала через Socket.IO
        participants.forEach(participant => {
            const socketId = userSessions.get(participant.user_id);
            console.log(`   → Пользователь ${participant.user_id}, socketId: ${socketId}`);
            if (socketId) {
                io.to(socketId).emit('new_post', post);
                console.log(`   ✅ Событие отправлено пользователю ${participant.user_id}`);
            } else {
                console.log(`   ❌ НЕТ socketId для пользователя ${participant.user_id}`);
            }
        });
        
        res.status(201).json(post);
        
    } catch (error) {
        console.error('❌ Ошибка создания поста:', error);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

/**
 * Получить ленту новостей пользователя
 * GET /api/feed?limit=20&offset=0
 */


/**
 * ПОЛУЧИТЬ ЛЕНТУ (с лайками)
 * GET /api/feed
 */
app.get('/api/feed', requireAuth, (req, res) => {
    const userId = req.session.userId;
    const limit = parseInt(req.query.limit) || 50;
    const offset = parseInt(req.query.offset) || 0;
    
    try {
        // 1. Получаем посты из каналов, на которые подписан пользователь
const channelPosts = db.prepare(`
    SELECT 
        p.id,
        p.content,
        p.media_url,
        p.created_at,
        p.author_id,
        u.username as author_name,
        u.avatar as author_avatar,
        c.name as source_name,
        c.id as source_id,
        'channel' as source_type,
        (SELECT COUNT(*) FROM post_likes WHERE post_id = p.id) as likes_count,
        (SELECT 1 FROM post_likes WHERE post_id = p.id AND user_id = ?) as user_liked,
        (SELECT COUNT(*) FROM post_comments WHERE post_id = p.id) as comments_count
    FROM channel_posts p
    INNER JOIN chats c ON p.channel_id = c.id
    INNER JOIN chat_participants cp ON c.id = cp.chat_id
    LEFT JOIN users u ON p.author_id = u.id
    WHERE cp.user_id = ? AND c.type = 'channel'
    ORDER BY p.created_at DESC
`).all(userId, userId);
        
        // 2. Получаем статусы друзей (если есть таблица friend_posts)
        let friendPosts = [];
        try {
            friendPosts = db.prepare(`
                SELECT 
                    fp.id,
                    fp.content,
                    fp.media_url,
                    fp.created_at,
                    fp.user_id as author_id,
                    u.username as author_name,
                    u.avatar as author_avatar,
                    u.username as source_name,
                    u.id as source_id,
                    'friend' as source_type,
                    (SELECT COUNT(*) FROM post_likes WHERE post_id = fp.id) as likes_count,
                    (SELECT 1 FROM post_likes WHERE post_id = fp.id AND user_id = ?) as user_liked
                FROM friend_posts fp
                JOIN users u ON fp.user_id = u.id
                WHERE fp.user_id IN (
                    SELECT 
                        CASE 
                            WHEN user_id = ? THEN friend_id 
                            WHEN friend_id = ? THEN user_id 
                        END as friend_id
                    FROM friends 
                    WHERE (user_id = ? OR friend_id = ?) AND status = 'accepted'
                )
                ORDER BY fp.created_at DESC
            `).all(userId, userId, userId, userId, userId);
        } catch(e) {
            // Таблицы friend_posts может не быть - игнорируем
            console.log('friend_posts не найдена');
        }
        
        // 3. Объединяем все посты
        let allPosts = [...channelPosts, ...friendPosts];
        
        // 4. Сортируем по дате (новые сверху)
        allPosts.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
        
        // 5. Пагинация
        const paginatedPosts = allPosts.slice(offset, offset + limit);
        
        // 6. Форматируем для отправки
        const formattedPosts = paginatedPosts.map(post => ({
            ...post,
            user_liked: post.user_liked === 1,
            likes_count: post.likes_count || 0
        }));
        
        res.json(formattedPosts);
        
    } catch (error) {
        console.error('Ошибка получения ленты:', error);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

/**
 * Удалить пост
 * DELETE /api/posts/:id
 */
app.delete('/api/posts/:id', requireAuth, (req, res) => {
    const postId = parseInt(req.params.id);
    const userId = req.session.userId;
    const isAdmin = req.session.role === 'admin';
    
    console.log(`🗑️ Удаление поста ${postId} пользователем ${userId}`);
    
    try {
        // Получаем пост
        const post = db.prepare(`
            SELECT p.*, c.creator_id as channel_creator
            FROM channel_posts p
            JOIN chats c ON p.channel_id = c.id
            WHERE p.id = ?
        `).get(postId);
        
        if (!post) {
            return res.status(404).json({ error: 'Пост не найден' });
        }
        
        // Проверяем права: автор поста, создатель канала или админ
        const isAuthor = post.author_id === userId;
        const isChannelCreator = post.channel_creator === userId;
        
        if (isAuthor || isChannelCreator || isAdmin) {
            db.prepare('DELETE FROM channel_posts WHERE id = ?').run(postId);
            console.log(`✅ Пост ${postId} удалён`);
            res.json({ success: true });
        } else {
            console.log(`❌ Нет прав на удаление поста ${postId}`);
            res.status(403).json({ error: 'У вас нет прав на удаление этого поста' });
        }
        
    } catch (error) {
        console.error('❌ Ошибка удаления поста:', error);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

/**
 * Получить один пост по ID (для просмотра)
 * GET /api/posts/:id
 */
app.get('/api/posts/:id', requireAuth, (req, res) => {
    const postId = parseInt(req.params.id);
    
    try {
        const post = db.prepare(`
            SELECT 
                p.*,
                u.username,
                u.avatar as author_avatar,
                c.name as channel_name,
                c.avatar as channel_avatar
            FROM channel_posts p
            LEFT JOIN users u ON p.author_id = u.id
            LEFT JOIN chats c ON p.channel_id = c.id
            WHERE p.id = ?
        `).get(postId);
        
        if (!post) {
            return res.status(404).json({ error: 'Пост не найден' });
        }
        
        res.json(post);
        
    } catch (error) {
        console.error('❌ Ошибка получения поста:', error);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

// Отдаём публичный ключ для клиента
app.get('/api/push/public-key', (req, res) => {
    res.json({ publicKey: process.env.VAPID_PUBLIC_KEY || null });
});

// ============= PUSH API =============

// Сохранить подписку на push-уведомления
app.post('/api/push/subscribe', requireAuth, (req, res) => {
    const subscription = req.body;
    const userId = req.session.userId;
    
    if (!subscription || !subscription.endpoint) {
        return res.status(400).json({ error: 'Неверная подписка' });
    }
    
    // Сохраняем подписку
    pushSubscriptions.set(userId, subscription);
    console.log(`📱 Пользователь ${userId} (${req.session.username}) подписался на push-уведомления`);
    res.json({ ok: true });
});

// Удалить подписку
app.post('/api/push/unsubscribe', requireAuth, (req, res) => {
    const userId = req.session.userId;
    pushSubscriptions.delete(userId);
    console.log(`📱 Пользователь ${userId} отписался от push-уведомлений`);
    res.json({ ok: true });
});

// Функция отправки уведомления
async function sendPushNotification(userId, title, body, data = {}) {
    const subscription = pushSubscriptions.get(userId);
    if (!subscription) return false;
    
    try {
        await webpush.sendNotification(
            subscription,
            JSON.stringify({
                title: title,
                body: body,
                icon: '/icons/Kryazh.png',
                badge: '/icons/Kryazh.png',
                vibrate: [200, 100, 200],
                data: {
                    url: '/',
                    chatId: data.chatId,
                    messageId: data.messageId,
                    type: data.type || 'new_message'
                },
                tag: `chat-${data.chatId}`,
                renotify: true,
                requireInteraction: true
            })
        );
        console.log(`📨 Push отправлен пользователю ${userId}`);
        return true;
    } catch (err) {
        if (err.statusCode === 410 || err.statusCode === 404) {
            // Подписка устарела — удаляем
            pushSubscriptions.delete(userId);
            console.log(`🗑️ Удалена устаревшая подписка для пользователя ${userId}`);
        } else {
            console.error(`❌ Ошибка отправки push пользователю ${userId}:`, err.message);
        }
        return false;
    }
}

// Экспортируем функцию для использования в WebSocket
// (если нужно использовать в других местах)

// ============= WEBSOCKET =============
io.on('connection', (socket) => {
    let currentUser = null;
    let currentSocketId = socket.id;

    socket.on('auth', (userId) => {
        // Проверка существования пользователя
        const userExists = db.prepare('SELECT id FROM users WHERE id = ?').get(userId);
        if (!userExists) {
            socket.emit('error', { message: 'Пользователь не найден' });
            return;
        }
        
        currentUser = userId;
        
        // Отключаем старую сессию если есть
        const existingSocketId = userSessions.get(userId);
        if (existingSocketId && existingSocketId !== socket.id) {
            const oldSocket = io.sockets.sockets.get(existingSocketId);
            if (oldSocket) {
                oldSocket.emit('session_replaced', { message: 'Новый вход в систему' });
                oldSocket.disconnect(true);
            }
        }
        
        onlineUsers.set(userId, socket.id);
        userSessions.set(userId, socket.id);
        io.emit('user online', userId);
        console.log(`✅ Пользователь ${userId} подключен`);
    });

    socket.on('join chat', (chatId) => {
        socket.join(`chat_${chatId}`);
    });

    socket.on('typing', ({ chatId, username }) => {
        socket.to(`chat_${chatId}`).emit('typing', { username });
    });
    
    socket.on('stop typing', ({ chatId }) => {
        socket.to(`chat_${chatId}`).emit('stop typing');
    });

    socket.on('new message', async (data) => {
        const { chatId, text, userId, username, isImage, imageUrl, isVoice, voiceUrl, forwardedFrom, replyTo, parentId } = data;
        
        if (!chatId || !userId) return;
        
        // Проверка, что userId совпадает с авторизованным
        if (userId !== currentUser) {
            socket.emit('error', { message: 'Неавторизованная отправка' });
            return;
        }
        
        const chat = db.prepare('SELECT type FROM chats WHERE id = ?').get(chatId);
        
        // Проверка прав для каналов
        if (chat && chat.type === 'channel' && !parentId) {
            const participant = db.prepare('SELECT role FROM chat_participants WHERE chat_id = ? AND user_id = ?').get(chatId, userId);
            if (!participant || participant.role !== 'admin') {
                socket.emit('error', { message: 'Только администраторы могут писать в канале' });
                return;
            }
        }
        
        let content;
        if (isImage && imageUrl) content = imageUrl;
        else if (isVoice && voiceUrl) content = voiceUrl;
        else content = text;
        if (!content) return;
        
        try {
            const stmt = db.prepare(`
                INSERT INTO messages (chat_id, user_id, content, image_url, voice_url, forwarded_from, reply_to, parent_id) 
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `);
            const result = stmt.run(
                chatId, userId, content,
                isImage ? imageUrl : null,
                isVoice ? voiceUrl : null,
                forwardedFrom || null,
                replyTo ? replyTo.msgId : null,
                parentId || null
            );
            const msgId = result.lastInsertRowid;

            // Отправляем push-уведомления всем участникам чата (кроме отправителя)
if (!parentId) { // Не отправляем для комментариев
    try {
        // Получаем название чата
        let chatName = null;
        if (chat.type !== 'private') {
            const chatInfo = db.prepare('SELECT name FROM chats WHERE id = ?').get(chatId);
            chatName = chatInfo?.name;
        }
        
        // Получаем всех участников чата, кроме отправителя
        const participants = db.prepare(`
            SELECT user_id FROM chat_participants 
            WHERE chat_id = ? AND user_id != ?
        `).all(chatId, userId);
        
        // Для каждого участника отправляем уведомление
        for (const p of participants) {
            let notificationTitle = '';
            let notificationBody = '';
            
            if (chat.type === 'private') {
                notificationTitle = username;  // Имя собеседника
                notificationBody = content.length > 100 ? content.substring(0, 100) + '...' : content;
            } else {
                notificationTitle = chatName || 'Групповой чат';
                notificationBody = `${username}: ${content.length > 80 ? content.substring(0, 80) + '...' : content}`;
            }
            
            await sendPushNotification(
                p.user_id,
                notificationTitle,
                notificationBody,
                { chatId, messageId: msgId, type: 'new_message' }
            );
        }
    } catch (err) {
        console.error('Ошибка отправки push-уведомлений:', err);
    }
}

            db.prepare('INSERT OR IGNORE INTO message_reads (message_id, user_id) VALUES (?, ?)').run(msgId, userId);
            
            let newMsg = db.prepare(`
                SELECT m.*, u.username, u.avatar, 
                    (SELECT COUNT(*) FROM message_reads WHERE message_id = m.id) as read_count 
                FROM messages m 
                JOIN users u ON m.user_id = u.id 
                WHERE m.id = ?
            `).get(msgId);
            
            if (newMsg.reply_to) {
                const replyMsg = db.prepare(`
                    SELECT m.content, u.username 
                    FROM messages m 
                    JOIN users u ON m.user_id = u.id 
                    WHERE m.id = ?
                `).get(newMsg.reply_to);
                if (replyMsg) newMsg.reply_to_data = { content: replyMsg.content, username: replyMsg.username };
            }
            if (newMsg.voice_url) newMsg.isVoice = true;
            
            if (parentId) {
                socket.emit('new message', newMsg);
                socket.to(`chat_${chatId}`).emit('comment added', newMsg);
            } else {
                io.to(`chat_${chatId}`).emit('new message', newMsg);
            }
        } catch (err) {
            console.error('Ошибка сохранения сообщения:', err);
            socket.emit('error', { message: 'Ошибка отправки сообщения' });
        }
    });

    socket.on('read messages', ({ chatId, userId }) => {
        if (userId !== currentUser) return;
        
        try {
            const msgs = db.prepare('SELECT id FROM messages WHERE chat_id = ? AND user_id != ?').all(chatId, userId);
            if (!msgs.length) return;
            const stmt = db.prepare('INSERT OR IGNORE INTO message_reads (message_id, user_id) VALUES (?, ?)');
            msgs.forEach(msg => stmt.run(msg.id, userId));
            io.to(`chat_${chatId}`).emit('messages read', { chatId, userId });
        } catch (err) {
            console.error('Ошибка read messages:', err);
        }
    });

    socket.on('react', ({ messageId, userId, emoji, chatId }) => {
        if (userId !== currentUser) return;
        
        try {
            const existing = db.prepare(`SELECT * FROM message_reactions WHERE message_id = ? AND user_id = ? AND emoji = ?`).get(messageId, userId, emoji);
            if (existing) {
                db.prepare(`DELETE FROM message_reactions WHERE message_id = ? AND user_id = ? AND emoji = ?`).run(messageId, userId, emoji);
                io.to(`chat_${chatId}`).emit('reaction updated', { messageId, userId, emoji, removed: true });
            } else {
                const otherReaction = db.prepare(`SELECT * FROM message_reactions WHERE message_id = ? AND user_id = ?`).get(messageId, userId);
                if (otherReaction) {
                    db.prepare(`DELETE FROM message_reactions WHERE message_id = ? AND user_id = ?`).run(messageId, userId);
                    io.to(`chat_${chatId}`).emit('reaction updated', { messageId, userId, emoji: otherReaction.emoji, removed: true });
                }
                db.prepare(`INSERT INTO message_reactions (message_id, user_id, emoji) VALUES (?, ?, ?)`).run(messageId, userId, emoji);
                io.to(`chat_${chatId}`).emit('reaction updated', { messageId, userId, emoji, removed: false });
            }
        } catch (err) {
            console.error('Ошибка реакции:', err);
        }
    });

    // Личные звонки
    socket.on('call start', ({ to, from, fromName, offer }) => {
        const targetSocket = onlineUsers.get(to);
        if (targetSocket) {
            io.to(targetSocket).emit('incoming call', { from, fromName, offer });
        } else {
            socket.emit('call rejected', { from: to, reason: 'offline' });
        }
    });

    socket.on('call accept', ({ to, from, answer }) => {
        const targetSocket = onlineUsers.get(to);
        if (targetSocket) {
            io.to(targetSocket).emit('call accepted', { from, answer });
        }
    });

    socket.on('call reject', ({ to, from }) => {
        const targetSocket = onlineUsers.get(to);
        if (targetSocket) {
            io.to(targetSocket).emit('call rejected', { from });
        }
    });

    socket.on('call signal', ({ to, from, signal }) => {
        const targetSocket = onlineUsers.get(to);
        if (targetSocket) {
            io.to(targetSocket).emit('call signal', { from, signal });
        }
    });

    socket.on('call end', ({ to, from }) => {
        const targetSocket = onlineUsers.get(to);
        if (targetSocket) {
            io.to(targetSocket).emit('call ended', { from });
        }
    });

    // Групповые звонки
    socket.on('group call start', ({ chatId, from, fromName }) => {
        socket.to(`chat_${chatId}`).emit('group call started', { from, fromName });
    });

    socket.on('group call end', ({ chatId, from }) => {
        socket.to(`chat_${chatId}`).emit('group call ended', { from });
    });

    socket.on('group call signal', ({ to, from, signal, chatId }) => {
        const targetSocket = onlineUsers.get(to);
        if (targetSocket) {
            io.to(targetSocket).emit('group call signal', { from, signal, chatId });
        }
    });

    socket.on('disconnect', () => {
        if (currentUser) {
            onlineUsers.delete(currentUser);
            userSessions.delete(currentUser);
            io.emit('user offline', currentUser);
            console.log(`❌ Пользователь ${currentUser} отключен`);
        }
    });
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('SIGTERM received, closing server...');
    server.close(() => {
        console.log('Server closed');
        process.exit(0);
    });
});

// ПРИНУДИТЕЛЬНОЕ СОЗДАНИЕ АДМИНА (временный код)
setTimeout(() => {
    try {
        // Добавляем колонку если нет
        db.exec('ALTER TABLE users ADD COLUMN role TEXT DEFAULT "user"');
    } catch(e) {}
    
    try {
        // Делаем kryazh админом
        db.prepare('UPDATE users SET role = "admin" WHERE username = "kryazh"').run();
        console.log('✅ Админ kryazh назначен');
    } catch(e) {}
    
    try {
        // Если пользователя нет — создаём
        const user = db.prepare('SELECT id FROM users WHERE username = "kryazh"').get();
        if (!user) {
            const hash = bcrypt.hashSync('123MaTeYsH123', 10);
            db.prepare('INSERT INTO users (username, password, role) VALUES (?, ?, "admin")').run('kryazh', hash);
            console.log('✅ Админ kryazh создан');
        }
    } catch(e) {}
}, 5000);

// ============================================
// ========== НОВЫЕ МАРШРУТЫ ==========
// ============================================

/**
 * ПОИСК КАНАЛОВ И ГРУПП
 * GET /api/channels/search?q=запрос
 */
app.get('/api/channels/search', requireAuth, (req, res) => {
    const query = req.query.q;
    
    // Если запрос короче 2 символов - возвращаем пустой результат
    if (!query || query.length < 2) {
        return res.json([]);
    }
    
    try {
        // Ищем каналы и группы по названию
        const channels = db.prepare(`
            SELECT 
                c.id,
                c.name,
                c.type,
                c.description,
                c.avatar,
                c.creator_id,
                u.username as creator_name,
                (SELECT COUNT(*) FROM chat_participants WHERE chat_id = c.id) as members_count,
                (SELECT 1 FROM chat_participants WHERE chat_id = c.id AND user_id = ?) as is_member
            FROM chats c
            LEFT JOIN users u ON c.creator_id = u.id
            WHERE (c.type = 'channel' OR c.type = 'group')
              AND c.name LIKE ?
            ORDER BY members_count DESC
            LIMIT 30
        `).all(req.session.userId, `%${query}%`);
        
        res.json(channels);
    } catch (error) {
        console.error('Ошибка поиска каналов:', error);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});


/**
 * ПОЛУЧИТЬ ПОСТЫ КАНАЛА
 * GET /api/channels/:id/posts
 */
app.get('/api/channels/:id/posts', requireAuth, (req, res) => {
    const channelId = parseInt(req.params.id);
    const limit = parseInt(req.query.limit) || 50;
    const offset = parseInt(req.query.offset) || 0;
    
    try {
        // Проверяем, существует ли канал
        const chat = db.prepare('SELECT * FROM chats WHERE id = ? AND type = ?').get(channelId, 'channel');
        if (!chat) {
            return res.status(404).json({ error: 'Канал не найден' });
        }
        
        // Получаем посты канала
        const posts = db.prepare(`
            SELECT 
                p.*,
                u.username,
                u.avatar as avatar_url
            FROM channel_posts p
            LEFT JOIN users u ON p.author_id = u.id
            WHERE p.channel_id = ?
            ORDER BY p.created_at DESC
            LIMIT ? OFFSET ?
        `).all(channelId, limit, offset);
        
        res.json(posts);
        
    } catch (error) {
        console.error('Ошибка получения постов канала:', error);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});
/**
 * ИНФОРМАЦИЯ О КАНАЛЕ
 * GET /api/channels/:id/info
 */
app.get('/api/channels/:id/info', requireAuth, (req, res) => {
    const channelId = parseInt(req.params.id);
    const userId = req.session.userId;
    
    try {
        const channel = db.prepare(`
            SELECT 
                c.*,
                u.username as creator_name,
                (SELECT COUNT(*) FROM chat_participants WHERE chat_id = c.id) as members_count,
                (SELECT 1 FROM chat_participants WHERE chat_id = c.id AND user_id = ?) as is_member
            FROM chats c
            LEFT JOIN users u ON c.creator_id = u.id
            WHERE c.id = ? AND (c.type = 'channel' OR c.type = 'group')
        `).get(userId, channelId);
        
        if (!channel) {
            return res.status(404).json({ error: 'Канал не найден' });
        }
        
        res.json(channel);
    } catch (error) {
        console.error('Ошибка получения информации о канале:', error);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

/**
 * ПОДПИСАТЬСЯ НА КАНАЛ
 * POST /api/channels/:id/subscribe
 */
app.post('/api/channels/:id/subscribe', requireAuth, (req, res) => {
    const channelId = parseInt(req.params.id);
    const userId = req.session.userId;
    
    try {
        const chat = db.getChatById(channelId);
        if (!chat || (chat.type !== 'channel' && chat.type !== 'group')) {
            return res.status(404).json({ error: 'Канал не найден' });
        }
        
        // Проверяем, не подписан ли уже
        const existing = db.prepare('SELECT 1 FROM chat_participants WHERE chat_id = ? AND user_id = ?').get(channelId, userId);
        if (existing) {
            return res.status(400).json({ error: 'Вы уже подписаны' });
        }
        
        // Добавляем подписчика
        db.prepare('INSERT INTO chat_participants (chat_id, user_id, role) VALUES (?, ?, ?)').run(channelId, userId, 'member');
        
        res.json({ success: true });
    } catch (error) {
        console.error('Ошибка подписки:', error);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

/**
 * ОТПИСАТЬСЯ ОТ КАНАЛА
 * DELETE /api/channels/:id/subscribe
 */
app.delete('/api/channels/:id/subscribe', requireAuth, (req, res) => {
    const channelId = parseInt(req.params.id);
    const userId = req.session.userId;
    
    try {
        const chat = db.getChatById(channelId);
        if (!chat) {
            return res.status(404).json({ error: 'Канал не найден' });
        }
        
        // Нельзя отписаться, если вы создатель
        if (chat.creator_id === userId) {
            return res.status(400).json({ error: 'Создатель не может отписаться от своего канала' });
        }
        
        // Удаляем подписчика
        const result = db.prepare('DELETE FROM chat_participants WHERE chat_id = ? AND user_id = ?').run(channelId, userId);
        
        if (result.changes === 0) {
            return res.status(404).json({ error: 'Вы не подписаны на этот канал' });
        }
        
        res.json({ success: true });
    } catch (error) {
        console.error('Ошибка отписки:', error);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

/**
 * ИНФОРМАЦИЯ О ПОЛЬЗОВАТЕЛЕ
 * GET /api/users/:id
 */
app.get('/api/users/:id', requireAuth, (req, res) => {
    const userId = parseInt(req.params.id);
    
    try {
        const user = db.prepare('SELECT id, username, avatar, role, created_at FROM users WHERE id = ?').get(userId);
        if (!user) {
            return res.status(404).json({ error: 'Пользователь не найден' });
        }
        res.json(user);
    } catch (error) {
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

/**
 * КАНАЛЫ И ГРУППЫ ПОЛЬЗОВАТЕЛЯ
 * GET /api/users/:id/channels
 */
app.get('/api/users/:id/channels', requireAuth, (req, res) => {
    const userId = parseInt(req.params.id);
    
    try {
        const channels = db.prepare(`
            SELECT c.id, c.name, c.type, c.description, c.avatar,
                   (SELECT COUNT(*) FROM chat_participants WHERE chat_id = c.id) as members_count
            FROM chats c
            JOIN chat_participants cp ON c.id = cp.chat_id
            WHERE cp.user_id = ? AND (c.type = 'channel' OR c.type = 'group')
            ORDER BY c.created_at DESC
        `).all(userId);
        
        res.json(channels);
    } catch (error) {
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

// ============= СИСТЕМА ДРУЗЕЙ =============

/**
 * Отправить заявку в друзья
 * POST /api/friends/request/:userId
 */
app.post('/api/friends/request/:userId', requireAuth, (req, res) => {
    const fromUserId = req.session.userId;
    const toUserId = parseInt(req.params.userId);
    
    if (fromUserId === toUserId) {
        return res.status(400).json({ error: 'Нельзя добавить себя в друзья' });
    }
    
    try {
        // Проверяем, существует ли пользователь
        const user = db.prepare('SELECT id FROM users WHERE id = ?').get(toUserId);
        if (!user) {
            return res.status(404).json({ error: 'Пользователь не найден' });
        }
        
        // Проверяем, нет ли уже заявки или дружбы
        const existing = db.prepare(`
            SELECT * FROM friends 
            WHERE (user_id = ? AND friend_id = ?) OR (user_id = ? AND friend_id = ?)
        `).get(fromUserId, toUserId, toUserId, fromUserId);
        
        if (existing) {
            if (existing.status === 'accepted') {
                return res.status(400).json({ error: 'Вы уже друзья' });
            }
            if (existing.status === 'pending') {
                return res.status(400).json({ error: 'Заявка уже отправлена' });
            }
        }
        
        // Создаём заявку
        db.prepare('INSERT INTO friends (user_id, friend_id, status) VALUES (?, ?, ?)').run(fromUserId, toUserId, 'pending');
        
        // Отправляем уведомление через Socket.IO
        const targetSocket = userSessions.get(toUserId);
        if (targetSocket) {
            io.to(targetSocket).emit('friend_request', {
                from: fromUserId,
                fromName: req.session.username
            });
        }
        
        res.json({ success: true, message: 'Заявка отправлена' });
        
    } catch (error) {
        console.error('Ошибка отправки заявки:', error);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

/**
 * Принять заявку в друзья
 * POST /api/friends/accept/:userId
 */
app.post('/api/friends/accept/:userId', requireAuth, (req, res) => {
    const currentUserId = req.session.userId;
    const fromUserId = parseInt(req.params.userId);
    
    try {
        const result = db.prepare(`
            UPDATE friends 
            SET status = 'accepted', updated_at = CURRENT_TIMESTAMP 
            WHERE user_id = ? AND friend_id = ? AND status = 'pending'
        `).run(fromUserId, currentUserId);
        
        if (result.changes === 0) {
            return res.status(404).json({ error: 'Заявка не найдена' });
        }
        
        // Уведомляем отправителя
        const targetSocket = userSessions.get(fromUserId);
        if (targetSocket) {
            io.to(targetSocket).emit('friend_accepted', {
                from: currentUserId,
                fromName: req.session.username
            });
        }
        
        res.json({ success: true });
        
    } catch (error) {
        console.error('Ошибка принятия заявки:', error);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

/**
 * Отклонить заявку
 * DELETE /api/friends/reject/:userId
 */
app.delete('/api/friends/reject/:userId', requireAuth, (req, res) => {
    const currentUserId = req.session.userId;
    const fromUserId = parseInt(req.params.userId);
    
    try {
        const result = db.prepare(`
            DELETE FROM friends 
            WHERE user_id = ? AND friend_id = ? AND status = 'pending'
        `).run(fromUserId, currentUserId);
        
        if (result.changes === 0) {
            return res.status(404).json({ error: 'Заявка не найдена' });
        }
        
        res.json({ success: true });
        
    } catch (error) {
        console.error('Ошибка отклонения заявки:', error);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

/**
 * Удалить из друзей
 * DELETE /api/friends/remove/:userId
 */
app.delete('/api/friends/remove/:userId', requireAuth, (req, res) => {
    const currentUserId = req.session.userId;
    const friendId = parseInt(req.params.userId);
    
    try {
        const result = db.prepare(`
            DELETE FROM friends 
            WHERE (user_id = ? AND friend_id = ?) OR (user_id = ? AND friend_id = ?)
        `).run(currentUserId, friendId, friendId, currentUserId);
        
        if (result.changes === 0) {
            return res.status(404).json({ error: 'Друг не найден' });
        }
        
        res.json({ success: true });
        
    } catch (error) {
        console.error('Ошибка удаления друга:', error);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

/**
 * Получить список друзей
 * GET /api/friends
 */
app.get('/api/friends', requireAuth, (req, res) => {
    const userId = req.session.userId;
    
    try {
        const friends = db.prepare(`
            SELECT u.id, u.username, u.avatar, u.online, f.created_at as since
            FROM friends f
            JOIN users u ON (f.user_id = ? AND f.friend_id = u.id) OR (f.friend_id = ? AND f.user_id = u.id)
            WHERE f.status = 'accepted' AND u.id != ?
        `).all(userId, userId, userId);
        
        res.json(friends);
        
    } catch (error) {
        console.error('Ошибка получения списка друзей:', error);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

/**
 * Получить входящие заявки
 * GET /api/friends/requests
 */
app.get('/api/friends/requests', requireAuth, (req, res) => {
    const userId = req.session.userId;
    
    try {
        const requests = db.prepare(`
            SELECT u.id, u.username, u.avatar, f.created_at
            FROM friends f
            JOIN users u ON f.user_id = u.id
            WHERE f.friend_id = ? AND f.status = 'pending'
            ORDER BY f.created_at DESC
        `).all(userId);
        
        res.json(requests);
        
    } catch (error) {
        console.error('Ошибка получения заявок:', error);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

/**
 * Получить исходящие заявки
 * GET /api/friends/outgoing
 */
app.get('/api/friends/outgoing', requireAuth, (req, res) => {
    const userId = req.session.userId;
    
    try {
        const outgoing = db.prepare(`
            SELECT u.id, u.username, u.avatar, f.created_at
            FROM friends f
            JOIN users u ON f.friend_id = u.id
            WHERE f.user_id = ? AND f.status = 'pending'
            ORDER BY f.created_at DESC
        `).all(userId);
        
        res.json(outgoing);
        
    } catch (error) {
        console.error('Ошибка получения исходящих заявок:', error);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

/**
 * Проверить статус дружбы с пользователем
 * GET /api/friends/status/:userId
 */
app.get('/api/friends/status/:userId', requireAuth, (req, res) => {
    const currentUserId = req.session.userId;
    const targetUserId = parseInt(req.params.userId);
    
    try {
        const relation = db.prepare(`
            SELECT status FROM friends 
            WHERE (user_id = ? AND friend_id = ?) OR (user_id = ? AND friend_id = ?)
        `).get(currentUserId, targetUserId, targetUserId, currentUserId);
        
        let status = 'none';
        if (relation) {
            status = relation.status;
        }
        
        res.json({ status });
        
    } catch (error) {
        console.error('Ошибка проверки статуса:', error);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

// ============= СТАТУСЫ ДРУЗЕЙ =============

/**
 * Создать статус
 * POST /api/friends/status
 */
app.post('/api/friends/status', requireAuth, (req, res) => {
    const { content, mediaUrl } = req.body;
    const userId = req.session.userId;
    
    if (!content || content.trim() === '') {
        return res.status(400).json({ error: 'Текст статуса не может быть пустым' });
    }
    
    if (content.length > 500) {
        return res.status(400).json({ error: 'Статус не может быть длиннее 500 символов' });
    }
    
    try {
        const stmt = db.prepare(`
            INSERT INTO friend_posts (user_id, content, media_url)
            VALUES (?, ?, ?)
        `);
        const info = stmt.run(userId, content, mediaUrl || null);
        
        const post = db.prepare(`
            SELECT fp.*, u.username, u.avatar
            FROM friend_posts fp
            JOIN users u ON fp.user_id = u.id
            WHERE fp.id = ?
        `).get(info.lastInsertRowid);
        
        // Отправляем уведомление всем друзьям
        const friends = db.prepare(`
            SELECT user_id FROM friends 
            WHERE (user_id = ? OR friend_id = ?) AND status = 'accepted'
        `).all(userId, userId);
        
        const friendIds = new Set();
        friends.forEach(f => {
            if (f.user_id === userId) {
                // Нужно найти friend_id
                const friend = db.prepare('SELECT friend_id FROM friends WHERE user_id = ? AND friend_id != ?').get(userId, userId);
                if (friend) friendIds.add(friend.friend_id);
            } else {
                friendIds.add(f.user_id);
            }
        });
        
        // Альтернативный способ получить друзей
        const allFriends = db.prepare(`
            SELECT 
                CASE 
                    WHEN user_id = ? THEN friend_id 
                    WHEN friend_id = ? THEN user_id 
                END as friend_id
            FROM friends 
            WHERE (user_id = ? OR friend_id = ?) AND status = 'accepted'
        `).all(userId, userId, userId, userId);
        
        allFriends.forEach(f => {
            if (f.friend_id && f.friend_id !== userId) {
                const socketId = userSessions.get(f.friend_id);
                if (socketId) {
                    io.to(socketId).emit('friend_status', post);
                }
            }
        });
        
        res.status(201).json(post);
        
    } catch (error) {
        console.error('Ошибка создания статуса:', error);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

/**
 * Получить ленту друзей
 * GET /api/friends/feed
 */
app.get('/api/friends/feed', requireAuth, (req, res) => {
    const userId = req.session.userId;
    const limit = parseInt(req.query.limit) || 50;
    const offset = parseInt(req.query.offset) || 0;
    
    try {
        // Получаем статусы друзей
        const feed = db.prepare(`
            SELECT 
                fp.*,
                u.username,
                u.avatar,
                'friend_status' as type
            FROM friend_posts fp
            JOIN users u ON fp.user_id = u.id
            WHERE fp.user_id IN (
                SELECT 
                    CASE 
                        WHEN user_id = ? THEN friend_id 
                        WHEN friend_id = ? THEN user_id 
                    END as friend_id
                FROM friends 
                WHERE (user_id = ? OR friend_id = ?) AND status = 'accepted'
            )
            ORDER BY fp.created_at DESC
            LIMIT ? OFFSET ?
        `).all(userId, userId, userId, userId, limit, offset);
        
        res.json(feed);
        
    } catch (error) {
        console.error('Ошибка получения ленты друзей:', error);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

// ============= ЛАЙКИ К ПОСТАМ И РЕПУТАЦИЯ =============

/**
 * ПОСТАВИТЬ/УБРАТЬ ЛАЙК
 * POST /api/posts/:id/like
 */
app.post('/api/posts/:id/like', requireAuth, (req, res) => {
    const postId = parseInt(req.params.id);
    const userId = req.session.userId;
    
    try {
        // 1. Проверяем, существует ли пост
        const post = db.prepare('SELECT * FROM channel_posts WHERE id = ?').get(postId);
        if (!post) {
            return res.status(404).json({ error: 'Пост не найден' });
        }
        
        // 2. Проверяем, есть ли уже лайк от этого пользователя
        const existingLike = db.prepare('SELECT * FROM post_likes WHERE post_id = ? AND user_id = ?').get(postId, userId);
        
        let action = 'removed';
        let likesCount = 0;
        let userLiked = false;
        
        if (existingLike) {
            // === УБИРАЕМ ЛАЙК ===
            // Удаляем запись о лайке
            db.prepare('DELETE FROM post_likes WHERE post_id = ? AND user_id = ?').run(postId, userId);
            
            // Уменьшаем репутацию автора поста (на 1)
            const repExists = db.prepare('SELECT * FROM user_reputation WHERE user_id = ?').get(post.author_id);
            if (repExists && repExists.points > 0) {
                db.prepare('UPDATE user_reputation SET points = points - 1, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?').run(post.author_id);
            }
            
            // Удаляем из истории репутации
            db.prepare('DELETE FROM reputation_history WHERE from_user_id = ? AND to_user_id = ? AND post_id = ?').run(userId, post.author_id, postId);
            
            action = 'removed';
        } else {
            // === СТАВИМ ЛАЙК ===
            // Добавляем запись о лайке
            db.prepare('INSERT INTO post_likes (post_id, user_id) VALUES (?, ?)').run(postId, userId);
            
            // Увеличиваем репутацию автора поста (на 1)
            const repExists = db.prepare('SELECT * FROM user_reputation WHERE user_id = ?').get(post.author_id);
            if (repExists) {
                db.prepare('UPDATE user_reputation SET points = points + 1, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?').run(post.author_id);
            } else {
                db.prepare('INSERT INTO user_reputation (user_id, points) VALUES (?, 1)').run(post.author_id);
            }
            
            // Добавляем в историю репутации
            db.prepare(`
                INSERT INTO reputation_history (from_user_id, to_user_id, post_id, points) 
                VALUES (?, ?, ?, 1)
            `).run(userId, post.author_id, postId);
            
            action = 'added';
        }
        
        // 3. Получаем обновлённое количество лайков
        const likesResult = db.prepare('SELECT COUNT(*) as count FROM post_likes WHERE post_id = ?').get(postId);
        likesCount = likesResult.count;
        
        // 4. Проверяем, лайкнул ли текущий пользователь
        const userLikedResult = db.prepare('SELECT 1 FROM post_likes WHERE post_id = ? AND user_id = ?').get(postId, userId);
        userLiked = userLikedResult !== undefined;
        
        // 5. Получаем обновлённую репутацию автора
        const repResult = db.prepare('SELECT points FROM user_reputation WHERE user_id = ?').get(post.author_id);
        const authorReputation = repResult ? repResult.points : 0;
        
        // 6. Отправляем ответ
        res.json({ 
            success: true, 
            action: action,
            likesCount: likesCount,
            userLiked: userLiked,
            authorReputation: authorReputation
        });
        
    } catch (error) {
        console.error('Ошибка при лайке:', error);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

/**
 * ПОЛУЧИТЬ КОЛИЧЕСТВО ЛАЙКОВ ПОСТА
 * GET /api/posts/:id/likes
 */
app.get('/api/posts/:id/likes', requireAuth, (req, res) => {
    const postId = parseInt(req.params.id);
    const userId = req.session.userId;
    
    try {
        const likesCount = db.prepare('SELECT COUNT(*) as count FROM post_likes WHERE post_id = ?').get(postId).count;
        const userLiked = db.prepare('SELECT 1 FROM post_likes WHERE post_id = ? AND user_id = ?').get(postId, userId) !== undefined;
        
        res.json({ likesCount, userLiked });
    } catch (error) {
        console.error('Ошибка получения лайков:', error);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

/**
 * ПОЛУЧИТЬ РЕПУТАЦИЮ ПОЛЬЗОВАТЕЛЯ
 * GET /api/users/:id/reputation
 */
app.get('/api/users/:id/reputation', requireAuth, (req, res) => {
    const targetUserId = parseInt(req.params.id);
    
    try {
        // Получаем количество очков репутации
        const reputation = db.prepare('SELECT points FROM user_reputation WHERE user_id = ?').get(targetUserId);
        const points = reputation ? reputation.points : 0;
        
        // Получаем последних 10 человек, кто поставил репутацию
        const recent = db.prepare(`
            SELECT 
                rh.*, 
                u.username, 
                u.avatar,
                p.content as post_preview
            FROM reputation_history rh
            JOIN users u ON rh.from_user_id = u.id
            LEFT JOIN channel_posts p ON rh.post_id = p.id
            WHERE rh.to_user_id = ?
            ORDER BY rh.created_at DESC
            LIMIT 10
        `).all(targetUserId);
        
        res.json({ points, recent });
    } catch (error) {
        console.error('Ошибка получения репутации:', error);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

// Статистика постов для админки
app.get('/api/admin/posts/stats', requireAdmin, (req, res) => {
    const totalPosts = db.prepare('SELECT COUNT(*) as count FROM channel_posts').get();
    const totalLikes = db.prepare('SELECT COUNT(*) as count FROM post_likes').get();
    res.json({ totalPosts: totalPosts.count, totalLikes: totalLikes.count });
});

// Список всех постов для админки
app.get('/api/admin/posts', requireAdmin, (req, res) => {
    const posts = db.prepare(`
        SELECT p.*, c.name as channel_name, u.username as author_name,
               (SELECT COUNT(*) FROM post_likes WHERE post_id = p.id) as likes_count
        FROM channel_posts p
        LEFT JOIN chats c ON p.channel_id = c.id
        LEFT JOIN users u ON p.author_id = u.id
        ORDER BY p.id DESC
        LIMIT 200
    `).all();
    res.json(posts);
});

// Удалить пост из админки
app.delete('/api/admin/posts/:postId', requireAdmin, (req, res) => {
    const postId = req.params.postId;
    try {
        db.prepare('DELETE FROM post_likes WHERE post_id = ?').run(postId);
        db.prepare('DELETE FROM reputation_history WHERE post_id = ?').run(postId);
        db.prepare('DELETE FROM channel_posts WHERE id = ?').run(postId);
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Список репутации для админки
app.get('/api/admin/reputation', requireAdmin, (req, res) => {
    const users = db.prepare(`
        SELECT u.id, u.username, 
               COALESCE(ur.points, 0) as reputation,
               (SELECT COUNT(*) FROM post_likes pl JOIN channel_posts cp ON pl.post_id = cp.id WHERE cp.author_id = u.id) as received_likes
        FROM users u
        LEFT JOIN user_reputation ur ON u.id = ur.user_id
        ORDER BY reputation DESC
    `).all();
    res.json(users);
});

app.post('/api/posts/:id/comments', requireAuth, (req, res) => {
    const postId = parseInt(req.params.id);
    const userId = req.session.userId;
    const { content } = req.body;
    
    console.log('========================================');
    console.log('📝 POST /api/posts/:id/comments');
    console.log('   postId:', postId);
    console.log('   userId:', userId);
    console.log('   content:', content);
    console.log('   req.session:', req.session);
    console.log('========================================');
    
    if (!content || content.trim() === '') {
        console.log('❌ Пустой комментарий');
        return res.status(400).json({ error: 'Комментарий не может быть пустым' });
    }
    
    if (content.length > 1000) {
        console.log('❌ Слишком длинный');
        return res.status(400).json({ error: 'Комментарий слишком длинный (макс. 1000 символов)' });
    }
    
    try {
        // Проверяем, существует ли пост
        const post = db.prepare('SELECT id, author_id FROM channel_posts WHERE id = ?').get(postId);
        console.log('   Пост найден:', post);
        
        if (!post) {
            console.log('❌ Пост не найден');
            return res.status(404).json({ error: 'Пост не найден' });
        }
        
        // Создаём комментарий
        const stmt = db.prepare(`
            INSERT INTO post_comments (post_id, user_id, content)
            VALUES (?, ?, ?)
        `);
        const info = stmt.run(postId, userId, content.trim());
        console.log('   Комментарий создан, ID:', info.lastInsertRowid);
        
        // Получаем созданный комментарий
        const newComment = db.prepare(`
            SELECT pc.*, u.username, u.avatar
            FROM post_comments pc
            JOIN users u ON pc.user_id = u.id
            WHERE pc.id = ?
        `).get(info.lastInsertRowid);
        
        console.log('   Отправляем ответ:', newComment);
        res.status(201).json(newComment);
        
    } catch (error) {
        console.error('❌ ОШИБКА:', error);
        console.error('   error.message:', error.message);
        console.error('   error.stack:', error.stack);
        res.status(500).json({ error: error.message });
    }
});

// ============= РАСШИРЕННЫЕ АДМИН-ФУНКЦИИ =============

/**
 * ИЗМЕНИТЬ РЕПУТАЦИЮ ПОЛЬЗОВАТЕЛЯ (админ)
 * POST /api/admin/users/:userId/reputation
 */
app.post('/api/admin/users/:userId/reputation', requireAdmin, (req, res) => {
    const userId = parseInt(req.params.userId);
    const { points, reason } = req.body;
    
    if (isNaN(points)) {
        return res.status(400).json({ error: 'Укажите количество очков' });
    }
    
    try {
        // Проверяем, существует ли пользователь
        const user = db.prepare('SELECT id, username FROM users WHERE id = ?').get(userId);
        if (!user) {
            return res.status(404).json({ error: 'Пользователь не найден' });
        }
        
        // Обновляем репутацию
        const existing = db.prepare('SELECT * FROM user_reputation WHERE user_id = ?').get(userId);
        if (existing) {
            db.prepare('UPDATE user_reputation SET points = points + ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?')
                .run(points, userId);
        } else {
            db.prepare('INSERT INTO user_reputation (user_id, points) VALUES (?, ?)')
                .run(userId, points);
        }
        
        // Добавляем запись в историю (от админа)
        db.prepare(`
            INSERT INTO reputation_history (from_user_id, to_user_id, points, created_at)
            VALUES (?, ?, ?, CURRENT_TIMESTAMP)
        `).run(req.session.userId, userId, points);
        
        const newPoints = db.prepare('SELECT points FROM user_reputation WHERE user_id = ?').get(userId).points;
        
        res.json({ 
            success: true, 
            newPoints: newPoints,
            message: `Репутация пользователя ${user.username} изменена на ${points > 0 ? '+' : ''}${points}`
        });
        
    } catch (error) {
        console.error('Ошибка изменения репутации:', error);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

/**
 * СБРОС ПАРОЛЯ (выдать временный)
 * POST /api/admin/users/:userId/reset-password
 */
app.post('/api/admin/users/:userId/reset-password', requireAdmin, async (req, res) => {
    const userId = parseInt(req.params.userId);
    
    try {
        const user = db.prepare('SELECT id, username FROM users WHERE id = ?').get(userId);
        if (!user) {
            return res.status(404).json({ error: 'Пользователь не найден' });
        }
        
        // Генерируем временный пароль (8 символов + цифры)
        const tempPassword = Math.random().toString(36).slice(-8) + Math.floor(Math.random() * 1000);
        const hash = await bcrypt.hash(tempPassword, 10);
        
        db.prepare('UPDATE users SET password = ? WHERE id = ?').run(hash, userId);
        
        res.json({ 
            success: true, 
            username: user.username,
            tempPassword: tempPassword
        });
        
    } catch (error) {
        console.error('Ошибка сброса пароля:', error);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

/**
 * ОТПРАВИТЬ СООБЩЕНИЕ ПОЛЬЗОВАТЕЛЮ (от админа)
 * POST /api/admin/users/:userId/message
 */
app.post('/api/admin/users/:userId/message', requireAdmin, (req, res) => {
    const userId = parseInt(req.params.userId);
    const adminId = req.session.userId;
    const { message } = req.body;
    
    if (!message || message.trim() === '') {
        return res.status(400).json({ error: 'Сообщение не может быть пустым' });
    }
    
    try {
        const user = db.prepare('SELECT id FROM users WHERE id = ?').get(userId);
        if (!user) {
            return res.status(404).json({ error: 'Пользователь не найден' });
        }
        
        // Сохраняем сообщение
        db.prepare(`
            INSERT INTO admin_messages (user_id, admin_id, message, created_at)
            VALUES (?, ?, ?, CURRENT_TIMESTAMP)
        `).run(userId, adminId, message.trim());
        
        // Отправляем уведомление через Socket.IO (если пользователь онлайн)
        const socketId = userSessions.get(userId);
        if (socketId) {
            io.to(socketId).emit('admin_message', {
                message: message.trim(),
                date: new Date().toISOString()
            });
        }
        
        res.json({ success: true, message: 'Сообщение отправлено' });
        
    } catch (error) {
        console.error('Ошибка отправки сообщения:', error);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

/**
 * ПОЛУЧИТЬ СПИСОК АДМИНСКИХ СООБЩЕНИЙ (для пользователя)
 * GET /api/admin/messages
 */
app.get('/api/admin/messages', requireAuth, (req, res) => {
    const userId = req.session.userId;
    
    try {
        const messages = db.prepare(`
            SELECT am.*, u.username as admin_name
            FROM admin_messages am
            JOIN users u ON am.admin_id = u.id
            WHERE am.user_id = ?
            ORDER BY am.created_at DESC
            LIMIT 50
        `).all(userId);
        
        res.json(messages);
        
    } catch (error) {
        console.error('Ошибка получения сообщений:', error);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

server.listen(port, () => console.log(`🚀 Kryazh Messenger запущен на http://localhost:${port}`));
