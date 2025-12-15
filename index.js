import makeWASocket, {
    DisconnectReason,
    fetchLatestBaileysVersion,
    useMultiFileAuthState
} from "@whiskeysockets/baileys"

import P from "pino"
import fs from "fs"
import XLSX from "xlsx"
import qrcode from "qrcode"

const GROUP_ID = '120363423646323874@g.us'

// CONFIGURAÇÃO DO CICLO
const ADD_POR_CICLO = 8
const LINK_POR_CICLO = 20
const CICLO_MINUTOS = 35

let isConnecting = false

const delay = ms => new Promise(r => setTimeout(r, ms))
const random = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min

// ====== LEITURA XLSX ======
function lerNumerosXLSX() {
    // tenta ler como planilha XLSX
    try {
        const wb = XLSX.readFile('./numeros.xlsx')
        const sheet = wb.Sheets[wb.SheetNames[0]]
        const rows = XLSX.utils.sheet_to_json(sheet, { defval: null })

        if (rows && rows.length) {
            // formatos possíveis: [{ numero: '55...' }, { A: '55...' }] ou [{ '55...': undefined }]
            const key = Object.keys(rows[0]).find(k => k && k.toLowerCase().includes('num') )
            if (key) {
                return rows
                    .map(r => r[key])
                    .filter(Boolean)
                    .map(n => normalizeNumber(n))
                    .filter(Boolean)
                    .map(n => `${n}@s.whatsapp.net`)
            }

            // fallback: take first column value for each row
            const firstKey = Object.keys(rows[0])[0]
            if (firstKey) {
                return rows
                    .map(r => r[firstKey])
                    .filter(Boolean)
                    .map(n => normalizeNumber(n))
                    .filter(Boolean)
                    .map(n => `${n}@s.whatsapp.net`)
            }
        }
    } catch (e) {
        // não crashar aqui — tentaremos ler como texto abaixo
    }

    // fallback: ler o arquivo como texto (algumas vezes o "xlsx" é na verdade um CSV/TXT)
    try {
        const raw = fs.readFileSync('./numeros.xlsx', 'utf8')
        const lines = raw.split(/\r?\n/)
        return lines
            .map(l => l.trim())
            .filter(Boolean)
            .map(n => normalizeNumber(n))
            .filter(Boolean)
            .map(n => `${n}@s.whatsapp.net`)
    } catch (e) {
        throw new Error('Não foi possível ler ./numeros.xlsx como XLSX nem como texto: ' + (e.message || e))
    }
}

function normalizeNumber(value) {
    if (typeof value !== 'string' && typeof value !== 'number') return null
    const s = String(value).replace(/[^0-9]/g, '')
    // descartar linhas muito curtas
    if (s.length < 8) return null
    // se já tem DDI (começa com 55 ou 0?), mantemos; caso contrário, usuário deve garantir
    return s
}

// ====== CONTROLE DE PROCESSADOS ======
function carregarProcessados() {
    if (!fs.existsSync('./processados.json')) {
        return { adicionados: [], linkEnviado: [] }
    }
    return JSON.parse(fs.readFileSync('./processados.json'))
}

function salvarProcessados(data) {
    fs.writeFileSync('./processados.json', JSON.stringify(data, null, 2))
}

