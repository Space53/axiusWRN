const express = require('express');
const axios = require('axios');
const app = express();

app.use(express.json({ limit: '50mb' }));
app.use(express.raw({ type: '*/*', limit: '50mb' }));

const YANDEX_TOKEN = process.env.YANDEX_TOKEN;
const TASK_FOLDER = 'app:/tasks';
const PORT = process.env.PORT || 3000;

const logs = [];
function log(msg) {
    const entry = `[${new Date().toISOString()}] ${msg}`;
    console.log(entry);
    logs.push(entry);
    if (logs.length > 50) logs.shift();
}

log('=== Axius WRN Server for Telegram ===');
log('TOKEN: ' + (YANDEX_TOKEN ? 'SET' : 'NOT SET'));

const stats = {
    startTime: new Date(),
    tasksProcessed: 0,
    tasksSucceeded: 0,
    tasksFailed: 0,
    totalBytesDownloaded: 0,
    avgResponseTime: 0
};

class YandexDisk {
    constructor(token) {
        this.token = token;
    }

    async listTaskFiles() {
        try {
            const res = await axios.get(`https://cloud-api.yandex.net/v1/disk/resources?path=${TASK_FOLDER}&limit=100`, {
                headers: { 'Authorization': `OAuth ${this.token}` }
            });
            const items = res.data._embedded?.items || [];
            return items.filter(f => f.name.endsWith('.task') && !f.name.includes('_result'));
        } catch (e) {
            return [];
        }
    }

    async readFile(path) {
        const dl = await axios.get(`https://cloud-api.yandex.net/v1/disk/resources/download?path=${path}`, {
            headers: { 'Authorization': `OAuth ${this.token}` }
        });
        const res = await axios.get(dl.data.href, { responseType: 'arraybuffer' });
        return Buffer.from(res.data);
    }

    async writeFile(path, data) {
        const up = await axios.get(`https://cloud-api.yandex.net/v1/disk/resources/upload?path=${path}&overwrite=true`, {
            headers: { 'Authorization': `OAuth ${this.token}` }
        });
        await axios.put(up.data.href, data, {
            headers: { 'Content-Type': 'application/octet-stream' }
        });
        log('[Disk] Written: ' + path.split('/').pop() + ' (' + data.length + ' bytes)');
    }

    async deleteFile(path) {
        try {
            await axios.delete(`https://cloud-api.yandex.net/v1/disk/resources?path=${path}&permanently=true`, {
                headers: { 'Authorization': `OAuth ${this.token}` }
            });
        } catch (e) {}
    }
}

const disk = new YandexDisk(YANDEX_TOKEN);

// Парсинг HTTP-запроса
function parseHttpRequest(buffer) {
    const str = buffer.toString('utf8');
    const lines = str.split('\r\n');
    const firstLine = lines[0].split(' ');
    
    const method = firstLine[0];
    const url = firstLine[1];
    
    const headers = {};
    let i = 1;
    while (i < lines.length && lines[i] !== '') {
        const colonIndex = lines[i].indexOf(':');
        if (colonIndex > 0) {
            const key = lines[i].substring(0, colonIndex).trim();
            const value = lines[i].substring(colonIndex + 1).trim();
            headers[key] = value;
        }
        i++;
    }
    
    // Тело запроса (после \r\n\r\n)
    const bodyStart = str.indexOf('\r\n\r\n');
    let body = null;
    if (bodyStart !== -1) {
        body = buffer.slice(bodyStart + 4);
    }
    
    // Определяем полный URL
    let fullUrl = url;
    if (!fullUrl.startsWith('http')) {
        const host = headers['Host'] || headers['host'];
        if (host) {
            fullUrl = 'https://' + host + url;
        }
    }
    
    return { method, url, fullUrl, headers, body };
}

