#!/usr/bin/env node
/**
 * gpu_detone_test.mjs — Headless WebGPU + WASM de-tone test
 *
 * Serves test HTML + assets on localhost, launches headless Chrome,
 * captures results. Pass --wasm for WASM test, default is GPU test.
 *
 * Usage:
 *   node tools/spin_tone_lab/gpu_detone_test.mjs          # GPU test
 *   node tools/spin_tone_lab/gpu_detone_test.mjs --wasm   # WASM test
 */

import puppeteer from 'puppeteer';
import { createServer } from 'http';
import { readFileSync, existsSync } from 'fs';
import { resolve, dirname, extname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = 9877;
const isWasm = process.argv.includes('--wasm');
const defaultPage = isWasm ? 'wasm_detone_test.html' : 'gpu_detone_test.html';

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
               '.wav': 'audio/wav', '.wasm': 'application/wasm', '.png': 'image/png' };

const server = createServer((req, res) => {
    const filePath = resolve(__dirname, req.url.replace(/^\//, '') || defaultPage);
    if (!existsSync(filePath)) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, {
        'Content-Type': MIME[extname(filePath)] || 'application/octet-stream',
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Cross-Origin-Embedder-Policy': 'require-corp',
    });
    res.end(readFileSync(filePath));
});

server.listen(PORT, async () => {
    console.log(`Serving ${defaultPage} on http://localhost:${PORT}`);

    const browser = await puppeteer.launch({
        headless: 'new',
        args: [
            '--enable-features=Vulkan',
            '--enable-unsafe-webgpu',
            '--disable-gpu-sandbox',
            '--enable-gpu',
        ],
    });

    const page = await browser.newPage();
    let resultReceived = false;

    page.on('console', msg => {
        const text = msg.text();
        console.log(text);
        if (text.startsWith('RESULT:')) resultReceived = true;
    });
    page.on('pageerror', err => console.error('PAGE ERROR:', err.message));

    try {
        await page.goto(`http://localhost:${PORT}/${defaultPage}`, {
            waitUntil: 'domcontentloaded', timeout: 15000
        });
        const deadline = Date.now() + 300000;
        while (!resultReceived && Date.now() < deadline) {
            await new Promise(r => setTimeout(r, 500));
        }
        if (!resultReceived) console.log('Timed out');
    } catch(e) {
        console.error('Error:', e.message);
    }

    await browser.close();
    server.close();
});
