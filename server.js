const express = require('express');
const axios = require('axios');
const app = express();

app.use(express.json());

// Конфигурация из переменных окружения
const YANDEX_TOKEN = process.env.YANDEX_TOKEN;
const TASK_FOLDER = 'app:/tasks';
const PORT = process.env.PORT || 3000;

// Очередь задач в памяти (для простоты)
const taskQueue = new Map();

// Функция для работы с Яндекс.Диском
class YandexDisk {
    constructor(token) {
        this.token = token;
    }

    async uploadTask(taskId, data) {
        const path = `${TASK_FOLDER}/${taskId}.task`;
        
        // 1. Получить URL для загрузки
        const uploadRes = await axios.get(
            `https://cloud-api.yandex.net/v1/disk/resources/upload?path=${path}&overwrite=true`,
            { headers: { 'Authorization': `OAuth ${this.token}` } }
        );
        
        // 2. Загрузить данные
        await axios.put(uploadRes.data.href, data, {
            headers: { 'Content-Type': 'application/octet-stream' }
        });
        
        // 3. Опубликовать
        await axios.put(
            `https://cloud-api.yandex.net/v1/disk/resources/publish?path=${path}`,
            {},
            { headers: { 'Authorization': `OAuth ${this.token}` } }
        );
        
        return `https://cloud-api.yandex.net/v1/disk/public/resources/download?public_key=${path}`;
    }

    async downloadTask(taskId) {
        const path = `${TASK_FOLDER}/${taskId}.task`;
        
        const downloadRes = await axios.get(
            `https://cloud-api.yandex.net/v1/disk/resources/download?path=${path}`,
            { headers: { 'Authorization': `OAuth ${this.token}` } }
        );
        
        const response = await axios.get(downloadRes.data.href, {
            responseType: 'arraybuffer'
        });
        
        return response.data;
    }

    async deleteTask(taskId) {
        const path = `${TASK_FOLDER}/${taskId}.task`;
        try {
            await axios.delete(
                `https://cloud-api.yandex.net/v1/disk/resources?path=${path}&permanently=true`,
                { headers: { 'Authorization': `OAuth ${this.token}` } }
            );
        } catch (e) {
            console.error('Delete error:', e.message);
        }
    }
}

const disk = new YandexDisk(YANDEX_TOKEN);

// Эндпоинт: Принять задачу
app.post('/fetch', async (req, res) => {
    const { task_id, target_url } = req.body;
    
    if (!task_id || !target_url) {
        return res.status(400).json({ error: 'Missing task_id or target_url' });
    }
    
    console.log(`[FETCH] Task ${task_id} for ${target_url}`);
    
    // Сразу отвечаем, чтобы не держать соединение
    res.status(202).json({ status: 'queued', task_id });
    
    // Обрабатываем асинхронно
    (async () => {
        try {
            // 1. Скачать данные задачи с Яндекс.Диска
            const taskData = await disk.downloadTask(task_id);
            
            // 2. Выполнить запрос к целевому сайту
            const targetResponse = await axios.get(target_url, {
                responseType: 'arraybuffer',
                timeout: 15000,
                maxRedirects: 5,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                }
            });
            
            // 3. Загрузить результат на Яндекс.Диск
            const resultId = `${task_id}_result`;
            await disk.uploadTask(resultId, targetResponse.data);
            
            // 4. Сохранить результат в памяти для Long Polling
            taskQueue.set(task_id, {
                status: 'done',
                resultId: resultId,
                timestamp: Date.now()
            });
            
            console.log(`[DONE] Task ${task_id} completed`);
            
            // Удалить исходную задачу
            await disk.deleteTask(task_id);
            
            // Автоочистка через 5 минут
            setTimeout(() => {
                taskQueue.delete(task_id);
            }, 300000);
            
        } catch (error) {
            console.error(`[ERROR] Task ${task_id}:`, error.message);
            taskQueue.set(task_id, {
                status: 'error',
                error: error.message,
                timestamp: Date.now()
            });
        }
    })();
});

// Эндпоинт: Проверить статус задачи (Long Polling)
app.get('/result', async (req, res) => {
    const { task_id } = req.query;
    
    if (!task_id) {
        return res.status(400).json({ error: 'Missing task_id' });
    }
    
    const task = taskQueue.get(task_id);
    
    if (task && task.status === 'done') {
        // Отдаем результат
        res.json({ 
            status: 'done', 
            result_id: task.resultId 
        });
        taskQueue.delete(task_id);
    } else if (task && task.status === 'error') {
        res.status(500).json({ 
            status: 'error', 
            error: task.error 
        });
        taskQueue.delete(task_id);
    } else {
        // Задача еще в обработке
        res.json({ status: 'processing' });
    }
});

// Эндпоинт: Скачать результат
app.get('/download/:resultId', async (req, res) => {
    const { resultId } = req.params;
    
    try {
        const data = await disk.downloadTask(resultId);
        res.set('Content-Type', 'application/octet-stream');
        res.send(data);
        
        // Удалить после скачивания
        await disk.deleteTask(resultId);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Эндпоинт: WebSocket для ожидания (опционально)
const server = require('http').createServer(app);
const WebSocket = require('ws');

const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
    console.log('[WS] Client connected');
    
    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            if (data.type === 'wait' && data.task_id) {
                const taskId = data.task_id;
                
                const checkInterval = setInterval(() => {
                    const task = taskQueue.get(taskId);
                    if (task && task.status === 'done') {
                        ws.send(JSON.stringify({ 
                            status: 'done', 
                            result_id: task.resultId 
                        }));
                        taskQueue.delete(taskId);
                        clearInterval(checkInterval);
                    } else if (task && task.status === 'error') {
                        ws.send(JSON.stringify({ 
                            status: 'error', 
                            error: task.error 
                        }));
                        taskQueue.delete(taskId);
                        clearInterval(checkInterval);
                    }
                }, 500);
                
                // Таймаут 30 секунд
                setTimeout(() => {
                    clearInterval(checkInterval);
                }, 30000);
            }
        } catch (e) {
            console.error('[WS] Error:', e.message);
        }
    });
    
    ws.on('close', () => {
        console.log('[WS] Client disconnected');
    });
});

// Health check
app.get('/', (req, res) => {
    res.send('Axius WRN Backend OK');
});

// Запуск сервера
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});

// Очистка старых задач каждые 10 минут
setInterval(() => {
    const now = Date.now();
    for (const [id, task] of taskQueue.entries()) {
        if (now - task.timestamp > 600000) { // 10 минут
            taskQueue.delete(id);
        }
    }
}, 600000);
