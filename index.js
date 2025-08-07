const express = require('express');
const axios = require('axios');
const app = express();

// Armazenamento em memória (lista de pedidos PIX pendentes)
let pendingPixOrders = new Map();

// Sistema de logs das últimas 1 hora
let systemLogs = [];
const LOG_RETENTION_TIME = 60 * 60 * 1000; // 1 hora em millisegundos

// Configurações - ATUALIZADAS
const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL || 'https://n8n.flowzap.fun/webhook/0c4be879-b0ee-44bb-a29d-0ede2b2de454';
const PIX_TIMEOUT = 7 * 60 * 1000; // 7 minutos em millisegundos

app.use(express.json());

// Função para adicionar logs com timestamp
function addLog(type, message, data = null) {
    const logEntry = {
        timestamp: new Date().toISOString(),
        type: type, // 'info', 'success', 'error', 'webhook_received', 'webhook_sent', 'timeout'
        message: message,
        data: data
    };
    
    systemLogs.push(logEntry);
    console.log(`[${logEntry.timestamp}] ${type.toUpperCase()}: ${message}`);
    
    // Remove logs mais antigos que 1 hora
    const oneHourAgo = Date.now() - LOG_RETENTION_TIME;
    systemLogs = systemLogs.filter(log => new Date(log.timestamp).getTime() > oneHourAgo);
}

// Endpoint principal que recebe webhooks da Perfect
app.post('/webhook/perfect', async (req, res) => {
    try {
        const data = req.body;
        const orderCode = data.code;
        const status = data.sale_status_enum_key;
        const customerName = data.customer?.full_name || 'N/A';
        const amount = data.sale_amount || 0;
        
        addLog('webhook_received', `Webhook recebido - Pedido: ${orderCode} | Status: ${status} | Cliente: ${customerName} | Valor: R$ ${amount}`, {
            order_code: orderCode,
            status: status,
            customer: customerName,
            amount: amount,
            full_data: data
        });
        
        if (status === 'approved') {
            // VENDA APROVADA - Envia direto pro N8N (IMEDIATO)
            addLog('info', `✅ VENDA APROVADA - Processando pedido: ${orderCode}`);
            
            // Remove da lista de PIX pendentes se existir
            if (pendingPixOrders.has(orderCode)) {
                clearTimeout(pendingPixOrders.get(orderCode).timeout);
                pendingPixOrders.delete(orderCode);
                addLog('info', `🗑️ Removido da lista PIX pendente: ${orderCode}`);
            }
            
            // Envia webhook completo para N8N
            const sendResult = await sendToN8N(data, 'approved');
            
            if (sendResult.success) {
                addLog('success', `✅ VENDA APROVADA enviada com sucesso para N8N: ${orderCode}`);
            } else {
                addLog('error', `❌ ERRO ao enviar VENDA APROVADA para N8N: ${orderCode} - ${sendResult.error}`);
            }
            
        } else if (status === 'pending') {
            // PIX GERADO - Armazena e agenda timeout
            addLog('info', `⏳ PIX GERADO - Aguardando pagamento: ${orderCode} | Timeout: 7 minutos`);
            
            // Se já existe, cancela o timeout anterior
            if (pendingPixOrders.has(orderCode)) {
                clearTimeout(pendingPixOrders.get(orderCode).timeout);
                addLog('info', `🔄 Timeout anterior cancelado para: ${orderCode}`);
            }
            
            // Cria timeout de 7 minutos
            const timeout = setTimeout(async () => {
                addLog('timeout', `⏰ TIMEOUT de 7 minutos atingido para: ${orderCode} - Enviando PIX não pago`);
                
                // Remove da lista
                pendingPixOrders.delete(orderCode);
                
                // Envia webhook completo PIX não pago para N8N
                const sendResult = await sendToN8N(data, 'pix_timeout');
                
                if (sendResult.success) {
                    addLog('success', `✅ PIX TIMEOUT enviado com sucesso para N8N: ${orderCode}`);
                } else {
                    addLog('error', `❌ ERRO ao enviar PIX TIMEOUT para N8N: ${orderCode} - ${sendResult.error}`);
                }
                
            }, PIX_TIMEOUT);
            
            // Armazena na lista
            pendingPixOrders.set(orderCode, {
                data: data,
                timeout: timeout,
                timestamp: new Date(),
                customer_name: customerName,
                amount: amount
            });
            
            addLog('info', `📝 Pedido PIX armazenado: ${orderCode} | Cliente: ${customerName} | Valor: R$ ${amount}`);
            
        } else {
            // Status desconhecido
            addLog('info', `❓ Status desconhecido recebido: ${status} para pedido: ${orderCode}`);
        }
        
        res.status(200).json({ 
            success: true, 
            message: 'Webhook processado com sucesso',
            order_code: orderCode,
            status: status,
            processed_at: new Date().toISOString()
        });
        
    } catch (error) {
        addLog('error', `❌ ERRO ao processar webhook: ${error.message}`, { error: error.stack });
        res.status(500).json({ success: false, error: error.message });
    }
});

