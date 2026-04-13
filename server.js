const express = require('express');
const axios = require('axios');
const app = express();

app.use(express.json({ limit: '50mb' }));
app.use(express.raw({ type: '*/*', limit: '50mb' }));

const YANDEX_TOKEN = process.env.YANDEX_TOKEN;
const TASK_FOLDER = 'app:/tasks';
const PORT = process.env.PORT || 3000;

const taskQueue = new Map();

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

// ГЛАВНАЯ СТРАНИЦА
app.get('/', (req, res) => {
    console.log('[GET /] OK');
    res.send('Axius WRN Backend OK');
});

// ПРИЁМ ЗАДАЧИ
app.post('/fetch', async (req, res) => {
    console.log('[POST /fetch] Body:', req.body);
    
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
            
            // Парсим HTTP-запрос от браузера
            const requestStr = taskData.toString('utf8');
            console.log(`[TASK ${task_id}] Request:`, requestStr.substring(0, 200));
            
            // Извлекаем заголовки
            const headers = {};
            const lines = requestStr.split('\r\n');
            let targetFullUrl = target_url;
            let method = 'GET';
            
            if (lines[0] && lines[0].includes(' ')) {
                const parts = lines[0].split(' ');
                method = parts[0];
                const path = parts[1];
                
                // Строим полный URL
                if (path.startsWith('http://') || path.startsWith('https://')) {
                    targetFullUrl = path;
                } else {
                    const hostLine = lines.find(l => l.toLowerCase().startsWith('host:'));
                    if (hostLine) {
                        const host = hostLine.substring(5).trim();
                        targetFullUrl = 'https://' + host + path;
                    }
                }
                
                // Извлекаем заголовки
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
            
            // Выполняем запрос к целевому сайту
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
            
            // Формируем полный HTTP-ответ
            let httpResponse = '';
            httpResponse += `HTTP/1.1 ${targetResponse.status} ${targetResponse.statusText}\r\n`;
            
            // Добавляем заголовки ответа
            if (targetResponse.headers) {
                Object.keys(targetResponse.headers).forEach(key => {
                    if (!key.toLowerCase().includes('encoding') && 
                        !key.toLowerCase().includes('connection') &&
                        !key.toLowerCase().includes('transfer')) {
                        httpResponse += `${key}: ${targetResponse.headers[key]}\r\n`;
                    }
                });
            }
            
            // Определяем Content-Type
            let contentType = targetResponse.headers['content-type'] || 'text/html';
            httpResponse += `Content-Type: ${contentType}\r\n`;
            httpResponse += `Content-Length: ${targetResponse.data.length}\r\n`;
            httpResponse += `Connection: close\r\n`;
            httpResponse += `\r\n`;
            
            // Конвертируем в Buffer
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
            
            // Создаём ответ с ошибкой
            const errorResponse = `HTTP/1.1 500 Internal Server Error\r\nContent-Type: text/plain\r\n\r\nError: ${error.message}`;
            const errorBuffer = Buffer.from(errorResponse, 'utf8');
            
            const resultId = `${task_id}_result`;
            await disk.uploadTask(resultId, errorBuffer);
            
            taskQueue.set(task_id, {
                status: 'error',
                error: error.message,
                resultId: resultId,
                timestamp: Date.now()
            });
        }
    })();
});

// ПРОВЕРКА РЕЗУЛЬТАТА
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

// СКАЧАТЬ РЕЗУЛЬТАТ НАПРЯМУЮ (для тестов)
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

// ЗАПУСК СЕРВЕРА
app.listen(PORT, () => {
    console.log(`=== Server running on port ${PORT} ===`);
});

// ОЧИСТКА СТАРЫХ ЗАДАЧ
setInterval(() => {
    const now = Date.now();
    for (const [id, task] of taskQueue.entries()) {
        if (now - task.timestamp > 600000) {
            taskQueue.delete(id);
            console.log('[CLEANUP] Removed old task:', id);
        }
    }
}, 600000);
