<?php
/**
 * php-browser.php - ПРОСТО PHP БРАУЗЕР
 * Принимает ?url=... и возвращает страницу
 */

// Настройки
ini_set('max_execution_time', 300);
ini_set('memory_limit', '256M');
session_start();

// CORS
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
header('Access-Control-Allow-Headers: *');

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(200);
    exit;
}

// Получаем URL
$url = $_GET['url'] ?? '';
if (!$url) {
    http_response_code(400);
    die('URL required');
}

// Куки для этого хоста
$host = parse_url($url, PHP_URL_HOST);
$cookieFile = sys_get_temp_dir() . '/cookies_' . md5($host) . '.txt';

// Загружаем страницу через cURL
$ch = curl_init();
curl_setopt_array($ch, [
    CURLOPT_URL => $url,
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_FOLLOWLOCATION => true,
    CURLOPT_MAXREDIRS => 10,
    CURLOPT_TIMEOUT => 60,
    CURLOPT_SSL_VERIFYPEER => false,
    CURLOPT_SSL_VERIFYHOST => false,
    CURLOPT_USERAGENT => 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    CURLOPT_COOKIEFILE => $cookieFile,
    CURLOPT_COOKIEJAR => $cookieFile,
    CURLOPT_HTTPHEADER => [
        'Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language: en-US,en;q=0.5',
        'Accept-Encoding: identity'
    ]
]);

// POST запрос
if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    curl_setopt($ch, CURLOPT_POST, true);
    curl_setopt($ch, CURLOPT_POSTFIELDS, http_build_query($_POST));
}

$html = curl_exec($ch);
$error = curl_error($ch);
$info = curl_getinfo($ch);
curl_close($ch);

if ($error) {
    http_response_code(500);
    die("Error: $error");
}

// Внедряем base для относительных путей
$base = $host ? "https://$host" : $url;
$html = str_replace('<head>', "<head><base href='$base/'>", $html);

// Возвращаем страницу
header('Content-Type: text/html');
echo $html;
