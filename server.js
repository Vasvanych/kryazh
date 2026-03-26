const express = require('express');
const path = require('path');
const http = require('http');
const { Server } = require('socket.io');
const db = require('./database');
const multer = require('multer');
const fs = require('fs');
const bcrypt = require('bcrypt');
const session = require('express-session');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const app = express();
app.set('trust proxy', 1);
const server = http.createServer(app);
const io = new Server(server);
const port = process.env.PORT || 3000;

const onlineUsers = new Map();

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

app.use(helmet({ contentSecurityPolicy: false }));
app.use(session({
    secret: 'kryazh-super-secret-key-2024',
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, maxAge: 7 * 24 * 60 * 60 * 1000 }
}));

const apiLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 200 });
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10 });
app.use('/api/', apiLimiter);

function requireAuth(req, res, next) {
    if (!req.session.userId) return res.status(401).json({ error: 'Не авторизован' });
    next();
}

const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];

const upload = multer({
    storage: multer.diskStorage({
        destination: (req, file, cb) => cb(null, uploadDir),
        filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname)
    }),
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        ALLOWED_IMAGE_TYPES.includes(file.mimetype) ? cb(null, true) : cb(new Error('Разрешены только изображения'));
    }
});

const uploadAvatar = multer({
    storage: multer.diskStorage({
        destination: (req, file, cb) => cb(null, avatarDir),
        filename: (req, file, cb) => cb(null, 'avatar-' + Date.now() + path.extname(file.originalname))
    }),
    limits: { fileSize: 2 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        ALLOWED_IMAGE_TYPES.includes(file.mimetype) ? cb(null, true) : cb(new Error('Разрешены только изображения'));
    }
});

