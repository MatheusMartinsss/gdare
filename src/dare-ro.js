const { withPage } = require('./browser')
const { SefinError, InputError, withRetry } = require('./errors')
const { defaultDueDate, currentMonthYear } = require('./datas')

const SEFIN_BASE_URL = process.env.SEFIN_BASE_URL || 'https://dare.sefin.ro.gov.br'

// Clientes antigos (icms-ro na Vercel) não mandam CNPJ. Para eles o gdare usa
// este CNPJ, que era o que ficava fixo no código.
const DEFAULT_CNPJ = process.env.DEFAULT_CNPJ || '46397430000190'
const DEFAULT_RECEITA = process.env.DEFAULT_CODIGO_RECEITA || '1414'

const onlyDigits = v => String(v ?? '').replace(/\D/g, '')

function formatCnpj(cnpj) {
    const d = onlyDigits(cnpj)
    if (d.length !== 14) throw new InputError(`CNPJ inválido: ${cnpj}`)
    return d.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5')
}

// Aceita número (1234.5), "1234,50", "1.234,50" ou "R$ 1.234,50" e devolve
// no formato que a máscara da SEFIN espera ("1234,50").
function toMoney(value) {
    if (value === undefined || value === null || value === '') return ''
    if (typeof value === 'number') return value.toFixed(2).replace('.', ',')
    const s = String(value).replace(/[^\d,.-]/g, '')
    if (s.includes(',')) return s.replace(/\./g, '')
    const n = Number(s)
    return Number.isFinite(n) ? n.toFixed(2).replace('.', ',') : ''
}

function normalizeInput(body = {}) {
    const input = {
        cnpj: formatCnpj(body.cnpj || DEFAULT_CNPJ),
        notaFiscal: String(body.invoiceNumber ?? body.notaFiscal ?? ''),
        destinatario: String(body.recipient ?? body.destinatario ?? ''),
        origem: String(body.origin ?? body.origem ?? ''),
        destino: String(body.destination ?? body.destino ?? ''),
        produto: String(body.product ?? body.produto ?? ''),
        baseCalculo: body.calculationBase ?? body.baseCalculo ?? '',
        valor: toMoney(body.value ?? body.valor),
        codigoReceita: onlyDigits(body.receiptCode ?? body.codigoReceita) || DEFAULT_RECEITA,
        dataVencimento: body.dataVencimento || defaultDueDate(),
        mesReferencia: body.mesReferencia || currentMonthYear(),
        contribuinte: body.contribuinte || {},
    }
    input.baseCalculo = input.baseCalculo === null || input.baseCalculo === undefined ? '' : String(input.baseCalculo)

    if (!input.valor || input.valor === '0,00') throw new InputError('Valor do DARE é obrigatório e precisa ser maior que zero')
    if (!/^\d{2}\/\d{2}\/\d{4}$/.test(input.dataVencimento)) throw new InputError('dataVencimento deve estar no formato dd/mm/aaaa')
    if (!/^\d{2}\/\d{4}$/.test(input.mesReferencia)) throw new InputError('mesReferencia deve estar no formato mm/aaaa')
    return input
}

async function setValue(page, selector, value) {
    const el = await page.$(selector)
    if (!el) return
    await page.$eval(selector, node => {
        node.removeAttribute('readonly')
        node.value = ''
        node.dispatchEvent(new Event('input', { bubbles: true }))
    })
    if (value) await page.type(selector, String(value))
}

// Só preenche se a SEFIN não trouxe o dado do próprio cadastro. Isso cobre
// transportadoras que ainda não estão no cadastro de contribuintes de RO.
async function fillIfEmpty(page, selector, value) {
    if (!value) return
    const current = await page.$eval(selector, el => el.value).catch(() => null)
    if (current === null || String(current).trim()) return
    await setValue(page, selector, value)
}

async function fillContribuinte(page, c) {
    await fillIfEmpty(page, 'input[name="nome_contribuinte"]', c.nome)
    await fillIfEmpty(page, 'input[name="telefone"]', onlyDigits(c.telefone))
    await fillIfEmpty(page, 'input[name="cep"]', onlyDigits(c.cep))
    await fillIfEmpty(page, 'input[name="endereco"]', c.endereco)
    await fillIfEmpty(page, 'input[name="municipio"]', c.municipio)
    if (c.uf) {
        const uf = await page.$eval('select[name="uf"]', el => el.value).catch(() => null)
        if (uf === '') await page.select('select[name="uf"]', String(c.uf).toUpperCase())
    }
    if (c.codigoMunicipio) {
        await page.evaluate(code => {
            const hidden = document.querySelector('#codigo_municipio')
            const display = document.querySelector('#codigo_municipio_display')
            if (hidden && !hidden.value) hidden.value = code
            if (display && !display.value) display.value = code
        }, String(c.codigoMunicipio))
    }
}

