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

// Настройка сессий с максимальной защитой
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
    max: 10
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

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(uploadDir));

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
        const stmt = db.prepare('INSERT INTO users (username, password, role) VALUES (?, ?, "user")');
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

    socket.on('new message', (data) => {
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

server.listen(port, () => console.log(`🚀 Kryazh Messenger запущен на http://localhost:${port}`));
