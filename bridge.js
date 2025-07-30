// =================================================================
// --- PUENTE Y SERVIDOR DE CHATBOT UNIFICADO PARA CRM HENMIR v3.4 FINAL ---
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
const chatContext = {}; // ✨ NUEVA LÍNEA: Nuestra memoria activa para los chats


// =================================================================
// CONFIGURACIÓN DE DB
// =================================================================
const db = new sqlite3.Database('./whatsapp_chats.db', (err) => {
    if (err) return console.error("❌ Error abriendo DB", err.message);
    console.log("✅ Conectado a SQLite.");

    // Función de migración segura para añadir columnas si no existen
    const runMigrations = () => {
        db.all("PRAGMA table_info(conversations)", (err, columns) => {
            if (err) return console.error("❌ Error al verificar la estructura de la tabla 'conversations':", err.message);

            const columnNames = columns.map(c => c.name);
            
            if (!columnNames.includes('known_identity')) {
                console.log("⏳ MIGRACIÓN: Añadiendo columna 'known_identity'...");
                db.run("ALTER TABLE conversations ADD COLUMN known_identity TEXT", (alterErr) => {
                    if (alterErr) console.error("❌ FALLO MIGRACIÓN 'known_identity':", alterErr.message);
                    else console.log("✅ Columna 'known_identity' añadida.");
                });
            }

            if (!columnNames.includes('status')) {
                console.log("⏳ MIGRACIÓN: Añadiendo columna 'status' con valor por defecto...");
                db.run("ALTER TABLE conversations ADD COLUMN status TEXT NOT NULL DEFAULT 'new_visitor'", (alterErr) => {
                    if (alterErr) console.error("❌ FALLO MIGRACIÓN 'status':", alterErr.message);
                    else console.log("✅ Columna 'status' añadida.");
                });
            } else {
                 console.log("➡️ La estructura de la base de datos ya está actualizada.");
            }
        });
    };

    db.serialize(() => {
        db.run(`CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id TEXT, sender TEXT, body TEXT, timestamp INTEGER, from_me BOOLEAN)`);
        db.run(`CREATE TABLE IF NOT EXISTS conversations (chat_id TEXT PRIMARY KEY, contact_name TEXT, last_message_timestamp INTEGER, bot_active BOOLEAN NOT NULL DEFAULT 1)`);
        db.run(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)`);
        db.run(`CREATE TABLE IF NOT EXISTS chat_tags (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, color TEXT DEFAULT '#808080')`);
        db.run(`CREATE TABLE IF NOT EXISTS conversation_tags (chat_id TEXT NOT NULL, tag_id INTEGER NOT NULL, PRIMARY KEY (chat_id, tag_id), FOREIGN KEY(tag_id) REFERENCES chat_tags(id) ON DELETE CASCADE)`);
        
        // ✨ NUEVA TABLA PARA NOTIFICACIONES PERSISTENTES
        db.run(`CREATE TABLE IF NOT EXISTS notifications (id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id TEXT NOT NULL, contact_name TEXT, type TEXT NOT NULL, summary TEXT NOT NULL, timestamp INTEGER NOT NULL, is_read INTEGER NOT NULL DEFAULT 0)`);

        runMigrations();
    });
});

// --- 3. FUNCIONES AUXILIARES ---
// =================================================================
async function callCrmTool(functionName, args) {
    // endpointMap actualizado con la nueva herramienta
    const endpointMap = {
        'search_vacancies_tool': '/api/bot_tools/vacancies',
        'validate_registration_tool': '/api/bot_tools/validate_registration',
        'get_all_active_vacancies_tool': '/api/bot_tools/all_active_vacancies',
        'get_vacancy_details_tool': '/api/bot_tools/vacancy_details',
        'get_candidate_status_tool': '/api/bot_tools/candidate_status' // <<< NUEVA LÍNEA
    };
    const endpoint = endpointMap[functionName];
    if (!endpoint) throw new Error(`Herramienta desconocida: ${functionName}`);

    const params = new URLSearchParams(args);
    const url = `${process.env.CRM_API_URL}${endpoint}?${params.toString()}`;
    
    try {
        const response = await fetch(url, { headers: { 'X-API-Key': process.env.CRM_INTERNAL_API_KEY } });

        if (!response.ok) {
            const errorBody = await response.text();
            console.error(`Error en la API del CRM (${response.status}): ${errorBody}`);
            throw new Error(`Error en API CRM: ${response.statusText}`);
        }
        
        const responseText = await response.text();
        const responseData = responseText ? JSON.parse(responseText) : null;

        // Ajuste para contar registros de forma genérica
        let recordCount = 0;
        if (responseData) {
             if (Array.isArray(responseData)) {
                recordCount = responseData.length;
             } else if (responseData.applications && Array.isArray(responseData.applications)) {
                recordCount = responseData.applications.length;
             } else {
                recordCount = 1;
             }
        }
        
        console.log(`\n--- Llamando Herramienta CRM: ${functionName} ---`);
        console.log(`URL: ${url}`);
        console.log(`-> Recibidos ${recordCount} registros de app.py.`);
        console.log(`--- FIN LLAMADA HERRAMIENTA ---\n`);
        
        return responseData;

    } catch (error) {
        console.error(`❌ FALLO DE CONEXIÓN con la herramienta CRM '${functionName}':`, error.message);
        return { 
            error: `La herramienta ${functionName} falló al intentar contactar el servidor. Razón: ${error.message}` 
        };
    }
}

async function analyzeConversationWithGemini(conversation) {
    if (!process.env.GEMINI_API_KEY) {
        console.warn("Advertencia: GEMINI_API_KEY no configurada. Se saltará el análisis.");
        return null;
    }
    
    const historyForAnalysis = conversation.map(msg => `${msg.from_me ? 'Asesor' : 'Usuario'}: ${msg.body}`).join('\n');
    
    const prompt = `
        Analiza la siguiente conversación de una agencia de empleos.
        Responde ÚNICA Y EXCLUSIVAMENTE con un objeto JSON válido que empiece con '{' y termine con '}'. No incluyas texto, notas o marcadores de código antes o después del JSON.
        
        El objeto JSON debe tener estas claves:
        1. "sentiment": "positivo", "negativo" o "neutro".
        2. "urgency": "alta", "media" o "baja".
        3. "incongruity": true o false.
        4. "summary": un resumen de máximo 10 palabras.

        CONVERSACIÓN:
        ---
        ${historyForAnalysis}
        ---
    `;

    try {
        console.log(`\n--- INICIANDO ANÁLISIS CON GEMINI ---`);
        console.log(`Enviando ${conversation.length} mensajes para análisis...`);
        
        const result = await geminiModel.generateContent(prompt);
        const response = await result.response;
        let text = response.text();

        const firstBracket = text.indexOf('{');
        const lastBracket = text.lastIndexOf('}');

        if (firstBracket === -1 || lastBracket === -1 || lastBracket < firstBracket) {
            throw new Error("La respuesta de Gemini no contenía un JSON válido.");
        }

        const jsonString = text.substring(firstBracket, lastBracket + 1);
        const jsonResponse = JSON.parse(jsonString);

        console.log(`Análisis de Gemini recibido:`);
        console.log(jsonResponse);
        console.log(`--- FIN DEL ANÁLISIS CON GEMINI ---\n`);

        return jsonResponse;

    } catch (error) {
        console.error("❌ Error analizando con Gemini:", error.message);
        return null;
    }
}


// =================================================================
// --- 4. RUTAS DE LA API HTTP (EXPRESS) ---
// =================================================================
// =================================================================
// REEMPLAZAR FUNCIÓN COMPLETA (VERSIÓN FINAL CON ESTADO PERSISTENTE)
// =================================================================
app.post('/api/whatsauto_reply', async (req, res) => {
    const { sender, message } = req.body;
    if (!sender || !message) return res.status(400).json({ error: "Faltan datos" });

    const imagePlaceholders = ['📷', 'Fotografía', 'image/'];
    if (imagePlaceholders.some(p => message.includes(p))) {
        return res.json({ reply: "" });
    }

    const chatId = `${sender.replace(/\D/g, '')}@c.us`;

    try {
        // --- PASO 1: OBTENER EL CONTEXTO COMPLETO DE LA DB ---
        const conversationContext = await new Promise((resolve, reject) => {
            db.get('SELECT bot_active, known_identity, status FROM conversations WHERE chat_id = ?', [chatId], (err, row) => err ? reject(err) : resolve(row || {}));
        });

        if (conversationContext.bot_active === 0 || conversationContext.status === 'needs_human_intervention') {
            console.log(`[${chatId}] Bot inactivo o requiere humano. No se procesará respuesta automática.`);
            return res.json({ reply: "" });
        }

        const settingsRows = await new Promise((resolve, reject) => db.all("SELECT key, value FROM settings", [], (err, rows) => err ? reject(err) : resolve(rows)));
        const settings = settingsRows.reduce((acc, row) => ({ ...acc, [row.key]: row.value }), {});
        
        // --- PASO 2: SELECCIÓN DINÁMICA DEL PROMPT BASADO EN EL ESTADO ---
        let system_prompt;
        const user_status = conversationContext.status || 'new_visitor';
        const known_identity = conversationContext.known_identity;

        if (user_status === 'identified_affiliate' && known_identity) {
            console.log(`[${chatId}] Usuario reconocido con ID: ${known_identity}. Usando prompt para afiliados.`);
            let promptForAffiliates = settings.prompt_affiliates || "Eres un asistente para usuarios registrados.";
            const contextInjection = JSON.stringify({
                "CONTEXTO_ACTUAL_OBLIGATORIO": `El usuario de esta conversación YA HA SIDO IDENTIFICADO con el número de identidad: ${known_identity}. DEBES usar este número para cualquier herramienta que lo requiera. NO vuelvas a preguntar por su identidad.`
            });
            system_prompt = `${promptForAffiliates}\n\n${contextInjection}`;
        } else {
            console.log(`[${chatId}] Usuario es '${user_status}'. Usando prompt para nuevos usuarios.`);
            system_prompt = settings.prompt_new_users || "Eres un asistente para nuevos usuarios.";
        }
        
        const historyFromDb = await new Promise((resolve, reject) => {
            db.all("SELECT from_me, body FROM messages WHERE chat_id = ? ORDER BY timestamp DESC LIMIT 20", [chatId], (err, rows) => {
                if (err) return reject(err);
                resolve(rows.reverse());
            });
        });

        const formattedHistory = historyFromDb.map(msg => ({ role: msg.from_me ? 'assistant' : 'user', content: msg.body }));
        const messagesForOpenAI = [{ role: 'system', content: system_prompt }, ...formattedHistory, { role: 'user', content: message }];

        const tools = [
            { type: "function", function: { name: "search_vacancies_tool", description: "Busca vacantes disponibles.", parameters: { type: "object", properties: { city: { type: "string" }, keyword: { type: "string" } }, required: ["city"] } } },
            { type: "function", function: { name: "validate_registration_tool", description: "Valida el registro de un nuevo usuario.", parameters: { type: "object", properties: { identity: { type: "string" } }, required: ["identity"] } } },
            { type: "function", function: { name: "get_all_active_vacancies_tool", description: "Obtiene todos los cargos de vacantes disponibles." } },
            { type: "function", function: { name: "get_vacancy_details_tool", description: "Obtiene los requisitos de una vacante.", parameters: { type: "object", properties: { cargo_solicitado: { type: "string" } }, required: ["cargo_solicitado"] } } },
            { type: "function", function: { name: "get_candidate_status_tool", description: "Consulta el estado de las postulaciones de un candidato.", parameters: { type: "object", properties: { identity_number: { type: "string" } }, required: ["identity_number"] } } }
        ];
        
        const initialResponse = await openai.chat.completions.create({ model: settings.model || 'gpt-4o-mini', messages: messagesForOpenAI, tools: tools, tool_choice: "auto" });
        const responseMessage = initialResponse.choices[0].message;
        const toolCalls = responseMessage.tool_calls;
        let finalReply = "";

        if (toolCalls) {
            messagesForOpenAI.push(responseMessage);
            for (const toolCall of toolCalls) {
                const functionName = toolCall.function.name;
                const functionArgs = JSON.parse(toolCall.function.arguments);
                console.log(`[${chatId}] Argumentos generados por IA para '${functionName}':`, functionArgs);
                let toolResult = await callCrmTool(functionName, functionArgs);
                
                // --- PASO 3: GUARDAR LA IDENTIDAD Y ACTUALIZAR EL ESTADO EN LA DB ---
                if ((functionName === 'get_candidate_status_tool' || functionName === 'validate_registration_tool') && (toolResult.status !== 'not_registered' && !toolResult.error)) {
                    const identityToSave = functionArgs.identity_number || functionArgs.identity;
                    if (identityToSave) {
                        const newStatus = 'identified_affiliate';
                        db.run('UPDATE conversations SET known_identity = ?, status = ? WHERE chat_id = ?', [identityToSave, newStatus, chatId], (err) => {
                            if (err) console.error(`[${chatId}] Error al guardar identidad/estado en DB:`, err);
                            else console.log(`[${chatId}] Identidad ${identityToSave} y estado ${newStatus} guardados permanentemente.`);
                        });
                    }
                }
                
                messagesForOpenAI.push({ tool_call_id: toolCall.id, role: "tool", name: functionName, content: JSON.stringify(toolResult) });
            }
            const secondResponse = await openai.chat.completions.create({ model: settings.model || 'gpt-4o-mini', messages: messagesForOpenAI });
            finalReply = secondResponse.choices[0].message.content;
        } else {
            finalReply = responseMessage.content;
        }
        
        if (finalReply) {
            const responseTime = Math.floor(Date.now() / 1000);
            await new Promise((resolve, reject) => db.run(`INSERT INTO messages (chat_id, sender, body, timestamp, from_me) VALUES (?, ?, ?, ?, ?)`,[chatId, 'me', finalReply, responseTime, true], err => err ? reject(err) : resolve()));
            await new Promise((resolve, reject) => db.run(`UPDATE conversations SET last_message_timestamp = ? WHERE chat_id = ?`, [responseTime, chatId], err => err ? reject(err) : resolve()));
        }
        
        return res.json({ reply: finalReply });

    } catch (error) {
        console.error(`❌ Error en chatbot para ${chatId}:`, error);
        return res.json({ reply: "Lo siento, tengo un problema técnico en este momento." });
    }
});

app.get('/api/crm/chatbot-settings', (req, res) => {
    db.all("SELECT key, value FROM settings", [], (err, rows) => {
        if (err) return res.status(500).json({ error: "Error de base de datos" });
        const settings = rows.reduce((acc, row) => ({...acc, [row.key]: row.value }), {});
        res.json({ model: settings.model || 'gpt-4o-mini', personality_prompt: settings.personality_prompt || 'Eres HenmirBot, un asistente amigable.' });
    });
});


app.post('/api/crm/chatbot-settings', (req, res) => {
    // ✨ Ahora aceptamos las tres claves
    const { model, prompt_new_users, prompt_affiliates } = req.body;
    if (!model || !prompt_new_users || !prompt_affiliates) return res.status(400).json({ error: "Faltan datos" });
    
    db.serialize(() => {
        const stmt = db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)");
        stmt.run('model', model);
        stmt.run('prompt_new_users', prompt_new_users);
        stmt.run('prompt_affiliates', prompt_affiliates);
        stmt.finalize((err) => {
            if (err) return res.status(500).json({ error: "No se pudo guardar." });
            res.json({ message: "Configuración guardada." });
        });
    });
});

// =================================================================
// =================================================================
app.get('/api/crm/chats', async (req, res) => {
    // ✨ NUEVA CONSULTA CON JOIN PARA TRAER LAS ETIQUETAS
    const query = `
        SELECT 
            c.chat_id as id, 
            c.contact_name as name, 
            c.last_message_timestamp as timestamp, 
            (SELECT body FROM messages WHERE chat_id = c.chat_id ORDER BY timestamp DESC LIMIT 1) as lastMessage,
            (SELECT GROUP_CONCAT(json_object('id', T.id, 'name', T.name, 'color', T.color)) 
             FROM chat_tags T
             JOIN conversation_tags CT ON T.id = CT.tag_id
             WHERE CT.chat_id = c.chat_id) as tags
        FROM conversations c 
        WHERE c.last_message_timestamp IS NOT NULL 
        ORDER BY c.last_message_timestamp DESC 
        LIMIT 200;
    `;
    
    db.all(query, [], (err, rows) => {
        if (err) {
            console.error("Error al obtener chats con etiquetas:", err);
            return res.status(500).json([]);
        }
        
        // El resultado de GROUP_CONCAT es un string, necesitamos convertirlo a un array de objetos JSON.
        const finalRows = rows.map(row => {
            return {
                ...row,
                lastMessage: row.lastMessage ? row.lastMessage.slice(0, 50) : '[Mensaje multimedia o vacío]',
                tags: row.tags ? JSON.parse(`[${row.tags}]`) : [] // Convertir el string a un array de JSON
            };
        });
        
        res.json(finalRows);
    });
});

// =================================================================
app.get('/api/crm/conversations/:chatId', (req, res) => {
    const { chatId } = req.params;
    const responseData = {};

    const messagesQuery = `SELECT * FROM messages WHERE chat_id = ? ORDER BY timestamp ASC`;
    const conversationQuery = `SELECT bot_active FROM conversations WHERE chat_id = ?`;
    // ✨ NUEVA CONSULTA para obtener las etiquetas de esta conversación específica
    const tagsQuery = `
        SELECT T.id, T.name, T.color 
        FROM chat_tags T
        JOIN conversation_tags CT ON T.id = CT.tag_id
        WHERE CT.chat_id = ?
    `;

    db.all(messagesQuery, [chatId], (err, messages) => {
        if (err) return res.status(500).json({ error: err.message });
        responseData.messages = messages;

        db.get(conversationQuery, [chatId], (err, conv) => {
            if (err) return res.status(500).json({ error: err.message });
            responseData.bot_active = (conv === undefined) ? true : !!conv.bot_active;

            // ✨ OBTENEMOS Y AÑADIMOS LAS ETIQUETAS
            db.all(tagsQuery, [chatId], (err, tags) => {
                if (err) return res.status(500).json({ error: err.message });
                responseData.tags = tags || [];
                res.json(responseData);
            });
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
// INSERTAR NUEVO BLOQUE DE ENDPOINTS
// =================================================================

// --- ENDPOINTS PARA GESTIONAR LAS ETIQUETAS DE CHAT (CRUD) ---

// Obtener todas las etiquetas disponibles
app.get('/api/crm/chattags', (req, res) => {
    db.all("SELECT * FROM chat_tags ORDER BY name ASC", [], (err, rows) => {
        if (err) return res.status(500).json({ error: "Error de base de datos" });
        res.json(rows);
    });
});

// Crear una nueva etiqueta
app.post('/api/crm/chattags', (req, res) => {
    const { name, color } = req.body;
    if (!name) return res.status(400).json({ error: "El nombre es requerido" });
    db.run("INSERT INTO chat_tags (name, color) VALUES (?, ?)", [name, color || '#808080'], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.status(201).json({ id: this.lastID, name, color });
    });
});

// Asignar una etiqueta a un chat
app.post('/api/crm/chats/:chatId/tags', (req, res) => {
    const { chatId } = req.params;
    const { tag_id } = req.body;
    if (!tag_id) return res.status(400).json({ error: "Se requiere tag_id" });

    db.run("INSERT INTO conversation_tags (chat_id, tag_id) VALUES (?, ?)", [chatId, tag_id], (err) => {
        if (err) {
            // Ignoramos el error si la etiqueta ya estaba asignada (PRIMARY KEY constraint)
            if (err.message.includes('UNIQUE constraint failed')) {
                return res.json({ success: true, message: "La etiqueta ya estaba asignada." });
            }
            return res.status(500).json({ error: err.message });
        }
        res.status(201).json({ success: true, message: "Etiqueta asignada." });
    });
});

// Remover una etiqueta de un chat
app.delete('/api/crm/chats/:chatId/tags/:tagId', (req, res) => {
    const { chatId, tagId } = req.params;
    db.run("DELETE FROM conversation_tags WHERE chat_id = ? AND tag_id = ?", [chatId, tagId], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        if (this.changes === 0) return res.status(404).json({ error: "Asignación de etiqueta no encontrada." });
        res.json({ success: true, message: "Etiqueta removida." });
    });
});


// =================================================================
app.get('/api/crm/notifications', (req, res) => {
    const query = "SELECT * FROM notifications WHERE is_read = 0 ORDER BY timestamp DESC";
    db.all(query, [], (err, rows) => {
        if (err) return res.status(500).json({ error: "Error de base de datos" });
        res.json(rows);
    });
});

app.post('/api/crm/notifications/:id/mark-read', (req, res) => {
    const { id } = req.params;
    const query = "UPDATE notifications SET is_read = 1 WHERE id = ?";
    db.run(query, [id], function(err) {
        if (err) return res.status(500).json({ error: "Error de base de datos" });
        if (this.changes === 0) return res.status(404).json({ error: "Notificación no encontrada." });
        res.json({ success: true, message: "Notificación marcada como leída." });
    });
});





// =================================================================
// --- 5. LÓGICA DEL WEBSOCKET (PARA ASISTENTE Y CAMPAÑAS) ---
// =================================================================

function setupWebSocketServer() {
    const wss = new WebSocketServer({ port: 8080 });
    console.log('✅ Servidor WebSocket escuchando en el puerto 8080.');

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
}

// =================================================================
// --- 6. INICIALIZACIÓN DEL CLIENTE DE WHATSAPP ---
// =================================================================

function initializeWhatsappClient() {
    console.log('⏳ Inicializando cliente de WhatsApp... (esto puede tardar la primera vez)');
    client = new Client({
        authStrategy: new LocalAuth(),
        puppeteer: { headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] }
    });

    client.on('qr', (qr) => {
        console.log('QR Recibido.');
        if (crmSocket) crmSocket.send(JSON.stringify({ type: 'qr', data: qr }));
    });

    client.on('ready', async () => {
        isWhatsappReady = true;
        console.log('✅ Cliente de WhatsApp está listo y conectado.');
        if (crmSocket) crmSocket.send(JSON.stringify({ type: 'status', message: 'Conectado' }));

        console.log('⏳ Sincronizando lista de chats inicial...');
        try {
            const chats = await client.getChats();
            const userChats = chats.filter(chat => !chat.isGroup && chat.id.user);

            db.serialize(() => {
                const stmt = db.prepare(`
                    INSERT INTO conversations (chat_id, contact_name, last_message_timestamp) 
                    VALUES (?, ?, ?)
                    ON CONFLICT(chat_id) DO UPDATE SET
                        contact_name = excluded.contact_name,
                        last_message_timestamp = MAX(last_message_timestamp, excluded.last_message_timestamp)
                `);
                
                for (const chat of userChats) {
                    stmt.run(chat.id._serialized, chat.name || chat.id.user, chat.timestamp || 0);
                }
                
                stmt.finalize((err) => {
                    if (err) {
                        console.error("❌ Error al finalizar sincronización de chats:", err.message);
                    } else {
                        console.log(`✅ Sincronización completada. ${userChats.length} chats procesados.`);
                        if (crmSocket) crmSocket.send(JSON.stringify({ type: 'chats_synced' }));
                    }
                });
            });
        } catch (error) {
            console.error("❌ Error durante la sincronización inicial de chats:", error);
        }
    });

    client.on('disconnected', (reason) => {
        isWhatsappReady = false;
        console.log('❌ Cliente de WhatsApp desconectado:', reason);
        if (crmSocket) crmSocket.send(JSON.stringify({ type: 'status', message: 'Desconectado', error: true }));
    });
    
    const inactivityTimers = {};

    // =================================================================
// REEMPLAZAR FUNCIÓN COMPLETA
// =================================================================
    // =================================================================
// REEMPLAZAR FUNCIÓN COMPLETA
// =================================================================
    const archiveAndAnalyze = async (msg, fromMe) => {
        const chatId = fromMe ? msg.to : msg.from;
        const contactName = msg._data.notifyName || chatId.split('@')[0];
        const messageBody = msg.body;

        if (messageBody) {
             db.run(`INSERT INTO messages (chat_id, sender, body, timestamp, from_me) VALUES (?, ?, ?, ?, ?)`,
                   [chatId, fromMe ? 'me' : msg.from, messageBody, msg.timestamp, fromMe]);
        }
       
        db.run(`
            INSERT INTO conversations (chat_id, contact_name, last_message_timestamp) VALUES (?, ?, ?) 
            ON CONFLICT(chat_id) DO UPDATE SET 
                contact_name = excluded.contact_name, 
                last_message_timestamp = excluded.last_message_timestamp
        `, [chatId, contactName, msg.timestamp]);

        if (crmSocket && crmSocket.readyState === WebSocket.OPEN) {
            crmSocket.send(JSON.stringify({
                type: 'new_message',
                data: {
                    chatId: chatId, contactName: contactName, lastMessage: msg.body || '[Mensaje Multimedia]', timestamp: msg.timestamp,
                    messageObject: { chat_id: chatId, sender: fromMe ? 'me' : 'user', body: messageBody, timestamp: msg.timestamp, from_me: fromMe }
                }
            }));
        }

        if (inactivityTimers[chatId]) clearTimeout(inactivityTimers[chatId]);

        inactivityTimers[chatId] = setTimeout(async () => {
            console.log(`[${chatId}] Inactividad detectada. Analizando conversación final.`);
            try {
                const history = await new Promise((resolve, reject) => db.all('SELECT * FROM messages WHERE chat_id = ? ORDER BY timestamp DESC LIMIT 20', [chatId], (err, rows) => err ? reject(err) : resolve(rows.reverse())));
                if (!history || history.length === 0) return;

                const analysis = await analyzeConversationWithGemini(history);
                if (!analysis) return;

                const conversation = await new Promise((resolve, reject) => db.get('SELECT status, contact_name, bot_active FROM conversations WHERE chat_id = ?', [chatId], (err, row) => err ? reject(err) : resolve(row)));
                if (!conversation) return;

                let notificationType = analysis.sentiment;
                if (analysis.incongruity) notificationType = 'incongruent';
                if (analysis.urgency === 'alta') notificationType = 'urgent';

                const insertQuery = `INSERT INTO notifications (chat_id, contact_name, type, summary, timestamp) VALUES (?, ?, ?, ?, ?)`;
                const insertParams = [chatId, conversation.contact_name, notificationType, analysis.summary, Math.floor(Date.now() / 1000)];

                db.run(insertQuery, insertParams, function(err) {
                    if (err) return console.error(`[${chatId}] Error guardando notificación en DB:`, err);
                    
                    console.log(`[${chatId}] Notificación guardada en DB con ID: ${this.lastID}`);
                    const newNotificationData = {
                        id: this.lastID,
                        chat_id: chatId,
                        contact_name: conversation.contact_name,
                        type: notificationType,
                        summary: analysis.summary,
                        timestamp: insertParams[4]
                    };

                    if (conversation.bot_active && conversation.status === 'identified_affiliate' && (notificationType === 'incongruent' || notificationType === 'negativo' || notificationType === 'urgent')) {
                        console.log(`[${chatId}] ¡ALERTA GEMINI! Se detectó un problema con un afiliado. Pausando bot.`);
                        db.run("UPDATE conversations SET bot_active = 0, status = 'needs_human_intervention' WHERE chat_id = ?", [chatId]);
                        newNotificationData.type = 'human_intervention_required';
                    }

                    if (crmSocket && crmSocket.readyState === WebSocket.OPEN) {
                        crmSocket.send(JSON.stringify({ type: 'new_notification', data: newNotificationData }));
                    }
                });

            } catch (error) {
                console.error(`❌ Error durante el análisis de inactividad para ${chatId}:`, error);
            }
            delete inactivityTimers[chatId];
        }, 120000);
    };

    client.on('message', (msg) => {
        if (!msg.hasMedia) {
            archiveAndAnalyze(msg, false);
        }
    });
    client.on('message_create', (msg) => {
        if (msg.fromMe) {
            archiveAndAnalyze(msg, true);
        }
    });

    client.initialize().catch(err => {
        console.error("❌ FALLO CRÍTICO AL INICIALIZAR WHATSAPP:", err);
    });
}

// =================================================================
// --- 7. PUNTO DE ENTRADA PRINCIPAL ---
// =================================================================

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`✅ Servidor Express escuchando en http://localhost:${PORT}`);
    
    fetch('https://www.google.com', { method: 'HEAD' })
        .then(res => console.log(res.ok ? "✅ Prueba de conectividad exitosa." : "❌ Prueba de conectividad fallida."))
        .catch(err => console.error("❌ FALLO CRÍTICO de fetch:", err.message));
    
    setupWebSocketServer();
    initializeWhatsappClient();
});