// Verifies real Electron text selection, Ctrl+C, and Ctrl+V without falling
// through to the timeline clip clipboard.
'use strict';

const puppeteer = require('puppeteer-core');

const BROWSER_WS = process.argv[2];
if (!BROWSER_WS) {
    console.error('usage: node runtime-clipboard-probe.js <browserWsEndpoint>');
    process.exit(2);
}

const watchdog = setTimeout(() => {
    console.error('PROBE ERROR runtime clipboard probe exceeded 60 seconds');
    process.exit(4);
}, 60_000);

(async () => {
    const browser = await puppeteer.connect({
        browserWSEndpoint: BROWSER_WS,
        defaultViewport: null,
    });
    let page = null;
    const deadline = Date.now() + 20_000;
    while (!page && Date.now() < deadline) {
        const pages = await browser.pages();
        page = pages.filter((candidate) => (
            !candidate.isClosed() && /ui\/index\.html/i.test(candidate.url())
        )).at(-1) || null;
        if (!page) await new Promise((resolve) => setTimeout(resolve, 150));
    }
    if (!page) throw new Error('Main renderer page was not found');

    await page.waitForSelector('#btn-agent', { timeout: 20_000 });
    await page.click('#btn-agent');
    await page.waitForSelector('.agent-welcome p', { timeout: 10_000 });

    const selection = await page.evaluate(() => {
        const source = document.querySelector('.agent-welcome p');
        const text = source?.textContent?.replace(/\s+/g, ' ').trim() || '';
        if (!source || !text) throw new Error('Agent welcome copy source is empty');
        const range = document.createRange();
        range.selectNodeContents(source);
        const selected = window.getSelection();
        selected.removeAllRanges();
        selected.addRange(range);
        return {
            text: selected.toString().replace(/\s+/g, ' ').trim(),
            userSelect: getComputedStyle(source.closest('.agent-welcome')).userSelect,
        };
    });

    await page.keyboard.down('Control');
    await page.keyboard.press('c');
    await page.keyboard.up('Control');
    await page.waitForFunction(async (expected) => {
        const result = await window.electronAPI?.readClipboardText?.();
        return result?.success === true
            && String(result.text || '').replace(/\s+/g, ' ').trim() === expected;
    }, { timeout: 10_000 }, selection.text);
    await page.click('#agent-input');
    await page.keyboard.down('Control');
    await page.keyboard.press('v');
    await page.keyboard.up('Control');
    try {
        await page.waitForFunction((expected) => (
            document.getElementById('agent-input')?.value?.replace(/\s+/g, ' ').trim() === expected
        ), { timeout: 10_000 }, selection.text);
    } catch (error) {
        const diagnostic = await page.evaluate(async () => ({
            activeTag: document.activeElement?.tagName || '',
            inputValue: document.getElementById('agent-input')?.value || '',
            clipboard: await window.electronAPI?.readClipboardText?.(),
        }));
        throw new Error(`Paste did not settle: ${JSON.stringify(diagnostic)} (${error.message})`);
    }

    const pasted = await page.$eval(
        '#agent-input',
        (input) => input.value.replace(/\s+/g, ' ').trim()
    );
    if (pasted !== selection.text) {
        throw new Error(`Clipboard mismatch: expected ${JSON.stringify(selection.text)}, got ${JSON.stringify(pasted)}`);
    }

    console.log(`PASS runtime text copy/paste (${pasted.length} characters)`);
    await browser.disconnect();
    clearTimeout(watchdog);
})().catch((error) => {
    clearTimeout(watchdog);
    console.error(`PROBE ERROR ${error.stack || error.message}`);
    process.exit(3);
});
