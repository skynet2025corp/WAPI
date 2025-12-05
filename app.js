const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
// Increase Socket.io max payload size to handle large image data URLs (default 1MB)
const io = socketIo(server, { maxHttpBufferSize: 50 * 1024 * 1024 }); // 50 MB

app.use(express.static('public'));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

class WhatsAppBot {
    constructor() {
        this.sock = null;
        this.isConnected = false;
        this.activeChats = new Map();
        this.clients = new Set();
        this.currentActiveChat = null;
        this.chats = new Map(); // Almacenar chats
        this.isSendingBulk = false; // Track if bulk sending is in progress
        this.lastConnectionCheck = Date.now();
    }

    async connect() {
        try {
            console.log('🔗 Iniciando conexión con WhatsApp...');

            const connectStart = Date.now();
            console.log(`⏱️ Connect start: ${new Date(connectStart).toLocaleTimeString()}`);

            // auth state
            const authStart = Date.now();
            const { state, saveCreds } = await useMultiFileAuthState('./auth_info');
            const authEnd = Date.now();
            console.log(`⏱️ Auth state load time: ${(authEnd - authStart)} ms`);

            // Try to reuse a cached baileys version to avoid network delay; fallback to fetchLatestBaileysVersion
            const fs = require('fs');
            const versionCacheFile = './.baileys_version_cache.json';
            let version;
            try {
                if (fs.existsSync(versionCacheFile)) {
                    const cache = JSON.parse(fs.readFileSync(versionCacheFile, 'utf8'));
                    const now = Date.now();
                    // if cached less than 24h, reuse
                    if (cache && cache.version && (now - cache.t) < 24 * 60 * 60 * 1000) {
                        version = cache.version;
                        console.log('📦 Reusing cached Baileys version:', version.version.join('.'));
                    }
                }
            } catch (e) {
                console.warn('No pudo leerse la caché de versión:', e.message || e);
            }

            if (!version) {
                const versionStart = Date.now();
                const fetched = await fetchLatestBaileysVersion();
                version = fetched.version;
                try {
                    fs.writeFileSync(versionCacheFile, JSON.stringify({ t: Date.now(), version }), 'utf8');
                } catch (e) {
                    console.warn('No se pudo guardar la caché de versión:', e.message || e);
                }
                const versionEnd = Date.now();
                console.log(`⏱️ fetchLatestBaileysVersion: ${(versionEnd - versionStart)} ms`);
            }
            
            this.sock = makeWASocket({
                auth: state,
                version,
                logger: {
                    level: 'silent',
                    trace: () => {},
                    debug: () => {},
                    info: () => {},
                    warn: () => {},
                    error: () => {},
                    fatal: () => {},
                    child: () => ({ 
                        trace: () => {}, debug: () => {}, info: () => {}, 
                        warn: () => {}, error: () => {}, fatal: () => {},
                        child: function() { return this; }
                    })
                },
                printQRInTerminal: false,
                connectTimeoutMs: 60000,
            });

            const connectEnd = Date.now();
            console.log(`⏱️ Total connect setup time: ${(connectEnd - connectStart)} ms`);

            this.sock.ev.on('connection.update', (update) => {
                const { connection, lastDisconnect, qr } = update;
                
                console.log('🔄 Estado de conexión:', connection, this.isSendingBulk ? '(durante envío masivo)' : '');
                
                if (qr) {
                    console.log('\n📱 ESCANEA ESTE CÓDIGO QR CON WHATSAPP:');
                    qrcode.generate(qr, { small: true });
                    io.emit('qr', qr);
                    // log timestamp for when QR appears
                    const qrTime = Date.now();
                    console.log(`⏱️ QR emitted after ${(qrTime - connectStart)} ms`);
                    io.emit('status', 'Escanea el código QR con WhatsApp');
                }

                if (connection === 'open') {
                    console.log('✅ ¡CONECTADO EXITOSAMENTE!');
                    this.isConnected = true;
                    io.emit('status', 'Conectado a WhatsApp');
                    io.emit('connected', true);
                    this.onConnected();
                }

                if (connection === 'close') {
                    this.isConnected = false;
                    const shouldReconnect = 
                        lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
                    
                    console.log('❌ Conexión cerrada' + (this.isSendingBulk ? ' (durante envío masivo)' : ''));
                    
                    if (this.isSendingBulk) {
                        io.emit('error', 'La conexión se desconectó durante el envío masivo. Se detendrá la operación.');
                    }
                    
                    io.emit('status', 'Conexión cerrada - Reconectando...');
                    io.emit('connected', false);
                    
                    if (shouldReconnect) {
                        setTimeout(() => this.connect(), 5000);
                    }
                }
            });

            this.sock.ev.on('creds.update', saveCreds);
            
            // Escuchar eventos de mensajes
            this.sock.ev.on('messages.upsert', ({ messages }) => {
                const message = messages[0];
                if (!message.key.fromMe && message.message) {
                    this.handleIncomingMessage(message);
                }
            });

            // Escuchar actualizaciones de mensajes (estado: sent/delivered/read)
            this.sock.ev.on('messages.update', (updates) => {
                try {
                    console.log('📬 messages.update', JSON.stringify(updates, null, 2));
                    // Emitir a los clientes la actualización de entrega si se necesita
                    io.emit('message_updates', updates);
                } catch (e) {
                    console.error('Error procesando messages.update:', e);
                }
            });

            // Escuchar eventos de chats
            this.sock.ev.on('chats.upsert', (chats) => {
                this.handleChatsUpdate(chats);
            });

            // Escuchar eventos de contactos
            this.sock.ev.on('contacts.upsert', (contacts) => {
                this.handleContactsUpdate(contacts);
            });

        } catch (error) {
            console.error('❌ Error crítico:', error);
            setTimeout(() => this.connect(), 10000);
        }
    }