// Lê os motivos de recusa da página: campos que o validador da SEFIN marcou
// como inválidos, avisos PNotify e alert() capturados.
async function collectErrors(page, dialogs) {
    const fromPage = await page.evaluate(() => {
        const label = el => {
            const group = el.closest('.form-group')
            const text = group && group.querySelector('label')
            return (text ? text.textContent : el.name || el.id || '').replace(/[*:]/g, '').trim()
        }
        const invalid = [...document.querySelectorAll('.inputInvalid')].map(label).filter(Boolean)
        const notices = [...document.querySelectorAll('.ui-pnotify-text, .alert-danger, .alert-warning, .flash-error')]
            .map(n => n.textContent.trim())
            .filter(Boolean)
        return { invalid, notices }
    }).catch(() => ({ invalid: [], notices: [] }))

    const parts = []
    if (fromPage.invalid.length) parts.push(`Campos recusados pela SEFIN: ${[...new Set(fromPage.invalid)].join(', ')}`)
    parts.push(...fromPage.notices, ...dialogs)
    return parts.join(' | ')
}

// Procura a linha digitável (48 dígitos, começa com 8) no texto do DARE.
async function extractLinhaDigitavel(page) {
    const text = await page.evaluate(() => document.body.innerText).catch(() => '')
    const match = text.match(/8\d{10}[\s-]*\d[\s.]+\d{11}[\s-]*\d[\s.]+\d{11}[\s-]*\d[\s.]+\d{11}[\s-]*\d/)
    return match ? match[0].replace(/\s+/g, ' ').trim() : null
}

async function emitOnce(input, { dryRun }) {
    return withPage(async page => {
        const dialogs = []
        page.on('dialog', dialog => {
            dialogs.push(dialog.message())
            dialog.dismiss().catch(() => { })
        })

        const url = `${SEFIN_BASE_URL}/avulso/dados-formulario?utf8=%E2%9C%93&c_o=1&ind=3&ident=${encodeURIComponent(input.cnpj)}`
        await page.goto(url, { waitUntil: 'domcontentloaded' })

        const form = await page.waitForSelector('input[name="infor_notafiscal"]', { timeout: 20000 }).catch(() => null)
        if (!form) {
            const reason = await collectErrors(page, dialogs)
            throw new SefinError(`A SEFIN não abriu o formulário do DARE para o CNPJ ${input.cnpj}${reason ? `: ${reason}` : ''}`)
        }

        await fillContribuinte(page, input.contribuinte)

        await setValue(page, 'input[name="infor_notafiscal"]', input.notaFiscal)
        await setValue(page, 'input[name="infor_destinatario"]', input.destinatario)
        await setValue(page, 'input[name="infor_origem"]', input.origem)
        await setValue(page, 'input[name="infor_destino"]', input.destino)
        await setValue(page, 'input[name="infor_produto"]', input.produto)
        await setValue(page, 'input[name="infor_basecalculo"]', input.baseCalculo)
        await setValue(page, 'input[name="valor_principal"]', input.valor)
        await setValue(page, 'input[name="data_vencimento"]', input.dataVencimento)
        await setValue(page, 'input[name="mesano_referencia"]', input.mesReferencia)

        await page.evaluate(code => {
            const el = document.querySelector('#codigo_receita')
            if (!el) throw new Error('Campo #codigo_receita não encontrado')
            el.value = code
            el.setAttribute('value', code)
            el.dispatchEvent(new Event('input', { bubbles: true }))
            el.dispatchEvent(new Event('change', { bubbles: true }))
            const display = document.querySelector('#codigo_receita_display')
            if (display) display.value = code
        }, input.codigoReceita)

        // O total é recalculado pelo próprio site quando o valor muda.
        await page.$eval('#valor_principal', el => el.dispatchEvent(new Event('change', { bubbles: true }))).catch(() => { })

        if (dryRun) {
            const screenshot = await page.screenshot({ fullPage: true, type: 'png' })
            return { kind: 'dry-run', screenshot }
        }

        // Daqui em diante a SEFIN pode já ter gerado a guia. Uma falha aqui não
        // é repetida automaticamente para não emitir DARE em dobro.
        try {
            await page.click('button[name="button"]')

            // Espera o DARE aparecer ou a SEFIN apontar erro, o que vier primeiro.
            const outcome = await Promise.race([
                page.waitForSelector('table.mb_20.text-size-13', { visible: true, timeout: 60000 }).then(() => 'ok'),
                page.waitForSelector('.inputInvalid, .ui-pnotify-text, .alert-danger', { visible: true, timeout: 60000 }).then(() => 'erro'),
            ]).catch(error => { throw new Error(`Timeout esperando o DARE da SEFIN: ${error.message}`) })

            if (outcome === 'erro') {
                // Dá um instante para o PNotify terminar de renderizar o texto.
                await new Promise(r => setTimeout(r, 500))
                const reason = await collectErrors(page, dialogs)
                const done = await page.$('table.mb_20.text-size-13')
                if (!done) throw new SefinError(reason || 'A SEFIN recusou os dados do DARE')
            }

            const linhaDigitavel = await extractLinhaDigitavel(page)
            const pdf = await page.pdf({
                format: 'A4',
                printBackground: true,
                margin: { top: '20mm', right: '20mm', bottom: '20mm', left: '20mm' },
            })
            return { kind: 'pdf', pdf, linhaDigitavel }
        } catch (error) {
            error.afterSubmit = true
            throw error
        }
    })
}

async function emitirDareRO(body, { dryRun = false } = {}) {
    const input = normalizeInput(body)
    const result = await withRetry(() => emitOnce(input, { dryRun }), { attempts: 2, label: `DARE NF ${input.notaFiscal}` })
    return { ...result, input }
}

module.exports = { emitirDareRO, normalizeInput, toMoney, formatCnpj }
