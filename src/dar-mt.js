const { withPage } = require('./browser')
const { SefinError, InputError, withRetry } = require('./errors')
const { formatDate } = require('./datas')

// DAR avulso da SEFAZ-MT (FETHAB e contribuições às entidades). Fluxo público
// e sem captcha:
//   1. menudarnovo: escolhe IE, CNPJ ou CPF e chama abrir(1).
//   2. Formulário: município, período, receita, vencimento, quantidade e
//      informações. A própria SEFAZ calcula o valor (quantidade × valor por
//      unidade do período).
//   3. emitir(): valida no navegador e faz POST em pj/gerardar.
//
// O POST é capturado por fetch dentro da página. Assim o gdare recebe os bytes
// da resposta como vieram (PDF ou HTML) sem depender do visualizador de PDF
// do Chrome.

const SEFAZ_MT_URL = process.env.SEFAZ_MT_URL || 'https://www.sefaz.mt.gov.br/arrecadacao/darlivre'
const TIMEOUT = Number(process.env.SEFAZ_MT_TIMEOUT_MS || 90000)

// Receitas que ficam no menu CONTRIBUIÇÕES (tipoTributo=60). O resto do FETHAB
// fica no menu 57.
const MENU_CONTRIBUICOES = new Set([
    '5606', '7200', '8090', '8096', '8097', '8132', '8134', '9563',
    ...Array.from({ length: 15 }, (_, i) => String(8234 + i)), // 8234 a 8248
])

const DOCUMENTOS = {
    ie: { radio: '3', campo: '#inscricaoEstadual', tamanhos: [8, 9, 10, 11, 12], nome: 'inscrição estadual' },
    cnpj: { radio: '2', campo: '#cnpj', tamanhos: [14], nome: 'CNPJ' },
    cpf: { radio: '1', campo: '#cpf', tamanhos: [11], nome: 'CPF' },
}

// Nomes do IBGE que a SEFAZ escreve de outro jeito.
const ALIAS_MUNICIPIO = {
    'NOSSA SENHORA DO LIVRAMENTO': 'NOSSA SRA DO LIVRAMENTO',
    'POXOREO': 'POXOREU',
    'SANTO ANTONIO DO LEVERGER': 'SANTO ANTONIO DE LEVERGER',
}

const onlyDigits = v => String(v ?? '').replace(/\D/g, '')

const semAcento = s => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '')

const normalizarMunicipio = s => {
    const n = semAcento(s).toUpperCase().replace(/['`´]/g, ' ').replace(/\s+/g, ' ').trim()
    return ALIAS_MUNICIPIO[n] || n
}

const pad = n => String(n).padStart(2, '0')

function lerData(texto) {
    const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(texto)
    if (!m) return null
    const d = new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]))
    return d.getDate() === Number(m[1]) && d.getMonth() === Number(m[2]) - 1 ? d : null
}

// "37,5" (o emissor tira os pontos e troca a vírgula por ponto).
const quantidadeParaCampo = q => String(Number(q.toFixed(4))).replace('.', ',')

// Valor lido da página: "1.931,19", "1931,19" ou "1931.19".
function lerValor(texto) {
    const s = String(texto ?? '').replace(/[^\d,.-]/g, '')
    if (!s) return null
    const n = Number(s.includes(',') ? s.replace(/\./g, '').replace(',', '.') : s)
    return Number.isFinite(n) ? n : null
}

const formatarReais = v => v.toFixed(2).replace('.', ',')

