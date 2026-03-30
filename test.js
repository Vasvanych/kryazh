const express = require('express');
const session = require('express-session');
const FileStore = require('session-file-store')(session);

const app = express();
const port = 3000;

app.use(session({
    store: new FileStore({ path: './test-sessions' }),
    secret: 'test',
    resave: false,
    saveUninitialized: true,
    cookie: { maxAge: 60000 }
}));

app.get('/', (req, res) => {
    if (!req.session.views) {
        req.session.views = 1;
        res.send('Первый визит. Обновите страницу.');
    } else {
        req.session.views++;
        res.send(`Вы посетили эту страницу ${req.session.views} раз.`);
    }
});

app.listen(port, () => console.log(`Тестовый сервер на http://localhost:${port}`));