// Função para enviar dados para N8N
async function sendToN8N(data, eventType) {
    try {
        // Envia o webhook COMPLETO da Perfect + nosso event_type
        const payload = {
            ...data, // WEBHOOK COMPLETO DA PERFECT
            event_type: eventType, // 'approved' ou 'pix_timeout'
            processed_at: new Date().toISOString(),
            system_info: {
                source: 'perfect-webhook-system',
                version: '2.0'
            }
        };
        
        addLog('info', `🚀 Tentando enviar para N8N - Pedido: ${data.code} | Tipo: ${eventType} | URL: ${N8N_WEBHOOK_URL}`);
        
        const response = await axios.post(N8N_WEBHOOK_URL, payload, {
            headers: {
                'Content-Type': 'application/json',
                'User-Agent': 'Perfect-Webhook-System/2.0'
            },
            timeout: 15000 // 15 segundos de timeout
        });
        
        addLog('webhook_sent', `✅ Webhook enviado com SUCESSO para N8N - Pedido: ${data.code} | Tipo: ${eventType} | Status HTTP: ${response.status}`, {
            order_code: data.code,
            event_type: eventType,
            http_status: response.status,
            response_data: response.data
        });
        
        return { success: true, status: response.status, data: response.data };
        
    } catch (error) {
        const errorMessage = error.response ? 
            `HTTP ${error.response.status}: ${error.response.statusText}` : 
            error.message;
            
        addLog('error', `❌ ERRO ao enviar para N8N - Pedido: ${data.code} | Erro: ${errorMessage}`, {
            order_code: data.code,
            event_type: eventType,
            error: errorMessage,
            error_details: error.response?.data
        });
        
        return { success: false, error: errorMessage };
    }
}

// Endpoint para monitoramento completo
app.get('/status', (req, res) => {
    const pendingList = Array.from(pendingPixOrders.entries()).map(([code, order]) => ({
        code: code,
        customer_name: order.customer_name,
        amount: order.amount,
        created_at: order.timestamp,
        remaining_time: Math.max(0, PIX_TIMEOUT - (new Date() - order.timestamp))
    }));
    
    // Estatísticas dos logs da última hora
    const stats = {
        total_webhooks_received: systemLogs.filter(log => log.type === 'webhook_received').length,
        approved_received: systemLogs.filter(log => log.type === 'webhook_received' && log.data?.status === 'approved').length,
        pix_generated: systemLogs.filter(log => log.type === 'webhook_received' && log.data?.status === 'pending').length,
        webhooks_sent: systemLogs.filter(log => log.type === 'webhook_sent').length,
        timeouts_triggered: systemLogs.filter(log => log.type === 'timeout').length,
        errors: systemLogs.filter(log => log.type === 'error').length
    };
    
    res.json({
        system_status: 'online',
        timestamp: new Date().toISOString(),
        pending_pix_orders: pendingPixOrders.size,
        orders: pendingList,
        logs_last_hour: systemLogs,
        statistics: stats,
        n8n_webhook_url: N8N_WEBHOOK_URL
    });
});

// Endpoint para configurar URL do N8N
app.post('/config/n8n-url', (req, res) => {
    const { url } = req.body;
    if (url) {
        process.env.N8N_WEBHOOK_URL = url;
        addLog('info', `⚙️ URL do N8N atualizada para: ${url}`);
        res.json({ success: true, message: 'URL do N8N configurada' });
    } else {
        res.status(400).json({ success: false, message: 'URL não fornecida' });
    }
});

