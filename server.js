const express = require('express');
const session = require('express-session');
const axios = require('axios');
const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(session({
    secret: 'axius-secret',
    resave: false,
    saveUninitialized: false
}));

const PORT = process.env.PORT || 3000;

// Пользователи
const users = new Map();
users.set('admin', { username: 'admin', password: 'admin123', sites: [] });

// Логи
const logs = [];
function log(msg) {
    const entry = `[${new Date().toLocaleTimeString('ru-RU')}] ${msg}`;
    console.log(entry);
    logs.push(entry);
    if (logs.length > 100) logs.shift();
}

log('=== Server started ===');

// ============ ПРОКСИ ЧЕРЕЗ ВНЕШНИЙ СЕРВИС ============
app.get('/proxy', async (req, res) => {
    const url = req.query.url;
    if (!url) return res.status(400).send('URL required');
    
    log('Proxy: ' + url);
    
    try {
        // Используем allorigins.win (бесплатный, без ограничений)
        const proxyUrl = `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`;
        
        const response = await axios.get(proxyUrl, {
            responseType: 'text',
            timeout: 30000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
        });
        
        let html = response.data;
        
        // Внедряем скрипт для перехвата ссылок
        const injectScript = `
            <base href="${url}">
            <script>
            (function() {
                // Перехватываем клики по ссылкам
                document.addEventListener('click', function(e) {
                    const link = e.target.closest('a');
                    if (link && link.href && !link.href.startsWith('javascript:')) {
                        e.preventDefault();
                        const newUrl = new URL(link.href, window.location.href).href;
                        window.parent.location.href = '/browser-frame?url=' + encodeURIComponent(newUrl);
                    }
                });
                
                // Перехватываем формы
                document.addEventListener('submit', function(e) {
                    e.preventDefault();
                    alert('Формы временно не поддерживаются в этой версии.');
                });
            })();
            </script>
        `;
        
        html = html.replace('</head>', injectScript + '</head>');
        
        res.send(html);
        
    } catch (e) {
        log('Proxy error: ' + e.message);
        
        // Fallback: пробуем другой прокси
        try {
            const fallbackUrl = `https://corsproxy.io/?${encodeURIComponent(url)}`;
            const response = await axios.get(fallbackUrl, { timeout: 30000 });
            res.send(response.data);
        } catch (e2) {
            res.status(502).send(`<h1>Ошибка загрузки</h1><p>${e.message}</p><a href="/dashboard">← Назад</a>`);
        }
    }
});

// ============ СТРАНИЦЫ ============
app.get('/', (req, res) => {
    if (req.session.user) return res.redirect('/dashboard');
    res.redirect('/login');
});