function normalizeInput(body = {}) {
    const doc = body.documento || {}
    let tipo = String(doc.tipo || '').toLowerCase()
    let numero = onlyDigits(doc.numero)
    if (!tipo) {
        if (body.inscricaoEstadual) { tipo = 'ie'; numero = onlyDigits(body.inscricaoEstadual) }
        else if (body.cnpj) { tipo = 'cnpj'; numero = onlyDigits(body.cnpj) }
        else if (body.cpf) { tipo = 'cpf'; numero = onlyDigits(body.cpf) }
    }
    const regra = DOCUMENTOS[tipo]
    if (!regra) throw new InputError('Informe o documento do remetente: inscrição estadual, CNPJ ou CPF')
    if (!regra.tamanhos.includes(numero.length)) throw new InputError(`${regra.nome} inválido: ${numero || '(vazio)'}`)

    const codigoReceita = onlyDigits(body.codigoReceita)
    if (codigoReceita.length !== 4) throw new InputError('codigoReceita deve ter 4 dígitos')

    const periodoReferencia = String(body.periodoReferencia || '').trim()
    if (!/^(0[1-9]|1[0-2])\/20\d\d$/.test(periodoReferencia)) throw new InputError('periodoReferencia deve estar no formato mm/aaaa')

    const hoje = new Date()
    hoje.setHours(0, 0, 0, 0)
    const dataVencimento = String(body.dataVencimento || formatDate(hoje)).trim()
    const vencimento = lerData(dataVencimento)
    if (!vencimento) throw new InputError('dataVencimento deve estar no formato dd/mm/aaaa')
    if (vencimento < hoje) throw new InputError('dataVencimento não pode ser anterior a hoje')
    const limite = new Date(hoje)
    limite.setFullYear(limite.getFullYear() + 1)
    if (vencimento > limite) throw new InputError('dataVencimento pode ser no máximo um ano à frente')

    const quantidade = typeof body.quantidade === 'number' ? body.quantidade : lerValor(body.quantidade)
    if (!quantidade || quantidade <= 0) throw new InputError('quantidade deve ser maior que zero')

    // Só ASCII: o envio vai em UTF-8 e o emissor é antigo. Corta em 220 como o formulário.
    const informacoes = semAcento(body.informacoes || '')
        .replace(/[º°]/g, 'o').replace(/ª/g, 'a').replace(/[–—]/g, '-')
        .replace(/[^ -~]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 220)

    let valorEsperado = null
    if (body.valorEsperado !== undefined && body.valorEsperado !== null && body.valorEsperado !== '') {
        valorEsperado = typeof body.valorEsperado === 'number' ? body.valorEsperado : lerValor(body.valorEsperado)
        if (valorEsperado === null) throw new InputError('valorEsperado inválido')
    }

    return {
        documento: { tipo, numero },
        codigoReceita,
        tipoTributo: String(body.tipoTributo || (MENU_CONTRIBUICOES.has(codigoReceita) ? '60' : '57')),
        periodoReferencia,
        dataVencimento,
        quantidade,
        municipio: body.municipio ? normalizarMunicipio(body.municipio) : '',
        informacoes,
        valorEsperado,
    }
}

const esperar = ms => new Promise(r => setTimeout(r, ms))

// Avalia fn na página e ignora erros de contexto destruído (navegação em curso).
const avaliarSeguro = (page, fn, ...args) => page.evaluate(fn, ...args).catch(() => null)

async function ociosa(page) {
    await page.waitForNetworkIdle({ idleTime: 400, timeout: 30000 }).catch(() => { })
}

function erroDeAlerta(alertas) {
    return new SefinError(`SEFAZ-MT: ${alertas.join(' | ').replace(/\s+/g, ' ').trim()}`)
}

// Texto da "Página de Erros" do emissor, se for ela que está aberta.
async function textoPaginaDeErro(page) {
    return avaliarSeguro(page, () => {
        const texto = document.body ? document.body.innerText : ''
        if (!/P[áa]gina de Erros/i.test(texto)) return null
        return texto.replace(/P[áa]gina de Erros/i, '').replace(/\s+/g, ' ').trim().slice(0, 300)
    })
}

