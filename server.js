const express = require('express');
const axios = require('axios');
const app = express();

app.use(express.json({ limit: '50mb' }));
app.use(express.raw({ type: '*/*', limit: '50mb' }));

const YANDEX_TOKEN = process.env.YANDEX_TOKEN;
const TASK_FOLDER = 'app:/tasks';
const PORT = process.env.PORT || 3000;

const taskQueue = new Map();

// Хранилище последних логов
const logStorage = [];
const MAX_LOGS = 100;

// Переопределяем console.log для сохранения в памяти
const originalLog = console.log;
const originalError = console.error;

console.log = function(...args) {
    const message = args.join(' ');
    logStorage.push({ time: new Date().toISOString(), level: 'INFO', message: message });
    if (logStorage.length > MAX_LOGS) logStorage.shift();
    originalLog.apply(console, args);
};

console.error = function(...args) {
    const message = args.join(' ');
    logStorage.push({ time: new Date().toISOString(), level: 'ERROR', message: message });
    if (logStorage.length > MAX_LOGS) logStorage.shift();
    originalError.apply(console, args);
};

console.log('=== Axius WRN Server Starting ===');
console.log('YANDEX_TOKEN:', YANDEX_TOKEN ? 'SET (' + YANDEX_TOKEN.substring(0, 10) + '...)' : 'NOT SET!');
console.log('PORT:', PORT);

class YandexDisk {
    constructor(token) {
        this.token = token;
    }

    async uploadTask(taskId, data) {
        const path = `${TASK_FOLDER}/${taskId}.task`;
        console.log('[Yandex] Uploading to:', path, 'size:', data.length);
        
        const uploadRes = await axios.get(
            `https://cloud-api.yandex.net/v1/disk/resources/upload?path=${path}&overwrite=true`,
            { headers: { 'Authorization': `OAuth ${this.token}` } }
        );
        
        await axios.put(uploadRes.data.href, data, {
            headers: { 'Content-Type': 'application/octet-stream' }
        });
        
        await axios.put(
            `https://cloud-api.yandex.net/v1/disk/resources/publish?path=${path}`,
            {},
            { headers: { 'Authorization': `OAuth ${this.token}` } }
        );
        
        console.log('[Yandex] Upload complete');
        return path;
    }

    async downloadTask(taskId) {
        const path = `${TASK_FOLDER}/${taskId}.task`;
        console.log('[Yandex] Downloading from:', path);
        
        const downloadRes = await axios.get(
            `https://cloud-api.yandex.net/v1/disk/resources/download?path=${path}`,
            { headers: { 'Authorization': `OAuth ${this.token}` } }
        );
        
        const response = await axios.get(downloadRes.data.href, {
            responseType: 'arraybuffer',
            timeout: 30000
        });
        
        console.log('[Yandex] Download complete, size:', response.data.length);
        return Buffer.from(response.data);
    }

    async deleteTask(taskId) {
        const path = `${TASK_FOLDER}/${taskId}.task`;
        try {
            await axios.delete(
                `https://cloud-api.yandex.net/v1/disk/resources?path=${path}&permanently=true`,
                { headers: { 'Authorization': `OAuth ${this.token}` } }
            );
            console.log('[Yandex] Deleted:', path);
        } catch (e) {
            console.error('[Yandex] Delete error:', e.message);
        }
    }
}

const disk = new YandexDisk(YANDEX_TOKEN);

