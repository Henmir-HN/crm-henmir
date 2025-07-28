// =================================================================
// --- PUENTE Y SERVIDOR DE CHATBOT UNIFICADO PARA CRM HENMIR v2.0 ---
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

const app = express();
app.use(cors());
app.use(express.json());

app.use(express.urlencoded({ extended: true }));

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

let client;
let isWhatsappReady = false;
let crmSocket = null;
const conversationHistory = {};

// --- 2. CONFIGURACIÓN DE LA BASE DE DATOS SQLITE ---
// REEMPLAZA EL CONTENIDO DE LA FUNCIÓN DE CONEXIÓN DE SQLITE EN bridge.js

const db = new sqlite3.Database('./whatsapp_chats.db', (err) => {
    if (err) return console.error("❌ Error abriendo DB", err.message);
    
    console.log("✅ Conectado a SQLite.");
    // Tabla para todos los mensajes
    db.run(`CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id TEXT NOT NULL,
        sender TEXT,
        body TEXT,
        timestamp INTEGER,
        from_me BOOLEAN
    )`);
    // Tabla para gestionar el estado de cada conversación
    db.run(`CREATE TABLE IF NOT EXISTS conversations (
        chat_id TEXT PRIMARY KEY,
        contact_name TEXT,
        last_message_timestamp INTEGER,
        bot_active BOOLEAN NOT NULL DEFAULT 1
    )`);
    // Tabla para la configuración del bot
    db.run(`CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT
    )`);
});

// =================================================================
// --- 4. API PARA LA INTERFAZ DEL CRM (PANEL DE CONTROL Y CHAT) ---
// =================================================================

// GET /api/crm/chatbot-settings
// Devuelve la configuración actual guardada en SQLite para mostrarla en el panel.

// GET /api/crm/chatbot-settings
app.get('/api/crm/chatbot-settings', (req, res) => {
    db.all("SELECT key, value FROM settings", [], (err, rows) => {
        if (err) return res.status(500).json({ error: "Error de base de datos" });
        const settings = rows.reduce((acc, row) => ({...acc, [row.key]: row.value }), {});
        res.json({
            model: settings.model || 'gpt-4o-mini',
            // Ahora devolvemos el 'personality_prompt' en lugar del 'system_prompt' completo
            personality_prompt: settings.personality_prompt || 'Eres HenmirBot, un asistente amigable de la agencia de empleos Henmir. Tu misión es guiar a los usuarios para que se afilien.'
        });
    });
});

// POST /api/crm/chatbot-settings
app.post('/api/crm/chatbot-settings', (req, res) => {
    // Ahora recibimos 'personality_prompt'
    const { model, personality_prompt } = req.body;
    if (!model || !personality_prompt) return res.status(400).json({ error: "Faltan datos" });

    const stmt = db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)");
    try {
        stmt.run('model', model);
        // Guardamos el texto plano del usuario
        stmt.run('personality_prompt', personality_prompt);
        stmt.finalize();
        console.log("✅ Configuración de personalidad del chatbot guardada en SQLite.");
        res.json({ message: "Configuración guardada correctamente." });
    } catch (error) {
        res.status(500).json({ error: "No se pudo guardar la configuración." });
    }
});


// GET /api/crm/chats
// Devuelve una lista de todas las conversaciones desde SQLite.
app.get('/api/crm/chats', async (req, res) => {
    if (!isWhatsappReady) {
        return res.status(503).json({ error: "El cliente de WhatsApp no está listo." });
    }
    try {
        const chats = await client.getChats();
        const userChats = chats
            .filter(chat => !chat.isGroup) // Ignoramos los grupos
            .map(chat => ({
                id: chat.id._serialized,
                name: chat.name || chat.id.user,
                timestamp: chat.timestamp,
                lastMessage: chat.lastMessage ? chat.lastMessage.body : ""
            }));
        
        // Ordenar por el mensaje más reciente
        userChats.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

        res.json(userChats);
    } catch (error) {
        console.error("Error al obtener la lista de chats:", error);
        res.status(500).json({ error: "No se pudieron obtener los chats." });
    }
});

// EN bridge.js, REEMPLAZA EL ENDPOINT GET /api/crm/conversations/:chatId

