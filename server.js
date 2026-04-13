const express = require('express');
const axios = require('axios');
const app = express();

app.use(express.json());

const YANDEX_TOKEN = process.env.YANDEX_TOKEN;
const TASK_FOLDER = 'app:/tasks';
const PORT = process.env.PORT || 3000;

const taskQueue = new Map();

console.log('=== Axius WRN Server Starting ===');
console.log('YANDEX_TOKEN:', YANDEX_TOKEN ? 'SET' : 'NOT SET!');
console.log('PORT:', PORT);

class YandexDisk {
    constructor(token) {
        this.token = token;
    }

    async uploadTask(taskId, data) {
        const path = `${TASK_FOLDER}/${taskId}.task`;
        console.log('[Yandex] Uploading to:', path);
        
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
            responseType: 'arraybuffer'
        });
        
        console.log('[Yandex] Download complete, size:', response.data.length);
        return response.data;
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
            
            console.log(`[TASK ${task_id}] Fetching ${target_url}...`);
            const targetResponse = await axios.get(target_url, {
                responseType: 'arraybuffer',
                timeout: 15000,
                maxRedirects: 5,
                headers: { 'User-Agent': 'Mozilla/5.0' }
            });
            
            const resultId = `${task_id}_result`;
            console.log(`[TASK ${task_id}] Uploading result (${targetResponse.data.length} bytes)...`);
            await disk.uploadTask(resultId, targetResponse.data);
            
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
            taskQueue.set(task_id, {
                status: 'error',
                error: error.message,
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
    
    // Проверяем, есть ли задача в очереди
    if (!task) {
        console.log('[GET /result] Task not found');
        return res.status(404).json({ error: 'Task not found' });
    }
    
    if (task.status === 'done') {
        console.log('[GET /result] DONE:', task.resultId);
        res.json({ status: 'done', result_id: task.resultId });
        taskQueue.delete(task_id);
    } else if (task.status === 'error') {
        console.log('[GET /result] ERROR:', task.error);
        res.status(500).json({ status: 'error', error: task.error });
        taskQueue.delete(task_id);
    } else {
        console.log('[GET /result] PROCESSING...');
        res.json({ status: 'processing' });
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