// ====== CICLO PRINCIPAL ======
async function ciclo(sock) {
    let numeros
    try {
        numeros = lerNumerosXLSX()
    } catch (e) {
        console.error('Erro ao ler numeros.xlsx:', e.message || e)
        return
    }
    const proc = carregarProcessados()

    const pendentes = numeros.filter(n =>
        !proc.adicionados.includes(n) &&
        !proc.linkEnviado.includes(n)
    )

    console.log(`Iniciando ciclo: ${pendentes.length} pendentes (adicionar ${ADD_POR_CICLO}, enviar link ${LINK_POR_CICLO})`)

    if (pendentes.length === 0) {
        console.log('🎉 Todos os números já foram processados')
        return
    }

    // ===== ADICIONAR DIRETO =====
    const paraAdicionar = pendentes.slice(0, ADD_POR_CICLO)

    for (const numero of paraAdicionar) {
        try {
            console.log('Tentando adicionar:', numero)
            await sock.groupParticipantsUpdate(GROUP_ID, [numero], 'add')
            proc.adicionados.push(numero)
            console.log(`✅ Adicionado: ${numero}`)
        } catch (err) {
            console.log(`❌ Falha ao adicionar: ${numero} —`, err?.message || err)
            proc.linkEnviado.push(numero)
        }

        salvarProcessados(proc)
        await delay(random(120000, 180000)) // 2–3 min
    }

    // ===== GERAR LINK =====
    let inviteCode
    try {
        inviteCode = await sock.groupInviteCode(GROUP_ID)
    } catch (err) {
        console.error('Erro ao gerar inviteCode do grupo:', err?.message || err)
        // não interrompe o ciclo inteiro; apenas registra e segue
        inviteCode = null
    }
    const link = inviteCode ? `https://chat.whatsapp.com/${inviteCode}` : null

    const paraLink = pendentes
        .filter(n => !proc.adicionados.includes(n))
        .slice(0, LINK_POR_CICLO)

    for (const numero of paraLink) {
        try {
            if (!link) throw new Error('link de convite não disponível')
            console.log('Enviando link para:', numero)
            await sock.sendMessage(numero, {
                text: `🔥 BLACK DECEMBER – PERFUMES IMPORTADOS 🔥

Os melhores perfumes importados com descontos de até 40% só em dezembro 
Entre agora no grupo e aproveite ofertas limitadas 👇 \n${link}`
            })
            proc.linkEnviado.push(numero)
            console.log(`🔗 Link enviado: ${numero}`)
        } catch (err) {
            console.log(`❌ Falha ao enviar link: ${numero} —`, err?.message || err)
        }

        salvarProcessados(proc)
        await delay(random(60000, 120000)) // 1–2 min
    }

    console.log(`⏸️ Ciclo finalizado. Pausa de ${CICLO_MINUTOS} minutos...\n`)
    await delay(CICLO_MINUTOS * 60 * 1000)

    return ciclo(sock)
}

// ====== INICIALIZAÇÃO ======
async function startBot() {
    if (isConnecting) {
        console.log('Já tentando conectar...')
        return
    }
    isConnecting = true

    try {
        const { state, saveCreds } = await useMultiFileAuthState('./auth')
        const { version } = await fetchLatestBaileysVersion()

        const sock = makeWASocket({
            auth: state,
            version,
            logger: P({ level: 'silent' })
        })

        sock.ev.on('creds.update', saveCreds)

        sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update

        if (qr) {
            console.log('🔗 Gerando QR Code...')
            await qrcode.toFile('./qr-code.png', qr)
            console.log('✅ QR Code salvo em qr-code.png! Abra a imagem e escaneie com o WhatsApp.')
        }

        if (connection === 'close') {
            isConnecting = false
            const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut
            console.log('Conexão fechada devido a:', lastDisconnect?.error, ', reconectando:', shouldReconnect)
            if (shouldReconnect) {
                console.log('Tentando reconectar em 10 segundos...')
                setTimeout(() => startBot(), 10000)
            } else {
                console.log('Não reconectando (logout ou erro permanente)')
            }
        } else if (connection === 'open') {
            isConnecting = false
            console.log('✅ Conectado ao WhatsApp')
            console.log('Iniciando o ciclo em 10s...')
            setTimeout(() => ciclo(sock), 10000)
        }
    })
    } catch (error) {
        isConnecting = false
        console.error('Erro ao iniciar bot:', error)
        console.log('Tentando novamente em 10 segundos...')
        setTimeout(() => startBot(), 10000)
    }
}

startBot()