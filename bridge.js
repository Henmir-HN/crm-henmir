// =================================================================
// --- PUENTE Y SERVIDOR DE CHATBOT UNIFICADO PARA CRM HENMIR v3.1 ---
// =================================================================

console.log('Iniciando el cerebro de comunicación del CRM...');

// --- 1. IMPORTACIONES Y CONFIGURACIÓN INICIAL ---
require('dotenv').config();
const { Client, LocalAuth } = require('whatsapp-web.js');
const { WebSocketServer } = require('ws');
const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const OpenAI = require('openai');
const { GoogleGenerativeAI } = require("@google/generative-ai");

// --- Configuración de Express ---
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// --- Configuración de Clientes de IA ---
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const geminiModel = genAI.getGenerativeModel({ model: "gemini-1.5-flash-latest" });

// --- Variables Globales ---
let client;
let isWhatsappReady = false;
let crmSocket = null;
const conversationHistory = {};

// --- 2. CONFIGURACIÓN DE LA BASE DE DATOS SQLITE ---
const db = new sqlite3.Database('./whatsapp_chats.db', (err) => {
    if (err) return console.error("❌ Error abriendo DB", err.message);
    console.log("✅ Conectado a SQLite.");
    db.run(`CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id TEXT, sender TEXT, body TEXT, timestamp INTEGER, from_me BOOLEAN)`);
    db.run(`CREATE TABLE IF NOT EXISTS conversations (chat_id TEXT PRIMARY KEY, contact_name TEXT, last_message_timestamp INTEGER, bot_active BOOLEAN NOT NULL DEFAULT 1)`);
    db.run(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)`);
});

// --- 3. FUNCIONES AUXILIARES ---

async function callCrmTool(functionName, args) {
    const endpointMap = {
        'search_vacancies_tool': '/api/bot_tools/vacancies',
        'validate_registration_tool': '/api/bot_tools/validate_registration',
        'get_all_active_vacancies_tool': '/api/bot_tools/all_active_vacancies'
    };
    const endpoint = endpointMap[functionName];
    if (!endpoint) throw new Error(`Herramienta desconocida: ${functionName}`);

    const params = new URLSearchParams(args);
    const url = `${process.env.CRM_API_URL}${endpoint}?${params.toString()}`;
    console.log(`\n--- Llamando Herramienta CRM: ${functionName} ---`);
    const response = await fetch(url, { headers: { 'X-API-Key': process.env.CRM_INTERNAL_API_KEY } });
    if (!response.ok) throw new Error(`Error en API CRM: ${response.statusText}`);
    const responseData = await response.json();
    console.log(`-> Recibidos ${responseData.length} registros de app.py.`);
    return responseData;
}

async function analyzeConversationWithGemini(conversation) {
    if (!process.env.GEMINI_API_KEY) return null;
    const historyForAnalysis = conversation.map(msg => `${msg.from_me ? 'Asesor' : 'Usuario'}: ${msg.body}`).join('\n');
    const prompt = `Analiza la siguiente conversación de una agencia de empleos y responde solo con un objeto JSON con las claves "sentiment", "urgency", "incongruity", y "summary" (máximo 10 palabras).\n\nCONVERSACIÓN:\n---\n${historyForAnalysis}\n---`;
    try {
        const result = await geminiModel.generateContent(prompt);
        const text = result.response.text().replace('```json', '').replace('```', '').trim();
        return JSON.parse(text);
    } catch (error) {
        console.error("❌ Error analizando con Gemini:", error.message);
        return null;
    }
}


// =================================================================
// --- 4. RUTAS DE LA API HTTP (EXPRESS) ---
// =================================================================

// --- Endpoint para el Chatbot de WhatsAuto ---
app.post('/api/whatsauto_reply', async (req, res) => {
    const { sender, message } = req.body;
    if (!sender || !message) return res.status(400).json({ error: "Faltan datos" });
    const chatId = `${sender.replace(/\D/g, '')}@c.us`;

    db.get('SELECT bot_active FROM conversations WHERE chat_id = ?', [chatId], async (err, row) => {
        if (err || (row && row.bot_active === 0)) return res.json({ reply: "" });

        try {
            const settingsRows = await new Promise((resolve, reject) => db.all("SELECT key, value FROM settings", [], (err, rows) => err ? reject(err) : resolve(rows)));
            const settings = settingsRows.reduce((acc, row) => ({ ...acc, [row.key]: row.value }), {});
            settings.model = settings.model || 'gpt-4o-mini';
            settings.personality_prompt = settings.personality_prompt || 'Eres un asistente de Henmir.';

            const masterPromptObject = {
                MISIÓN_Y_PERSONALIDAD: settings.personality_prompt,
                REGLAS_CRITICAS: {
                    RENDERIZADO_URL: "Cualquier texto que empiece con http:// o https:// es una URL y NUNCA debe ser alterado o formateado como un enlace Markdown. Muestra siempre la URL completa.",
                    FIDELIDAD_DATOS: "Al mostrar datos de herramientas (como vacantes), debes presentar la información EXACTAMENTE como la recibes. Tu prompt te dará instrucciones sobre CÓMO presentarla. Sigue esas instrucciones."
                },
            };
            const system_prompt = JSON.stringify(masterPromptObject);

            const history = conversationHistory[chatId] || [];
            const messagesForOpenAI = [{ role: 'system', content: system_prompt }, ...history, { role: 'user', content: message }];

            const tools = [
                { type: "function", function: { name: "search_vacancies_tool", description: "Busca vacantes específicas por ciudad y palabra clave." } },
                { type: "function", function: { name: "validate_registration_tool", description: "Valida el registro de un usuario por su identidad." } },
                { type: "function", function: { name: "get_all_active_vacancies_tool", description: "Obtiene una lista completa de TODOS los cargos de vacantes disponibles. Úsalo como último recurso si una búsqueda específica no da resultados." } }
            ];
            
            console.log(`[${chatId}] Procesando mensaje: "${message}"`);
            const initialResponse = await openai.chat.completions.create({ model: settings.model, messages: messagesForOpenAI, tools: tools, tool_choice: "auto" });
            const responseMessage = initialResponse.choices[0].message;
            const toolCalls = responseMessage.tool_calls;
            let finalReply = "";

            if (toolCalls) {
                messagesForOpenAI.push(responseMessage);
                const toolCall = toolCalls[0];
                const functionName = toolCall.function.name;
                const functionArgs = JSON.parse(toolCall.function.arguments);
                let toolResult = await callCrmTool(functionName, functionArgs);
                
                if (functionName === 'search_vacancies_tool' && (!toolResult || toolResult.length === 0)) {
                    console.log(`[${chatId}] Búsqueda inicial fallida. Activando Plan B.`);
                    const allVacancies = await callCrmTool('get_all_active_vacancies_tool', {});
                    if (allVacancies && allVacancies.length > 0) {
                        const semanticPrompt = `La búsqueda del usuario para '${functionArgs.keyword || 'cualquier vacante'}' no encontró resultados directos. Las vacantes disponibles son: [${allVacancies.join(', ')}]. Sugiere hasta 3 vacantes de esta lista que sean las más similares. Responde directamente al usuario empezando con 'No encontré una vacante exacta para lo que buscas, pero estas opciones podrían interesarte:'.`;
                        messagesForOpenAI.push({ tool_call_id: toolCall.id, role: "tool", name: functionName, content: JSON.stringify(toolResult) });
                        messagesForOpenAI.push({ role: "user", content: semanticPrompt });
                        const semanticResponse = await openai.chat.completions.create({ model: settings.model, messages: messagesForOpenAI });
                        finalReply = semanticResponse.choices[0].message.content;
                    } else {
                         finalReply = "Actualmente no se encontraron vacantes de ningún tipo en el sistema.";
                    }
                } else {
                    messagesForOpenAI.push({ tool_call_id: toolCall.id, role: "tool", name: functionName, content: JSON.stringify(toolResult) });
                    const secondResponse = await openai.chat.completions.create({ model: settings.model, messages: messagesForOpenAI });
                    finalReply = secondResponse.choices[0].message.content;
                }
            } else {
                finalReply = responseMessage.content;
            }
            
            history.push({ role: 'user', content: message }, { role: 'assistant', content: finalReply });
            conversationHistory[chatId] = history.slice(-20);
            res.json({ reply: finalReply });

        } catch (error) {
            console.error(`❌ Error en chatbot para ${chatId}:`, error);
            res.json({ reply: "Lo siento, tengo un problema técnico." });
        }
    });
});

// --- Endpoints para la Interfaz del CRM Manual ---
app.get('/api/crm/chatbot-settings', (req, res) => {
    db.all("SELECT key, value FROM settings", [], (err, rows) => {
        if (err) return res.status(500).json({ error: "Error de base de datos" });
        const settings = rows.reduce((acc, row) => ({...acc, [row.key]: row.value }), {});
        res.json({
            model: settings.model || 'gpt-4o-mini',
            personality_prompt: settings.personality_prompt || 'Eres HenmirBot, un asistente amigable.'
        });
    });
});

app.post('/api/crm/chatbot-settings', (req, res) => {
    const { model, personality_prompt } = req.body;
    if (!model || !personality_prompt) return res.status(400).json({ error: "Faltan datos" });
    const stmt = db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)");
    stmt.run('model', model);
    stmt.run('personality_prompt', personality_prompt);
    stmt.finalize();
    res.json({ message: "Configuración guardada." });
});

app.get('/api/crm/chats', async (req, res) => {
    if (!isWhatsappReady) return res.status(503).json({ error: "WhatsApp no está listo." });
    try {
        const chats = await client.getChats();
        const userChats = chats.filter(c => !c.isGroup).map(c => ({ id: c.id._serialized, name: c.name || c.id.user, timestamp: c.timestamp, lastMessage: c.lastMessage?.body }));
        userChats.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
        res.json(userChats);
    } catch (e) { res.status(500).json({ error: "No se pudieron obtener los chats." }); }
});

app.get('/api/crm/conversations/:chatId', (req, res) => {
    const { chatId } = req.params;
    const responseData = {};
    db.all(`SELECT * FROM messages WHERE chat_id = ? ORDER BY timestamp ASC`, [chatId], (err, messages) => {
        if (err) return res.status(500).json({ error: err.message });
        responseData.messages = messages;
        db.get(`SELECT bot_active FROM conversations WHERE chat_id = ?`, [chatId], (err, conv) => {
            if (err) return res.status(500).json({ error: err.message });
            responseData.bot_active = (conv === undefined) ? true : !!conv.bot_active;
            res.json(responseData);
        });
    });
});

app.post('/api/crm/send-message', async (req, res) => {
    const { chatId, message } = req.body;
    if (!chatId || !message) return res.status(400).json({ error: "Faltan datos." });
    if (!isWhatsappReady) return res.status(503).json({ error: "WhatsApp no está listo." });
    try {
        await client.sendMessage(chatId, message);
        res.json({ success: true, message: "Mensaje enviado." });
    } catch (e) { res.status(500).json({ error: "No se pudo enviar." }); }
});

app.post('/api/crm/chats/:chatId/disable_bot', (req, res) => {
    const { chatId } = req.params;
    db.run(`UPDATE conversations SET bot_active = 0 WHERE chat_id = ?`, [chatId], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        if (this.changes === 0) db.run(`INSERT INTO conversations (chat_id, bot_active) VALUES (?, 0)`, [chatId]);
        res.json({ success: true, message: "Bot desactivado." });
    });
});

app.post('/api/crm/chats/:chatId/enable_bot', (req, res) => {
    const { chatId } = req.params;
    db.run(`UPDATE conversations SET bot_active = 1 WHERE chat_id = ?`, [chatId], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true, message: "Bot reactivado." });
    });
});


// =================================================================
// --- 5. LÓGICA DEL WEBSOCKET (PARA ASISTENTE Y CAMPAÑAS) ---
// =================================================================

const wss = new WebSocketServer({ port: 8080 });
console.log('Servidor WebSocket escuchando en el puerto 8080.');

wss.on('connection', ws => {
    console.log('✅ Interfaz del CRM conectada al WebSocket.');
    crmSocket = ws;
    const initialStatus = isWhatsappReady ? 'Conectado' : 'Esperando a WhatsApp...';
    ws.send(JSON.stringify({ type: 'status', message: initialStatus, error: !isWhatsappReady }));

    ws.on('message', async (message) => {
        try {
            const command = JSON.parse(message.toString());
            if (!isWhatsappReady) {
                ws.send(JSON.stringify({ type: 'log', success: false, message: 'Error: WhatsApp no está listo.' }));
                return;
            }
            if (command.action === 'send_single_message' && command.task) {
                const task = command.task;
                const chatId = `${task.telefono.replace(/\D/g, '')}@c.us`;
                await client.sendMessage(chatId, task.mensaje);
                ws.send(JSON.stringify({ type: 'log', success: true, message: `Éxito: Campaña enviada a ${task.nombre}` }));
            }
        } catch (e) {
            ws.send(JSON.stringify({ type: 'log', success: false, message: `Error: ${e.message}` }));
        }
    });

    ws.on('close', () => {
        console.log('❌ Interfaz del CRM desconectada del WebSocket.');
        crmSocket = null;
    });
});


// =================================================================
// --- 6. INICIALIZACIÓN DEL CLIENTE DE WHATSAPP ---
// =================================================================

function initializeWhatsappClient() {
    console.log('Inicializando cliente de WhatsApp...');
    client = new Client({
        authStrategy: new LocalAuth(),
        puppeteer: { headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] }
    });

    client.on('qr', (qr) => {
        console.log('QR Recibido.');
        if (crmSocket) crmSocket.send(JSON.stringify({ type: 'qr', data: qr }));
    });

    client.on('ready', () => {
        isWhatsappReady = true;
        console.log('✅ Cliente de WhatsApp está listo y conectado.');
        if (crmSocket) crmSocket.send(JSON.stringify({ type: 'status', message: 'Conectado' }));
    });

    client.on('disconnected', (reason) => {
        isWhatsappReady = false;
        console.log('❌ Cliente de WhatsApp desconectado:', reason);
        if (crmSocket) crmSocket.send(JSON.stringify({ type: 'status', message: 'Desconectado', error: true }));
    });
    
    const archiveAndAnalyze = async (msg, fromMe) => {
        const chatId = fromMe ? msg.to : msg.from;
        db.run(`INSERT INTO messages (chat_id, sender, body, timestamp, from_me) VALUES (?, ?, ?, ?, ?)`, [chatId, fromMe ? 'me' : msg.from, msg.body, msg.timestamp, fromMe]);
        db.run(`INSERT OR IGNORE INTO conversations (chat_id, contact_name, last_message_timestamp) VALUES (?, ?, ?)`, [chatId, msg._data.notifyName || chatId.split('@')[0], msg.timestamp]);
        db.run(`UPDATE conversations SET last_message_timestamp = ? WHERE chat_id = ?`, [msg.timestamp, chatId]);

        try {
            const history = await new Promise((resolve, reject) => db.all('SELECT * FROM messages WHERE chat_id = ? ORDER BY timestamp DESC LIMIT 6', [chatId], (err, rows) => err ? reject(err) : resolve(rows.reverse())));
            if (!history || history.length === 0) return;
            const analysis = await analyzeConversationWithGemini(history);
            if (analysis && crmSocket && crmSocket.readyState === WebSocket.OPEN) {
                const notification = { type: 'conversation_analysis', data: { chatId, contactName: msg._data.notifyName || chatId.split('@')[0], ...analysis } };
                crmSocket.send(JSON.stringify(notification));
            }
        } catch (error) {
            console.error(`❌ Error durante el análisis para ${chatId}:`, error);
        }
    };

    client.on('message', (msg) => { archiveAndAnalyze(msg, false); });
    client.on('message_create', (msg) => { if (msg.fromMe) archiveAndAnalyze(msg, true); });
    
    client.initialize();
}

// =================================================================
// --- 7. PUNTO DE ENTRADA PRINCIPAL ---
// =================================================================

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`✅ Servidor Express escuchando en http://localhost:${PORT}`);
    initializeWhatsappClient();
});