const express = require('express');
const axios = require('axios');
const puppeteer = require('puppeteer');
const app = express();

app.use(express.json({ limit: '50mb' }));

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

log('=== Axius WRN Server with Puppeteer ===');
log('TOKEN: ' + (YANDEX_TOKEN ? 'SET' : 'NOT SET'));

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
            const tasks = items.filter(f => f.name.endsWith('.task') && !f.name.includes('_result'));
            return tasks;
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
        log('[Disk] Written: ' + path.split('/').pop());
    }

    async deleteFile(path) {
        try {
            await axios.delete(`https://cloud-api.yandex.net/v1/disk/resources?path=${path}&permanently=true`, {
                headers: { 'Authorization': `OAuth ${this.token}` }
            });
            log('[Disk] Deleted: ' + path.split('/').pop());
        } catch (e) {}
    }
}

const disk = new YandexDisk(YANDEX_TOKEN);

// Запускаем браузер один раз при старте
let browser = null;

async function getBrowser() {
    if (browser) return browser;
    
    log('[Puppeteer] Launching browser...');
    browser = await puppeteer.launch({
        headless: 'new',
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--disable-web-security',
            '--disable-features=IsolateOrigins,site-per-process',
            '--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        ]
    });
    log('[Puppeteer] Browser launched');
    return browser;
}

async function fetchWithPuppeteer(url) {
    const browser = await getBrowser();
    const page = await browser.newPage();
    
    try {
        log('[Puppeteer] Navigating to: ' + url);
        
        // Устанавливаем таймауты
        await page.setDefaultNavigationTimeout(60000);
        await page.setDefaultTimeout(60000);
        
        // Перехватываем запросы, чтобы ускорить загрузку (блокируем ненужное)
        await page.setRequestInterception(true);
        page.on('request', (req) => {
            const resourceType = req.resourceType();
            const reqUrl = req.url();
            
            // Блокируем рекламу, аналитику, шрифты (для скорости)
            if (reqUrl.includes('google-analytics') ||
                reqUrl.includes('doubleclick') ||
                reqUrl.includes('googlesyndication') ||
                reqUrl.includes('googletagmanager') ||
                resourceType === 'font' ||
                resourceType === 'media') {
                req.abort();
            } else {
                req.continue();
            }
        });
        
        // Переходим на страницу
        await page.goto(url, { 
            waitUntil: 'networkidle2', // Ждём, пока не будет 2 сетевых запросов за 500мс
            timeout: 60000 
        });
        
        // Дополнительное ожидание для SPA
        await page.waitForTimeout(3000);
        
        // Прокручиваем страницу для ленивой загрузки
        await page.evaluate(async () => {
            await new Promise((resolve) => {
                let totalHeight = 0;
                const distance = 300;
                const timer = setInterval(() => {
                    const scrollHeight = document.body.scrollHeight;
                    window.scrollBy(0, distance);
                    totalHeight += distance;
                    
                    if (totalHeight >= scrollHeight * 2) {
                        clearInterval(timer);
                        resolve();
                    }
                }, 100);
            });
        });
        
        // Ждём ещё немного
        await page.waitForTimeout(2000);
        
        // Получаем HTML
        const html = await page.content();
        log('[Puppeteer] Done: ' + html.length + ' bytes');
        
        await page.close();
        return html;
        
    } catch (error) {
        log('[Puppeteer] Error: ' + error.message);
        await page.close();
        throw error;
    }
}

// Главная страница с логами
app.get('/', (req, res) => {
    let html = '<h1>Axius WRN Server (Puppeteer)</h1><pre>';
    logs.slice().reverse().forEach(l => html += l + '\n');
    html += '</pre>';
    res.send(html);
});

// Обработка задач
async function processTask(taskFile) {
    const taskName = taskFile.name;
    const taskPath = `${TASK_FOLDER}/${taskName}`;
    const resultId = taskName.replace('.task', '_result');
    const resultPath = `${TASK_FOLDER}/${resultId}.task`;
    
    log('[Worker] Processing: ' + taskName);
    
    try {
        const taskData = await disk.readFile(taskPath);
        const requestStr = taskData.toString('utf8');
        
        // Извлекаем URL
        let url = '';
        const lines = requestStr.split('\r\n');
        if (lines[0]) {
            const parts = lines[0].split(' ');
            url = parts[1];
        }
        
        log('[Worker] Fetching with Puppeteer: ' + url);
        
        // Используем Puppeteer для полной загрузки
        const html = await fetchWithPuppeteer(url);
        
        // Формируем HTTP-ответ
        const httpResponse = `HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: ${html.length}\r\n\r\n${html}`;
        
        await disk.writeFile(resultPath, Buffer.from(httpResponse));
        await disk.deleteFile(taskPath);
        
        log('[Worker] DONE: ' + taskName + ' (' + html.length + ' bytes)');
        
    } catch (e) {
        log('[Worker] ERROR: ' + e.message);
        
        const errorResponse = `HTTP/1.1 500 Error\r\nContent-Type: text/html\r\n\r\n<h1>Error</h1><p>${e.message}</p>`;
        await disk.writeFile(resultPath, Buffer.from(errorResponse));
        await disk.deleteFile(taskPath);
    }
}

async function workerLoop() {
    log('[Worker] Started');
    
    while (true) {
        try {
            const tasks = await disk.listTaskFiles();
            
            for (const task of tasks) {
                await processTask(task);
            }
        } catch (e) {
            log('[Worker] Loop error: ' + e.message);
        }
        
        await new Promise(r => setTimeout(r, 3000));
    }
}

workerLoop().catch(e => log('[Worker] Fatal: ' + e.message));

app.listen(PORT, () => log('Server on port ' + PORT));
