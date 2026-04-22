const express = require('express');
const session = require('express-session');
const { exec } = require('child_process');
const fs = require('fs');
const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
    secret: 'axius-secret',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 24 * 60 * 60 * 1000 }
}));

const PORT = process.env.PORT || 3000;
const YANDEX_TOKEN = process.env.YANDEX_TOKEN || '';
const TASK_FOLDER = 'app:/tasks';

// ============ ЛОГИ ============
const logs = [];
function log(msg) {
    const entry = `[${new Date().toLocaleTimeString()}] ${msg}`;
    console.log(entry);
    logs.push(entry);
    if (logs.length > 200) logs.shift();
}

// ============ ПОЛЬЗОВАТЕЛИ ============
const usersFile = '/tmp/users.json';
let users = {};
if (fs.existsSync(usersFile)) {
    users = JSON.parse(fs.readFileSync(usersFile));
} else {
    users = { 'admin': { password: 'admin123', sites: [] } };
    fs.writeFileSync(usersFile, JSON.stringify(users));
}

function saveUsers() {
    fs.writeFileSync(usersFile, JSON.stringify(users));
}

// ============ PHP БРАУЗЕР (С КУКАМИ) ============
const cookieJar = {};

function phpBrowser(url, method = 'GET', postData = null, sessionId = '') {
    return new Promise((resolve, reject) => {
        // Куки для этого URL
        const host = new URL(url).hostname;
        const cookies = cookieJar[host] || [];
        const cookieString = cookies.map(c => `${c.name}=${c.value}`).join('; ');
        
        const phpScript = `<?php
            session_start();
            
            $url = '${url}';
            $method = '${method}';
            $cookies = '${cookieString}';
            
            $ch = curl_init();
            curl_setopt($ch, CURLOPT_URL, $url);
            curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
            curl_setopt($ch, CURLOPT_FOLLOWLOCATION, true);
            curl_setopt($ch, CURLOPT_MAXREDIRS, 10);
            curl_setopt($ch, CURLOPT_TIMEOUT, 60);
            curl_setopt($ch, CURLOPT_SSL_VERIFYPEER, false);
            curl_setopt($ch, CURLOPT_SSL_VERIFYHOST, false);
            curl_setopt($ch, CURLOPT_USERAGENT, 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
            curl_setopt($ch, CURLOPT_HEADER, true);
            
            $headers = [
                'Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Accept-Language: en-US,en;q=0.5',
                'Accept-Encoding: identity',
                'Connection: close',
                'Upgrade-Insecure-Requests: 1'
            ];
            curl_setopt($ch, CURLOPT_HTTPHEADER, $headers);
            
            if (!empty($cookies)) {
                curl_setopt($ch, CURLOPT_COOKIE, $cookies);
            }
            
            if ($method === 'POST') {
                curl_setopt($ch, CURLOPT_POST, true);
                curl_setopt($ch, CURLOPT_POSTFIELDS, http_build_query($_POST));
            }
            
            $response = curl_exec($ch);
            $info = curl_getinfo($ch);
            curl_close($ch);
            
            $headerSize = $info['header_size'];
            $headers = substr($response, 0, $headerSize);
            $body = substr($response, $headerSize);
            
            // Сохраняем куки в файл для Node.js
            preg_match_all('/^Set-Cookie:\\s*([^;]*)/mi', $headers, $matches);
            $cookies = [];
            foreach ($matches[1] as $cookie) {
                $parts = explode('=', $cookie, 2);
                if (count($parts) === 2) {
                    $cookies[] = ['name' => $parts[0], 'value' => $parts[1]];
                }
            }
            file_put_contents('/tmp/cookies_${host}.json', json_encode($cookies));
            
            // Внедряем base
            $parsed = parse_url($url);
            $base = $parsed['scheme'] . '://' . $parsed['host'];
            $body = str_replace('<head>', '<head><base href="' . $base . '/">', $body);
            
            echo $body;
        ?>`;
        
        fs.writeFileSync('/tmp/browser.php', phpScript);
        
        exec('php /tmp/browser.php', (error, stdout, stderr) => {
            if (error) {
                reject(error);
            } else {
                // Загружаем куки
                const cookieFile = `/tmp/cookies_${host}.json`;
                if (fs.existsSync(cookieFile)) {
                    cookieJar[host] = JSON.parse(fs.readFileSync(cookieFile));
                }
                
                resolve(stdout);
            }
        });
    });
}

