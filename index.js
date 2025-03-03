const express = require('express')
require('dotenv').config()
const app = express()
const port = process.env.PORT || 8080
const puppeteer = require('puppeteer');
const path = require('path');

const fs = require('fs')

// Middleware to parse JSON requests
app.use(express.json())
app.listen(port, () => {
    console.log(`Servidor rodando na porta ${port}`)
})

app.post('/dare', async (req, res) => {
    console.log(req.body)
    let browser;
    try {
        // Date calculation functions
        function isWeekend(date) {
            const day = date.getDay();
            return day === 0 || day === 6;
        }

        function getCurrentMonthAndYear() {
            const currentDate = new Date();
            const month = String(currentDate.getMonth() + 1).padStart(2, '0')
            const year = currentDate.getFullYear()
            return `${month}/${year}`
        }

        function getNextMonthWeekdayDate() {
            const currentDate = new Date();
            const nextMonthDate = new Date(currentDate);
            nextMonthDate.setMonth(currentDate.getMonth() + 1);

            if (nextMonthDate.getDate() !== currentDate.getDate()) {
                nextMonthDate.setMonth(nextMonthDate.getMonth() + 1, 0);
            }

            let attempts = 0;
            while (isWeekend(nextMonthDate)) {
                nextMonthDate.setDate(nextMonthDate.getDate() + 1);
                attempts++;
            }

            const day = String(nextMonthDate.getDate()).padStart(2, '0')
            const month = String(nextMonthDate.getMonth() + 1).padStart(2, '0')
            const year = nextMonthDate.getFullYear()
            return `${day}/${month}/${year}`
        }

        // Launch browser and create page
        browser = await puppeteer.launch({
            executablePath: await chrome.executablePath(),
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--single-process'
            ],
            headless: 'new',
            ignoreHTTPSErrors: true,
            userDataDir: '/opt/render/.cache/puppeteer'
        });
        const page = await browser.newPage();

        // Setup PDF handler
        await page.evaluateOnNewDocument(() => {
            window.print = () => { };
        });

        // Navigate to form page
        await page.goto('https://dare.sefin.ro.gov.br/avulso/dados-formulario?utf8=%E2%9C%93&c_o=1&ind=3&ident=53.254.947%2F0001-95');

        // Fill form with request data
        await page.type('input[name="infor_notafiscal"]', req.body.invoiceNumber || '');
        await page.type('input[name="infor_destinatario"]', req.body.recipient || '');
        await page.type('input[name="infor_origem"]', req.body.origin || '');
        await page.type('input[name="infor_destino"]', req.body.destination || '');
        await page.type('input[name="infor_produto"]', req.body.product || '');
        await page.$eval('input[name="infor_basecalculo"]', el => {
            el.value = '';  // Clear current value
            el.dispatchEvent(new Event('input', { bubbles: true })); // Trigger input event
        });
        await page.type('input[name="infor_basecalculo"]', String(req.body.calculationBase) || '');
        await page.type('input[name="valor_principal"]', req.body.value || '');

        // Handle date fields
        await page.$eval('input[name="data_vencimento"]', el => el.removeAttribute('readonly'));
        await page.type('input[name="data_vencimento"]', getNextMonthWeekdayDate());
        await page.type('input[name="mesano_referencia"]', getCurrentMonthAndYear());

        // Handle receipt code
        await page.$eval('input[name="codigo_receita"]', el => el.removeAttribute('readonly'));
        await page.type('input[name="codigo_receita"]', req.body.receiptCode || '');

        // Submit form
        await Promise.all([
            page.waitForNavigation({ waitUntil: 'networkidle0' }),
            page.click('button[name="button"]')
        ]);
        // Wait for document generation

        // Wait for the DARE document table to appear
        await page.waitForSelector('table.mb_20.text-size-13', {
            visible: true,
            timeout: 10000 // 15 seconds
        });



        const pdfBuffer = await page.pdf({
            format: 'A4',
            printBackground: true,
            margin: { top: '20mm', right: '20mm', bottom: '20mm', left: '20mm' }
        });

        const fileName = `temp.pdf`
        const filePath = path.join(__dirname, fileName);
        fs.writeFileSync(filePath, pdfBuffer);

        // 2. Send the saved file
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename=${fileName}`);

        // Option 1: Read file and send buffer
        const savedFileBuffer = fs.readFileSync(filePath);
        res.send(savedFileBuffer)


        // Send PDF to client

    } catch (error) {
        console.error('Error:', error);
        // Ensure we only send one response
        if (!res.headersSent) {
            res.status(500).send('Error generating PDF: ' + error.message);
        }
    } finally {
        if (browser) await browser.close();
    }
});