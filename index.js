const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { chromium } = require('playwright'); // Menggunakan Playwright
const qrcode = require('qrcode');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
const PORT = 8080;

app.use(express.json());

let context; 
let storedQrImage = null;
let stopSendingFlag = false; // Variabel untuk mengontrol stop

function sendToClients(type, data) {
    const message = JSON.stringify({ type, data });
    if (type === 'log') { console.log(`[LOG] ${data}`); }
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) { client.send(message); }
    });
}

async function sendMessages(contacts, messageTemplate) {
    stopSendingFlag = false; // Reset flag setiap kali proses baru dimulai
    sendToClients('log', `Memulai pengiriman ke ${contacts.length} kontak...`);
    if (!context) {
        sendToClients('log', '❌ Gagal: Konteks browser tidak ditemukan. Silakan restart server.');
        return;
    }

    for (const contact of contacts) {
        // Cek flag di setiap awal loop
        if (stopSendingFlag) {
            sendToClients('log', '🛑 Proses dihentikan oleh pengguna.');
            break; // Keluar dari loop
        }

        let newPage = null;
        try {
            newPage = await context.newPage();
            sendToClients('log', `Mengirim ke ${contact.nomor} (Nama: ${contact.nama})...`);

            const finalMessage = messageTemplate.replace('{nama}', contact.nama);
            const waUrl = `https://web.whatsapp.com/send?phone=${contact.nomor}`;
            
            await newPage.goto(waUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

            const messageBoxLocator = newPage.locator('div[aria-label="Ketik pesan"]').or(newPage.locator('div[aria-label="Type a message"]'));
            await messageBoxLocator.waitFor({ state: 'visible', timeout: 20000 });
            await messageBoxLocator.click();

            const messageBlocks = finalMessage.split('\n');
            for (let i = 0; i < messageBlocks.length; i++) {
                const block = messageBlocks[i];
                if (block) {
                    await newPage.keyboard.insertText(block);
                }
                if (i < messageBlocks.length - 1) {
                    await newPage.keyboard.press('Shift+Enter');
                }
            }
            
            await newPage.keyboard.press('Enter');

            sendToClients('log', `✅ Pesan berhasil dikirim ke ${contact.nomor}`);
            sendToClients('send_success');
            await newPage.waitForTimeout(4000); // Penundaan antar pengiriman

        } catch (err) {
            sendToClients('log', `❌ Gagal mengirim ke ${contact.nomor}: ${err.message.split('\n')[0]}`);
            sendToClients('send_fail');
        } finally {
            if (newPage) await newPage.close();
        }
    }
    sendToClients('log', '<strong>Proses Selesai!</strong>');
    sendToClients('finish');
}


async function startAutomation() {
    try {
        sendToClients('log', 'Membuka browser baru...');
        const browser = await chromium.launch({ 
            headless: true, // Pastikan ini true untuk lingkungan server tanpa GUI
            args: [         // Argumen penting untuk browser headless di Linux
                '--no-sandbox', 
                '--disable-setuid-sandbox', 
                '--disable-dev-shm-usage', // Mengatasi masalah /dev/shm yang kecil
                '--disable-accelerated-2d-canvas',
                '--no-first-run',
                '--no-zygote',
                '--disable-gpu' // Mematikan penggunaan GPU jika tidak ada
            ]
        });
        context = await browser.newContext();
        const page = await context.newPage();
        
        sendToClients('log', 'Membuka WhatsApp Web...');
        // Menambah timeout untuk page.goto juga jika load sangat lambat
        await page.goto('https://web.whatsapp.com', { waitUntil: 'domcontentloaded', timeout: 120000 });

        sendToClients('log', 'Mencari QR Code...');
        
        // --- MODIFIKASI UNTUK SELECTOR DAN PENGAMBILAN QR CODE ---
        // Selector yang lebih akurat menargetkan elemen canvas QR code
        const qrSelector = 'canvas[aria-label="Scan this QR code to link a device!"]'; 
        
        try { 
            // Menunggu elemen canvas QR code muncul
            const qrCanvas = await page.waitForSelector(qrSelector, { timeout: 90000 });
            sendToClients('log', 'Elemen QR Code (canvas) ditemukan di DOM.');
            
            // Ambil screenshot dari elemen canvas QR code tersebut
            const qrBuffer = await qrCanvas.screenshot();
            // Konversi buffer gambar ke base64 data URL agar bisa dikirim ke frontend
            const qrDataUrl = `data:image/png;base64,${qrBuffer.toString('base64')}`;
            
            if (qrDataUrl) {
                storedQrImage = qrDataUrl; // Simpan data URL gambar
                sendToClients('qr', storedQrImage); // Kirim ke frontend
                sendToClients('log', 'QR Code ditemukan dan dikirim. Silakan scan.');
            } else {
                throw new Error('Gagal mendapatkan gambar QR Code dari canvas.');
            }

            // Menunggu QR code hilang (ini mengindikasikan bahwa user sudah scan dan login)
            await page.waitForSelector(qrSelector, { state: 'hidden', timeout: 90000 });
            storedQrImage = null; // Hapus gambar QR setelah login
            sendToClients('status', 'loggedin'); // Beritahu frontend bahwa sudah login
            sendToClients('log', '✅ Berhasil login!');

        } catch (qrError) {
            // Log error spesifik jika QR code tidak ditemukan atau ada masalah lainnya saat pemrosesan QR
            sendToClients('log', `❌ Error saat mencari atau memproses QR Code: ${qrError.message.split('\n')[0]}`);
            throw qrError; // Re-throw error untuk ditangkap di blok catch utama
        }
        // --- AKHIR MODIFIKASI ---

    } catch (error) {
        // Log error umum dari startAutomation
        sendToClients('log', `❌ Terjadi kesalahan umum saat memulai otomatisasi: ${error.message}`);
    }
}

// Handler untuk koneksi WebSocket dari frontend
wss.on('connection', ws => {
    sendToClients('log', 'Frontend terhubung!');
    // Kirim QR code yang tersimpan jika sudah ada (untuk klien yang baru terhubung)
    if (storedQrImage) {
        ws.send(JSON.stringify({ type: 'qr', data: storedQrImage }));
    }
    
    // Handler untuk pesan yang diterima dari frontend
    ws.on('message', message => {
        const parsedMessage = JSON.parse(message);
        if (parsedMessage.type === 'send_messages') {
            sendMessages(parsedMessage.data.contacts, parsedMessage.data.message);
        } else if (parsedMessage.type === 'stop_sending') {
            // Jika ada perintah stop, ubah nilai flag
            stopSendingFlag = true;
        }
    });
});

// Mulai server HTTP dan WebSocket
server.listen(PORT, () => {
    console.log(`🚀 Server berjalan di http://localhost:${PORT}`);
    startAutomation(); // Panggil fungsi otomatisasi saat server dimulai
});