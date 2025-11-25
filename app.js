const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

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
    }

    async connect() {
        try {
            console.log('🔗 Iniciando conexión con WhatsApp...');
            
            const { state, saveCreds } = await useMultiFileAuthState('./auth_info');
            const { version } = await fetchLatestBaileysVersion();
            
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

            this.sock.ev.on('connection.update', (update) => {
                const { connection, lastDisconnect, qr } = update;
                
                console.log('🔄 Estado de conexión:', connection);
                
                if (qr) {
                    console.log('\n📱 ESCANEA ESTE CÓDIGO QR CON WHATSAPP:');
                    qrcode.generate(qr, { small: true });
                    io.emit('qr', qr);
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
                    
                    console.log('❌ Conexión cerrada');
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

            // Respuesta automática opcional
            if (text.toLowerCase().includes('hola') && !sender.endsWith('@g.us')) {
                setTimeout(async () => {
                    await this.sendMessage(sender, '¡Hola! 👋 Soy un bot de mensajería masiva. ¿En qué puedo ayudarte?');
                }, 1000);
            }

        } catch (error) {
            console.error('Error procesando mensaje:', error);
        }
    }

    async sendMessage(to, text) {
        try {
            if (!this.isConnected) {
                throw new Error('No conectado a WhatsApp');
            }

            await this.sock.sendMessage(to, { text: text });
            
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

            console.log(`📤 Mensaje enviado a ${this.getChatName(to)}: ${text}`);
            
            return true;

        } catch (error) {
            console.error('❌ Error enviando mensaje:', error.message);
            io.emit('error', `Error enviando mensaje: ${error.message}`);
            return false;
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
                
                await new Promise(resolve => setTimeout(resolve, 2000));

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