    onConnected() {
        console.log('🤖 Bot listo para recibir y enviar mensajes');
        // Los chats se cargarán automáticamente a través de los eventos
    }

    handleChatsUpdate(chats) {
        console.log(`📂 Actualizando ${chats.length} chats...`);
        
        chats.forEach(chat => {
            this.chats.set(chat.id, chat);
        });

        // Convertir a array para enviar al cliente
        const chatList = Array.from(this.chats.values()).map(chat => ({
            id: chat.id,
            name: chat.name || this.formatNumber(chat.id),
            isGroup: chat.id.endsWith('@g.us'),
            lastMessage: chat.conversationTimestamp ? new Date(chat.conversationTimestamp * 1000).toLocaleString() : 'Sin mensajes',
            unread: chat.unreadCount || 0
        }));

        io.emit('chats_loaded', chatList);
    }

    handleContactsUpdate(contacts) {
        console.log(`👥 Actualizando ${contacts.length} contactos...`);
        // Podemos usar esta información para mejorar los nombres de los chats
    }

    async handleIncomingMessage(message) {
        try {
            const sender = message.key.remoteJid;
            let text = '';
            let messageType = 'text';
            
            if (message.message?.conversation) {
                text = message.message.conversation;
            } else if (message.message?.extendedTextMessage?.text) {
                text = message.message.extendedTextMessage.text;
            } else if (message.message?.imageMessage) {
                text = '🖼️ Imagen';
                messageType = 'image';
            } else if (message.message?.videoMessage) {
                text = '🎥 Video';
                messageType = 'video';
            } else if (message.message?.audioMessage) {
                text = '🎵 Audio';
                messageType = 'audio';
            } else if (message.message?.documentMessage) {
                text = `📄 ${message.message.documentMessage.fileName}`;
                messageType = 'document';
            } else {
                text = '📎 Archivo multimedia';
                messageType = 'media';
            }

            const chatMessage = {
                id: message.key.id,
                sender: this.formatNumber(sender),
                senderJid: sender,
                message: text,
                type: messageType,
                timestamp: new Date(),
                fromMe: false,
                profile: this.getProfileColor(sender)
            };

            // Guardar mensaje en el chat correspondiente
            if (!this.activeChats.has(sender)) {
                this.activeChats.set(sender, []);
            }
            this.activeChats.get(sender).push(chatMessage);

            // Enviar a la interfaz web solo si es el chat activo
            if (this.currentActiveChat === sender) {
                io.emit('new_message', chatMessage);
            }

            // Notificar nuevo mensaje en la lista de chats
            io.emit('chat_updated', {
                id: sender,
                lastMessage: text,
                timestamp: chatMessage.timestamp,
                unread: this.currentActiveChat !== sender
            });

            console.log(`📥 Mensaje de ${this.getChatName(sender)}: ${text}`);

            // Se removió respuesta automática fija para evitar mensajes no deseados

        } catch (error) {
            console.error('Error procesando mensaje:', error);
        }
    }