// ============ YANDEX DISK API ============
async function listTaskFiles() {
    if (!YANDEX_TOKEN) return [];
    
    const response = await fetch(`https://cloud-api.yandex.net/v1/disk/resources?path=${TASK_FOLDER}&limit=100`, {
        headers: { 'Authorization': `OAuth ${YANDEX_TOKEN}` }
    });
    const data = await response.json();
    const items = data._embedded?.items || [];
    
    return items.filter(f => f.name.endsWith('.task') && !f.name.includes('_result'));
}

async function readFile(path) {
    const dl = await fetch(`https://cloud-api.yandex.net/v1/disk/resources/download?path=${TASK_FOLDER}/${path}`, {
        headers: { 'Authorization': `OAuth ${YANDEX_TOKEN}` }
    });
    const dlData = await dl.json();
    const file = await fetch(dlData.href);
    return await file.text();
}

async function writeFile(path, content) {
    const up = await fetch(`https://cloud-api.yandex.net/v1/disk/resources/upload?path=${TASK_FOLDER}/${path}&overwrite=true`, {
        headers: { 'Authorization': `OAuth ${YANDEX_TOKEN}` }
    });
    const upData = await up.json();
    await fetch(upData.href, {
        method: 'PUT',
        body: content
    });
}

async function deleteFile(path) {
    await fetch(`https://cloud-api.yandex.net/v1/disk/resources?path=${TASK_FOLDER}/${path}&permanently=true`, {
        method: 'DELETE',
        headers: { 'Authorization': `OAuth ${YANDEX_TOKEN}` }
    });
}

// ============ ФОНОВЫЙ ВОРКЕР ============
async function processTask(taskFile) {
    const taskName = taskFile.name;
    const resultId = taskName.replace('.task', '_result') + '.task';
    
    log(`Worker: Processing ${taskName}`);
    
    try {
        const taskData = await readFile(taskName);
        const lines = taskData.split('\r\n');
        const firstLine = lines[0].split(' ');
        const url = firstLine[1];
        
        if (!url) {
            log(`Worker: No URL in ${taskName}`);
            return;
        }
        
        log(`Worker: Fetching ${url}`);
        
        // ИСПОЛЬЗУЕМ PHP БРАУЗЕР!
        const html = await phpBrowser(url);
        
        const result = `HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: ${html.length}\r\n\r\n${html}`;
        
        await writeFile(resultId, result);
        await deleteFile(taskName);
        
        log(`Worker: Done ${taskName}, ${html.length} bytes`);
    } catch (e) {
        log(`Worker: Error ${taskName}: ${e.message}`);
    }
}

async function workerLoop() {
    while (true) {
        try {
            const tasks = await listTaskFiles();
            for (const task of tasks) {
                await processTask(task);
            }
        } catch (e) {
            log(`Worker loop error: ${e.message}`);
        }
        await new Promise(r => setTimeout(r, 3000));
    }
}

// ============ СТАРЫЙ API (ДЛЯ ANDROID) ============
app.post('/fetch', (req, res) => {
    const { task_id, target_url } = req.body;
    log(`API /fetch: ${task_id} -> ${target_url}`);
    res.status(202).json({ status: 'queued', task_id });
});

app.get('/result', (req, res) => {
    const { task_id } = req.query;
    log(`API /result: ${task_id}`);
    res.json({ status: 'processing' });
});

// ============ PHP БРАУЗЕР ЭНДПОИНТ ============
app.get('/browser', async (req, res) => {
    const url = req.query.url;
    if (!url) return res.status(400).send('URL required');
    
    log(`Browser: ${url}`);
    
    try {
        const html = await phpBrowser(url);
        res.send(html);
    } catch (e) {
        log(`Browser error: ${e.message}`);
        res.status(500).send(`<h1>Ошибка</h1><p>${e.message}</p>`);
    }
});

app.post('/browser', async (req, res) => {
    const url = req.query.url;
    if (!url) return res.status(400).send('URL required');
    
    log(`Browser POST: ${url}`);
    
    try {
        const html = await phpBrowser(url, 'POST', req.body);
        res.send(html);
    } catch (e) {
        res.status(500).send(e.message);
    }
});

