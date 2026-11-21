// Datas usadas no DARE. O container deve rodar com TZ=America/Porto_Velho
// (ver Dockerfile); em UTC, depois das 20h em RO o "hoje" já vira o dia
// seguinte e, no último dia do mês, o mês de referência saía errado.

const pad = n => String(n).padStart(2, '0')

const formatDate = d => `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`

const formatMonthYear = d => `${pad(d.getMonth() + 1)}/${d.getFullYear()}`

// Domingo de Páscoa (algoritmo de Meeus/Jones/Butcher)
function easterSunday(year) {
    const a = year % 19
    const b = Math.floor(year / 100)
    const c = year % 100
    const d = Math.floor(b / 4)
    const e = b % 4
    const f = Math.floor((b + 8) / 25)
    const g = Math.floor((b - f + 1) / 3)
    const h = (19 * a + b - d - g + 15) % 30
    const i = Math.floor(c / 4)
    const k = c % 4
    const l = (32 + 2 * e + 2 * i - h - k) % 7
    const m = Math.floor((a + 11 * h + 22 * l) / 451)
    const month = Math.floor((h + l - 7 * m + 114) / 31)
    const day = ((h + l - 7 * m + 114) % 31) + 1
    return new Date(year, month - 1, day)
}

const addDays = (date, days) => {
    const d = new Date(date)
    d.setDate(d.getDate() + days)
    return d
}

const holidayCache = new Map()

// Feriados nacionais + estaduais de Rondônia + datas em que a rede bancária
// não funciona (Carnaval).
function holidaysOf(year) {
    if (holidayCache.has(year)) return holidayCache.get(year)

    const fixed = [
        '01-01', // Confraternização Universal
        '01-04', // Criação do Estado de Rondônia
        '04-21', // Tiradentes
        '05-01', // Dia do Trabalho
        '06-18', // Dia do Evangélico (RO)
        '09-07', // Independência
        '10-12', // Nossa Senhora Aparecida
        '11-02', // Finados
        '11-15', // Proclamação da República
        '11-20', // Consciência Negra
        '12-25', // Natal
    ].map(md => `${year}-${md}`)

    const easter = easterSunday(year)
    const movable = [
        addDays(easter, -48), // Carnaval (segunda)
        addDays(easter, -47), // Carnaval (terça)
        addDays(easter, -2),  // Sexta-feira Santa
        addDays(easter, 60),  // Corpus Christi
    ].map(d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`)

    const set = new Set([...fixed, ...movable])
    holidayCache.set(year, set)
    return set
}

function isBusinessDay(date) {
    const day = date.getDay()
    if (day === 0 || day === 6) return false
    const key = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    return !holidaysOf(date.getFullYear()).has(key)
}

function nextBusinessDay(date) {
    let d = new Date(date)
    while (!isBusinessDay(d)) d = addDays(d, 1)
    return d
}

// Mesmo dia do mês seguinte (ou o último dia, se o mês seguinte for mais
// curto), empurrado para o próximo dia útil.
function defaultDueDate(now = new Date()) {
    const target = new Date(now.getFullYear(), now.getMonth() + 1, 1)
    const lastDay = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate()
    target.setDate(Math.min(now.getDate(), lastDay))
    return formatDate(nextBusinessDay(target))
}

function currentMonthYear(now = new Date()) {
    return formatMonthYear(now)
}

module.exports = {
    defaultDueDate,
    currentMonthYear,
    isBusinessDay,
    nextBusinessDay,
    formatDate,
}
