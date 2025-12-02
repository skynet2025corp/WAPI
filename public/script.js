class WhatsAppUI {
    constructor() {
        this.socket = io();
        this.chats = [];
        this.activeChat = null;
        this.setupEventListeners();
        this.setupSocketHandlers();
        // Add an initial section
        this.addSection();
        // Map to track statuses of numbers: key = `${sectionIndex}-${numberIndex}`
        this.sectionsStatus = new Map();
        this.lastGlobalSectionsProgress = { success: 0, errors: 0, current: 0 };
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

        // Event handlers for sections UI
        const addSectionBtn = document.getElementById('add-section-btn');
        if (addSectionBtn) addSectionBtn.addEventListener('click', () => this.addSection());
        // CSV file input for quick load
        const csvFile = document.getElementById('csv-file');
        if (csvFile) csvFile.addEventListener('change', (e) => this.handleCSVUpload(e));
        const sendSectionsBtn = document.getElementById('send-sections-btn');
        if (sendSectionsBtn) sendSectionsBtn.addEventListener('click', () => this.sendSections());
        const clearStatusBtn = document.getElementById('clear-status-btn');
        if (clearStatusBtn) clearStatusBtn.addEventListener('click', () => this.clearSectionsStatus());

        // Enter en el modal de nuevo chat
        document.getElementById('new-chat-number').addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                this.createNewChat();
            }
        });
    }

    handleCSVUpload(e) {
        const file = e.target.files && e.target.files[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = (evt) => {
            const text = evt.target.result;
            const rows = this.parseCSV(text);

            // Detect header row if first cell contains 'number' or 'número'
            let start = 0;
            if (rows.length > 0) {
                const header0 = (rows[0][0] || '').toString().toLowerCase();
                if (header0.includes('number') || header0.includes('número') || header0.includes('numero')) {
                    start = 1;
                }
            }

            const invalidRows = [];
            for (let i = start; i < rows.length; i++) {
                const row = rows[i];
                if (!row || row.length === 0) continue;
                const number = (row[0] || '').toString().trim();
                if (!number) {
                    invalidRows.push(i + 1);
                    continue;
                }
                const numOnly = number.replace(/[^0-9]/g, '');
                const numRegex = /^[0-9]{10,15}$/;
                if (!numRegex.test(numOnly)) {
                    invalidRows.push(i + 1);
                    continue;
                }
                const messages = row.slice(1).map(c => (c || '').toString().trim()).filter(Boolean);
                // If no messages present, add an empty message so user can edit
                this.addSection(numOnly, messages.length ? messages : ['']);
            }

            if (invalidRows.length > 0) {
                alert(`Se encontraron filas con números inválidos o vacíos: ${invalidRows.join(', ')} (números de fila)`);
            }

            // Reset the file input so the same file can be loaded again
            e.target.value = '';
        };
        reader.readAsText(file, 'UTF-8');
    }

    // Minimal CSV parser: handles quoted fields and commas
    parseCSV(text) {
        const rows = [];
        let current = [];
        let value = '';
        let i = 0;
        let inQuotes = false;
        while (i < text.length) {
            const ch = text[i];
            if (inQuotes) {
                if (ch === '"') {
                    if (text[i + 1] === '"') { // escaped quote
                        value += '"';
                        i += 2;
                        continue;
                    } else {
                        inQuotes = false;
                        i++;
                        continue;
                    }
                } else {
                    value += ch;
                    i++;
                    continue;
                }
            }

            if (ch === '"') {
                inQuotes = true;
                i++;
            } else if (ch === ',') {
                current.push(value);
                value = '';
                i++;
            } else if (ch === '\r') {
                // ignore
                i++;
            } else if (ch === '\n') {
                current.push(value);
                rows.push(current);
                current = [];
                value = '';
                i++;
            } else {
                value += ch;
                i++;
            }
        }
        // push remaining
        if (value !== '' || current.length > 0) {
            current.push(value);
            rows.push(current);
        }
        return rows;
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

        // Bulk / Sections progress events
        this.socket.on('bulk_start', (data) => { this.showBulkProgress(data); });
        this.socket.on('bulk_progress', (data) => { this.updateBulkProgress(data); });
        this.socket.on('bulk_complete', (data) => { this.completeBulkSend(data); });
        this.socket.on('sections_start', (data) => { this.showBulkProgress(data); });
        this.socket.on('sections_progress', (data) => {
            this.updateBulkProgress(data);
            this.updateSectionsStatusFromProgress(data);
        });
        this.socket.on('sections_complete', (data) => { this.completeBulkSend(data); });
        this.socket.on('sections_complete', (data) => { this.finalizeSectionsStatus(data); });

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
        console.warn('sendBulkMessage is deprecated, use sendSections() instead');
    }

    // New behavior: Sections mode -> each section contains one number and multiple messages
    addSection(numbers = [], messages = []) {
        const container = document.getElementById('sections-container');
        if (!container) return;

        const index = container.children.length;
        const section = document.createElement('div');
        section.className = 'section-item';
        section.dataset.index = index;
        section.innerHTML = `
            <div class="section-row">
                <div class="form-group small">
                    <label>Números (separados por coma)</label>
                    <input type="text" class="section-number" placeholder="1234567890,0987654321" value="${this.escapeHtml(Array.isArray(numbers) ? numbers.join(',') : numbers)}">
                    <input type="file" class="section-csv" accept=".csv" style="display:none;">
                    <label class="csv-section-label btn">Cargar CSV</label>
                </div>
                <div class="form-group small">
                    <label>Acciones</label>
                    <div>
                        <button class="btn btn-remove">Eliminar</button>
                    </div>
                </div>
            </div>
            <div class="form-group messages-block">
                <label>Mensajes (por subsección)</label>
                <div class="messages-controls">
                    <button class="btn btn-add-message">Agregar Mensaje</button>
                </div>
                <div class="section-messages-list"></div>
            </div>
        `;

        // Remove handler for section
        section.querySelector('.btn-remove').addEventListener('click', () => {
            section.remove();
        });

        // Add message button handler
        const addMsgBtn = section.querySelector('.btn-add-message');
        addMsgBtn.addEventListener('click', () => this.addMessageToSection(section));

        // CSV upload for numbers in this section
        const csvInput = section.querySelector('.section-csv');
        const csvLabel = section.querySelector('.csv-section-label');
        csvLabel.addEventListener('click', () => csvInput.click());
        csvInput.addEventListener('change', (e) => this.handleSectionCSVUpload(e, section));

        // Populate messages if passed (support string or array)
        if (typeof messages === 'string') {
            messages = messages.split(/\n+/).map(s => s.trim()).filter(Boolean);
        }
        if (Array.isArray(messages) && messages.length > 0) {
            messages.forEach(msg => this.addMessageToSection(section, msg));
        } else {
            // default: add a single empty message field
            this.addMessageToSection(section, '');
        }

        container.appendChild(section);
        // Auto-scroll to the added section
        container.scrollTop = container.scrollHeight;
    }

    handleSectionCSVUpload(e, section) {
        const file = e.target.files && e.target.files[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = (evt) => {
            const text = evt.target.result;
            const rows = this.parseCSV(text);

            const numbers = [];
            for (let i = 0; i < rows.length; i++) {
                const row = rows[i];
                if (!row || row.length === 0) continue;
                const rawNum = (row[0] || '').toString().trim();
                if (!rawNum) continue;
                const numOnly = rawNum.replace(/[^0-9]/g, '');
                const numRegex = /^[0-9]{10,15}$/;
                if (!numRegex.test(numOnly)) continue;
                numbers.push(numOnly);
            }

            if (numbers.length === 0) {
                alert('No se encontraron números válidos en el CSV');
                e.target.value = '';
                return;
            }

            const input = section.querySelector('.section-number');
            const existed = input.value ? input.value.split(/[,\s]+/).map(s=>s.trim()).filter(Boolean) : [];
            const merged = Array.from(new Set([...existed, ...numbers]));
            input.value = merged.join(',');

            e.target.value = '';
        };
        reader.readAsText(file, 'UTF-8');
    }

    // Add a message subitem to a section
    addMessageToSection(sectionElement, text = '') {
        const list = sectionElement.querySelector('.section-messages-list');
        if (!list) return;

        const item = document.createElement('div');
        item.className = 'section-message-item';
        item.innerHTML = `
            <textarea class="section-message-textarea" rows="2" placeholder="Escribe el mensaje...">${this.escapeHtml(text)}</textarea>
            <div class="msg-actions">
                <button class="btn btn-remove-message">Eliminar</button>
                <button class="btn btn-up">↑</button>
                <button class="btn btn-down">↓</button>
            </div>
        `;

        // Remove message handler
        item.querySelector('.btn-remove-message').addEventListener('click', () => {
            item.remove();
        });

        // Move up/down handlers
        item.querySelector('.btn-up').addEventListener('click', () => {
            const prev = item.previousElementSibling;
            if (prev) list.insertBefore(item, prev);
        });
        item.querySelector('.btn-down').addEventListener('click', () => {
            const next = item.nextElementSibling;
            if (next) list.insertBefore(next, item);
        });

        list.appendChild(item);
        // Auto-scroll to the new message at the bottom of the section
        list.scrollTop = list.scrollHeight;
    }

    sendSections() {
        const container = document.getElementById('sections-container');
        if (!container) {
            alert('No hay secciones disponibles');
            return;
        }

        const sectionNodes = [...container.querySelectorAll('.section-item')];
        if (sectionNodes.length === 0) {
            alert('Añade al menos una sección');
            return;
        }

        const sections = [];
        let totalMessages = 0;

        for (const node of sectionNodes) {
            const numbersStr = node.querySelector('.section-number').value.trim();
            const numbers = numbersStr.split(/[,\s]+/).map(n => n.trim()).filter(Boolean);
            // Read messages from subitems
            const messagesNodes = [...node.querySelectorAll('.section-message-textarea')];
            const messages = messagesNodes.map(n => n.value.trim()).filter(Boolean);

            if (!numbers || numbers.length === 0) {
                alert('Por favor ingresa al menos un número en todas las secciones');
                return;
            }
            const numRegex = /^[0-9]{10,15}$/;
            const invalidNum = numbers.find(n => !numRegex.test(n));
            if (invalidNum) {
                alert(`Número inválido: ${invalidNum}`);
                return;
            }

            // (messages variable already set from nodes)
            if (messages.length === 0) {
                alert(`Agrega al menos un mensaje para el número ${number}`);
                return;
            }

            sections.push({ numbers, messages });
            totalMessages += messages.length;
        }

        // Prepare and render status table
        this.prepareSectionsStatus(sections);
        this.renderSectionsStatusTable();

        // Emitir evento al servidor
        this.socket.emit('send_sections', { sections });
    }

    prepareSectionsStatus(sections) {
        // Reset status map
        this.sectionsStatus.clear();
        // Sections is array of {numbers:[], messages:[]}
        for (let si = 0; si < sections.length; si++) {
            const s = sections[si];
            const msgsLen = Array.isArray(s.messages) ? s.messages.length : 1;
            for (let ni = 0; ni < s.numbers.length; ni++) {
                const number = s.numbers[ni];
                const key = `${si}-${ni}`;
                this.sectionsStatus.set(key, {
                    sectionIndex: si,
                    numberIndex: ni,
                    number: number,
                    totalMessages: msgsLen,
                    success: 0,
                    errors: 0,
                    status: 'pending'
                });
            }
        }
    }

    clearSectionsStatus() {
        this.sectionsStatus.clear();
        this.renderSectionsStatusTable();
    }

    renderSectionsStatusTable() {
        const tbody = document.querySelector('#sections-status-table tbody');
        if (!tbody) return;
        tbody.innerHTML = '';
        for (const [key, st] of this.sectionsStatus.entries()) {
            const tr = document.createElement('tr');
            tr.dataset.key = key;
            tr.innerHTML = `
                <td>${st.sectionIndex + 1}</td>
                <td>${this.escapeHtml(st.number)}</td>
                <td>${st.totalMessages}</td>
                <td id="progress-${key}">${st.success}/${st.totalMessages}</td>
                <td id="status-${key}">${st.status}</td>
            `;
            tbody.appendChild(tr);
        }
    }

    updateSectionsStatusFromProgress(data) {
        // data provides sectionIndex and numberIndex
        if (typeof data.sectionIndex === 'undefined' || typeof data.numberIndex === 'undefined') {
            // If no per-number info, ignore
            return;
        }
        const key = `${data.sectionIndex}-${data.numberIndex}`;
        const st = this.sectionsStatus.get(key);
        if (!st) return;
        // Compute delta from last global counters to apply per-number updates when perNumber fields may be missing
        const last = this.lastGlobalSectionsProgress || { success: 0, errors: 0, current: 0 };
        const deltaSuccess = (typeof data.success !== 'undefined') ? data.success - last.success : 0;
        const deltaErrors = (typeof data.errors !== 'undefined') ? data.errors - last.errors : 0;

        // Update last global progress
        this.lastGlobalSectionsProgress = { success: (data.success || 0), errors: (data.errors || 0), current: (data.current || 0) };
        // If server includes sectionCurrent, and we are tracking, increment success when sectionCurrent increased and no error
        if (typeof data.sectionCurrent !== 'undefined') {
            // We'll mark as 'in-progress'
            st.status = 'in-progress';
            // Update per-number counters if server provides them
            // Update per-number counters if available
            if (typeof data.perNumberSuccess !== 'undefined') {
                st.success = data.perNumberSuccess;
            } else if (deltaSuccess > 0) {
                // apply delta heuristically to the current number
                st.success = (st.success || 0) + deltaSuccess;
            }
            if (typeof data.perNumberErrors !== 'undefined') {
                st.errors = data.perNumberErrors;
            } else if (deltaErrors > 0) {
                st.errors = (st.errors || 0) + deltaErrors;
            }
            if (st.success + st.errors >= st.totalMessages) {
                // All messages attempted for this number
                if (st.errors > 0) {
                    st.status = st.success > 0 ? 'partial' : 'failed';
                } else {
                    st.status = 'sent';
                }
            }
        }
        // Update table row
        this.sectionsStatus.set(key, st);
        this.updateSectionsStatusRow(key, st);
    }

    updateSectionsStatusRow(key, st) {
        const progressTd = document.getElementById(`progress-${key}`);
        const statusTd = document.getElementById(`status-${key}`);
        if (progressTd) progressTd.textContent = `${st.success}/${st.totalMessages}`;
        if (statusTd) statusTd.textContent = st.status;
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

        const percentage = (data.total > 0 ? (data.current / data.total) * 100 : 0);
        progressFill.style.width = `${percentage}%`;
        // Show overall progress
        progressText.textContent = `${data.current}/${data.total}`;
        // Show stats
        progressStats.textContent = `✅ ${data.success} | ❌ ${data.errors}`;

        // If there is section-specific detail, append it
        if (typeof data.sectionIndex !== 'undefined') {
            let sectionInfo = ` (Sección ${data.sectionIndex + 1}: ${data.sectionCurrent}/${data.sectionTotal})`;
            if (typeof data.numberIndex !== 'undefined' && data.number) {
                sectionInfo += ` - Nr ${data.numberIndex + 1}: ${data.number}`;
            }
            progressText.textContent += sectionInfo;
        }
    }

    completeBulkSend(data) {
        setTimeout(() => {
            alert(`Envío masivo completado!\n✅ Exitosos: ${data.success}\n❌ Errores: ${data.errors}`);
            document.getElementById('bulk-progress').style.display = 'none';
            
            // Limpiar formulario / Secciones
            const sectionsContainer = document.getElementById('sections-container');
            if (sectionsContainer) {
                sectionsContainer.innerHTML = '';
                // Add a fresh empty section
                this.addSection();
            }
        }, 1000);
    }

    finalizeSectionsStatus(data) {
        // Iterate all entries and finalize status if not already
        for (const [key, st] of this.sectionsStatus.entries()) {
            if (st.success + st.errors >= st.totalMessages) {
                // Already finalized
            } else {
                // If total messages > 0 and we have some success values, decide
                if (st.success === st.totalMessages) {
                    st.status = 'sent';
                } else if (st.success > 0 || st.errors > 0) {
                    st.status = 'partial';
                } else {
                    st.status = 'failed';
                }
            }
            this.updateSectionsStatusRow(key, st);
        }
        // Optionally, show a final summary
        console.log('✅ Finalized sections status');
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