    async sendMessage(to, text) {
        try {
            if (!this.isConnected) {
                throw new Error('No conectado a WhatsApp');
            }

            const sendRes = await this.sock.sendMessage(to, { text: text });
            
            // Log detailed response for debugging
            console.log(`📤 Mensaje enviado a ${this.getChatName(to)}: ${text}`, 
                `[MsgID: ${sendRes?.key?.id || 'N/A'}]`, 
                `[Status: ${sendRes?.status || 'N/A'}]`);
            
            const sentMessage = {
                id: Date.now().toString(),
                sender: this.getChatName(to),
                senderJid: to,
                message: text,
                timestamp: new Date(),
                type: 'text',
                fromMe: true,
                profile: '#25D366'
            };

            // Guardar mensaje en el chat correspondiente
            if (!this.activeChats.has(to)) {
                this.activeChats.set(to, []);
            }
            this.activeChats.get(to).push(sentMessage);

            // Enviar a la interfaz web solo si es el chat activo
            if (this.currentActiveChat === to) {
                io.emit('new_message', sentMessage);
            }
            
            // Return the full response so caller can check delivery status
            return sendRes;

        } catch (error) {
            console.error('❌ Error enviando mensaje a', to, ':', error.message);
            io.emit('error', `Error enviando mensaje: ${error.message}`);
            throw error; // Re-throw so caller knows it failed
        }
    }

    setActiveChat(chatJid) {
        this.currentActiveChat = chatJid;
        
        // Obtener mensajes del chat seleccionado
        const messages = this.activeChats.get(chatJid) || [];
        
        // Enviar información del chat y mensajes al cliente
        io.emit('active_chat_changed', {
            chatJid: chatJid,
            chatName: this.getChatName(chatJid),
            isGroup: chatJid.endsWith('@g.us'),
            messages: messages
        });

        console.log(`💬 Chat activo cambiado a: ${this.getChatName(chatJid)}`);
    }

    async sendToActiveChat(message) {
        if (!this.currentActiveChat) {
            throw new Error('No hay ningún chat activo seleccionado');
        }
        return await this.sendMessage(this.currentActiveChat, message);
    }

    async sendBulkMessage(numbers, message) {
        if (!this.isConnected) {
            io.emit('error', 'No conectado a WhatsApp');
            return;
        }

        io.emit('bulk_start', { total: numbers.length });
        
        let success = 0;
        let errors = 0;

        for (let i = 0; i < numbers.length; i++) {
            const number = numbers[i].includes('@') ? numbers[i] : numbers[i] + '@s.whatsapp.net';
            
            try {
                await this.sendMessage(number, message);
                success++;
                io.emit('bulk_progress', { 
                    current: i + 1, 
                    total: numbers.length, 
                    success: success,
                    errors: errors
                });
                
                await new Promise(resolve => setTimeout(resolve, 15000));

            } catch (error) {
                errors++;
                io.emit('bulk_progress', { 
                    current: i + 1, 
                    total: numbers.length, 
                    success: success,
                    errors: errors
                });
            }
        }

        io.emit('bulk_complete', { success, errors, total: numbers.length });
    }