app.get('/api/crm/conversations/:chatId', (req, res) => {
    const { chatId } = req.params;
    const responseData = {};
    // Primero, obtenemos los mensajes
    db.all(`SELECT * FROM messages WHERE chat_id = ? ORDER BY timestamp ASC`, [chatId], (err, messages) => {
        if (err) return res.status(500).json({ error: err.message });
        responseData.messages = messages;
        // Luego, obtenemos el estado del bot para este chat
        db.get(`SELECT bot_active FROM conversations WHERE chat_id = ?`, [chatId], (err, conversation) => {
            if (err) return res.status(500).json({ error: err.message });
            // Si no hay registro, asumimos que el bot está activo por defecto
            responseData.bot_active = (conversation === undefined) ? true : !!conversation.bot_active;
            res.json(responseData);
        });
    });
});

// POST /api/crm/send-message
// Envía un mensaje manual a un chat específico.
app.post('/api/crm/send-message', async (req, res) => {
    const { chatId, message } = req.body;
    if (!chatId || !message) {
        return res.status(400).json({ error: "Faltan datos 'chatId' o 'message'." });
    }
    if (!isWhatsappReady) {
        return res.status(503).json({ error: "El cliente de WhatsApp no está listo para enviar." });
    }
    try {
        await client.sendMessage(chatId, message);
        console.log(`Mensaje manual enviado a ${chatId}`);
        res.json({ success: true, message: "Mensaje enviado." });
    } catch (error) {
        console.error("Error al enviar mensaje manual:", error);
        res.status(500).json({ error: "No se pudo enviar el mensaje." });
    }
});

// POST /api/crm/chats/:chatId/disable_bot
// Desactiva el bot para una conversación específica.
app.post('/api/crm/chats/:chatId/disable_bot', (req, res) => {
    const { chatId } = req.params;
    const query = `UPDATE conversations SET bot_active = 0 WHERE chat_id = ?`;
    db.run(query, [chatId], function(err) {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        // Creamos el registro si no existía
        if (this.changes === 0) {
            db.run(`INSERT INTO conversations (chat_id, bot_active) VALUES (?, 0)`, [chatId]);
        }
        console.log(`Bot desactivado manualmente para ${chatId}`);
        res.json({ success: true, message: "Bot desactivado para este chat." });
    });
});


// Reactiva el bot para una conversación específica.
app.post('/api/crm/chats/:chatId/enable_bot', (req, res) => {
    const { chatId } = req.params;
    // Simplemente ponemos la bandera bot_active de nuevo en 1 (true)
    const query = `UPDATE conversations SET bot_active = 1 WHERE chat_id = ?`;
    db.run(query, [chatId], function(err) {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        console.log(`Bot reactivado manualmente para ${chatId}`);
        res.json({ success: true, message: "Bot reactivado para este chat." });
    });
});



// --- 3. LÓGICA DEL CHATBOT DE WHATSAUTO ---


async function callCrmTool(functionName, args) {
    // ✨ AQUÍ ESTÁ EL CAMBIO: Rellenamos el mapa de traducción.
    const endpointMap = {
        'search_vacancies_tool': '/api/bot_tools/vacancies',
        'validate_registration_tool': '/api/bot_tools/validate_registration'
    };
    const endpoint = endpointMap[functionName];

    // Esta línea ahora funcionará correctamente.
    if (!endpoint) {
        throw new Error(`Herramienta desconocida: ${functionName}`);
    }
    
    const params = new URLSearchParams(args);
    const url = `${process.env.CRM_API_URL}${endpoint}?${params.toString()}`;

    console.log(`\n--- LLAMANDO HERRAMIENTA CRM ---`);
    console.log(`URL: ${url}`);
    
    const response = await fetch(url, { headers: { 'X-API-Key': process.env.CRM_INTERNAL_API_KEY } });
    
    if (!response.ok) {
        const errorBody = await response.text();
        console.error(`Error en la API del CRM (${response.status}): ${errorBody}`);
        throw new Error(`Error en API CRM: ${response.statusText}`);
    }
    
    const responseData = await response.json();
    console.log(`Datos recibidos de app.py: Se recibieron ${responseData.length} registros.`);
    console.log(`Primer registro recibido:`, responseData[0] || 'Ninguno');
    console.log(`--- FIN LLAMADA HERRAMIENTA ---\n`);
    
    return responseData;
}