// Endpoint de health check
app.get('/health', (req, res) => {
    res.json({
        status: 'online',
        timestamp: new Date().toISOString(),
        pending_orders: pendingPixOrders.size,
        logs_count: systemLogs.length,
        uptime: process.uptime()
    });
});

// Interface web nova e clean - LINKS ATUALIZADOS
app.get('/', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>Webhook Vendas - Controle</title>
            <meta charset="utf-8">
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <style>
                * { margin: 0; padding: 0; box-sizing: border-box; }
                body { 
                    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; 
                    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                    min-height: 100vh;
                    padding: 20px;
                }
                .container { 
                    max-width: 1200px; 
                    margin: 0 auto; 
                    background: rgba(255, 255, 255, 0.95);
                    backdrop-filter: blur(10px);
                    border-radius: 20px; 
                    padding: 30px; 
                    box-shadow: 0 20px 40px rgba(0,0,0,0.1);
                    margin-bottom: 20px;
                }
                h1 { 
                    color: #2d3748; 
                    text-align: center; 
                    font-size: 2.5rem; 
                    font-weight: 700; 
                    margin-bottom: 40px;
                    background: linear-gradient(135deg, #667eea, #764ba2);
                    -webkit-background-clip: text;
                    -webkit-text-fill-color: transparent;
                    background-clip: text;
                }
                .section-title { 
                    color: #4a5568; 
                    font-size: 1.3rem; 
                    font-weight: 600; 
                    margin-bottom: 20px;
                    display: flex;
                    align-items: center;
                    border-bottom: 2px solid #e2e8f0;
                    padding-bottom: 10px;
                }
                .icon { 
                    width: 24px; 
                    height: 24px; 
                    margin-right: 10px; 
                    fill: currentColor;
                }
                .status-card { 
                    background: linear-gradient(135deg, #48bb78, #38a169);
                    color: white; 
                    padding: 20px; 
                    border-radius: 15px; 
                    margin-bottom: 30px;
                    box-shadow: 0 10px 25px rgba(72, 187, 120, 0.3);
                }
                .status-content {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    flex-wrap: wrap;
                    gap: 20px;
                }
                .status-item {
                    display: flex;
                    flex-direction: column;
                    align-items: center;
                    text-align: center;
                }
                .status-label {
                    font-size: 0.9rem;
                    opacity: 0.9;
                    margin-bottom: 5px;
                }
                .status-value {
                    font-size: 1.5rem;
                    font-weight: 700;
                }
                .stats-grid { 
                    display: grid; 
                    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); 
                    gap: 20px; 
                    margin-bottom: 30px; 
                }
                .stat-card { 
                    background: white;
                    border: 1px solid #e2e8f0;
                    padding: 25px; 
                    border-radius: 15px; 
                    text-align: center;
                    transition: all 0.3s ease;
                    position: relative;
                    overflow: hidden;
                }
                .stat-card::before {
                    content: '';
                    position: absolute;
                    top: 0;
                    left: 0;
                    right: 0;
                    height: 4px;
                    background: linear-gradient(90deg, #667eea, #764ba2);
                }
                .stat-card:hover {
                    transform: translateY(-5px);
                    box-shadow: 0 15px 35px rgba(0,0,0,0.1);
                }
                .stat-title { 
                    color: #718096; 
                    font-size: 0.9rem; 
                    font-weight: 500; 
                    margin-bottom: 10px;
                    text-transform: uppercase;
                    letter-spacing: 0.5px;
                }
                .stat-value { 
                    color: #2d3748; 
                    font-size: 2.5rem; 
                    font-weight: 700; 
                }
                .controls {
                    display: flex;
                    gap: 15px;
                    flex-wrap: wrap;
                    margin-bottom: 30px;
                }
                .btn { 
                    background: linear-gradient(135deg, #667eea, #764ba2);
                    color: white; 
                    border: none; 
                    padding: 12px 25px; 
                    border-radius: 25px; 
                    cursor: pointer; 
                    font-weight: 600;
                    font-size: 0.95rem;
                    transition: all 0.3s ease;
                    display: flex;
                    align-items: center;
                    gap: 8px;
                }
                .btn:hover { 
                    transform: translateY(-2px);
                    box-shadow: 0 10px 25px rgba(102, 126, 234, 0.4);
                }
                .btn-success { 
                    background: linear-gradient(135deg, #48bb78, #38a169);
                }
                .btn-success:hover {
                    box-shadow: 0 10px 25px rgba(72, 187, 120, 0.4);
                }
                .input-group {
                    display: flex;
                    gap: 15px;
                    align-items: center;
                    flex-wrap: wrap;
                    margin-bottom: 20px;
                }
                .form-input { 
                    flex: 1;
                    min-width: 300px;
                    padding: 12px 20px; 
                    border: 2px solid #e2e8f0; 
                    border-radius: 25px; 
                    font-size: 0.95rem;
                    transition: all 0.3s ease;
                    background: white;
                }
                .form-input:focus {
                    outline: none;
                    border-color: #667eea;
                    box-shadow: 0 0 0 3px rgba(102, 126, 234, 0.1);
                }
                .orders-list {
                    background: white;
                    border-radius: 15px;
                    overflow: hidden;
                    border: 1px solid #e2e8f0;
                }
                .order-item {
                    padding: 20px;
                    border-bottom: 1px solid #f7fafc;
                    transition: all 0.3s ease;
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    flex-wrap: wrap;
                    gap: 15px;
                }
                .order-item:hover {
                    background: #f8fafc;
                }
                .order-item:last-child {
                    border-bottom: none;
                }
                .order-info {
                    flex: 1;
                    min-width: 250px;
                }
                .order-code {
                    font-weight: 700;
                    font-size: 1.1rem;
                    color: #2d3748;
                    margin-bottom: 5px;
                }
                .order-details {
                    color: #718096;
                    font-size: 0.9rem;
                    line-height: 1.4;
                }
                .order-status {
                    padding: 8px 16px;
                    border-radius: 20px;
                    font-size: 0.85rem;
                    font-weight: 600;
                    text-transform: uppercase;
                    letter-spacing: 0.5px;
                }
                .status-pending {
                    background: linear-gradient(135deg, #fed7aa, #fb923c);
                    color: #c2410c;
                }
                .status-approved {
                    background: linear-gradient(135deg, #bbf7d0, #4ade80);
                    color: #166534;
                }
                .status-timeout {
                    background: linear-gradient(135deg, #fecaca, #f87171);
                    color: #991b1b;
                }
                .empty-state {
                    text-align: center;
                    padding: 60px 20px;
                    color: #718096;
                }
                .empty-icon {
                    width: 64px;
                    height: 64px;
                    margin: 0 auto 20px;
                    opacity: 0.5;
                }
                .loading {
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    padding: 40px;
                    color: #718096;
                }
                .spinner {
                    width: 24px;
                    height: 24px;
                    border: 3px solid #e2e8f0;
                    border-top: 3px solid #667eea;
                    border-radius: 50%;
                    animation: spin 1s linear infinite;
                    margin-right: 15px;
                }
                @keyframes spin {
                    0% { transform: rotate(0deg); }
                    100% { transform: rotate(360deg); }
                }
                @media (max-width: 768px) {
                    body { padding: 10px; }
                    .container { padding: 20px; }
                    h1 { font-size: 2rem; }
                    .stats-grid { grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); }
                    .order-item { flex-direction: column; align-items: flex-start; }
                    .form-input { min-width: 250px; }
                }
            </style>
        </head>
        <body>
            <div class="container">
                <h1>Webhook Vendas - Controle</h1>
                
                <div class="status-card">
                    <div class="status-content">
                        <div class="status-item">
                            <div class="status-label">Status</div>
                            <div class="status-value">Online</div>
                        </div>
                        <div class="status-item">
                            <div class="status-label">PIX Pendentes</div>
                            <div class="status-value" id="pending-count">0</div>
                        </div>
                        <div class="status-item">
                            <div class="status-label">Total Processados</div>
                            <div class="status-value" id="total-processed">0</div>
                        </div>
                    </div>
                </div>
                
                <div class="stats-grid">
                    <div class="stat-card">
                        <div class="stat-title">Webhooks Recebidos</div>
                        <div class="stat-value" id="total-received">0</div>
                    </div>
                    <div class="stat-card">
                        <div class="stat-title">Vendas Aprovadas</div>
                        <div class="stat-value" id="approved-count">0</div>
                    </div>
                    <div class="stat-card">
                        <div class="stat-title">PIX Gerados</div>
                        <div class="stat-value" id="pix-count">0</div>
                    </div>
                    <div class="stat-card">
                        <div class="stat-title">Enviados N8N</div>
                        <div class="stat-value" id="sent-count">0</div>
                    </div>
                    <div class="stat-card">
                        <div class="stat-title">Timeouts</div>
                        <div class="stat-value" id="timeout-count">0</div>
                    </div>
                    <div class="stat-card">
                        <div class="stat-title">Erros</div>
                        <div class="stat-value" id="error-count">0</div>
                    </div>
                </div>
                
                <div class="controls">
                    <button class="btn btn-success" onclick="refreshStatus()">
                        <svg class="icon" viewBox="0 0 24 24">
                            <path d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/>
                        </svg>
                        Atualizar
                    </button>
                </div>
            </div>
            
            <div class="container">
                <h2 class="section-title">
                    <svg class="icon" viewBox="0 0 24 24">
                        <path d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"/>
                        <path d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/>
                    </svg>
                    Configuração N8N
                </h2>
                <div class="input-group">
                    <input type="text" class="form-input" id="n8n-url" placeholder="https://n8n.flowzap.fun/webhook/..." value="${N8N_WEBHOOK_URL}" />
                    <button class="btn" onclick="saveN8nUrl()">
                        <svg class="icon" viewBox="0 0 24 24">
                            <path d="M8 4H6a2 2 0 00-2 2v12a2 2 0 002 2h12a2 2 0 002-2V6a2 2 0 00-2-2h-2m-4-1v8m0 0l3-3m-3 3L9 8"/>
                        </svg>
                        Salvar URL
                    </button>
                </div>
            </div>
            
            <div class="container">
                <h2 class="section-title">
                    <svg class="icon" viewBox="0 0 24 24">
                        <path d="M9 5H7a2 2 0 00-2 2v10a2 2 0 002 2h8a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"/>
                    </svg>
                    Lista de Pedidos
                </h2>
                <div class="orders-list" id="orders-container">
                    <div class="loading">
                        <div class="spinner"></div>
                        Carregando pedidos...
                    </div>
                </div>
            </div>
            
            <script>
                let allOrders = [];
                
                function refreshStatus() {
                    fetch('/status')
                        .then(r => r.json())
                        .then(data => {
                            // Atualiza contadores principais
                            document.getElementById('pending-count').textContent = data.pending_pix_orders;
                            document.getElementById('total-processed').textContent = data.statistics.total_webhooks_received;
                            
                            // Atualiza estatísticas
                            document.getElementById('total-received').textContent = data.statistics.total_webhooks_received;
                            document.getElementById('approved-count').textContent = data.statistics.approved_received;
                            document.getElementById('pix-count').textContent = data.statistics.pix_generated;
                            document.getElementById('sent-count').textContent = data.statistics.webhooks_sent;
                            document.getElementById('timeout-count').textContent = data.statistics.timeouts_triggered;
                            document.getElementById('error-count').textContent = data.statistics.errors;
                            
                            // Processa todos os pedidos dos logs
                            allOrders = processOrdersFromLogs(data.logs_last_hour, data.orders);
                            displayOrders(allOrders);
                        })
                        .catch(err => {
                            console.error('Erro ao buscar status:', err);
                            document.getElementById('orders-container').innerHTML = 
                                '<div class="empty-state"><div class="empty-icon">⚠️</div>Erro ao carregar dados</div>';
                        });
                }
                
                function processOrdersFromLogs(logs, pendingOrders) {
                    const ordersMap = new Map();
                    
                    // Adiciona pedidos pendentes
                    pendingOrders.forEach(order => {
                        ordersMap.set(order.code, {
                            code: order.code,
                            customer_name: order.customer_name,
                            amount: order.amount,
                            status: 'pending',
                            created_at: order.created_at,
                            remaining_time: order.remaining_time
                        });
                    });
                    
                    // Processa logs para encontrar outros pedidos
                    logs.forEach(log => {
                        if (log.type === 'webhook_received' && log.data) {
                            const orderCode = log.data.order_code;
                            const status = log.data.status;
                            
                            if (!ordersMap.has(orderCode)) {
                                ordersMap.set(orderCode, {
                                    code: orderCode,
                                    customer_name: log.data.customer || 'N/A',
                                    amount: log.data.amount || 0,
                                    status: status === 'approved' ? 'approved' : 'pending',
                                    created_at: log.timestamp,
                                    remaining_time: 0
                                });
                            }
                        }
                        
                        if (log.type === 'timeout' && log.message.includes('TIMEOUT de 7 minutos')) {
                            const match = log.message.match(/para: ([A-Z0-9]+)/);
                            if (match) {
                                const orderCode = match[1];
                                if (ordersMap.has(orderCode)) {
                                    ordersMap.get(orderCode).status = 'timeout';
                                }
                            }
                        }
                    });
                    
                    return Array.from(ordersMap.values())
                        .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
                }
                
                function displayOrders(orders) {
                    const container = document.getElementById('orders-container');
                    
                    if (orders.length === 0) {
                        container.innerHTML = 
                            '<div class="empty-state">' +
                            '<svg class="empty-icon" viewBox="0 0 24 24"><path d="M9 5H7a2 2 0 00-2 2v10a2 2 0 002 2h8a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"/></svg>' +
                            '<h3>Nenhum pedido encontrado</h3>' +
                            '<p>Os pedidos aparecerão aqui conforme forem processados</p>' +
                            '</div>';
                        return;
                    }
                    
                    container.innerHTML = orders.map(order => {
                        const statusClass = order.status === 'approved' ? 'status-approved' : 
                                          order.status === 'timeout' ? 'status-timeout' : 'status-pending';
                        const statusText = order.status === 'approved' ? 'Aprovado' : 
                                         order.status === 'timeout' ? 'Expirado' : 'Pendente';
                        
                        let timeInfo = '';
                        if (order.status === 'pending' && order.remaining_time > 0) {
                            const minutes = Math.floor(order.remaining_time / 1000 / 60);
                            timeInfo = '<br>Tempo restante: ' + minutes + ' min';
                        }
                        
                        return '<div class="order-item">' +
                               '<div class="order-info">' +
                               '<div class="order-code">' + order.code + '</div>' +
                               '<div class="order-details">' +
                               'Cliente: ' + order.customer_name + '<br>' +
                               'Valor: R$ ' + order.amount + '<br>' +
                               'Data: ' + new Date(order.created_at).toLocaleString() +
                               timeInfo +
                               '</div>' +
                               '</div>' +
                               '<div class="order-status ' + statusClass + '">' + statusText + '</div>' +
                               '</div>';
                    }).join('');
                }
                
                function saveN8nUrl() {
                    const url = document.getElementById('n8n-url').value;
                    fetch('/config/n8n-url', {
                        method: 'POST',
                        headers: {'Content-Type': 'application/json'},
                        body: JSON.stringify({url: url})
                    })
                    .then(r => r.json())
                    .then(data => {
                        alert(data.message);
                        if (data.success) refreshStatus();
                    });
                }
                
                // Atualiza automaticamente a cada 10 segundos
                setInterval(refreshStatus, 10000);
                
                // Carrega dados iniciais
                refreshStatus();
            </script>
        </body>
        </html>
    `);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    addLog('info', `🚀 Sistema Perfect Webhook v2.0 - CONTROLE iniciado na porta ${PORT}`);
    addLog('info', `📡 Webhook Perfect Pay: https://controle-webhook-perfect.flowzap.fun/webhook/perfect`);
    addLog('info', `🖥️ Interface Monitor: https://controle-webhook-perfect.flowzap.fun`);
    addLog('info', `🎯 N8N Webhook: ${N8N_WEBHOOK_URL}`);
    console.log(`🚀 Servidor CONTROLE rodando na porta ${PORT}`);
    console.log(`📡 Webhook URL Perfect: https://controle-webhook-perfect.flowzap.fun/webhook/perfect`);
    console.log(`🖥️ Interface Monitor: https://controle-webhook-perfect.flowzap.fun`);
    console.log(`🎯 N8N Webhook: ${N8N_WEBHOOK_URL}`);
});