// ============================================================
// ГЛАВНАЯ СТРАНИЦА (КРАСИВАЯ)
// ============================================================
app.get('/', (req, res) => {
    console.log('[GET /] OK');
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <title>Axius WRN</title>
            <style>
                * { margin: 0; padding: 0; box-sizing: border-box; }
                body { 
                    font-family: 'Segoe UI', Arial, sans-serif; 
                    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                    min-height: 100vh;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    padding: 20px;
                }
                .card {
                    background: white;
                    border-radius: 20px;
                    padding: 40px;
                    max-width: 600px;
                    width: 100%;
                    box-shadow: 0 20px 60px rgba(0,0,0,0.3);
                    text-align: center;
                }
                h1 { 
                    color: #333; 
                    margin-bottom: 10px;
                    font-size: 2.5em;
                }
                .emoji { font-size: 3em; margin-bottom: 20px; }
                .status-badge {
                    display: inline-block;
                    background: #4CAF50;
                    color: white;
                    padding: 8px 20px;
                    border-radius: 30px;
                    font-weight: bold;
                    margin-bottom: 30px;
                }
                .info-grid {
                    display: grid;
                    grid-template-columns: 1fr 1fr;
                    gap: 15px;
                    margin-bottom: 30px;
                }
                .info-item {
                    background: #f5f5f5;
                    padding: 15px;
                    border-radius: 10px;
                }
                .info-label { 
                    font-size: 0.8em; 
                    color: #666; 
                    text-transform: uppercase;
                    letter-spacing: 1px;
                }
                .info-value { 
                    font-size: 1.5em; 
                    font-weight: bold; 
                    color: #333; 
                }
                .info-value.ok { color: #4CAF50; }
                .info-value.error { color: #f44336; }
                .links { margin-top: 20px; }
                .btn {
                    display: inline-block;
                    padding: 15px 30px;
                    background: #2196F3;
                    color: white;
                    text-decoration: none;
                    border-radius: 10px;
                    font-weight: bold;
                    transition: transform 0.2s, box-shadow 0.2s;
                    margin: 5px;
                }
                .btn:hover {
                    transform: translateY(-2px);
                    box-shadow: 0 5px 20px rgba(33,150,243,0.4);
                }
                .btn.logs { background: #FF9800; }
                .btn.logs:hover { box-shadow: 0 5px 20px rgba(255,152,0,0.4); }
                .footer { margin-top: 30px; color: #999; font-size: 0.8em; }
            </style>
        </head>
        <body>
            <div class="card">
                <div class="emoji">🚀</div>
                <h1>Axius WRN</h1>
                <div class="status-badge">✅ Backend Online</div>
                
                <div class="info-grid">
                    <div class="info-item">
                        <div class="info-label">Порт</div>
                        <div class="info-value">${PORT}</div>
                    </div>
                    <div class="info-item">
                        <div class="info-label">Токен Яндекса</div>
                        <div class="info-value ${YANDEX_TOKEN ? 'ok' : 'error'}">${YANDEX_TOKEN ? '✅ Установлен' : '❌ Отсутствует'}</div>
                    </div>
                    <div class="info-item">
                        <div class="info-label">Активных задач</div>
                        <div class="info-value">${taskQueue.size}</div>
                    </div>
                    <div class="info-item">
                        <div class="info-label">Логов в памяти</div>
                        <div class="info-value">${logStorage.length}</div>
                    </div>
                </div>
                
                <div class="links">
                    <a href="/logs" class="btn logs">📋 Смотреть логи</a>
                </div>
                
                <div class="footer">
                    Axius WRN Backend • Render • ${new Date().toLocaleString('ru-RU')}
                </div>
            </div>
        </body>
        </html>
    `);
});

// ============================================================
// СТРАНИЦА ЛОГОВ
// ============================================================
app.get('/logs', (req, res) => {
    let html = `
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Axius WRN - Логи</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { 
            font-family: 'Consolas', 'Monaco', monospace; 
            background: #1e1e1e; 
            color: #d4d4d4; 
            padding: 20px;
            min-height: 100vh;
        }
        .container { max-width: 1400px; margin: 0 auto; }
        h1 { 
            color: #4CAF50; 
            margin-bottom: 20px;
            display: flex;
            align-items: center;
            gap: 10px;
        }
        .status-bar { 
            background: #2d2d2d; 
            padding: 15px 20px; 
            border-radius: 10px; 
            margin-bottom: 20px;
            display: flex;
            align-items: center;
            flex-wrap: wrap;
            gap: 20px;
        }
        .status-ok { color: #4CAF50; font-weight: bold; }
        .status-badge {
            background: #3d3d3d;
            padding: 5px 15px;
            border-radius: 20px;
            font-size: 0.9em;
        }
        .btn {
            background: #4CAF50;
            color: white;
            border: none;
            padding: 10px 20px;
            border-radius: 5px;
            cursor: pointer;
            font-size: 14px;
            font-weight: bold;
            transition: opacity 0.2s;
            margin-left: 10px;
        }
        .btn:hover { opacity: 0.8; }
        .btn.clear { background: #f44336; }
        .btn.home { background: #2196F3; }
        .log-container {
            background: #252526;
            border-radius: 10px;
            padding: 20px;
            max-height: 70vh;
            overflow-y: auto;
        }
        .log-entry {
            padding: 8px 0;
            border-bottom: 1px solid #3d3d3d;
            font-size: 13px;
        }
        .log-time { color: #888; margin-right: 15px; }
        .log-level-INFO { color: #4CAF50; font-weight: bold; margin-right: 15px; }
        .log-level-ERROR { color: #f44336; font-weight: bold; margin-right: 15px; }
        .log-message { color: #ddd; word-break: break-all; }
        .empty-logs {
            text-align: center;
            padding: 40px;
            color: #888;
        }
        .auto-refresh {
            color: #888;
            font-size: 0.9em;
            margin-left: auto;
        }
        a { color: white; text-decoration: none; }
    </style>
    <script>
        let autoRefresh = true;
        let timer;
        
        function startAutoRefresh() {
            timer = setInterval(() => { if (autoRefresh) location.reload(); }, 3000);
        }
        
        function toggleAutoRefresh() {
            autoRefresh = !autoRefresh;
            document.getElementById('autoRefreshBtn').textContent = autoRefresh ? '⏸️ Пауза' : '▶️ Авто';
        }
        
        function clearLogs() { 
            fetch('/clear-logs', { method: 'POST' }).then(() => location.reload()); 
        }
        
        window.onload = startAutoRefresh;
    </script>
</head>
<body>
    <div class="container">
        <h1>
            <span>🖥️ Axius WRN Server Logs</span>
            <a href="/" class="btn home">🏠 Главная</a>
        </h1>
        
        <div class="status-bar">
            <span class="status-ok">✅ Сервер работает</span>
            <span class="status-badge">📡 Порт: ${PORT}</span>
            <span class="status-badge">🔑 Токен: ${YANDEX_TOKEN ? 'Установлен' : 'НЕ УСТАНОВЛЕН!'}</span>
            <span class="status-badge">📋 Активных задач: ${taskQueue.size}</span>
            <span class="auto-refresh">🔄 Автообновление 3с</span>
            <button id="autoRefreshBtn" class="btn" onclick="toggleAutoRefresh()">⏸️ Пауза</button>
            <button class="btn clear" onclick="clearLogs()">🗑️ Очистить</button>
            <button class="btn" onclick="location.reload()">🔄 Обновить</button>
        </div>
        
        <div class="log-container">
`;

    if (logStorage.length === 0) {
        html += '<div class="empty-logs">📭 Логов пока нет...</div>';
    } else {
        logStorage.slice().reverse().forEach(log => {
            const time = new Date(log.time).toLocaleTimeString('ru-RU', { hour12: false });
            html += `
            <div class="log-entry">
                <span class="log-time">[${time}]</span>
                <span class="log-level-${log.level}">[${log.level}]</span>
                <span class="log-message">${escapeHtml(log.message)}</span>
            </div>`;
        });
    }

    html += `
        </div>
        <div style="margin-top: 10px; color: #888; font-size: 12px;">
            Показано последних ${logStorage.length} записей из ${MAX_LOGS}
        </div>
    </div>
</body>
</html>`;
    
    res.send(html);
});

// ============================================================
// ОЧИСТКА ЛОГОВ
// ============================================================
app.post('/clear-logs', (req, res) => {
    logStorage.length = 0;
    console.log('=== Logs cleared ===');
    res.json({ status: 'ok' });
});

// ============================================================
// ЭКРАНИРОВАНИЕ HTML
// ============================================================
function escapeHtml(text) {
    if (!text) return '';
    return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

// ============================================================
// ПРИЁМ ЗАДАЧИ
// ============================================================
app.post('/fetch', async (req, res) => {
    console.log('[POST /fetch] Body:', JSON.stringify(req.body).substring(0, 200));
    
    const { task_id, target_url } = req.body;
    
    if (!task_id || !target_url) {
        console.log('[POST /fetch] Missing fields');
        return res.status(400).json({ error: 'Missing task_id or target_url' });
    }
    
    console.log(`[FETCH] Task ${task_id} -> ${target_url}`);
    res.status(202).json({ status: 'queued', task_id });
    
    (async () => {
        try {
            console.log(`[TASK ${task_id}] Downloading from Yandex...`);
            const taskData = await disk.downloadTask(task_id);
            
            const requestStr = taskData.toString('utf8');
            console.log(`[TASK ${task_id}] Request:`, requestStr.substring(0, 200));
            
            const headers = {};
            const lines = requestStr.split('\r\n');
            let targetFullUrl = target_url;
            let method = 'GET';
            
            if (lines[0] && lines[0].includes(' ')) {
                const parts = lines[0].split(' ');
                method = parts[0];
                const path = parts[1];
                
                if (path.startsWith('http://') || path.startsWith('https://')) {
                    targetFullUrl = path;
                } else {
                    const hostLine = lines.find(l => l.toLowerCase().startsWith('host:'));
                    if (hostLine) {
                        const host = hostLine.substring(5).trim();
                        targetFullUrl = 'https://' + host + path;
                    }
                }
                
                for (let i = 1; i < lines.length; i++) {
                    const line = lines[i];
                    if (line === '') break;
                    const colonIndex = line.indexOf(':');
                    if (colonIndex > 0) {
                        const key = line.substring(0, colonIndex).trim();
                        const value = line.substring(colonIndex + 1).trim();
                        headers[key] = value;
                    }
                }
            }
            
            console.log(`[TASK ${task_id}] Fetching ${targetFullUrl}...`);
            
            const targetResponse = await axios({
                method: method,
                url: targetFullUrl,
                responseType: 'arraybuffer',
                timeout: 30000,
                maxRedirects: 5,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                    'Accept': headers['Accept'] || '*/*',
                    'Accept-Language': headers['Accept-Language'] || 'en-US,en;q=0.9',
                    'Accept-Encoding': 'identity',
                    'Connection': 'close'
                },
                validateStatus: function (status) {
                    return status < 500;
                }
            });
            
            let httpResponse = '';
            httpResponse += `HTTP/1.1 ${targetResponse.status} ${targetResponse.statusText}\r\n`;
            
            if (targetResponse.headers) {
                Object.keys(targetResponse.headers).forEach(key => {
                    if (!key.toLowerCase().includes('encoding') && 
                        !key.toLowerCase().includes('connection') &&
                        !key.toLowerCase().includes('transfer')) {
                        httpResponse += `${key}: ${targetResponse.headers[key]}\r\n`;
                    }
                });
            }
            
            let contentType = targetResponse.headers['content-type'] || 'text/html';
            httpResponse += `Content-Type: ${contentType}\r\n`;
            httpResponse += `Content-Length: ${targetResponse.data.length}\r\n`;
            httpResponse += `Connection: close\r\n`;
            httpResponse += `\r\n`;
            
            const headerBuffer = Buffer.from(httpResponse, 'utf8');
            const bodyBuffer = Buffer.from(targetResponse.data);
            const fullResponse = Buffer.concat([headerBuffer, bodyBuffer]);
            
            console.log(`[TASK ${task_id}] Response size: ${fullResponse.length} bytes`);
            
            const resultId = `${task_id}_result`;
            console.log(`[TASK ${task_id}] Uploading result...`);
            await disk.uploadTask(resultId, fullResponse);
            
            taskQueue.set(task_id, {
                status: 'done',
                resultId: resultId,
                timestamp: Date.now()
            });
            
            await disk.deleteTask(task_id);
            console.log(`[TASK ${task_id}] COMPLETED!`);
            
            setTimeout(() => taskQueue.delete(task_id), 300000);
        } catch (error) {
            console.error(`[TASK ${task_id}] ERROR:`, error.message);
            
            const errorResponse = `HTTP/1.1 500 Internal Server Error\r\nContent-Type: text/plain\r\n\r\nError: ${error.message}`;
            const errorBuffer = Buffer.from(errorResponse, 'utf8');
            
            const resultId = `${task_id}_result`;
            try {
                await disk.uploadTask(resultId, errorBuffer);
                taskQueue.set(task_id, {
                    status: 'error',
                    error: error.message,
                    resultId: resultId,
                    timestamp: Date.now()
                });
            } catch (e) {
                console.error(`[TASK ${task_id}] Failed to upload error response:`, e.message);
            }
        }
    })();
});

// ============================================================
// ПРОВЕРКА РЕЗУЛЬТАТА
// ============================================================
app.get('/result', async (req, res) => {
    const { task_id } = req.query;
    console.log('[GET /result] task_id:', task_id);
    
    if (!task_id) {
        return res.status(400).json({ error: 'Missing task_id' });
    }
    
    const task = taskQueue.get(task_id);
    
    if (!task) {
        console.log('[GET /result] Task not found');
        return res.json({ status: 'processing' });
    }
    
    if (task.status === 'done') {
        console.log('[GET /result] DONE:', task.resultId);
        res.json({ status: 'done', result_id: task.resultId });
        taskQueue.delete(task_id);
    } else if (task.status === 'error') {
        console.log('[GET /result] ERROR:', task.error);
        res.status(500).json({ status: 'error', error: task.error, result_id: task.resultId });
        taskQueue.delete(task_id);
    } else {
        console.log('[GET /result] PROCESSING...');
        res.json({ status: 'processing' });
    }
});

// ============================================================
// СКАЧАТЬ РЕЗУЛЬТАТ НАПРЯМУЮ
// ============================================================
app.get('/download/:resultId', async (req, res) => {
    const { resultId } = req.params;
    try {
        const data = await disk.downloadTask(resultId);
        res.set('Content-Type', 'application/octet-stream');
        res.send(data);
        await disk.deleteTask(resultId);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ============================================================
// ЗАПУСК СЕРВЕРА
// ============================================================
app.listen(PORT, () => {
    console.log(`=== Server running on port ${PORT} ===`);
    console.log(`=== Open https://axiuswrn.onrender.com to view status ===`);
    console.log(`=== Open https://axiuswrn.onrender.com/logs to view logs ===`);
});

// ============================================================
// ОЧИСТКА СТАРЫХ ЗАДАЧ
// ============================================================
setInterval(() => {
    const now = Date.now();
    for (const [id, task] of taskQueue.entries()) {
        if (now - task.timestamp > 600000) {
            taskQueue.delete(id);
            console.log('[CLEANUP] Removed old task:', id);
        }
    }
}, 600000);
