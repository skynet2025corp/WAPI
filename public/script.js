class WhatsAppUI {
    constructor() {
        this.socket = io();
        this.chats = [];
        this.activeChat = null;
        this.setupEventListeners();
        this.setupSocketHandlers();
    }

    setupEventListeners() {
        document.getElementById('send-message-btn').addEventListener('click', () => {
            this.sendToActiveChat();
        });

        document.getElementById('message-text').addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                this.sendToActiveChat();
            }
        });

        document.getElementById('send-bulk-btn').addEventListener('click', () => {
            this.sendBulkMessage();
        });

        // Enter en el modal de nuevo chat
        document.getElementById('new-chat-number').addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                this.createNewChat();
            }
        });
    }

    setupSocketHandlers() {
        this.socket.on('connected', (isConnected) => {
            this.updateConnectionStatus(isConnected);
        });

        this.socket.on('status', (status) => {
            this.updateStatus(status);
        });

        this.socket.on('qr', (qrCode) => {
            this.showQRCode(qrCode);
        });

        this.socket.on('chats_loaded', (chats) => {
            this.displayChats(chats);
        });

        this.socket.on('active_chat_changed', (data) => {
            this.setActiveChatUI(data);
        });

        this.socket.on('new_message', (message) => {
            this.addMessageToChat(message);
        });

        this.socket.on('chat_updated', (chatData) => {
            this.updateChatInList(chatData);
        });

        this.socket.on('bulk_start', (data) => {
            this.showBulkProgress(data);
        });

        this.socket.on('bulk_progress', (data) => {
            this.updateBulkProgress(data);
        });

        this.socket.on('bulk_complete', (data) => {
            this.completeBulkSend(data);
        });

        this.socket.on('error', (error) => {
            this.showError(error);
        });
    }

    updateConnectionStatus(isConnected) {
        const statusElement = document.getElementById('connection-status');
        const statusConnected = document.getElementById('status-connected');
        
        if (isConnected) {
            statusElement.textContent = 'Conectado';
            statusElement.className = 'status connected';
            statusConnected.textContent = 'Conectado';
            document.getElementById('qr-container').style.display = 'none';
        } else {
            statusElement.textContent = 'Desconectado';
            statusElement.className = 'status disconnected';
            statusConnected.textContent = 'Desconectado';
        }
    }

    displayChats(chats) {
        this.chats = chats;
        const container = document.getElementById('chats-container');
        
        if (chats.length === 0) {
            container.innerHTML = `
                <div class="no-chats">
                    <i class="fas fa-comment-slash"></i>
                    <p>No hay chats disponibles</p>
                    <p style="margin-top: 10px; font-size: 12px;">Usa el botón "+ Nuevo" para crear un chat</p>
                </div>
            `;
            return;
        }

        container.innerHTML = chats.map(chat => `
            <div class="chat-item" onclick="whatsappUI.selectChat('${chat.id}')">
                <div class="chat-avatar ${chat.isGroup ? 'group' : 'individual'}">
                    <i class="fas fa-${chat.isGroup ? 'users' : 'user'}"></i>
                </div>
                <div class="chat-info">
                    <div class="chat-name">${this.escapeHtml(chat.name)}</div>
                    <div class="chat-last-message">${chat.lastMessage || 'Sin mensajes'}</div>
                </div>
                ${chat.unread > 0 ? `<div class="chat-unread">${chat.unread}</div>` : ''}
            </div>
        `).join('');

        this.updateStats();
    }

    selectChat(chatJid) {
        this.socket.emit('select_chat', chatJid);
        
        // Actualizar UI de items de chat
        document.querySelectorAll('.chat-item').forEach(item => {
            item.classList.remove('active');
        });
        event.currentTarget.classList.add('active');
    }

    // Nueva función para crear chat manualmente
    createNewChat() {
        const numberInput = document.getElementById('new-chat-number');
        const number = numberInput.value.trim();
        
        if (!number) {
            alert('Por favor ingresa un número');
            return;
        }

        // Validar formato de número (solo números, 10-15 dígitos)
        const numberRegex = /^[0-9]{10,15}$/;
        if (!numberRegex.test(number)) {
            alert('Por favor ingresa un número válido (10-15 dígitos)');
            return;
        }

        const chatJid = number + '@s.whatsapp.net';
        
        // Crear objeto de chat manual
        const newChat = {
            id: chatJid,
            name: number,
            isGroup: false,
            lastMessage: 'Nuevo chat',
            unread: 0
        };

        // Agregar a la lista de chats
        this.chats.push(newChat);
        this.displayChats(this.chats);
        
        // Seleccionar automáticamente el nuevo chat
        this.selectChat(chatJid);
        
        // Cerrar modal y limpiar input
        this.closeNewChatModal();
        numberInput.value = '';
        
        console.log(`✅ Nuevo chat creado: ${number}`);
    }

    openNewChatModal() {
        document.getElementById('newChatModal').style.display = 'flex';
        document.getElementById('new-chat-number').focus();
    }

    closeNewChatModal() {
        document.getElementById('newChatModal').style.display = 'none';
    }

    setActiveChatUI(data) {
        this.activeChat = data.chatJid;
        
        // Actualizar header del chat
        document.getElementById('active-chat-name').innerHTML = `
            <i class="fas fa-${data.isGroup ? 'users' : 'user'}"></i>
            ${this.escapeHtml(data.chatName)}
        `;
        
        const chatTypeElement = document.getElementById('active-chat-type');
        chatTypeElement.textContent = data.isGroup ? 'Grupo' : 'Contacto';
        chatTypeElement.className = `chat-type ${data.isGroup ? 'group' : 'individual'}`;

        // Mostrar input de mensaje
        document.getElementById('message-input-container').style.display = 'block';

        // Mostrar mensajes
        this.displayMessages(data.messages);
    }

    displayMessages(messages) {
        const container = document.getElementById('messages-container');
        container.innerHTML = '';

        if (messages.length === 0) {
            container.innerHTML = `
                <div class="welcome-message">
                    <i class="fas fa-comments"></i>
                    <h3>Inicia la conversación</h3>
                    <p>Envía un mensaje para comenzar a chatear con ${this.activeChat ? this.getChatName(this.activeChat) : 'este contacto'}</p>
                </div>
            `;
            return;
        }

        messages.forEach(message => {
            this.displayMessage(message);
        });
        
        this.scrollToBottom();
    }

    addMessageToChat(message) {
        // Solo agregar si es del chat activo
        if (this.activeChat === message.senderJid) {
            this.displayMessage(message);
            this.scrollToBottom();
        }
        this.updateStats();
    }

    displayMessage(message) {
        const container = document.getElementById('messages-container');
        
        // Remover mensaje de bienvenida si existe
        const welcomeMsg = container.querySelector('.welcome-message');
        if (welcomeMsg) {
            welcomeMsg.remove();
        }

        const messageElement = document.createElement('div');
        messageElement.className = `message ${message.fromMe ? 'own' : ''}`;
        
        const profileColor = message.profile || '#25D366';
        
        messageElement.innerHTML = `
            ${!message.fromMe ? `
                <div class="message-avatar" style="background: ${profileColor}">
                    <i class="fas fa-user"></i>
                </div>
            ` : ''}
            
            <div class="message-bubble">
                <div class="message-header">
                    <span class="message-sender">${message.fromMe ? 'Yo' : message.sender}</span>
                    <span class="message-time">${this.formatTime(message.timestamp)}</span>
                </div>
                <div class="message-content">${this.escapeHtml(message.message)}</div>
            </div>
            
            ${message.fromMe ? `
                <div class="message-avatar" style="background: #25D366">
                    <i class="fas fa-robot"></i>
                </div>
            ` : ''}
        `;

        container.appendChild(messageElement);
    }

    sendToActiveChat() {
        if (!this.activeChat) {
            alert('Por favor selecciona un chat primero');
            return;
        }

        const text = document.getElementById('message-text').value.trim();
        if (!text) {
            alert('Por favor escribe un mensaje');
            return;
        }

        this.socket.emit('send_to_active', text);
        document.getElementById('message-text').value = '';
    }

    sendBulkMessage() {
        const numbersInput = document.getElementById('bulk-numbers').value.trim();
        const message = document.getElementById('bulk-message').value.trim();

        if (!numbersInput || !message) {
            alert('Por favor ingresa los números y el mensaje');
            return;
        }

        const numbers = numbersInput.split(/[\n,]/)
            .map(num => num.trim())
            .filter(num => {
                // Validar que sea un número válido
                const numRegex = /^[0-9]{10,15}$/;
                return numRegex.test(num);
            });

        if (numbers.length === 0) {
            alert('Por favor ingresa al menos un número válido (10-15 dígitos)');
            return;
        }

        this.socket.emit('send_bulk', { numbers, message });
    }

    updateChatInList(chatData) {
        // Buscar y actualizar el chat en la lista
        const chatIndex = this.chats.findIndex(chat => chat.id === chatData.id);
        if (chatIndex !== -1) {
            this.chats[chatIndex].lastMessage = chatData.lastMessage;
            this.chats[chatIndex].timestamp = chatData.timestamp;
            if (chatData.unread && this.activeChat !== chatData.id) {
                this.chats[chatIndex].unread = (this.chats[chatIndex].unread || 0) + 1;
            }
            this.displayChats(this.chats);
        }
    }

    updateStats() {
        document.getElementById('total-chats').textContent = this.chats.length;
        // En una implementación completa, aquí contaríamos los mensajes de todos los chats
        document.getElementById('total-messages').textContent = '0';
    }

    getChatName(jid) {
        const chat = this.chats.find(chat => chat.id === jid);
        return chat ? chat.name : jid.replace('@s.whatsapp.net', '');
    }

    scrollToBottom() {
        const container = document.getElementById('messages-container');
        container.scrollTop = container.scrollHeight;
    }

    formatTime(timestamp) {
        const date = new Date(timestamp);
        return date.toLocaleTimeString('es-ES', { 
            hour: '2-digit', 
            minute: '2-digit' 
        });
    }

    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    showQRCode(qrCode) {
        const qrContainer = document.getElementById('qr-container');
        qrContainer.style.display = 'block';
        
        document.getElementById('qrcode').innerHTML = '';
        
        QRCode.toCanvas(document.getElementById('qrcode'), qrCode, {
            width: 200,
            margin: 2
        }, function(error) {
            if (error) console.error(error);
        });
    }

    showBulkProgress(data) {
        const progressContainer = document.getElementById('bulk-progress');
        progressContainer.style.display = 'block';
        this.updateBulkProgress({ current: 0, ...data });
    }

    updateBulkProgress(data) {
        const progressFill = document.getElementById('progress-fill');
        const progressText = document.getElementById('progress-text');
        const progressStats = document.getElementById('progress-stats');

        const percentage = (data.current / data.total) * 100;
        progressFill.style.width = `${percentage}%`;
        progressText.textContent = `${data.current}/${data.total}`;
        progressStats.textContent = `✅ ${data.success} | ❌ ${data.errors}`;
    }

    completeBulkSend(data) {
        setTimeout(() => {
            alert(`Envío masivo completado!\n✅ Exitosos: ${data.success}\n❌ Errores: ${data.errors}`);
            document.getElementById('bulk-progress').style.display = 'none';
            
            // Limpiar formulario
            document.getElementById('bulk-numbers').value = '';
            document.getElementById('bulk-message').value = '';
        }, 1000);
    }

    showError(error) {
        alert(`Error: ${error}`);
    }

    updateStatus(status) {
        console.log('Status:', status);
    }
}

// Global functions
function showSection(sectionName) {
    document.querySelectorAll('.section').forEach(section => {
        section.classList.remove('active');
    });
    document.getElementById(`${sectionName}-section`).classList.add('active');

    document.querySelectorAll('.menu-btn').forEach(btn => {
        btn.classList.remove('active');
    });
    event.currentTarget.classList.add('active');
}

function clearChat() {
    if (confirm('¿Estás seguro de que quieres limpiar el chat?')) {
        const container = document.getElementById('messages-container');
        container.innerHTML = `
            <div class="welcome-message">
                <i class="fas fa-comments"></i>
                <h3>Inicia la conversación</h3>
                <p>Envía un mensaje para comenzar a chatear</p>
            </div>
        `;
    }
}

function openNewChatModal() {
    if (whatsappUI) {
        whatsappUI.openNewChatModal();
    }
}

function closeNewChatModal() {
    if (whatsappUI) {
        whatsappUI.closeNewChatModal();
    }
}

function createNewChat() {
    if (whatsappUI) {
        whatsappUI.createNewChat();
    }
}

// Initialize
let whatsappUI;
document.addEventListener('DOMContentLoaded', () => {
    whatsappUI = new WhatsAppUI();
});