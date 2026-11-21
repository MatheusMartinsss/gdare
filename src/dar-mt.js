const zlib = require('zlib')
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
    // Com IE a SEFAZ usa o município do cadastro da inscrição: o #municipio vem
    // como input oculto já preenchido e não há lista. Só CNPJ e CPF mostram o
    // select. O laço é manual porque a página carrega o prototype.js 1.5, que
    // troca o Array.from (com undefined ele devolve [] em vez de dar erro).
    const estado = await page.$eval('#municipio', el => {
        const opcoes = []
        if (el.tagName === 'SELECT') {
            for (let i = 0; i < el.options.length; i++) {
                opcoes.push({ value: el.options[i].value, text: el.options[i].text.trim() })
            }
        }
        return {
            lista: el.tagName === 'SELECT',
            disabled: el.disabled,
            atual: el.value && el.value !== '0' ? el.value : '',
            opcoes,
        }
    })
    if (!estado.lista) {
        if (estado.atual) return
        throw new SefinError('A SEFAZ-MT não trouxe o município do cadastro desta inscrição estadual')
    }
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

// Troca os envios da página (form.submit, botão submit e window.open) por um
// fetch e guarda a resposta em window.__dar. Roda de novo a cada página nova.
async function capturarEnvio(page) {
    await page.evaluate(() => {
        window.__dar = null
        const baixar = (url, init) => {
            window.__dar = { estado: 'enviando' }
            fetch(url, Object.assign({ credentials: 'same-origin' }, init))
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
        const capturar = function () {
            const form = this
            const metodo = (form.getAttribute('method') || 'GET').toUpperCase()
            const dados = new FormData(form)
            if (metodo === 'GET') {
                const url = new URL(form.action, document.baseURI)
                new URLSearchParams(dados).forEach((v, k) => url.searchParams.append(k, v))
                return baixar(url.href, { method: 'GET' })
            }
            const body = form.enctype === 'multipart/form-data' ? dados : new URLSearchParams(dados)
            baixar(form.action, { method: metodo, body })
        }
        window.__baixar = url => baixar(new URL(url, document.baseURI).href, { method: 'GET' })
        HTMLFormElement.prototype.submit = capturar
        for (let i = 0; i < document.forms.length; i++) document.forms[i].submit = capturar
        document.addEventListener('submit', ev => { ev.preventDefault(); capturar.call(ev.target) }, true)
        window.open = url => {
            if (url) window.__baixar(url)
            return { focus() { }, close() { }, document: { write() { }, close() { } } }
        }
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

async function esperarEnvio(page, alertas, { validacao }) {
    const fim = Date.now() + TIMEOUT
    let resultado = null
    while (Date.now() < fim) {
        resultado = await avaliarSeguro(page, () => window.__dar)
        if (resultado && resultado.estado !== 'enviando') break
        // Alerta antes do envio é a validação do próprio formulário.
        if (validacao && !resultado && alertas.length) throw erroDeAlerta(alertas)
        await esperar(300)
    }
    if (!resultado || resultado.estado === 'enviando') {
        throw new Error('Timeout esperando a resposta da SEFAZ-MT. Confira no portal se o DAR foi gerado.')
    }
    if (resultado.estado === 'erro') throw new Error(`Falha ao enviar o DAR para a SEFAZ-MT: ${resultado.erro}`)
    if (resultado.status >= 400) throw new Error(`SEFAZ-MT respondeu ${resultado.status} ao gerar o DAR`)
    return resultado
}

const ehPdf = (bytes, tipo) => /pdf/i.test(tipo) || bytes.subarray(0, 5).toString('latin1') === '%PDF-'

// O texto do PDF da SEFAZ-MT fica em streams comprimidos (FlateDecode).
function textoDoPdf(bytes) {
    const bruto = bytes.toString('latin1')
    let texto = bruto
    const re = /stream\r?\n/g
    let m
    while ((m = re.exec(bruto))) {
        const ini = m.index + m[0].length
        const fim = bruto.indexOf('endstream', ini)
        if (fim < 0) break
        try { texto += '\n' + zlib.inflateSync(bytes.subarray(ini, fim)).toString('latin1') } catch { /* stream não comprimido */ }
        re.lastIndex = fim + 'endstream'.length
    }
    return texto
}

const resultadoPdf = bytes => ({ pdf: bytes, formato: 'pdf', linhaDigitavel: extrairLinhaDigitavel(textoDoPdf(bytes)) })

// Resposta em HTML: escreve no próprio documento da SEFAZ (com <base> da
// resposta). Ao contrário do setContent, a página continua na origem
// sefaz.mt.gov.br, então os scripts e formulários dela funcionam na sessão.
async function abrirHtml(page, bytes, resultado, alertas) {
    const html = decodificarHtml(bytes, resultado.tipo)
    const base = `<base href="${resultado.url.replace(/"/g, '&quot;')}">`
    const comBase = /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, m => m + base) : base + html
    await page.evaluate(h => { document.open(); document.write(h); document.close() }, comBase).catch(() => { })
    await ociosa(page)

    const erro = await textoPaginaDeErro(page)
    if (erro) throw new SefinError(`SEFAZ-MT: ${erro}`)
    if (alertas.length) {
        const voltouAoFormulario = await avaliarSeguro(page, () => !!document.querySelector('#tributo'))
        if (voltouAoFormulario) throw erroDeAlerta(alertas)
    }
    return await avaliarSeguro(page, () => (document.body ? document.body.innerText : '')) || ''
}

// Botão "DAR/PDF" da tela de forma de pagamento.
const BOTAO_DAR_PDF = '^\\s*DAR\\s*/?\\s*PDF\\s*$'

function acharBotao(page, clicar) {
    return avaliarSeguro(page, (re, clicar) => {
        const els = document.querySelectorAll('input[type=button],input[type=submit],button,a')
        for (let i = 0; i < els.length; i++) {
            const el = els[i]
            if (new RegExp(re, 'i').test(el.value || el.textContent || '')) {
                if (clicar) setTimeout(() => el.click(), 0)
                return true
            }
        }
        return false
    }, BOTAO_DAR_PDF, clicar)
}

// Resumo da página no log (sem valores dos campos), para ajustar o fluxo se a
// SEFAZ mudar a tela de novo.
async function registrarEstrutura(page, rotulo) {
    const estrutura = await avaliarSeguro(page, () => {
        const forms = []
        for (let i = 0; i < document.forms.length; i++) {
            const f = document.forms[i]
            const campos = []
            for (let j = 0; j < f.elements.length; j++) {
                const el = f.elements[j]
                campos.push(`${el.tagName.toLowerCase()}:${el.type || ''}:${el.name || el.id || ''}`)
            }
            forms.push({ name: f.getAttribute('name'), action: f.getAttribute('action'), method: f.getAttribute('method'), target: f.getAttribute('target'), campos })
        }
        const botoes = []
        const els = document.querySelectorAll('input[type=button],input[type=submit],button,a[onclick],iframe,embed,object')
        for (let i = 0; i < els.length; i++) botoes.push(els[i].outerHTML.slice(0, 400))
        return { url: location.href, forms, botoes }
    })
    console.log(`[dar-mt] ${rotulo}: ${JSON.stringify(estrutura)}`)
}

async function imprimirPagina(page, texto) {
    const pdf = await page.pdf({ format: 'A4', printBackground: true, margin: { top: '10mm', right: '10mm', bottom: '10mm', left: '10mm' } })
    return { pdf, formato: 'html', linhaDigitavel: extrairLinhaDigitavel(texto) }
}

async function enviar(page, alertas) {
    await capturarEnvio(page)
    await page.evaluate(() => { setTimeout(() => emitir(), 0) })
    const primeiro = await esperarEnvio(page, alertas, { validacao: true })
    const bytes = Buffer.from(primeiro.base64, 'base64')
    if (ehPdf(bytes, primeiro.tipo)) return resultadoPdf(bytes)

    const texto = await abrirHtml(page, bytes, primeiro, alertas)

    // Desde nov/2026 o pj/gerardar devolve "Selecione a Forma de Pagamento"
    // (DAR/PDF ou PIX/QRCode). O DAR em PDF vem do botão DAR/PDF.
    if (!/Forma de Pagamento/i.test(texto) || !(await acharBotao(page, false))) {
        return imprimirPagina(page, texto)
    }

    await registrarEstrutura(page, 'forma de pagamento')
    await capturarEnvio(page)
    await acharBotao(page, true)

    const segundo = await esperarEnvio(page, alertas, { validacao: false }).catch(error => {
        throw new Error(`A SEFAZ-MT não devolveu o PDF após escolher DAR/PDF (${error.message})`)
    })
    const bytes2 = Buffer.from(segundo.base64, 'base64')
    if (ehPdf(bytes2, segundo.tipo)) return resultadoPdf(bytes2)

    // HTML de novo: o PDF pode vir embutido (iframe, embed ou object).
    const texto2 = await abrirHtml(page, bytes2, segundo, alertas)
    await registrarEstrutura(page, 'após DAR/PDF')
    const embutido = await avaliarSeguro(page, () => {
        const el = document.querySelector('iframe[src],embed[src],object[data]')
        return el ? (el.getAttribute('src') || el.getAttribute('data')) : null
    })
    if (embutido) {
        await capturarEnvio(page)
        await page.evaluate(u => window.__baixar(u), embutido)
        const terceiro = await esperarEnvio(page, alertas, { validacao: false })
        const bytes3 = Buffer.from(terceiro.base64, 'base64')
        if (ehPdf(bytes3, terceiro.tipo)) return resultadoPdf(bytes3)
    }
    const linha = extrairLinhaDigitavel(texto2)
    throw new Error('A SEFAZ-MT não devolveu o DAR em PDF. Confira no portal se o DAR foi gerado.' +
        (linha ? ` Linha digitável: ${linha}` : ''))
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
