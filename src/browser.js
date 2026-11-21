const puppeteer = require('puppeteer')

// Um único Chrome fica aberto e cada emissão roda numa aba anônima própria
// (BrowserContext). Antes, cada requisição abria e fechava um Chrome inteiro:
// a primeira emissão depois de um tempo parado levava mais de 10s e o
// icms-ro (Vercel) desistia da requisição.

const MAX_CONCURRENCY = Number(process.env.MAX_CONCURRENCY || 2)
const RECYCLE_AFTER = Number(process.env.BROWSER_RECYCLE_AFTER || 100)
const PAGE_TIMEOUT = Number(process.env.PAGE_TIMEOUT_MS || 45000)

let browserPromise = null
let pagesServed = 0
let active = 0
const queue = []

function launch() {
    return puppeteer.launch({
        headless: process.env.HEADLESS === 'false' ? false : true,
        // Só é necessário dentro da imagem Docker (ver Dockerfile). Localmente,
        // deixe CHROME_PATH vazio para usar o Chrome baixado pelo npm install.
        executablePath: process.env.CHROME_PATH || undefined,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--no-zygote',
            // /dev/shm do Docker tem 64MB por padrão e o Chrome derruba abas
            // quando enche. Com essa flag ele usa /tmp.
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--disable-features=FedCm',
        ],
    })
}

async function getBrowser() {
    if (browserPromise) {
        const current = await browserPromise.catch(() => null)
        if (current && current.connected) return current
        browserPromise = null
    }

    browserPromise = launch().then(browser => {
        pagesServed = 0
        browser.on('disconnected', () => {
            console.warn('[browser] Chrome desconectou, será reaberto na próxima emissão')
            browserPromise = null
        })
        return browser
    })
    browserPromise.catch(() => { browserPromise = null })
    return browserPromise
}

// Fecha o Chrome de tempos em tempos (só quando ninguém está usando) para não
// acumular memória em um processo que fica semanas no ar.
async function maybeRecycle() {
    if (active > 0 || pagesServed < RECYCLE_AFTER || !browserPromise) return
    const browser = await browserPromise.catch(() => null)
    browserPromise = null
    if (browser) {
        console.log(`[browser] reciclando Chrome após ${pagesServed} emissões`)
        await browser.close().catch(() => { })
    }
}

function drain() {
    while (active < MAX_CONCURRENCY && queue.length) {
        const { task, resolve, reject } = queue.shift()
        active++
        task().then(resolve, reject).finally(() => {
            active--
            maybeRecycle().finally(drain)
        })
    }
}

function schedule(task) {
    return new Promise((resolve, reject) => {
        queue.push({ task, resolve, reject })
        drain()
    })
}

// Executa fn(page) numa aba isolada, respeitando o limite de concorrência.
function withPage(fn) {
    return schedule(async () => {
        const browser = await getBrowser()
        const context = await browser.createBrowserContext()
        pagesServed++
        try {
            const page = await context.newPage()
            page.setDefaultTimeout(PAGE_TIMEOUT)
            page.setDefaultNavigationTimeout(PAGE_TIMEOUT)
            await page.evaluateOnNewDocument(() => { window.print = () => { } })
            return await fn(page)
        } finally {
            await context.close().catch(() => { })
        }
    })
}

async function status() {
    const browser = browserPromise ? await browserPromise.catch(() => null) : null
    return {
        browserConnected: Boolean(browser && browser.connected),
        active,
        queued: queue.length,
        pagesServed,
        maxConcurrency: MAX_CONCURRENCY,
    }
}

async function closeBrowser() {
    const browser = browserPromise ? await browserPromise.catch(() => null) : null
    browserPromise = null
    if (browser) await browser.close().catch(() => { })
}

module.exports = { withPage, getBrowser, status, closeBrowser }
