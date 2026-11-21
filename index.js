require('dotenv').config()
const crypto = require('crypto')
const express = require('express')

const { emitirDareRO } = require('./src/dare-ro')
const { emitirDarMt } = require('./src/dar-mt')
const { SefinError, InputError } = require('./src/errors')
const browser = require('./src/browser')

const app = express()
const port = process.env.PORT || 8080
const API_KEY = process.env.API_KEY || ''

app.use(express.json({ limit: '1mb' }))

// Com API_KEY definida, toda rota (menos /health) exige o header x-api-key.
// Sem ela o serviço continua aberto como antes, para não quebrar clientes
// antigos durante a migração.
app.use((req, res, next) => {
    if (!API_KEY || req.path === '/health') return next()
    const received = req.get('x-api-key') || ''
    const ok = received.length === API_KEY.length &&
        crypto.timingSafeEqual(Buffer.from(received), Buffer.from(API_KEY))
    if (!ok) return res.status(401).json({ error: 'API key inválida' })
    next()
})

function sendError(res, error, requestId) {
    if (res.headersSent) return
    if (error instanceof InputError) return res.status(400).json({ error: error.message, requestId })
    if (error instanceof SefinError) return res.status(422).json({ error: error.message, requestId })
    return res.status(502).json({ error: `Falha ao gerar o documento na SEFIN: ${error.message}`, requestId })
}

function sendPdf(res, pdf, fileName, extraHeaders = {}) {
    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Disposition', `attachment; filename=${fileName}`)
    for (const [key, value] of Object.entries(extraHeaders)) {
        if (value) res.setHeader(key, value)
    }
    res.send(Buffer.from(pdf))
}

app.get('/health', async (_req, res) => {
    res.json({ ok: true, ...(await browser.status()) })
})

// DARE avulso SEFIN-RO (ICMS sobre frete). Campos aceitos, em inglês (formato
// antigo) ou em português:
//   cnpj, invoiceNumber|notaFiscal, recipient|destinatario, origin|origem,
//   destination|destino, product|produto, calculationBase|baseCalculo,
//   value|valor, receiptCode|codigoReceita, dataVencimento (dd/mm/aaaa),
//   mesReferencia (mm/aaaa), contribuinte { nome, cep, endereco, municipio,
//   uf, telefone, codigoMunicipio }, dryRun (só preenche e devolve um PNG).
app.post('/dare', async (req, res) => {
    const requestId = crypto.randomUUID().slice(0, 8)
    const started = Date.now()
    const dryRun = req.body?.dryRun === true || req.query.dryRun === 'true'
    try {
        const result = await emitirDareRO(req.body, { dryRun })
        const { input } = result
        console.log(`[dare ${requestId}] ok cnpj=${input.cnpj} nf=${input.notaFiscal} valor=${input.valor} ${Date.now() - started}ms${dryRun ? ' (dry-run)' : ''}`)

        if (result.kind === 'dry-run') {
            res.setHeader('Content-Type', 'image/png')
            return res.send(Buffer.from(result.screenshot))
        }
        sendPdf(res, result.pdf, `dare-${input.notaFiscal || requestId}.pdf`, {
            'X-Request-Id': requestId,
            'X-Linha-Digitavel': result.linhaDigitavel,
            'X-Data-Vencimento': input.dataVencimento,
            'X-Mes-Referencia': input.mesReferencia,
        })
    } catch (error) {
        console.error(`[dare ${requestId}] erro ${Date.now() - started}ms: ${error.message}`)
        sendError(res, error, requestId)
    }
})

// DAR avulso SEFAZ-MT (FETHAB e contribuições às entidades). Campos:
//   documento { tipo: 'ie'|'cnpj'|'cpf', numero }, codigoReceita (ex. 7237),
//   periodoReferencia (mm/aaaa), dataVencimento (dd/mm/aaaa, padrão hoje),
//   quantidade (número), municipio (nome do município do remetente em MT),
//   informacoes (até 220 caracteres), valorEsperado (opcional: aborta antes
//   de emitir se a SEFAZ calcular outro valor), dryRun (só preenche e devolve
//   um PNG, sem emitir).
async function darMt(req, res) {
    const requestId = crypto.randomUUID().slice(0, 8)
    const started = Date.now()
    const dryRun = req.body?.dryRun === true || req.query.dryRun === 'true'
    try {
        const result = await emitirDarMt(req.body, { dryRun })
        const { input } = result
        console.log(`[dar-mt ${requestId}] ok ${input.documento.tipo} receita=${input.codigoReceita} valor=${result.valor} ${Date.now() - started}ms${dryRun ? ' (dry-run)' : ` (${result.formato})`}`)
        const valor = result.valor.toFixed(2)

        if (result.kind === 'dry-run') {
            res.setHeader('Content-Type', 'image/png')
            res.setHeader('X-Valor', valor)
            res.setHeader('X-Valor-Unidade', String(result.porUnidade))
            return res.send(Buffer.from(result.screenshot))
        }
        sendPdf(res, result.pdf, `dar-mt-${input.codigoReceita}-${requestId}.pdf`, {
            'X-Request-Id': requestId,
            'X-Linha-Digitavel': result.linhaDigitavel,
            'X-Valor': valor,
            'X-Data-Vencimento': input.dataVencimento,
            'X-Periodo-Referencia': input.periodoReferencia,
            'X-Formato-Sefaz': result.formato,
        })
    } catch (error) {
        console.error(`[dar-mt ${requestId}] erro ${Date.now() - started}ms: ${error.message}`)
        sendError(res, error, requestId)
    }
}

app.post('/dar-mt', darMt)
// Nome antigo, mantido por compatibilidade.
app.post('/dare-mt-fethab', darMt)

const server = app.listen(port, () => {
    console.log(`Servidor rodando na porta ${port}`)
    // Abre o Chrome já na subida para a primeira emissão não pagar esse custo.
    browser.getBrowser().catch(error => console.error('[browser] falha ao abrir o Chrome:', error.message))
})

async function shutdown(signal) {
    console.log(`${signal} recebido, encerrando`)
    server.close()
    await browser.closeBrowser()
    process.exit(0)
}
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
