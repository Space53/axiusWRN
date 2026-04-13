const express = require('express');
const axios = require('axios');
const app = express();

app.use(express.json({ limit: '50mb' }));

const YANDEX_TOKEN = process.env.YANDEX_TOKEN;
const TASK_FOLDER = 'app:/tasks';
const PORT = process.env.PORT || 3000;

// Логи в память
const logs = [];
function log(msg) {
    const entry = `[${new Date().toISOString()}] ${msg}`;
    console.log(entry);
    logs.push(entry);
    if (logs.length > 100) logs.shift();
}

log('=== Axius WRN Server Starting ===');
log('TOKEN: ' + (YANDEX_TOKEN ? 'SET' : 'NOT SET'));
log('TASK_FOLDER: ' + TASK_FOLDER);

class YandexDisk {
    constructor(token) {
        this.token = token;
    }

    async listTaskFiles() {
        try {
            log('[Disk] Listing files in ' + TASK_FOLDER);
            const res = await axios.get(`https://cloud-api.yandex.net/v1/disk/resources?path=${TASK_FOLDER}&limit=100`, {
                headers: { 'Authorization': `OAuth ${this.token}` }
            });
            const items = res.data._embedded?.items || [];
            const tasks = items.filter(f => f.name.endsWith('.task'));
            log('[Disk] Found ' + tasks.length + ' task files');
            return tasks;
        } catch (e) {
            log('[Disk] ERROR listing: ' + e.message);
            return [];
        }
    }

    async readFile(path) {
        log('[Disk] Reading: ' + path);
        const dl = await axios.get(`https://cloud-api.yandex.net/v1/disk/resources/download?path=${path}`, {
            headers: { 'Authorization': `OAuth ${this.token}` }
        });
        const res = await axios.get(dl.data.href, { responseType: 'arraybuffer' });
        return Buffer.from(res.data);
    }

    async writeFile(path, data) {
        log('[Disk] Writing: ' + path + ' (' + data.length + ' bytes)');
        const up = await axios.get(`https://cloud-api.yandex.net/v1/disk/resources/upload?path=${path}&overwrite=true`, {
            headers: { 'Authorization': `OAuth ${this.token}` }
        });
        await axios.put(up.data.href, data, {
            headers: { 'Content-Type': 'application/octet-stream' }
        });
        log('[Disk] Written OK');
    }

    async deleteFile(path) {
        try {
            log('[Disk] Deleting: ' + path);
            await axios.delete(`https://cloud-api.yandex.net/v1/disk/resources?path=${path}&permanently=true`, {
                headers: { 'Authorization': `OAuth ${this.token}` }
            });
            log('[Disk] Deleted OK');
        } catch (e) {
            log('[Disk] Delete error: ' + e.message);
        }
    }

    async fileExists(path) {
        try {
            await axios.get(`https://cloud-api.yandex.net/v1/disk/resources?path=${path}`, {
                headers: { 'Authorization': `OAuth ${this.token}` }
            });
            return true;
        } catch { return false; }
    }
}

const disk = new YandexDisk(YANDEX_TOKEN);

// ============ ЭНДПОИНТЫ ============

app.get('/', (req, res) => {
    let html = '<h1>Axius WRN Server</h1>';
    html += '<h2>Logs:</h2><pre>';
    logs.slice().reverse().forEach(l => html += l + '\n');
    html += '</pre>';
    res.send(html);
});

app.post('/fetch', async (req, res) => {
    const { task_id, target_url } = req.body;
    log('[API] /fetch: ' + task_id + ' -> ' + target_url);
    
    if (!task_id || !target_url) {
        log('[API] Missing fields');
        return res.status(400).json({ error: 'Missing fields' });
    }
    
    res.status(202).json({ status: 'queued', task_id });
    log('[API] Task queued: ' + task_id);
});

app.get('/result', async (req, res) => {
    const { task_id } = req.query;
    log('[API] /result: ' + task_id);
    
    const resultPath = `${TASK_FOLDER}/${task_id}_result.task`;
    const exists = await disk.fileExists(resultPath);
    
    if (exists) {
        log('[API] Result ready: ' + task_id);
        res.json({ status: 'done', result_id: task_id + '_result' });
    } else {
        log('[API] Still processing: ' + task_id);
        res.json({ status: 'processing' });
    }
});

// ============ ВОРКЕР ============

async function processTask(taskFile) {
    const taskName = taskFile.name;
    const taskPath = `${TASK_FOLDER}/${taskName}`;
    const resultId = taskName.replace('.task', '_result');
    const resultPath = `${TASK_FOLDER}/${resultId}.task`;
    
    log('[Worker] Processing: ' + taskName);
    
    try {
        // Читаем задачу
        const taskData = await disk.readFile(taskPath);
        const requestStr = taskData.toString('utf8');
        log('[Worker] Request: ' + requestStr.substring(0, 200));
        
        // Извлекаем URL
        let url = '';
        const lines = requestStr.split('\r\n');
        if (lines[0]) {
            const parts = lines[0].split(' ');
            if (parts[1]) {
                url = parts[1];
            }
        }
        
        // Ищем Host заголовок
        let host = '';
        for (const line of lines) {
            if (line.toLowerCase().startsWith('host:')) {
                host = line.substring(5).trim();
                break;
            }
        }
        
        if (!url.startsWith('http')) {
            url = 'https://' + host + url;
        }
        
        log('[Worker] Fetching: ' + url);
        
        // Выполняем запрос
        const response = await axios.get(url, {
            responseType: 'arraybuffer',
            timeout: 30000,
            maxRedirects: 5,
            headers: { 'User-Agent': 'Mozilla/5.0' }
        });
        
        log('[Worker] Response: ' + response.status + ', ' + response.data.length + ' bytes');
        
        // Формируем HTTP-ответ
        let httpResponse = `HTTP/1.1 ${response.status} OK\r\n`;
        httpResponse += `Content-Type: text/html\r\n`;
        httpResponse += `Content-Length: ${response.data.length}\r\n`;
        httpResponse += `\r\n`;
        
        const header = Buffer.from(httpResponse, 'utf8');
        const body = Buffer.from(response.data);
        const full = Buffer.concat([header, body]);
        
        // Сохраняем результат
        await disk.writeFile(resultPath, full);
        
        // Удаляем задачу
        await disk.deleteFile(taskPath);
        
        log('[Worker] DONE: ' + taskName);
        
    } catch (e) {
        log('[Worker] ERROR: ' + e.message);
        
        // Сохраняем ошибку
        const errorResponse = `HTTP/1.1 500 Error\r\nContent-Type: text/html\r\n\r\n<h1>Error</h1><p>${e.message}</p>`;
        await disk.writeFile(resultPath, Buffer.from(errorResponse));
        await disk.deleteFile(taskPath);
    }
}

async function workerLoop() {
    log('[Worker] Loop started');
    
    while (true) {
        try {
            const tasks = await disk.listTaskFiles();
            
            for (const task of tasks) {
                const resultId = task.name.replace('.task', '_result');
                const resultPath = `${TASK_FOLDER}/${resultId}.task`;
                const exists = await disk.fileExists(resultPath);
                
                if (!exists) {
                    await processTask(task);
                }
            }
        } catch (e) {
            log('[Worker] Loop error: ' + e.message);
        }
        
        await new Promise(r => setTimeout(r, 3000));
    }
}

// Запускаем воркер
workerLoop().catch(e => log('[Worker] Fatal: ' + e.message));

// Запускаем сервер
app.listen(PORT, () => log('Server on port ' + PORT));