app.get('/login', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <style>
                body { font-family: Arial; background: #1a1a2e; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
                .box { background: #2a2a4e; padding: 30px; border-radius: 20px; width: 320px; }
                h1 { color: #00d4ff; text-align: center; }
                input { width: 100%; padding: 15px; margin: 10px 0; background: #1a1a2e; border: 1px solid #444; border-radius: 10px; color: #fff; box-sizing: border-box; }
                button { width: 100%; padding: 15px; background: #00d4ff; border: none; border-radius: 10px; font-weight: bold; cursor: pointer; }
                .error { color: #ff4444; text-align: center; }
                a { color: #00d4ff; }
            </style>
        </head>
        <body>
            <div class="box">
                <h1>🚀 Axius WRN</h1>
                ${req.query.error ? '<p class="error">❌ ' + req.query.error + '</p>' : ''}
                <form method="POST" action="/login">
                    <input type="text" name="username" placeholder="Логин" value="admin" required>
                    <input type="password" name="password" placeholder="Пароль" value="admin123" required>
                    <button type="submit">Войти</button>
                </form>
                <p style="text-align: center; margin-top: 15px;"><a href="/register">Создать аккаунт</a></p>
                <p style="color: #888; font-size: 12px; text-align: center;">admin / admin123</p>
            </div>
        </body>
        </html>
    `);
});

app.post('/login', (req, res) => {
    const { username, password } = req.body;
    const user = users.get(username);
    
    if (user && user.password === password) {
        req.session.user = { username };
        log('Login: ' + username);
        res.redirect('/dashboard');
    } else {
        res.redirect('/login?error=Неверный логин или пароль');
    }
});

app.get('/register', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="UTF-8">
            <style>
                body { font-family: Arial; background: #1a1a2e; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
                .box { background: #2a2a4e; padding: 30px; border-radius: 20px; width: 320px; }
                h1 { color: #00ff88; text-align: center; }
                input { width: 100%; padding: 15px; margin: 10px 0; background: #1a1a2e; border: 1px solid #444; border-radius: 10px; color: #fff; box-sizing: border-box; }
                button { width: 100%; padding: 15px; background: #00ff88; border: none; border-radius: 10px; font-weight: bold; cursor: pointer; }
                a { color: #00d4ff; }
            </style>
        </head>
        <body>
            <div class="box">
                <h1>📝 Регистрация</h1>
                <form method="POST" action="/register">
                    <input type="text" name="username" placeholder="Логин" required>
                    <input type="password" name="password" placeholder="Пароль" required>
                    <button type="submit">Зарегистрироваться</button>
                </form>
                <p style="text-align: center; margin-top: 15px;"><a href="/login">← Назад</a></p>
            </div>
        </body>
        </html>
    `);
});

app.post('/register', (req, res) => {
    const { username, password } = req.body;
    
    if (!username || !password) {
        return res.redirect('/register?error=Заполните все поля');
    }
    
    if (users.has(username)) {
        return res.redirect('/register?error=Пользователь уже существует');
    }
    
    users.set(username, { username, password, sites: [] });
    log('Register: ' + username);
    res.redirect('/login');
});

app.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/login');
});

app.get('/dashboard', (req, res) => {
    if (!req.session.user) return res.redirect('/login');
    
    const username = req.session.user.username;
    const user = users.get(username);
    
    let sitesHtml = '';
    user.sites.forEach(site => {
        sitesHtml += `
            <div style="background: #2a2a4e; padding: 15px; border-radius: 15px; display: flex; align-items: center; gap: 15px; margin-bottom: 10px;">
                <div style="width: 40px; height: 40px; background: #00d4ff; border-radius: 10px; display: flex; align-items: center; justify-content: center; font-size: 20px;">${site.icon}</div>
                <div style="flex: 1;">
                    <div style="font-weight: bold;">${site.name}</div>
                    <div style="font-size: 12px; opacity: 0.7;">${site.url}</div>
                </div>
                <a href="/browser/${site.id}" style="background: #00d4ff; color: #1a1a2e; padding: 8px 12px; border-radius: 8px; text-decoration: none;">Открыть</a>
                <a href="/delete/${site.id}" style="color: #ff4444;" onclick="return confirm('Удалить?')">🗑️</a>
            </div>
        `;
    });
    
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <style>
                body { font-family: Arial; background: #1a1a2e; color: #eee; margin: 0; }
                .header { background: #00d4ff; padding: 15px; display: flex; justify-content: space-between; align-items: center; }
                .header h1 { color: #1a1a2e; margin: 0; font-size: 24px; }
                .container { max-width: 800px; margin: 20px auto; padding: 15px; }
                .add-box { background: #2a2a4e; padding: 20px; border-radius: 15px; margin-bottom: 20px; }
                .add-box input { width: 100%; padding: 12px; margin: 8px 0; background: #1a1a2e; border: 1px solid #444; border-radius: 10px; color: #fff; box-sizing: border-box; }
                .add-box button { width: 100%; padding: 12px; background: #00ff88; border: none; border-radius: 10px; font-weight: bold; cursor: pointer; }
                .logout { background: rgba(0,0,0,0.2); color: #1a1a2e; padding: 8px 15px; border-radius: 5px; text-decoration: none; }
                .nav { display: flex; gap: 10px; }
                .nav a { color: #1a1a2e; text-decoration: none; padding: 8px; background: rgba(0,0,0,0.1); border-radius: 5px; }
            </style>
        </head>
        <body>
            <div class="header">
                <h1>🚀 Axius WRN</h1>
                <div style="display: flex; gap: 15px; align-items: center;">
                    <div class="nav">
                        <a href="/logs">📋 Логи</a>
                    </div>
                    <span>👤 ${username}</span>
                    <a href="/logout" class="logout">Выйти</a>
                </div>
            </div>
            <div class="container">
                <div class="add-box">
                    <h2 style="margin-top: 0;">➕ Добавить сайт</h2>
                    <form method="POST" action="/add">
                        <input type="text" name="name" placeholder="Название" required>
                        <input type="url" name="url" placeholder="URL" value="https://web.telegram.org/k/" required>
                        <button type="submit">Добавить</button>
                    </form>
                    <p style="font-size: 12px; opacity: 0.7; margin-bottom: 0;">💡 Использует внешний прокси (allorigins.win)</p>
                </div>
                <h2>📱 Мои сайты</h2>
                ${sitesHtml || '<p style="opacity: 0.5;">Нет сохранённых сайтов</p>'}
            </div>
        </body>
        </html>
    `);
});

app.post('/add', (req, res) => {
    if (!req.session.user) return res.redirect('/login');
    
    const { name, url } = req.body;
    const user = users.get(req.session.user.username);
    
    const icon = url.includes('telegram') ? '📱' : url.includes('google') ? '🔍' : '🌐';
    
    user.sites.push({ id: Date.now().toString(), name, url, icon });
    log('Added: ' + name);
    res.redirect('/dashboard');
});

app.get('/delete/:id', (req, res) => {
    if (!req.session.user) return res.redirect('/login');
    
    const user = users.get(req.session.user.username);
    user.sites = user.sites.filter(s => s.id !== req.params.id);
    res.redirect('/dashboard');
});

app.get('/browser/:id', (req, res) => {
    if (!req.session.user) return res.redirect('/login');
    
    const user = users.get(req.session.user.username);
    const site = user.sites.find(s => s.id === req.params.id);
    
    if (!site) return res.redirect('/dashboard');
    
    const proxyUrl = `/proxy?url=${encodeURIComponent(site.url)}`;
    
    log('Browser: ' + site.name);
    
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <style>
                body { margin: 0; background: #1a1a2e; }
                .bar { background: #2a2a4e; padding: 10px 15px; display: flex; gap: 10px; align-items: center; }
                .bar a { color: #fff; text-decoration: none; padding: 8px 12px; background: #3a3a5e; border-radius: 5px; white-space: nowrap; }
                .url { flex: 1; padding: 8px 12px; background: #1a1a2e; border-radius: 5px; color: #00d4ff; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
                iframe { width: 100%; height: calc(100vh - 50px); border: none; background: #fff; }
            </style>
        </head>
        <body>
            <div class="bar">
                <a href="/dashboard">← Назад</a>
                <div class="url">${site.url}</div>
                <a href="/logs">📋 Логи</a>
            </div>
            <iframe src="${proxyUrl}" sandbox="allow-same-origin allow-scripts allow-forms allow-popups allow-modals allow-top-navigation"></iframe>
        </body>
        </html>
    `);
});

app.get('/browser-frame', (req, res) => {
    const url = req.query.url;
    if (!url) return res.redirect('/dashboard');
    
    const proxyUrl = `/proxy?url=${encodeURIComponent(url)}`;
    
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="UTF-8">
            <style>
                body { margin: 0; background: #1a1a2e; }
                .bar { background: #2a2a4e; padding: 10px 15px; display: flex; gap: 10px; }
                .bar a { color: #fff; text-decoration: none; padding: 8px 12px; background: #3a3a5e; border-radius: 5px; }
                .url { flex: 1; padding: 8px 12px; background: #1a1a2e; border-radius: 5px; color: #00d4ff; overflow: hidden; text-overflow: ellipsis; }
                iframe { width: 100%; height: calc(100vh - 50px); border: none; background: #fff; }
            </style>
        </head>
        <body>
            <div class="bar">
                <a href="/dashboard">← Назад</a>
                <div class="url">${url}</div>
            </div>
            <iframe src="${proxyUrl}" sandbox="allow-same-origin allow-scripts allow-forms allow-popups allow-modals"></iframe>
        </body>
        </html>
    `);
});

app.get('/logs', (req, res) => {
    if (!req.session.user) return res.redirect('/login');
    
    let html = `
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <style>
                body { font-family: monospace; background: #1a1a2e; color: #0f0; padding: 15px; margin: 0; }
                h1 { color: #00d4ff; }
                .log { background: #0d0d1a; padding: 15px; border-radius: 10px; font-size: 14px; }
                .nav { margin-bottom: 15px; }
                .nav a { color: #00d4ff; margin-right: 15px; text-decoration: none; }
            </style>
        </head>
        <body>
            <div class="nav">
                <a href="/dashboard">← Дашборд</a>
                <a href="/logs">🔄 Обновить</a>
            </div>
            <h1>📋 Логи</h1>
            <div class="log">
    `;
    
    logs.slice().reverse().forEach(l => html += `<div>${l}</div>`);
    
    html += `
            </div>
            <script>setTimeout(() => location.reload(), 5000);</script>
        </body>
        </html>
    `;
    
    res.send(html);
});

app.listen(PORT, () => {
    log(`Server running on port ${PORT}`);
    console.log(`Login: admin / admin123`);
});