app.post('/api/whatsauto_reply', async (req, res) => {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body;
    const sender = body.sender || req.query.sender;
    const message = body.message || req.query.message;
    if (!sender || !message) {
        return res.status(400).json({ error: "Faltan datos sender/message" });
    }

    const chatId = `${sender.replace(/\D/g, '')}@c.us`;

    db.get('SELECT bot_active FROM conversations WHERE chat_id = ?', [chatId], async (err, row) => {
        if (err || (row && row.bot_active === 0)) {
            return res.json({ reply: "" });
        }

        try {
            const settingsRows = await new Promise((resolve, reject) => {
                db.all("SELECT key, value FROM settings", [], (err, rows) => err ? reject(err) : resolve(rows));
            });
            const settings = settingsRows.reduce((acc, row) => ({ ...acc, [row.key]: row.value }), {});
            settings.model = settings.model || 'gpt-4o-mini';
            settings.personality_prompt = settings.personality_prompt || 'Eres un asistente de Henmir.';

            const masterPromptObject = {
                REGLAS_CRITICAS: {
                    RENDERIZADO_URL: "Cualquier texto que empiece con http:// o https:// es una URL y NUNCA debe ser alterado o formateado como un enlace Markdown. Muestra siempre la URL completa.",
                    FIDELIDAD_DATOS: "Al mostrar datos de herramientas (como vacantes), debes presentar la información EXACTAMENTE como la recibes. NO inventes, resumas o alteres los datos."
                },
                MISIÓN_Y_PERSONALIDAD: settings.personality_prompt,
                REGLAS_DE_FORMATO: "Usa negritas (**) para resaltar y listas con viñetas (-, *) para enumerar elementos. Separa párrafos para facilitar la lectura."
            };
            const system_prompt = JSON.stringify(masterPromptObject);

            const history = conversationHistory[chatId] || [];
            const messagesForOpenAI = [
                { role: 'system', content: system_prompt },
                ...history,
                { role: 'user', content: message }
            ];

            const tools = [
                { type: "function", function: { name: "search_vacancies_tool", description: "Busca vacantes de empleo disponibles en el CRM.", parameters: { type: "object", properties: { city: { type: "string" }, keyword: { type: "string" } } } } },
                { type: "function", function: { name: "validate_registration_tool", description: "Verifica en el CRM si un candidato se ha registrado recientemente usando su número de identidad.", parameters: { type: "object", properties: { identity: { type: "string" } }, required: ["identity"] } } }
            ];
            
            console.log(`[${chatId}] Procesando mensaje: "${message}"`);
            const initialResponse = await openai.chat.completions.create({
                model: settings.model,
                messages: messagesForOpenAI,
                tools: tools,
                tool_choice: "auto",
            });

            const responseMessage = initialResponse.choices[0].message;
            const toolCalls = responseMessage.tool_calls;
            let finalReply = "";

            if (toolCalls) {
                console.log(`[${chatId}] IA solicita usar herramienta(s): ${toolCalls.map(tc => tc.function.name).join(', ')}`);
                messagesForOpenAI.push(responseMessage);

                // ✨ INICIO DEL BUCLE CORREGIDO ✨
                for (const toolCall of toolCalls) {
                    const functionName = toolCall.function.name;
                    const functionArgs = JSON.parse(toolCall.function.arguments);
                    
                    const functionResponse = await callCrmTool(functionName, functionArgs);
                    
                    // --- LOG DE DEPURACIÓN AÑADIDO ---
                    console.log(`\n--- ENVIANDO A IA PARA RESPUESTA FINAL ---`);
                    console.log(`Resultado de la herramienta '${functionName}' que se enviará a OpenAI:`);
                    console.log(JSON.stringify(functionResponse, null, 2));
                    console.log(`--- FIN DE DATOS PARA IA ---\n`);
                    // --- FIN DEL LOG DE DEPURACIÓN ---

                    messagesForOpenAI.push({
                        tool_call_id: toolCall.id,
                        role: "tool",
                        name: functionName,
                        content: JSON.stringify(functionResponse),
                    });
                } // ✨ CIERRE CORRECTO DEL BUCLE 'for' ✨
                
                console.log(`[${chatId}] Enviando resultados de herramientas a IA para respuesta final.`);
                const secondResponse = await openai.chat.completions.create({
                    model: settings.model,
                    messages: messagesForOpenAI,
                });
                finalReply = secondResponse.choices[0].message.content;

            } else {
                finalReply = responseMessage.content;
            }
            
            console.log(`[${chatId}] Respuesta final: "${finalReply.substring(0, 60)}..."`);
            history.push({ role: 'user', content: message }, { role: 'assistant', content: finalReply });
            conversationHistory[chatId] = history.slice(-20);

            res.json({ reply: finalReply });

        } catch (error) {
            console.error(`❌ Error en el flujo del chatbot para ${chatId}:`, error);
            res.json({ reply: "Lo siento, estoy teniendo un problema técnico." });
        }
    }); // ✨ CIERRE CORRECTO DEL 'db.get' ✨
}); // ✨ CIERRE CORRECTO DEL 'app.post' ✨```


