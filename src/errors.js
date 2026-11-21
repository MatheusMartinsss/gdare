// Erro de negócio: a SEFIN recusou os dados (CNPJ inválido, campo faltando,
// etc.). Não adianta repetir a emissão, então não entra no retry e volta 422.
class SefinError extends Error {
    constructor(message) {
        super(message)
        this.name = 'SefinError'
    }
}

// Erro de entrada da própria API (body incompleto). Volta 400.
class InputError extends Error {
    constructor(message) {
        super(message)
        this.name = 'InputError'
    }
}

const TRANSIENT_PATTERNS = [
    /timeout/i,
    /Target closed/i,
    /Session closed/i,
    /Protocol error/i,
    /net::ERR_/i,
    /Navigation failed/i,
    /detached/i,
    /Execution context was destroyed/i,
    /disconnected/i,
]

function isTransient(error) {
    if (error instanceof SefinError || error instanceof InputError) return false
    if (error && error.afterSubmit) return false
    const message = String(error && error.message || error)
    return TRANSIENT_PATTERNS.some(p => p.test(message))
}

async function withRetry(fn, { attempts = 2, label = 'operação' } = {}) {
    let lastError
    for (let attempt = 1; attempt <= attempts; attempt++) {
        try {
            return await fn(attempt)
        } catch (error) {
            lastError = error
            if (attempt < attempts && isTransient(error)) {
                console.warn(`[retry] ${label} falhou na tentativa ${attempt}: ${error.message}. Tentando de novo.`)
                continue
            }
            throw error
        }
    }
    throw lastError
}

module.exports = { SefinError, InputError, isTransient, withRetry }