async function abrirFormulario(page, input, alertas) {
    const url = `${SEFAZ_MT_URL}/menudarnovo?tipoTributo=${input.tipoTributo}&tipoContribuinte=0&pagn=contribuinte`
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: TIMEOUT })

    const regra = DOCUMENTOS[input.documento.tipo]
    await page.waitForSelector(`input[name=radioDocumento][value="${regra.radio}"]`, { timeout: TIMEOUT })
    await page.click(`input[name=radioDocumento][value="${regra.radio}"]`)
    await page.$eval(regra.campo, (el, v) => { el.value = v }, input.documento.numero)

    // abrir(1) navega. O setTimeout evita que o evaluate morra junto com a página.
    await page.evaluate(() => { setTimeout(() => abrir(1), 0) })

    const fim = Date.now() + TIMEOUT
    while (Date.now() < fim) {
        if (alertas.length) throw erroDeAlerta(alertas)
        const erro = await textoPaginaDeErro(page)
        if (erro) throw new SefinError(`SEFAZ-MT: ${erro}`)
        const pronto = await avaliarSeguro(page, () => !!document.querySelector('#tributo'))
        if (pronto) return
        await esperar(500)
    }
    throw new Error('Timeout esperando o formulário do DAR da SEFAZ-MT')
}

async function escolherMunicipio(page, input) {
    const estado = await page.$eval('#municipio', el => ({
        disabled: el.disabled,
        atual: el.value && el.value !== '0' ? el.value : '',
        opcoes: Array.from(el.options).map(o => ({ value: o.value, text: o.text.trim() })),
    }))
    if (!input.municipio) {
        if (estado.atual) return
        throw new InputError('Informe o município do remetente em MT')
    }
    if (estado.disabled && estado.atual) return

    const alvo = input.municipio
    const opcao = estado.opcoes.find(o => normalizarMunicipio(o.text) === alvo)
    if (!opcao) throw new InputError(`Município não encontrado na lista da SEFAZ-MT: ${alvo}`)
    await page.select('#municipio', opcao.value)
}

async function preencher(page, input, alertas) {
    await escolherMunicipio(page, input)

    // O blur do período recarrega a lista de receitas.
    await page.$eval('#periodoReferencia', (el, v) => {
        el.value = v
        el.dispatchEvent(new Event('blur'))
    }, input.periodoReferencia)
    await ociosa(page)

    const temReceita = await page.waitForFunction(
        c => !!document.querySelector(`#tributo option[value="${c}"]`),
        { timeout: 30000 }, input.codigoReceita,
    ).then(() => true).catch(() => false)
    if (!temReceita) {
        throw new SefinError(`A receita ${input.codigoReceita} não está disponível no emissor da SEFAZ-MT para ${input.periodoReferencia}`)
    }

    // A troca de receita busca o valor por unidade (campo oculto upfmtFethab).
    await page.select('#tributo', input.codigoReceita)
    await ociosa(page)
    const porUnidade = await page.waitForFunction(() => {
        const el = document.querySelector('#upfmtFethab, [name="upfmtFethab"]')
        const n = el ? Number(String(el.value).trim()) : NaN
        return n > 0 ? n : false
    }, { timeout: 30000 }).then(h => h.jsonValue()).catch(() => null)
    if (!porUnidade) {
        throw new SefinError(`A SEFAZ-MT não informou valor para a receita ${input.codigoReceita} em ${input.periodoReferencia}`)
    }

    await page.$eval('#dataVencimento', (el, v) => { el.value = v }, input.dataVencimento)

    // O blur da quantidade calcula o valor (quantidade × valor por unidade).
    await page.$eval('#qtd', (el, v) => {
        el.value = v
        el.dispatchEvent(new Event('blur'))
    }, quantidadeParaCampo(input.quantidade))

    if (input.informacoes) {
        await page.$eval('#informacaoPrevista', (el, v) => { el.value = v }, input.informacoes)
    }

    // As mesmas checagens que validarForm() faz antes do submit. Elas só
    // devolvem true/false (e dão alert), sem enviar nada, então rodam também
    // no dryRun. validarForm() em si não é chamada porque ela mesma faz o submit.
    const valido = await page.evaluate(() => {
        const ok = (fn, ...args) => (typeof window[fn] === 'function' ? window[fn](...args) !== false : true)
        const hoje = typeof dataAtual !== 'undefined' ? dataAtual : undefined
        const periodo = document.querySelector('#periodoReferencia').value
        const vencimento = document.querySelector('#dataVencimento').value
        return ok('stringSearch') && ok('validaPeriodoReferencia', hoje, periodo) && ok('validaDataVencimento', hoje, vencimento)
    })

    const lido = await page.evaluate(() => {
        const v = document.querySelector('#valor')
        const c = document.querySelector('#valorCampo')
        return { valor: v ? v.value : '', valorCampo: c ? c.value : '' }
    })
    const valor = lerValor(lido.valor) ?? lerValor(lido.valorCampo)
    if (!valido) throw alertas.length ? erroDeAlerta(alertas) : new SefinError('A SEFAZ-MT recusou o período ou o vencimento')
    if (!valor || valor <= 0) throw new SefinError('A SEFAZ-MT não calculou o valor do DAR')

    if (input.valorEsperado !== null && Math.abs(valor - input.valorEsperado) > 0.01) {
        throw new SefinError(
            `O valor calculado pela SEFAZ-MT (R$ ${formatarReais(valor)}) é diferente do esperado ` +
            `(R$ ${formatarReais(input.valorEsperado)}). Nenhuma guia foi gerada.`,
        )
    }
    return { valor, porUnidade }
}

