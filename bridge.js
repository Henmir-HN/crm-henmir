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
const { GoogleGenerativeAI } = require("@google/generative-ai");
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const geminiModel = genAI.getGenerativeModel({ model: "gemini-2.5-flash"}); 


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

// EN bridge.js, AGREGA ESTA FUNCIÓN COMPLETA (por ejemplo, antes de la Sección 4)

/**
 * Analiza un historial de conversación con Gemini para detectar sentimiento, urgencia e incongruencias.
 * @param {Array<Object>} conversation - El historial de mensajes del chat.
 * @returns {Promise<Object|null>} - Un objeto con el análisis o null si hay un error.
 */
async function analyzeConversationWithGemini(conversation) {
    if (!process.env.GEMINI_API_KEY) {
        console.warn("Advertencia: GEMINI_API_KEY no está configurada. Se saltará el análisis de conversación.");
        return null;
    }
    
    // Formateamos el historial para que Gemini lo entienda
    const historyForAnalysis = conversation.map(msg => `${msg.from_me ? 'Asesor' : 'Usuario'}: ${msg.body}`).join('\n');
    
    const prompt = `
        Analiza la siguiente conversación de atención al cliente de una agencia de empleos.
        Evalúa los siguientes puntos y responde estrictamente con un solo objeto JSON, sin texto adicional antes o después.
        
        1. "sentiment": clasifícalo como "positivo", "negativo" o "neutro".
        2. "urgency": clasifícalo como "alta", "media" o "baja". Urgencia alta significa que el usuario necesita ayuda inmediata o está muy frustrado.
        3. "incongruity": pon 'true' si el usuario parece confundido, da información contradictoria o el bot parece no entenderle. De lo contrario, pon 'false'.
        4. "summary": un resumen muy corto (máximo 10 palabras) del tema principal de la conversación.

        CONVERSACIÓN:
        ---
        ${historyForAnalysis}
        ---
    `;

    try {
        const result = await geminiModel.generateContent(prompt);
        const response = await result.response;
        const text = response.text();
        // Limpiamos la respuesta para asegurarnos de que sea solo el JSON
        const jsonResponse = text.replace('```json', '').replace('```', '').trim();
        return JSON.parse(jsonResponse);
    } catch (error) {
        console.error("❌ Error al analizar la conversación con Gemini:", error);
        return null;
    }
}


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
    const endpointMap = {
        'search_vacancies_tool': '/api/bot_tools/vacancies',
        'validate_registration_tool': '/api/bot_tools/validate_registration',
        // ✨ NUEVA HERRAMIENTA AÑADIDA AL MAPA ✨
        'get_all_active_vacancies_tool': '/api/bot_tools/all_active_vacancies' 
    };
    const endpoint = endpointMap[functionName];

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
    console.log(`--- FIN LLAMADA HERRAMIENTA ---\n`);
    
    return responseData;
}


// EN bridge.js, REEMPLAZA LA FUNCIÓN app.post('/api/whatsauto_reply', ...) COMPLETA