    async sendSections(sections) {
        if (!this.isConnected) {
            io.emit('error', 'No conectado a WhatsApp');
            return;
        }

        console.log('🔔 sendSections called - incoming sections type:', typeof sections);
        if (!Array.isArray(sections)) {
            console.warn('sendSections: sections is not an array', sections);
            io.emit('error', 'Invalid sections payload');
            return;
        }

        // Mark bulk sending as in progress
        this.isSendingBulk = true;
        
        try {
            await this._sendSectionsAsync(sections);
        } finally {
            this.isSendingBulk = false;
        }
    }

    async _sendSectionsAsync(sections) {
        // Normalize and prepare sections: ensure numbers as array and messages as array
        const normalized = sections.map((s) => {
            let numbers = [];
            if (Array.isArray(s.numbers)) numbers = s.numbers.map(n => (n || '').toString().trim()).filter(Boolean);
            else if (typeof s.number === 'string' && s.number.trim()) numbers = s.number.split(/[ ,\n\r]+/).map(n => n.trim()).filter(Boolean);

            const messages = Array.isArray(s.messages) ? s.messages : (s.message ? [s.message] : []);
            //se cargan las imagenes opcionales si nos es correcta
            const image = s.image || null;
            const imageName = s.imageName || null;
            return { numbers, messages, image, imageName };
        });

        const total = normalized.reduce((acc, s) => acc + (s.numbers.length * s.messages.length), 0);
        io.emit('sections_start', { total });

        let success = 0;
        let errors = 0;
        let current = 0;

        // Track per-number counters
        const perNumberCounters = {};
        for (let si = 0; si < normalized.length; si++) {
            const s = normalized[si];
            for (let ni = 0; ni < s.numbers.length; ni++) {
                const numberRaw = (s.numbers[ni] || '').toString();
                const number = numberRaw.includes('@') ? numberRaw : numberRaw + '@s.whatsapp.net';
                const perKey = `${si}-${ni}`;
                perNumberCounters[perKey] = perNumberCounters[perKey] || { success: 0, errors: 0 };
                
                // Check connection health every few messages
                if (current > 0 && current % 5 === 0) {
                    if (!this.isConnected) {
                        console.error('❌ Conexión perdida durante envío. Abortando operación...');
                        io.emit('error', 'Conexión perdida durante envío masivo. Por favor, reconecta e intenta de nuevo.');
                        io.emit('sections_complete', { success, errors, total, aborted: true });
                        return;
                    }
                }
                
                // Preflight check: if possible, validate that number is a WhatsApp account
                try {
                    if (typeof this.sock.onWhatsApp === 'function') {
                        const check = await this.sock.onWhatsApp(numberRaw);
                        // if check indicates it's not on WhatsApp, record an error and continue
                        if (Array.isArray(check) && check[0] && check[0].exists === false) {
                            console.log(`⚠️ Número no registrado en WhatsApp: ${numberRaw}`);
                            errors++;
                            current++;
                            io.emit('sections_progress', { current, total, success, errors, sectionIndex: si, numberIndex: ni, number: numberRaw, sectionTotal: s.messages.length, sectionCurrent: 0 });
                            continue;
                        }
                    }
                } catch (e) {
                    console.warn('onWhatsApp check failed:', e && e.message ? e.message : e);
                }
                for (let mi = 0; mi < s.messages.length; mi++) {
                    const text = s.messages[mi];
                        // If this section includes an image, send it once per number before text messages
                        if (mi === 0 && s.image) {
                            try {
                                const dataUrl = s.image;
                                const match = (dataUrl || '').match(/^data:(.+);base64,(.+)$/);
                                let buffer;
                                let mimeType = 'image/jpeg';
                                if (match) {
                                    mimeType = match[1];
                                    buffer = Buffer.from(match[2], 'base64');
                                } else {
                                    // fallback: assume raw base64
                                    buffer = Buffer.from(dataUrl, 'base64');
                                }
                                console.log(new Date().toISOString(), `→ Sending image to ${numberRaw} (mime=${mimeType}, bytes=${buffer.length})`);
                                io.emit('sections_debug', { type: 'sending_image', sectionIndex: si, numberIndex: ni, number: numberRaw, bytes: buffer.length, mimeType });
                                const imgRes = await this.sock.sendMessage(number, { image: buffer, mimetype: mimeType, caption: '' });
                                console.log(new Date().toISOString(), `🖼️ Image sendRes for ${numberRaw}:`, { id: imgRes?.key?.id, status: imgRes?.status });
                                io.emit('sections_debug', { type: 'image_sent', sectionIndex: si, numberIndex: ni, number: numberRaw, id: imgRes?.key?.id, status: imgRes?.status });
                            } catch (imgErr) {
                                console.error(`❌ Error enviando imagen a ${numberRaw}:`, imgErr && imgErr.message ? imgErr.message : imgErr);
                                // record an error but continue sending the text messages
                                errors++;
                                perNumberCounters[perKey].errors++;
                                io.emit('sections_progress', { current, total, success, errors, sectionIndex: si, numberIndex: ni, number: numberRaw, perNumberSuccess: perNumberCounters[perKey].success, perNumberErrors: perNumberCounters[perKey].errors, sectionTotal: s.messages.length, sectionCurrent: mi + 1 });
                            }
                        }
                    try {
                        const sendRes = await this.sendMessage(number, text);
                        // Check if sendRes contains a message key indicating success
                        if (sendRes && sendRes.key && sendRes.key.id) {
                            success++;
                            perNumberCounters[perKey].success++;
                            console.log(`✅ Mensaje confirmado a ${numberRaw}: ${text.substring(0, 50)}`);
                            io.emit('sections_debug', { type: 'message_sent', sectionIndex: si, numberIndex: ni, number: numberRaw, messageIndex: mi, id: sendRes.key.id });
                        } else {
                            // If sendMessage didn't return a proper message key, it's likely a failure
                            errors++;
                            perNumberCounters[perKey].errors++;
                            console.warn(`⚠️ Mensaje sin confirmación a ${numberRaw}: ${text.substring(0, 50)}`);
                            io.emit('sections_debug', { type: 'message_no_confirm', sectionIndex: si, numberIndex: ni, number: numberRaw, messageIndex: mi, sendRes });
                        }
                    } catch (error) {
                        errors++;
                        perNumberCounters[perKey].errors++;
                        console.error(`❌ Error enviando a ${numberRaw}:`, error.message);
                        
                        // If it's a connection error, stop sending
                        if (error.message.includes('No conectado')) {
                            console.error('Deteniendo envío masivo - No hay conexión');
                            io.emit('sections_complete', { success, errors, total, aborted: true });
                            return;
                        }
                    }
                    current++;
                    io.emit('sections_progress', {
                        current,
                        total,
                        success,
                        errors,
                        sectionIndex: si,
                        numberIndex: ni,
                        number: numberRaw,
                        perNumberSuccess: perNumberCounters[perKey].success,
                        perNumberErrors: perNumberCounters[perKey].errors,
                        sectionTotal: s.messages.length,
                        sectionCurrent: mi + 1
                    });
                    // Pause between messages (10 segundos por numero)
                    await new Promise(resolve => setTimeout(resolve, 15000));
                }
            }
        }

        io.emit('sections_complete', { success, errors, total });
    }