// Troca o submit do formulário por um fetch e guarda a resposta em window.__dar.
async function capturarEnvio(page) {
    await page.evaluate(() => {
        window.__dar = null
        const capturar = function () {
            const form = this
            const dados = new FormData(form)
            const body = form.enctype === 'multipart/form-data' ? dados : new URLSearchParams(dados)
            window.__dar = { estado: 'enviando' }
            fetch(form.action, { method: (form.method || 'POST').toUpperCase(), body, credentials: 'same-origin' })
                .then(async r => {
                    const bytes = new Uint8Array(await r.arrayBuffer())
                    let bin = ''
                    for (let i = 0; i < bytes.length; i += 0x8000) {
                        bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000))
                    }
                    window.__dar = {
                        estado: 'ok',
                        status: r.status,
                        url: r.url,
                        tipo: r.headers.get('content-type') || '',
                        base64: btoa(bin),
                    }
                })
                .catch(e => { window.__dar = { estado: 'erro', erro: String(e) } })
        }
        HTMLFormElement.prototype.submit = capturar
        if (document.form && typeof document.form.submit === 'function') document.form.submit = capturar
    })
}

function decodificarHtml(buffer, contentType) {
    let charset = (/charset=([\w-]+)/i.exec(contentType) || [])[1]
    if (!charset) {
        const cabeca = buffer.subarray(0, 2048).toString('latin1')
        charset = (/<meta[^>]+charset=["']?([\w-]+)/i.exec(cabeca) || [])[1] || 'utf-8'
    }
    try {
        return new TextDecoder(charset.toLowerCase()).decode(buffer)
    } catch {
        return buffer.toString('latin1')
    }
}

// Linha digitável de arrecadação: 48 dígitos começando com 8.
function extrairLinhaDigitavel(texto) {
    const m = String(texto).match(/8\d{10}[\s.-]*\d[\s.-]+\d{11}[\s.-]*\d[\s.-]+\d{11}[\s.-]*\d[\s.-]+\d{11}[\s.-]*\d/)
    return m ? m[0].replace(/\s+/g, ' ').trim() : null
}

async function enviar(page, alertas) {
    await capturarEnvio(page)
    await page.evaluate(() => { setTimeout(() => emitir(), 0) })

    const fim = Date.now() + TIMEOUT
    let resultado = null
    while (Date.now() < fim) {
        resultado = await avaliarSeguro(page, () => window.__dar)
        if (resultado && resultado.estado !== 'enviando') break
        // Alerta antes do envio é a validação do próprio formulário.
        if (!resultado && alertas.length) throw erroDeAlerta(alertas)
        await esperar(300)
    }
    if (!resultado || resultado.estado === 'enviando') {
        throw new Error('Timeout esperando a resposta da SEFAZ-MT. Confira no portal se o DAR foi gerado.')
    }
    if (resultado.estado === 'erro') throw new Error(`Falha ao enviar o DAR para a SEFAZ-MT: ${resultado.erro}`)
    if (resultado.status >= 400) throw new Error(`SEFAZ-MT respondeu ${resultado.status} ao gerar o DAR`)

    const bytes = Buffer.from(resultado.base64, 'base64')
    const ehPdf = /pdf/i.test(resultado.tipo) || bytes.subarray(0, 5).toString('latin1') === '%PDF-'
    if (ehPdf) {
        const texto = bytes.toString('latin1')
        return { pdf: bytes, formato: 'pdf', linhaDigitavel: extrairLinhaDigitavel(texto) }
    }

    // Resposta em HTML: abre na mesma aba (com <base> para CSS e imagens) e imprime.
    const html = decodificarHtml(bytes, resultado.tipo)
    const base = `<base href="${resultado.url.replace(/"/g, '&quot;')}">`
    const comBase = /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, m => m + base) : base + html
    await page.setContent(comBase, { waitUntil: 'networkidle0', timeout: TIMEOUT }).catch(() => { })

    const erro = await textoPaginaDeErro(page)
    if (erro) throw new SefinError(`SEFAZ-MT: ${erro}`)
    if (alertas.length) {
        const voltouAoFormulario = await avaliarSeguro(page, () => !!document.querySelector('#tributo'))
        if (voltouAoFormulario) throw erroDeAlerta(alertas)
    }

    const texto = await avaliarSeguro(page, () => document.body.innerText) || ''
    const pdf = await page.pdf({ format: 'A4', printBackground: true, margin: { top: '10mm', right: '10mm', bottom: '10mm', left: '10mm' } })
    return { pdf, formato: 'html', linhaDigitavel: extrairLinhaDigitavel(texto) }
}

async function emitOnce(input, { dryRun }) {
    return withPage(async page => {
        page.setDefaultTimeout(TIMEOUT)
        page.setDefaultNavigationTimeout(TIMEOUT)

        const alertas = []
        page.on('dialog', dialog => {
            // Confirmações são aceitas. Alertas são motivo de recusa.
            if (dialog.type() !== 'confirm') alertas.push(dialog.message())
            dialog.accept().catch(() => { })
        })

        await abrirFormulario(page, input, alertas)
        const { valor, porUnidade } = await preencher(page, input, alertas)
        if (alertas.length) throw erroDeAlerta(alertas)

        if (dryRun) {
            const screenshot = await page.screenshot({ fullPage: true, type: 'png' })
            return { kind: 'dry-run', screenshot, valor, porUnidade }
        }

        // Daqui em diante a SEFAZ pode já ter gerado a guia. Nada é repetido.
        try {
            const resultado = await enviar(page, alertas)
            return { kind: 'pdf', valor, porUnidade, ...resultado }
        } catch (error) {
            error.afterSubmit = true
            throw error
        }
    })
}

async function emitirDarMt(body, { dryRun = false } = {}) {
    const input = normalizeInput(body)
    const result = await withRetry(() => emitOnce(input, { dryRun }), {
        attempts: 2,
        label: `DAR-MT ${input.codigoReceita} ${input.documento.tipo}`,
    })
    return { ...result, input }
}

module.exports = { emitirDarMt, normalizeInput, normalizarMunicipio, extrairLinhaDigitavel }