const uploadVoice = multer({
    storage: multer.diskStorage({
        destination: (req, file, cb) => cb(null, voiceDir),
        filename: (req, file, cb) => cb(null, 'voice-' + Date.now() + '.webm')
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

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/register', (req, res) => res.sendFile(path.join(__dirname, 'public', 'register.html')));

// Регистрация
app.post('/api/register', authLimiter, async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Заполните все поля' });
    if (username.length < 3 || username.length > 30) return res.status(400).json({ error: 'Имя: от 3 до 30 символов' });
    if (password.length < 6) return res.status(400).json({ error: 'Пароль: минимум 6 символов' });
    if (!/^[a-zA-Z0-9_]+$/.test(username)) return res.status(400).json({ error: 'Имя: только латиница, цифры и _' });

    try {
        const hash = await bcrypt.hash(password, 10);
        const stmt = db.prepare('INSERT INTO users (username, password) VALUES (?, ?)');
        const result = stmt.run(username, hash);
        req.session.userId = result.lastInsertRowid;
        req.session.username = username;
        res.json({ id: result.lastInsertRowid, username });
    } catch (err) {
        if (err.message.includes('UNIQUE')) return res.status(400).json({ error: 'Пользователь уже существует' });
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

// Вход
app.post('/api/login', authLimiter, async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Заполните все поля' });

    try {
        const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
        if (!user) return res.status(401).json({ error: 'Неверное имя или пароль' });
        const match = await bcrypt.compare(password, user.password);
        if (!match) return res.status(401).json({ error: 'Неверное имя или пароль' });
        req.session.userId = user.id;
        req.session.username = user.username;
        res.json({ id: user.id, username: user.username, avatar: user.avatar });
    } catch (err) {
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

app.post('/api/logout', (req, res) => {
    req.session.destroy();
    res.json({ ok: true });
});

app.get('/api/me', (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Не авторизован' });
    const user = db.prepare('SELECT id, username, avatar FROM users WHERE id = ?').get(req.session.userId);
    if (!user) return res.status(401).json({ error: 'Не авторизован' });
    res.json(user);
});

// Список чатов
app.get('/api/chats/:userId', requireAuth, (req, res) => {
    if (parseInt(req.params.userId) !== req.session.userId)
        return res.status(403).json({ error: 'Доступ запрещён' });
    const rows = db.prepare(`
        SELECT c.*,
            (SELECT content FROM messages WHERE chat_id = c.id ORDER BY created_at DESC LIMIT 1) as last_message,
            (SELECT created_at FROM messages WHERE chat_id = c.id ORDER BY created_at DESC LIMIT 1) as last_message_time,
            (SELECT COUNT(*) FROM messages m
             WHERE m.chat_id = c.id AND m.user_id != @userId
             AND m.id NOT IN (SELECT message_id FROM message_reads WHERE user_id = @userId)) as unread_count
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
        WHERE m.chat_id = ?
        ORDER BY m.created_at ASC
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
    const existing = db.prepare(`SELECT c.id FROM chats c JOIN chat_participants cp1 ON c.id = cp1.chat_id JOIN chat_participants cp2 ON c.id = cp2.chat_id WHERE c.type = 'private' AND cp1.user_id = ? AND cp2.user_id = ?`).get(user1, user2);
    if (existing) return res.json({ chatId: existing.id });
    const chatId = db.prepare("INSERT INTO chats (type) VALUES ('private')").run().lastInsertRowid;
    db.prepare('INSERT INTO chat_participants (chat_id, user_id) VALUES (?, ?), (?, ?)').run(chatId, user1, chatId, user2);
    res.json({ chatId });
});

// Создать групповой чат
app.post('/api/chat/group', requireAuth, (req, res) => {
    const { name, members } = req.body;
    const creatorId = req.session.userId;
    if (!name || name.trim().length < 1) return res.status(400).json({ error: 'Введите название группы' });
    const existingGroup = db.prepare(`SELECT c.id FROM chats c JOIN chat_participants cp ON c.id = cp.chat_id WHERE c.type = 'group' AND c.name = ? AND cp.user_id = ?`).get(name.trim(), creatorId);
    if (existingGroup) return res.status(400).json({ error: 'У вас уже есть группа с таким названием' });
    try {
        const chatResult = db.prepare("INSERT INTO chats (name, type, creator_id) VALUES (?, 'group', ?)").run(name.trim(), creatorId);
        const chatId = chatResult.lastInsertRowid;
        const allMembers = [creatorId, ...(members || []).filter(m => m !== creatorId && !isNaN(m))];
        const insertMember = db.prepare('INSERT INTO chat_participants (chat_id, user_id) VALUES (?, ?)');
        allMembers.forEach(m => insertMember.run(chatId, m));
        res.json({ chatId, name });
    } catch (err) {
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

// Участники чата
app.get('/api/chat/:chatId/participants', requireAuth, (req, res) => {
    const chatId = req.params.chatId;
    const userId = req.session.userId;
    const access = db.prepare('SELECT 1 FROM chat_participants WHERE chat_id = ? AND user_id = ?').get(chatId, userId);
    if (!access) return res.status(403).json({ error: 'Доступ запрещён' });
    const rows = db.prepare(`SELECT u.id, u.username, u.avatar FROM users u JOIN chat_participants cp ON u.id = cp.user_id WHERE cp.chat_id = ?`).all(chatId);
    res.json(rows);
});

// Добавить участника в группу
app.post('/api/chat/:chatId/add-participant', requireAuth, (req, res) => {
    const chatId = parseInt(req.params.chatId);
    const currentUserId = req.session.userId;
    const { userId: newUserId } = req.body;
    
    const chat = db.prepare("SELECT * FROM chats WHERE id = ? AND type = 'group'").get(chatId);
    if (!chat) return res.status(404).json({ error: 'Группа не найдена' });
    
    if (chat.creator_id !== currentUserId) {
        return res.status(403).json({ error: 'Только создатель может добавлять участников' });
    }
    
    const user = db.prepare('SELECT id FROM users WHERE id = ?').get(newUserId);
    if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
    
    const existing = db.prepare('SELECT 1 FROM chat_participants WHERE chat_id = ? AND user_id = ?').get(chatId, newUserId);
    if (existing) return res.status(400).json({ error: 'Пользователь уже в группе' });
    
    db.prepare('INSERT INTO chat_participants (chat_id, user_id) VALUES (?, ?)').run(chatId, newUserId);
    
    const targetSocket = onlineUsers.get(newUserId);
    if (targetSocket) {
        io.to(targetSocket).emit('added to group', { chatId, chatName: chat.name });
    }
    
    res.json({ ok: true });
});

// Удалить участника из группы
app.delete('/api/chat/:chatId/remove-participant', requireAuth, (req, res) => {
    const chatId = parseInt(req.params.chatId);
    const currentUserId = req.session.userId;
    const { userId: removeUserId } = req.body;
    
    const chat = db.prepare("SELECT * FROM chats WHERE id = ? AND type = 'group'").get(chatId);
    if (!chat) return res.status(404).json({ error: 'Группа не найдена' });
    
    if (chat.creator_id !== currentUserId) {
        return res.status(403).json({ error: 'Только создатель может удалять участников' });
    }
    
    if (removeUserId === chat.creator_id) {
        return res.status(400).json({ error: 'Нельзя удалить создателя группы' });
    }
    
    db.prepare('DELETE FROM chat_participants WHERE chat_id = ? AND user_id = ?').run(chatId, removeUserId);
    
    const targetSocket = onlineUsers.get(removeUserId);
    if (targetSocket) {
        io.to(targetSocket).emit('removed from group', { chatId, chatName: chat.name });
    }
    
    res.json({ ok: true });
});

// Выйти из группы
app.post('/api/chat/:chatId/leave', requireAuth, (req, res) => {
    const chatId = parseInt(req.params.chatId);
    const userId = req.session.userId;
    
    const chat = db.prepare("SELECT * FROM chats WHERE id = ? AND type = 'group'").get(chatId);
    if (!chat) return res.status(404).json({ error: 'Группа не найдена' });
    
    if (chat.creator_id === userId) {
        return res.status(400).json({ error: 'Создатель не может покинуть группу, только удалить её' });
    }
    
    db.prepare('DELETE FROM chat_participants WHERE chat_id = ? AND user_id = ?').run(chatId, userId);
    
    res.json({ ok: true });
});

// Удалить группу (только для создателя)
app.delete('/api/chat/:chatId', requireAuth, (req, res) => {
    const chatId = parseInt(req.params.chatId);
    const userId = req.session.userId;
    
    const chat = db.prepare("SELECT * FROM chats WHERE id = ? AND type = 'group'").get(chatId);
    if (!chat) return res.status(404).json({ error: 'Группа не найдена' });
    
    if (chat.creator_id !== userId) {
        return res.status(403).json({ error: 'Только создатель может удалить группу' });
    }
    
    db.prepare('DELETE FROM message_reactions WHERE message_id IN (SELECT id FROM messages WHERE chat_id = ?)').run(chatId);
    db.prepare('DELETE FROM message_reads WHERE message_id IN (SELECT id FROM messages WHERE chat_id = ?)').run(chatId);
    db.prepare('DELETE FROM messages WHERE chat_id = ?').run(chatId);
    db.prepare('DELETE FROM chat_participants WHERE chat_id = ?').run(chatId);
    db.prepare('DELETE FROM chats WHERE id = ?').run(chatId);
    
    res.json({ ok: true });
});

// Загрузка изображения
app.post('/api/upload', requireAuth, upload.single('image'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'Нет файла' });
    res.json({ imageUrl: `/uploads/${req.file.filename}` });
});

// Загрузка аватарки
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
    if (!content || content.trim().length === 0) return res.status(400).json({ error: 'Сообщение не может быть пустым' });
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

app.use((err, req, res, next) => {
    if (err.message && err.message.includes('Разрешены только')) return res.status(400).json({ error: err.message });
    if (err.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ error: 'Файл слишком большой' });
    next(err);
});

// ============= WEBSOCKET =============
io.on('connection', (socket) => {
    let currentUser = null;

    socket.on('auth', (userId) => {
        currentUser = userId;
        onlineUsers.set(userId, socket.id);
        io.emit('user online', userId);
    });

    socket.on('join chat', (chatId) => socket.join(`chat_${chatId}`));

    socket.on('typing', ({ chatId, username }) => {
        socket.to(`chat_${chatId}`).emit('typing', { username });
    });
    socket.on('stop typing', ({ chatId }) => {
        socket.to(`chat_${chatId}`).emit('stop typing');
    });

    socket.on('new message', (data) => {
        const { chatId, text, userId, username, isImage, imageUrl, isVoice, voiceUrl, forwardedFrom, replyTo } = data;
        if (!chatId || !userId) return;
        let content;
        if (isImage && imageUrl) content = imageUrl;
        else if (isVoice && voiceUrl) content = voiceUrl;
        else content = text;
        if (!content) return;
        try {
            const stmt = db.prepare(`INSERT INTO messages (chat_id, user_id, content, image_url, voice_url, forwarded_from, reply_to) VALUES (?, ?, ?, ?, ?, ?, ?)`);
            const result = stmt.run(chatId, userId, content, isImage ? imageUrl : null, isVoice ? voiceUrl : null, forwardedFrom || null, replyTo ? replyTo.msgId : null);
            const msgId = result.lastInsertRowid;
            db.prepare('INSERT OR IGNORE INTO message_reads (message_id, user_id) VALUES (?, ?)').run(msgId, userId);
            let newMsg = db.prepare(`SELECT m.*, u.username, u.avatar, (SELECT COUNT(*) FROM message_reads WHERE message_id = m.id) as read_count FROM messages m JOIN users u ON m.user_id = u.id WHERE m.id = ?`).get(msgId);
            if (newMsg.reply_to) {
                const replyMsg = db.prepare(`SELECT m.content, u.username FROM messages m JOIN users u ON m.user_id = u.id WHERE m.id = ?`).get(newMsg.reply_to);
                if (replyMsg) newMsg.reply_to_data = { content: replyMsg.content, username: replyMsg.username };
            }
            if (newMsg.voice_url) newMsg.isVoice = true;
            io.to(`chat_${chatId}`).emit('new message', newMsg);
        } catch (err) {
            console.error('Ошибка сохранения сообщения:', err);
        }
    });

    socket.on('read messages', ({ chatId, userId }) => {
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

    socket.on('disconnect', () => {
        if (currentUser) {
            onlineUsers.delete(currentUser);
            io.emit('user offline', currentUser);
        }
    });
});

server.listen(port, () => console.log(`🚀 Kryazh Messenger запущен на http://localhost:${port}`));
