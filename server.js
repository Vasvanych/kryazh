const express = require('express');
const path = require('path');
const http = require('http');
const { Server } = require('socket.io');
const db = require('./database');
const multer = require('multer');
const fs = require('fs');
const bcrypt = require('bcrypt');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const port = 3000;

const onlineUsers = new Map();

const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);

// Папка для аватарок
const avatarDir = path.join(__dirname, 'uploads', 'avatars');
if (!fs.existsSync(avatarDir)) fs.mkdirSync(avatarDir);

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname)
});
const upload = multer({ storage });

const avatarStorage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, avatarDir),
    filename: (req, file, cb) => cb(null, 'avatar-' + Date.now() + path.extname(file.originalname))
});
const uploadAvatar = multer({ storage: avatarStorage });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(uploadDir));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Регистрация
app.post('/api/register', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password)
        return res.status(400).json({ error: 'Заполните все поля' });
    try {
        const hash = await bcrypt.hash(password, 10);
        db.run('INSERT INTO users (username, password) VALUES (?, ?)', [username, hash], function(err) {
            if (err) {
                if (err.message.includes('UNIQUE'))
                    return res.status(400).json({ error: 'Пользователь уже существует' });
                return res.status(500).json({ error: err.message });
            }
            res.json({ id: this.lastID, username });
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Вход
app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    db.get('SELECT * FROM users WHERE username = ?', [username], async (err, user) => {
        if (err || !user)
            return res.status(401).json({ error: 'Неверное имя или пароль' });
        const match = await bcrypt.compare(password, user.password);
        if (!match)
            return res.status(401).json({ error: 'Неверное имя или пароль' });
        res.json({ id: user.id, username: user.username, avatar: user.avatar });
    });
});

// Список чатов
app.get('/api/chats/:userId', (req, res) => {
    db.all(`
        SELECT c.*,
               (SELECT content FROM messages WHERE chat_id = c.id ORDER BY created_at DESC LIMIT 1) as last_message,
               (SELECT created_at FROM messages WHERE chat_id = c.id ORDER BY created_at DESC LIMIT 1) as last_message_time
        FROM chats c
        JOIN chat_participants cp ON c.id = cp.chat_id
        WHERE cp.user_id = ?
        ORDER BY last_message_time DESC
    `, [req.params.userId], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows || []);
    });
});

// Сообщения чата
app.get('/api/messages/:chatId', (req, res) => {
    db.all(`
        SELECT m.*, u.username, u.avatar
        FROM messages m
        JOIN users u ON m.user_id = u.id
        WHERE m.chat_id = ?
        ORDER BY m.created_at ASC
    `, [req.params.chatId], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows || []);
    });
});

// Поиск пользователей
app.get('/api/users/search', (req, res) => {
    const query = req.query.q;
    if (!query) return res.json([]);
    db.all('SELECT id, username, avatar FROM users WHERE username LIKE ? LIMIT 20',
        [`%${query}%`], (err, rows) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json(rows || []);
        });
});

// Создать личный чат
app.post('/api/chat/private', (req, res) => {
    const { user1, user2 } = req.body;
    db.get(`
        SELECT c.id FROM chats c
        JOIN chat_participants cp1 ON c.id = cp1.chat_id
        JOIN chat_participants cp2 ON c.id = cp2.chat_id
        WHERE c.type = 'private' AND cp1.user_id = ? AND cp2.user_id = ?
    `, [user1, user2], (err, chat) => {
        if (err) return res.status(500).json({ error: err.message });
        if (chat) return res.json({ chatId: chat.id });
        db.run('INSERT INTO chats (type) VALUES ("private")', function(err) {
            if (err) return res.status(500).json({ error: err.message });
            const chatId = this.lastID;
            db.run('INSERT INTO chat_participants (chat_id, user_id) VALUES (?, ?), (?, ?)',
                [chatId, user1, chatId, user2], (err) => {
                    if (err) return res.status(500).json({ error: err.message });
                    res.json({ chatId });
                });
        });
    });
});

// Создать групповой чат
app.post('/api/chat/group', (req, res) => {
    const { name, creatorId, members } = req.body;
    db.run('INSERT INTO chats (name, type) VALUES (?, "group")', [name], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        const chatId = this.lastID;
        const allMembers = [creatorId, ...(members || [])];
        const placeholders = allMembers.map(() => '(?, ?)').join(',');
        const values = allMembers.flatMap(m => [chatId, m]);
        db.run(`INSERT INTO chat_participants (chat_id, user_id) VALUES ${placeholders}`, values, (err) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ chatId, name });
        });
    });
});

// Участники чата
app.get('/api/chat/:chatId/participants', (req, res) => {
    db.all(`
        SELECT u.id, u.username, u.avatar
        FROM users u
        JOIN chat_participants cp ON u.id = cp.user_id
        WHERE cp.chat_id = ?
    `, [req.params.chatId], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

// Загрузка изображения
app.post('/api/upload', upload.single('image'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'Нет файла' });
    res.json({ imageUrl: `/uploads/${req.file.filename}` });
});

// Загрузка аватарки
app.post('/api/upload/avatar', uploadAvatar.single('avatar'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'Нет файла' });
    const userId = req.body.userId;
    const avatarUrl = `/uploads/avatars/${req.file.filename}`;
    db.run('UPDATE users SET avatar = ? WHERE id = ?', [avatarUrl, userId], (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ avatarUrl });
    });
});

// Онлайн пользователи
app.get('/api/online-users', (req, res) => {
    res.json([...onlineUsers.keys()]);
});

// WebSocket
io.on('connection', (socket) => {
    let currentUser = null;

    socket.on('auth', (userId) => {
        currentUser = userId;
        onlineUsers.set(userId, socket.id);
        io.emit('user online', userId);
    });

    socket.on('join chat', (chatId) => {
        socket.join(`chat_${chatId}`);
    });

    // Статус "печатает"
    socket.on('typing', ({ chatId, username }) => {
        socket.to(`chat_${chatId}`).emit('typing', { username });
    });
    socket.on('stop typing', ({ chatId }) => {
        socket.to(`chat_${chatId}`).emit('stop typing');
    });

    socket.on('new message', (data) => {
        const { chatId, text, userId, username, isImage, imageUrl } = data;
        const content = isImage && imageUrl ? imageUrl : text;

        db.run('INSERT INTO messages (chat_id, user_id, content, image_url) VALUES (?, ?, ?, ?)',
            [chatId, userId, content, isImage ? imageUrl : null], function(err) {
                if (err) return console.error('Ошибка сохранения:', err);
                io.to(`chat_${chatId}`).emit('new message', {
                    id: this.lastID,
                    chat_id: chatId,
                    user_id: userId,
                    username,
                    content,
                    isImage: isImage || false,
                    image_url: imageUrl,
                    created_at: new Date().toISOString()
                });
            });
    });

    socket.on('disconnect', () => {
        if (currentUser) {
            onlineUsers.delete(currentUser);
            io.emit('user offline', currentUser);
        }
    });
});

server.listen(port, () => {
    console.log(`🚀 Kryazh Messenger запущен на http://localhost:${port}`);
});