    getChatName(jid) {
        // Buscar en los chats cargados
        const chat = this.chats.get(jid);
        if (chat && chat.name) {
            return chat.name;
        }
        
        // Si no tiene nombre, formatear el JID
        if (jid.endsWith('@g.us')) {
            return `Grupo ${this.formatNumber(jid)}`;
        } else {
            return this.formatNumber(jid);
        }
    }

    formatNumber(jid) {
        return jid.replace('@s.whatsapp.net', '').replace('@g.us', '');
    }

    getProfileColor(jid) {
        const colors = ['#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4', '#FFEAA7', '#DDA0DD', '#98D8C8'];
        const index = jid.split('').reduce((a, b) => a + b.charCodeAt(0), 0) % colors.length;
        return colors[index];
    }

    setupSocketHandlers() {
        io.on('connection', (socket) => {
            console.log('👤 Cliente web conectado');
            this.clients.add(socket);

            socket.emit('connected', this.isConnected);
            socket.emit('status', this.isConnected ? 'Conectado' : 'Desconectado');
            
            // Enviar chats existentes si hay alguno
            if (this.chats.size > 0) {
                const chatList = Array.from(this.chats.values()).map(chat => ({
                    id: chat.id,
                    name: chat.name || this.formatNumber(chat.id),
                    isGroup: chat.id.endsWith('@g.us'),
                    lastMessage: chat.conversationTimestamp ? new Date(chat.conversationTimestamp * 1000).toLocaleString() : 'Sin mensajes',
                    unread: chat.unreadCount || 0
                }));
                socket.emit('chats_loaded', chatList);
            }

            // Enviar chat activo actual si existe
            if (this.currentActiveChat) {
                const messages = this.activeChats.get(this.currentActiveChat) || [];
                socket.emit('active_chat_changed', {
                    chatJid: this.currentActiveChat,
                    chatName: this.getChatName(this.currentActiveChat),
                    isGroup: this.currentActiveChat.endsWith('@g.us'),
                    messages: messages
                });
            }

            // Manejar selección de chat
            socket.on('select_chat', (chatJid) => {
                this.setActiveChat(chatJid);
            });

            // Manejar envío de mensajes al chat activo
            socket.on('send_to_active', async (message) => {
                try {
                    await this.sendToActiveChat(message);
                } catch (error) {
                    socket.emit('error', error.message);
                }
            });

            // Manejar envío de mensajes a contacto específico
            socket.on('send_message', async (data) => {
                const { to, message } = data;
                await this.sendMessage(to + '@s.whatsapp.net', message);
            });

            socket.on('send_bulk', async (data) => {
                const { numbers, message } = data;
                await this.sendBulkMessage(numbers, message);
            });

            socket.on('send_sections', async (data) => {
                try {
                    const { sections } = data || {};
                    console.log('📥 Received send_sections from client. sections.length=', Array.isArray(sections) ? sections.length : 0);
                    // Log image sizes and details
                    if (Array.isArray(sections)) {
                        sections.forEach((s, idx) => {
                            const imgSize = s.image ? (s.image.length / 1024).toFixed(2) : 0;
                            console.log(`   Sección ${idx}: ${s.numbers?.length || 0} números, ${s.messages?.length || 0} mensajes, imagen: ${s.image ? imgSize + ' KB' : 'vacía'}`);
                        });
                    }
                    // For quick debugging, log a small preview (avoid huge dumps)
                    try { console.log('📥 sections preview:', JSON.stringify((sections || []).map(s=>({ numbers: (s.numbers||[]).slice(0,3), messagesCount: (s.messages||[]).length, hasImage: !!s.image, imageSize: s.image ? (s.image.length / 1024).toFixed(2) + ' KB' : 'no' })), null, 2)); } catch(e) {}
                    await this.sendSections(sections);
                } catch (err) {
                    console.error('Error handling send_sections:', err && err.stack ? err.stack : err);
                    socket.emit('error', 'Error procesando send_sections: ' + (err && err.message ? err.message : String(err)));
                }
            });

            socket.on('disconnect', () => {
                console.log('👤 Cliente web desconectado');
                this.clients.delete(socket);
            });
        });
    }
}

const bot = new WhatsAppBot();
bot.setupSocketHandlers();
bot.connect();

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🌐 Servidor web ejecutándose en http://localhost:${PORT}`);
});

process.on('SIGINT', () => {
    console.log('\n👋 Cerrando aplicación...');
    process.exit(0);
});