// --- 4. LÓGICA DEL PUENTE PARA CRM MANUAL Y ASISTENTE (TU CÓDIGO ORIGINAL MEJORADO) ---

const wss = new WebSocketServer({ port: 8080 });
console.log('Servidor WebSocket (para Asistente y Campañas) escuchando en el puerto 8080.');

wss.on('connection', ws => {
    console.log('✅ Interfaz del CRM conectada al puente WebSocket.');
    crmSocket = ws;
    const initialStatus = isWhatsappReady ? 'Conectado' : 'Esperando a WhatsApp...';
    crmSocket.send(JSON.stringify({ type: 'status', message: initialStatus, error: !isWhatsappReady }));

    ws.on('message', async (message) => {
        try {
            const command = JSON.parse(message.toString());
            console.log('Recibida orden desde el CRM (WebSocket):', command.action);

            if (!isWhatsappReady) {
                ws.send(JSON.stringify({ type: 'log', success: false, message: 'Error: WhatsApp no está listo.' }));
                return;
            }

            if (command.action === 'send_single_message' && command.task) {
                // Tu lógica existente para enviar campañas desde el asistente
                const task = command.task;
                const chatId = `${task.telefono.replace(/\D/g, '')}@c.us`;
                
                // Aquí podrías reutilizar la lógica de validación de número si quisieras
                await client.sendMessage(chatId, task.mensaje);
                ws.send(JSON.stringify({ type: 'log', success: true, message: `Éxito: Mensaje de campaña enviado a ${task.nombre}` }));
            }
        } catch (e) {
            console.error("Error procesando mensaje del CRM (WebSocket):", e);
            ws.send(JSON.stringify({ type: 'log', success: false, message: `Error: ${e.message}` }));
        }
    });

    ws.on('close', () => {
        console.log('❌ Interfaz del CRM desconectada del WebSocket.');
        crmSocket = null;
    });
});


// --- 5. INICIALIZACIÓN DEL CLIENTE DE WHATSAPP Y SERVIDOR ---

function initializeWhatsappClient() {
    console.log('Inicializando cliente de WhatsApp...');
    client = new Client({
        authStrategy: new LocalAuth(),
        puppeteer: { headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] }
    });

    client.on('qr', (qr) => {
        console.log('QR Recibido. Si el CRM está conectado, se enviará.');
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
    
    // ARCHIVADO AUTOMÁTICO EN SQLITE
    const archiveMessage = (msg, fromMe) => {
        const chatId = fromMe ? msg.to : msg.from;
        const sender = fromMe ? 'me' : msg.from;
        db.run(`INSERT INTO messages (chat_id, sender, body, timestamp, from_me) VALUES (?, ?, ?, ?, ?)`,
               [chatId, sender, msg.body, msg.timestamp, fromMe]);
        
        db.run(`INSERT OR IGNORE INTO conversations (chat_id, last_message_timestamp) VALUES (?, ?)`, [chatId, msg.timestamp]);
        db.run(`UPDATE conversations SET last_message_timestamp = ? WHERE chat_id = ?`, [msg.timestamp, chatId]);
    };

    client.on('message', msg => archiveMessage(msg, false));
    client.on('message_create', msg => { if (msg.fromMe) archiveMessage(msg, true) });
    
    client.initialize();
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`✅ Servidor Express (para WhatsAuto y CRM Chat) escuchando en http://localhost:${PORT}`);
    initializeWhatsappClient();
});