app.post('/api/whatsauto_reply', async (req, res) => {
    const body = req.body;
    const sender = body.sender;
    const message = body.message;
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
                { type: "function", function: { name: "search_vacancies_tool", description: "Busca vacantes específicas por ciudad y palabra clave." } },
                { type: "function", function: { name: "validate_registration_tool", description: "Valida el registro de un usuario por su identidad." } },
                // ✨ NUEVA HERRAMIENTA VIRTUAL PARA LA IA ✨
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
                
                // --- ✨ INICIO DE LA LÓGICA DEL "PLAN B" ✨ ---
                if (functionName === 'search_vacancies_tool' && (!toolResult || toolResult.length === 0)) {
                    console.log(`[${chatId}] Búsqueda inicial fallida. Activando Plan B: búsqueda semántica.`);
                    
                    // 1. Obtener la lista completa de vacantes
                    const allVacancies = await callCrmTool('get_all_active_vacancies_tool', {});
                    
                    if (allVacancies && allVacancies.length > 0) {
                        // 2. Crear un nuevo prompt para la IA pidiendo sugerencias
                        const semanticPrompt = `La búsqueda del usuario para '${functionArgs.keyword || 'cualquier vacante'}' en '${functionArgs.city || 'cualquier ciudad'}' no encontró resultados directos. Sin embargo, estas son todas las vacantes disponibles en la empresa: [${allVacancies.join(', ')}]. Basado en la intención del usuario, sugiere hasta 3 vacantes de esta lista que sean las más similares o relevantes. Responde directamente al usuario empezando con una frase como 'No encontré una vacante exacta para lo que buscas, pero estas opciones podrían interesarte:'. Si ninguna es remotamente similar, indícalo amablemente.`;
                        
                        // Añadimos el resultado de la herramienta fallida
                        messagesForOpenAI.push({ tool_call_id: toolCall.id, role: "tool", name: functionName, content: JSON.stringify(toolResult) });
                        // Añadimos el nuevo prompt de sistema/instrucción
                        messagesForOpenAI.push({ role: "user", content: semanticPrompt });

                        // 3. Hacemos la segunda llamada a OpenAI para que genere la sugerencia
                        const semanticResponse = await openai.chat.completions.create({
                            model: settings.model,
                            messages: messagesForOpenAI,
                        });
                        finalReply = semanticResponse.choices[0].message.content;

                    } else {
                         // Si no hay ninguna vacante en la empresa, dejamos que la IA lo diga
                         finalReply = "Actualmente no se encontraron vacantes de ningún tipo en el sistema.";
                    }

                } else {
                    // --- FLUJO NORMAL (SI LA BÚSQUEDA INICIAL FUNCIONA O ES OTRA HERRAMIENTA) ---
                    messagesForOpenAI.push({ tool_call_id: toolCall.id, role: "tool", name: functionName, content: JSON.stringify(toolResult) });
                    const secondResponse = await openai.chat.completions.create({ model: settings.model, messages: messagesForOpenAI });
                    finalReply = secondResponse.choices[0].message.content;
                }
                
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
    });
});



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



    const archiveAndAnalyze = async (msg, fromMe) => {
        const chatId = fromMe ? msg.to : msg.from;
        const sender = fromMe ? 'me' : msg.from;

        // Paso 1: Guardar el mensaje en la base de datos SQLite.
        db.run(`INSERT INTO messages (chat_id, sender, body, timestamp, from_me) VALUES (?, ?, ?, ?, ?)`,
               [chatId, sender, msg.body, msg.timestamp, fromMe]);
        
        db.run(`INSERT OR IGNORE INTO conversations (chat_id, contact_name, last_message_timestamp) VALUES (?, ?, ?)`, 
               [chatId, msg._data.notifyName || chatId.split('@')[0], msg.timestamp]);
        db.run(`UPDATE conversations SET last_message_timestamp = ? WHERE chat_id = ?`, [msg.timestamp, chatId]);

        // Paso 2: Después de guardar, analizar la conversación con Gemini.
        try {
            // Se recuperan los últimos 6 mensajes para dar contexto.
            const conversationHistory = await new Promise((resolve, reject) => {
                db.all('SELECT * FROM messages WHERE chat_id = ? ORDER BY timestamp DESC LIMIT 6', [chatId], (err, rows) => {
                    if (err) return reject(err);
                    resolve(rows.reverse()); // Se ordenan cronológicamente.
                });
            });

            if (!conversationHistory || conversationHistory.length === 0) return;

            // Se llama a la función de análisis que ya hemos creado.
            const analysis = await analyzeConversationWithGemini(conversationHistory);

            // Paso 3: Si el análisis tiene resultado y el CRM está conectado, se envía la notificación.
            if (analysis && crmSocket && crmSocket.readyState === WebSocket.OPEN) {
                const notification = {
                    type: 'conversation_analysis',
                    data: {
                        chatId: chatId,
                        contactName: msg._data.notifyName || chatId.split('@')[0],
                        sentiment: analysis.sentiment,
                        urgency: analysis.urgency,
                        incongruity: analysis.incongruity,
                        summary: analysis.summary
                    }
                };
                crmSocket.send(JSON.stringify(notification));
                console.log(`[${chatId}] Análisis de Gemini enviado al CRM.`);
            }
        } catch (error) {
            console.error(`❌ Error durante el análisis de la conversación para ${chatId}:`, error);
        }
    };

    // Cuando llega un mensaje nuevo de un usuario.
    client.on('message', (msg) => {
        archiveAndAnalyze(msg, false);
    });

    // Cuando nosotros enviamos un mensaje (desde el móvil o el CRM manual).
    client.on('message_create', (msg) => {
        if (msg.fromMe) {
            archiveAndAnalyze(msg, true);
        }
    })
};