// Выполнение HTTP-запроса
async function executeRequest(method, url, headers, body) {
    const config = {
        method: method,
        url: url,
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Accept': '*/*',
            'Accept-Language': 'en-US,en;q=0.9',
            'Accept-Encoding': 'identity'
        },
        timeout: 30000,
        maxRedirects: 5,
        validateStatus: status => status < 500
    };
    
    // Копируем важные заголовки
    if (headers) {
        for (const [key, value] of Object.entries(headers)) {
            if (!['host', 'connection', 'accept-encoding', 'proxy-connection'].includes(key.toLowerCase())) {
                config.headers[key] = value;
            }
        }
    }
    
    // Добавляем тело для POST/PUT/PATCH
    if (body && body.length > 0 && ['POST', 'PUT', 'PATCH'].includes(method)) {
        config.data = body;
    }
    
    return await axios(config);
}

async function processTask(taskFile) {
    const taskName = taskFile.name;
    const taskPath = `${TASK_FOLDER}/${taskName}`;
    const resultId = taskName.replace('.task', '_result');
    const resultPath = `${TASK_FOLDER}/${resultId}.task`;
    
    stats.tasksProcessed++;
    const startTime = Date.now();
    
    log('[Worker] Processing: ' + taskName);
    
    try {
        // Читаем задачу
        const taskData = await disk.readFile(taskPath);
        const parsed = parseHttpRequest(taskData);
        
        log('[Worker] ' + parsed.method + ' ' + parsed.fullUrl);
        
        // Выполняем запрос
        const response = await executeRequest(
            parsed.method, 
            parsed.fullUrl, 
            parsed.headers, 
            parsed.body
        );
        
        const duration = Date.now() - startTime;
        stats.tasksSucceeded++;
        stats.totalBytesDownloaded += response.data.length;
        stats.avgResponseTime = (stats.avgResponseTime * (stats.tasksSucceeded - 1) + duration) / stats.tasksSucceeded;
        
        log('[Worker] Response: ' + response.status + ', ' + response.data.length + ' bytes, ' + duration + 'ms');
        
        // Формируем HTTP-ответ
        let httpResponse = `HTTP/1.1 ${response.status} ${response.statusText}\r\n`;
        
        // Добавляем заголовки ответа
        if (response.headers) {
            for (const [key, value] of Object.entries(response.headers)) {
                if (!['connection', 'transfer-encoding', 'keep-alive'].includes(key.toLowerCase())) {
                    httpResponse += `${key}: ${value}\r\n`;
                }
            }
        }
        
        httpResponse += `Content-Length: ${response.data.length}\r\n`;
        httpResponse += `Connection: close\r\n`;
        httpResponse += `\r\n`;
        
        const header = Buffer.from(httpResponse, 'utf8');
        const body = Buffer.isBuffer(response.data) ? response.data : Buffer.from(response.data);
        const full = Buffer.concat([header, body]);
        
        await disk.writeFile(resultPath, full);
        await disk.deleteFile(taskPath);
        
        log('[Worker] DONE: ' + taskName);
        
    } catch (e) {
        stats.tasksFailed++;
        log('[Worker] ERROR: ' + e.message);
        
        // Создаём ответ с ошибкой
        const errorResponse = `HTTP/1.1 502 Bad Gateway\r\nContent-Type: text/plain\r\nContent-Length: ${e.message.length}\r\n\r\n${e.message}`;
        await disk.writeFile(resultPath, Buffer.from(errorResponse));
        await disk.deleteFile(taskPath);
    }
}

async function workerLoop() {
    log('[Worker] Started');
    
    while (true) {
        try {
            const tasks = await disk.listTaskFiles();
            
            if (tasks.length > 0) {
                log('[Worker] Found ' + tasks.length + ' tasks');
            }
            
            // Обрабатываем задачи параллельно (до 5 одновременно)
            const batch = tasks.slice(0, 5);
            await Promise.all(batch.map(task => processTask(task)));
            
        } catch (e) {
            log('[Worker] Loop error: ' + e.message);
        }
        
        await new Promise(r => setTimeout(r, 1000)); // Проверяем каждую секунду для быстрой реакции
    }
}

// Главная страница
app.get('/', (req, res) => {
    const uptime = Math.floor((Date.now() - stats.startTime) / 1000);
    const uptimeStr = `${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m ${uptime % 60}s`;
    const successRate = stats.tasksProcessed > 0 ? ((stats.tasksSucceeded / stats.tasksProcessed) * 100).toFixed(1) : '0';
    
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="UTF-8">
            <title>Axius WRN - Telegram Ready</title>
            <style>
                body { font-family: Arial; padding: 20px; background: #1a1a2e; color: #eee; }
                h1 { color: #00d4ff; }
                .stat { background: rgba(255,255,255,0.1); padding: 15px; border-radius: 10px; margin: 10px 0; }
                .badge { display: inline-block; padding: 5px 15px; border-radius: 20px; background: #00ff88; color: #000; }
            </style>
            <script>setTimeout(() => location.reload(), 5000);</script>
        </head>
        <body>
            <h1>🚀 Axius WRN Server</h1>
            <span class="badge">Telegram Ready</span>
            
            <div class="stat">
                <p>⏱️ Uptime: ${uptimeStr}</p>
                <p>📊 Tasks: ${stats.tasksSucceeded}/${stats.tasksProcessed} (${successRate}%)</p>
                <p>💾 Downloaded: ${(stats.totalBytesDownloaded / 1024 / 1024).toFixed(2)} MB</p>
                <p>⚡ Avg response: ${Math.round(stats.avgResponseTime)}ms</p>
            </div>
            
            <h3>📋 Recent Logs</h3>
            <pre style="background: #000; padding: 10px; border-radius: 5px; font-size: 11px; max-height: 400px; overflow-y: auto;">
${logs.slice().reverse().map(l => escapeHtml(l)).join('\n')}
            </pre>
        </body>
        </html>
    `);
});

function escapeHtml(text) {
    return String(text).replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Запуск
workerLoop().catch(e => log('[Worker] Fatal: ' + e.message));

app.listen(PORT, () => {
    log('=== Server running on port ' + PORT + ' ===');
    log('=== Ready for Telegram Web ===');
});