// ============ АВТОРИЗАЦИЯ ============
app.get('/login', (req, res) => {
    if (req.session.user) return res.redirect('/dashboard');
    
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="UTF-8">
            <style>
                body { font-family: Arial; background: #1a1a2e; display: flex; align-items: center; justify-content: center; min-height: 100vh; }
                .box { background: #2a2a4e; padding: 40px; border-radius: 20px; width: 350px; }
                h1 { color: #00d4ff; text-align: center; }
                input { width: 100%; padding: 15px; margin: 10px 0; background: #1a1a2e; border: 1px solid #444; border-radius: 10px; color: #fff; }
                button { width: 100%; padding: 15px; background: #00d4ff; border: none; border-radius: 10px; font-weight: bold; cursor: pointer; }
                a { color: #00d4ff; }
                .error { color: #ff4444; text-align: center; }
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
                <p style="text-align: center; margin-top: 20px;"><a href="/register">Регистрация</a></p>
                <p style="color: #888; font-size: 12px; text-align: center;">admin / admin123</p>
            </div>
        </body>
        </html>
    `);
});

app.post('/login', (req, res) => {
    const { username, password } = req.body;
    
    if (users[username] && users[username].password === password) {
        req.session.user = { username };
        log(`Login: ${username}`);
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
                body { font-family: Arial; background: #1a1a2e; display: flex; align-items: center; justify-content: center; min-height: 100vh; }
                .box { background: #2a2a4e; padding: 40px; border-radius: 20px; width: 350px; }
                h1 { color: #00ff88; text-align: center; }
                input { width: 100%; padding: 15px; margin: 10px 0; background: #1a1a2e; border: 1px solid #444; border-radius: 10px; color: #fff; }
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
                <p style="text-align: center; margin-top: 20px;"><a href="/login">← Назад</a></p>
            </div>
        </body>
        </html>
    `);
});

app.post('/register', (req, res) => {
    const { username, password } = req.body;
    
    if (users[username]) {
        return res.redirect('/register?error=Пользователь уже существует');
    }
    
    users[username] = { password, sites: [] };
    saveUsers();
    req.session.user = { username };
    log(`Register: ${username}`);
    res.redirect('/dashboard');
});

app.get('/dashboard', (req, res) => {
    if (!req.session.user) return res.redirect('/login');
    
    const username = req.session.user.username;
    const user = users[username];
    
    let sitesHtml = '';
    (user.sites || []).forEach(site => {
        sitesHtml += `
            <div style="background:#2a2a4e;padding:15px;border-radius:15px;display:flex;align-items:center;gap:15px;margin-bottom:10px;">
                <div style="width:40px;height:40px;background:#00d4ff;border-radius:10px;display:flex;align-items:center;justify-content:center;font-size:20px;">${site.icon || '🌐'}</div>
                <div style="flex:1;">
                    <div style="font-weight:bold;">${site.name}</div>
                    <div style="font-size:12px;opacity:0.7;">${site.url}</div>
                </div>
                <a href="/view/${site.id}" style="background:#00d4ff;color:#1a1a2e;padding:8px 12px;border-radius:8px;text-decoration:none;">Открыть</a>
                <a href="/delete/${site.id}" style="color:#ff4444;text-decoration:none;" onclick="return confirm('Удалить?')">🗑️</a>
            </div>
        `;
    });
    
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="UTF-8">
            <style>
                body { font-family: Arial; background: #1a1a2e; color: #eee; margin: 0; }
                .header { background: #00d4ff; padding: 15px; display: flex; justify-content: space-between; }
                .header h1 { color: #1a1a2e; margin: 0; }
                .container { max-width: 800px; margin: 20px auto; padding: 15px; }
                .add-box { background: #2a2a4e; padding: 20px; border-radius: 15px; margin-bottom: 20px; }
                .add-box input { width: 100%; padding: 12px; margin: 8px 0; background: #1a1a2e; border: 1px solid #444; border-radius: 10px; color: #fff; }
                .add-box button { width: 100%; padding: 12px; background: #00ff88; border: none; border-radius: 10px; font-weight: bold; cursor: pointer; }
                .logout { background: rgba(0,0,0,0.2); color: #1a1a2e; padding: 8px 15px; border-radius: 5px; text-decoration: none; }
            </style>
        </head>
        <body>
            <div class="header">
                <h1>🚀 Axius WRN</h1>
                <div>
                    <span>👤 ${username}</span>
                    <a href="/logout" class="logout">Выйти</a>
                    <a href="/logs" style="color:#1a1a2e;margin-left:10px;">📋 Логи</a>
                </div>
            </div>
            <div class="container">
                <div class="add-box">
                    <h2>➕ Добавить сайт</h2>
                    <form method="POST" action="/add">
                        <input type="text" name="name" placeholder="Название" required>
                        <input type="url" name="url" placeholder="URL" value="https://web.telegram.org/k/" required>
                        <button type="submit">Добавить</button>
                    </form>
                    <p style="font-size:12px;opacity:0.7;margin-top:10px;">💡 Открывается через PHP-браузер (полноценный рендеринг)</p>
                </div>
                <h2>📱 Мои сайты</h2>
                ${sitesHtml || '<p style="opacity:0.5;">Нет сайтов</p>'}
            </div>
        </body>
        </html>
    `);
});

app.post('/add', (req, res) => {
    if (!req.session.user) return res.redirect('/login');
    
    const { name, url } = req.body;
    const username = req.session.user.username;
    const icon = url.includes('telegram') ? '📱' : (url.includes('google') ? '🔍' : '🌐');
    
    if (!users[username].sites) users[username].sites = [];
    users[username].sites.push({ id: Date.now().toString(), name, url, icon });
    saveUsers();
    
    res.redirect('/dashboard');
});

app.get('/view/:id', (req, res) => {
    if (!req.session.user) return res.redirect('/login');
    
    const username = req.session.user.username;
    const site = (users[username].sites || []).find(s => s.id === req.params.id);
    
    if (!site) return res.redirect('/dashboard');
    
    const browserUrl = `/browser?url=${encodeURIComponent(site.url)}`;
    
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="UTF-8">
            <style>
                body { margin: 0; background: #1a1a2e; }
                .bar { background: #2a2a4e; padding: 10px 15px; display: flex; gap: 10px; }
                .bar a { color: #fff; text-decoration: none; padding: 8px 12px; background: #3a3a5e; border-radius: 5px; }
                .url { flex: 1; padding: 8px 12px; background: #1a1a2e; border-radius: 5px; color: #00d4ff; }
                iframe { width: 100%; height: calc(100vh - 50px); border: none; }
            </style>
        </head>
        <body>
            <div class="bar">
                <a href="/dashboard">← Назад</a>
                <div class="url">${site.url}</div>
                <a href="${site.url}" target="_blank">↗️</a>
            </div>
            <iframe src="${browserUrl}" sandbox="allow-same-origin allow-scripts allow-forms allow-popups allow-modals"></iframe>
        </body>
        </html>
    `);
});

app.get('/delete/:id', (req, res) => {
    if (!req.session.user) return res.redirect('/login');
    
    const username = req.session.user.username;
    users[username].sites = (users[username].sites || []).filter(s => s.id !== req.params.id);
    saveUsers();
    
    res.redirect('/dashboard');
});

app.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/login');
});

app.get('/logs', (req, res) => {
    if (!req.session.user) return res.redirect('/login');
    
    let html = '<!DOCTYPE html><html><head><meta charset="UTF-8"><style>body{font-family:monospace;background:#1a1a2e;color:#0f0;padding:20px;}</style></head><body><h1>📋 Логи</h1><a href="/dashboard">← Назад</a><pre>';
    logs.slice().reverse().forEach(l => html += l + '\n');
    html += '</pre></body></html>';
    
    res.send(html);
});

app.get('/', (req, res) => {
    if (req.session.user) return res.redirect('/dashboard');
    res.redirect('/login');
});

// ============ ЗАПУСК ============
app.listen(PORT, () => {
    log(`Server running on port ${PORT}`);
    log(`Login: admin / admin123`);
    
    // Запускаем воркер
    workerLoop().catch(e => log(`Worker fatal: ${e.message}`));
});
