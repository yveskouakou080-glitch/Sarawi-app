const express = require('express');
const { SignJWT } = require('jose');
const bcrypt = require('bcryptjs');
const axios = require('axios');
const fs = require('fs');
const app = express();
app.use(express.json());

// ========== STOCKAGE JSON ==========
const DATA_FILE = './data.json';
function readData() {
    try { if (fs.existsSync(DATA_FILE)) return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch(e) {}
    return { users: [], nextId: 1 };
}
function writeData(data) { fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2)); }
function getUsers() { return readData().users; }
function addUser(user) { const d = readData(); user.id = d.nextId++; d.users.push(user); writeData(d); return user; }
function updateUser(email, updates) { const d = readData(); const idx = d.users.findIndex(u => u.email === email); if (idx !== -1) { d.users[idx] = { ...d.users[idx], ...updates }; writeData(d); return true; } return false; }
function findUserByEmail(email) { return getUsers().find(u => u.email === email); }

// ========== FEDAPAY ==========
const FEDAPAY_API_KEY = 'sk_sandbox_qvc_xPvQ6JpuUl7xPVkUha0X';
const FEDAPAY_API_URL = 'https://sandbox.api.fedapay.com/v1';

// ========== ADMIN ==========
const ADMIN_PASSWORD = 'admin123';

function verifyAdminToken(req, res, next) {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Token requis' });
    try {
        const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString());
        if (payload.role === 'admin') { req.admin = payload; next(); }
        else res.status(403).json({ error: 'Accès refusé' });
    } catch(e) { res.status(400).json({ error: 'Token invalide' }); }
}

// ========== ADMIN ROUTES ==========
app.get('/admin', (req, res) => {
    res.send(`<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Admin Sarawi</title>
<style>body{font-family:sans-serif;background:#f0f2f5;padding:10px}.container{max-width:1200px;margin:auto;background:#fff;border-radius:12px;padding:15px}.login-form{max-width:300px;margin:30px auto}input,button{width:100%;padding:8px;margin:5px 0;border-radius:8px;border:1px solid #ccc}button{background:#3b82f6;color:#fff;border:none;cursor:pointer}table{width:100%;border-collapse:collapse;margin-top:15px;font-size:12px}th,td{border:1px solid #ddd;padding:6px;text-align:left}th{background:#3b82f6;color:#fff}.hidden{display:none}</style></head>
<body><div class="container"><h2>Admin Sarawi</h2><div id="loginDiv" class="login-form"><input type="password" id="adminPassword" placeholder="Mot de passe"><button onclick="loginAdmin()">Se connecter</button><div id="loginError" style="color:red"></div></div><div id="dashboardDiv" class="hidden"><button onclick="logoutAdmin()">Déconnexion</button><div id="usersList"></div></div></div>
<script>
async function loginAdmin(){
    const pwd=document.getElementById('adminPassword').value;
    const r=await fetch('/admin/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:pwd})});
    const d=await r.json();
    if(r.ok){
        localStorage.setItem('adminToken',d.token);
        document.getElementById('loginDiv').classList.add('hidden');
        document.getElementById('dashboardDiv').classList.remove('hidden');
        loadUsers();
    }else{
        document.getElementById('loginError').innerText=d.error;
    }
}
async function loadUsers(){
    const t=localStorage.getItem('adminToken');
    const r=await fetch('/admin/users',{headers:{'Authorization':'Bearer '+t}});
    const u=await r.json();
    if(r.ok){
        let h='<tr><th>ID</th><th>Email</th><th>Nom</th><th>Sexe</th><th>Solde</th><th>Date</th><th>Position</th></tr>';
        u.forEach(u=>{
            let lp='Non partagée';
            if(u.lastPosition) lp='<a href="https://www.google.com/maps?q='+u.lastPosition.lat+','+u.lastPosition.lng+'" target="_blank">Voir</a>';
            h+='<tr><td>'+u.id+'</td><td>'+u.email+'</td><td>'+u.nom+'</td><td>'+u.sexe+'</td><td>'+u.balance+'</td><td>'+new Date(u.createdAt).toLocaleString()+'</td><td>'+lp+'</td></tr>';
        });
        document.getElementById('usersList').innerHTML='<table border="1">'+h+'</table>';
    }else{
        document.getElementById('usersList').innerHTML='<p style="color:red">Erreur chargement</p>';
    }
}
function logoutAdmin(){
    localStorage.removeItem('adminToken');
    document.getElementById('loginDiv').classList.remove('hidden');
    document.getElementById('dashboardDiv').classList.add('hidden');
}
if(localStorage.getItem('adminToken')){
    document.getElementById('loginDiv').classList.add('hidden');
    document.getElementById('dashboardDiv').classList.remove('hidden');
    loadUsers();
}
</script></body></html>`);
});

app.post('/admin/login', async (req, res) => {
    if (req.body.password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Mot de passe incorrect' });
    const secret = new TextEncoder().encode('mon_secret_super_long');
    const token = await new SignJWT({ role: 'admin' }).setProtectedHeader({ alg: 'HS256' }).setIssuedAt().setExpirationTime('12h').sign(secret);
    res.json({ token });
});

app.get('/admin/users', verifyAdminToken, (req, res) => {
    const users = getUsers().map(u => ({
        id: u.id, email: u.email, nom: u.nom, sexe: u.sexe, balance: u.balance,
        createdAt: u.createdAt,
        lastPosition: u.positions?.length ? u.positions[u.positions.length-1] : null
    }));
    res.json(users);
});

// ========== RETRAIT ==========
app.post('/withdraw', async (req, res) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Token requis' });
    let email;
    try { email = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString()).email; } catch(e) { return res.status(400).json({ error: 'Token invalide' }); }
    const user = findUserByEmail(email);
    if (!user) return res.status(404).json({ error: 'Utilisateur non trouvé' });
    const { amount, phone } = req.body;
    if (!amount || amount <= 0) return res.status(400).json({ error: 'Montant invalide' });
    if (amount > user.balance) return res.status(400).json({ error: 'Solde insuffisant' });
    try {
        const response = await axios.post(`${FEDAPAY_API_URL}/transactions`, {
            amount, currency: 'XOF', description: `Retrait ${amount} FCFA`,
            customer: { email: user.email, phone_number: phone || '00000000' },
            callback_url: 'https://votre-site.com/callback'
        }, { headers: { 'Authorization': `Bearer ${FEDAPAY_API_KEY}`, 'Content-Type': 'application/json' } });
        if (response.data && response.data.id) {
            const newBalance = user.balance - amount;
            updateUser(email, { balance: newBalance });
            user.transactions = user.transactions || [];
            user.transactions.push({ type: 'withdraw', amount, date: new Date().toISOString(), fedapay_id: response.data.id });
            updateUser(email, { transactions: user.transactions });
            res.json({ success: true, message: `Retrait de ${amount} FCFA effectué. Nouveau solde: ${newBalance} FCFA` });
        } else {
            throw new Error('Réponse FedaPay invalide');
        }
    } catch(error) {
        console.error('Erreur FedaPay:', error.response?.data || error.message);
        res.status(500).json({ error: 'Erreur lors du retrait' });
    }
});

// ========== PAGE PRINCIPALE ==========
app.get('/', (req, res) => {
    res.send(`<!DOCTYPE html>
<html lang="fr"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1"><title>Sarawi</title>
<style>
*{margin:0;padding:0;box-sizing:border-box;font-family:system-ui}
body{background:#f5f7fa;display:flex;justify-content:center;align-items:center;min-height:100vh;padding:8px}
.container{background:#fff;border-radius:24px;padding:20px;max-width:480px;width:100%;box-shadow:0 4px 12px rgba(0,0,0,0.05)}
h1{font-size:26px;text-align:center;font-weight:600;margin-bottom:2px}
.sub{text-align:center;color:#666;font-size:14px;margin-bottom:16px}
.toggle-buttons{display:flex;gap:8px;margin-bottom:20px}
.toggle-btn{flex:1;background:#eef2f6;border-radius:40px;padding:10px;text-align:center;cursor:pointer;font-weight:500;transition:0.2s}
.toggle-btn.active{background:#3b82f6;color:#fff}
.hidden{display:none}
.form-group{margin-bottom:14px}
label{display:block;font-size:13px;font-weight:500;margin-bottom:4px;color:#333}
input,select{width:100%;padding:12px 14px;font-size:15px;border:1px solid #d1d5db;border-radius:12px;background:#fff;transition:0.2s}
input:focus,select:focus{border-color:#3b82f6;outline:none;box-shadow:0 0 0 3px rgba(59,130,246,0.2)}
button{width:100%;padding:14px;background:#3b82f6;color:#fff;border:none;border-radius:40px;font-size:16px;font-weight:600;cursor:pointer;transition:0.2s}
button:hover{background:#2563eb}
.switch{text-align:center;margin-top:14px;font-size:14px}
.switch a{color:#3b82f6;text-decoration:none;font-weight:500}
.success-msg{background:#e6fffa;color:#234e52;padding:12px;border-radius:12px;margin-top:12px;font-size:14px;border-left:4px solid #0d9488}
.error-msg{background:#fee2e2;color:#991b1b;padding:12px;border-radius:12px;margin-top:12px;font-size:14px;border-left:4px solid #dc2626}
.dashboard{margin-top:20px;border-top:2px solid #f0f0f0;padding-top:16px}
.dashboard h3{font-size:18px;margin:0 0 10px 0}
.dashboard p{margin:6px 0;font-size:14px;display:flex;justify-content:space-between}
.dashboard p strong{font-weight:600}
.history{margin-top:12px}
.history-item{background:#f9fafb;padding:8px 12px;border-radius:8px;margin-bottom:6px;font-size:13px;display:flex;justify-content:space-between}
</style>
</head>
<body>
<div class="container">
    <h1>Sarawi</h1>
    <div class="sub">Votre espace sécurisé</div>
    <div class="toggle-buttons">
        <div class="toggle-btn active" id="showRegisterBtn">Inscription</div>
        <div class="toggle-btn" id="showLoginBtn">Connexion</div>
    </div>
    <div id="registerForm">
        <div class="form-group"><label>Email Gmail</label><input type="email" id="regEmail" placeholder="exemple@gmail.com"></div>
        <div class="form-group"><label>Nom complet</label><input type="text" id="regNom" placeholder="Votre nom"></div>
        <div class="form-group"><label>Sexe</label><select id="regSexe"><option value="masculin">Masculin</option><option value="feminin">Féminin</option></select></div>
        <div class="form-group"><label>Mot de passe (6+ lettres+chiffres)</label><input type="password" id="regPass" placeholder="●●●●●●"></div>
        <div class="form-group"><label>Confirmer le mot de passe</label><input type="password" id="regConfirmPass" placeholder="●●●●●●"></div>
        <button id="registerBtn">Créer mon compte</button>
        <div class="switch" id="switchToLogin">Déjà un compte ? <a href="#">Se connecter</a></div>
    </div>
    <div id="loginForm" class="hidden">
        <div class="form-group"><label>Email</label><input type="email" id="loginEmail" placeholder="exemple@gmail.com"></div>
        <div class="form-group"><label>Mot de passe</label><input type="password" id="loginPass" placeholder="●●●●●●"></div>
        <button id="loginBtn">Se connecter</button>
        <div class="switch" id="switchToRegister">Pas encore de compte ? <a href="#">S'inscrire</a></div>
    </div>
    <div id="result"></div>
    <div id="dashboard" class="dashboard hidden">
        <h3>Mon compte</h3>
        <p><span>Solde</span> <strong id="balance">0</strong> FCFA</p>
        <div class="form-group"><label>Montant à retirer (FCFA)</label><input type="number" id="withdrawAmount" placeholder="5000"></div>
        <div class="form-group"><label>Téléphone (optionnel)</label><input type="tel" id="withdrawPhone" placeholder="+225XXXXXXXX"></div>
        <button id="withdrawBtn">Retirer</button>
        <div id="withdrawResult"></div>
        <div class="history" id="historyContainer"><strong>Historique des retraits</strong><div id="historyList"></div></div>
    </div>
</div>
<script>
const registerDiv = document.getElementById('registerForm');
const loginDiv = document.getElementById('loginForm');
const dashboardDiv = document.getElementById('dashboard');
document.getElementById('showRegisterBtn').onclick = () => {
    registerDiv.classList.remove('hidden');
    loginDiv.classList.add('hidden');
    dashboardDiv.classList.add('hidden');
    document.getElementById('showRegisterBtn').classList.add('active');
    document.getElementById('showLoginBtn').classList.remove('active');
    document.getElementById('result').innerHTML = '';
};
document.getElementById('showLoginBtn').onclick = () => {
    registerDiv.classList.add('hidden');
    loginDiv.classList.remove('hidden');
    dashboardDiv.classList.add('hidden');
    document.getElementById('showLoginBtn').classList.add('active');
    document.getElementById('showRegisterBtn').classList.remove('active');
    document.getElementById('result').innerHTML = '';
};
document.getElementById('switchToLogin').onclick = (e) => { e.preventDefault(); document.getElementById('showLoginBtn').click(); };
document.getElementById('switchToRegister').onclick = (e) => { e.preventDefault(); document.getElementById('showRegisterBtn').click(); };

function speak(m) {
    if (window.speechSynthesis) {
        const u = new SpeechSynthesisUtterance(m);
        u.lang = 'fr-FR';
        window.speechSynthesis.cancel();
        window.speechSynthesis.speak(u);
    }
}
function getCurrentPosition() {
    return new Promise((resolve, reject) => {
        if (!navigator.geolocation) reject('Géolocalisation non supportée');
        else navigator.geolocation.getCurrentPosition(resolve, reject, { enableHighAccuracy: true, timeout: 10000 });
    });
}

document.getElementById('registerBtn').onclick = async () => {
    const email = document.getElementById('regEmail').value.trim();
    const nom = document.getElementById('regNom').value.trim();
    const sexe = document.getElementById('regSexe').value;
    const pass = document.getElementById('regPass').value;
    const confirm = document.getElementById('regConfirmPass').value;
    if (!email.endsWith('@gmail.com')) { speak('Email Gmail requis'); alert('Email Gmail requis'); return; }
    if (!nom) { speak('Nom requis'); alert('Nom requis'); return; }
    if (pass !== confirm) { speak('Mots de passe différents'); alert('Mots de passe différents'); return; }
    if (!/^(?=.*[A-Za-z])(?=.*\\d)[A-Za-z\\d]{6,}$/.test(pass)) { speak('Mot de passe trop faible'); alert('6+ caractères, lettres+chiffres'); return; }
    let location = null;
    try { const pos = await getCurrentPosition(); location = { lat: pos.coords.latitude, lng: pos.coords.longitude }; } catch(e) {}
    const res = await fetch('/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, nom, sexe, password: pass, location })
    });
    const data = await res.json();
    const resultDiv = document.getElementById('result');
    if (data.success) {
        resultDiv.innerHTML = '<div class="success-msg">' + data.message + '</div>';
        speak('Compte créé');
        setTimeout(() => document.getElementById('showLoginBtn').click(), 1500);
    } else {
        resultDiv.innerHTML = '<div class="error-msg">' + data.message + '</div>';
        speak(data.message);
    }
};

document.getElementById('loginBtn').onclick = async () => {
    const email = document.getElementById('loginEmail').value.trim();
    const pass = document.getElementById('loginPass').value;
    if (!email.endsWith('@gmail.com')) { speak('Email Gmail requis'); alert('Email Gmail requis'); return; }
    let location = null;
    try { const pos = await getCurrentPosition(); location = { lat: pos.coords.latitude, lng: pos.coords.longitude }; } catch(e) {}
    const res = await fetch('/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password: pass, location })
    });
    const data = await res.json();
    const resultDiv = document.getElementById('result');
    if (data.success) {
        resultDiv.innerHTML = '<div class="success-msg">Bienvenue ' + data.salutation + '</div>';
        localStorage.setItem('token', data.token);
        document.getElementById('balance').innerText = data.balance;
        dashboardDiv.classList.remove('hidden');
        if (data.transactions && data.transactions.length > 0) {
            let html = '';
            data.transactions.forEach(t => {
                html += '<div class="history-item"><span>' + new Date(t.date).toLocaleString() + '</span><span>' + t.type + ' ' + t.amount + ' FCFA</span></div>';
            });
            document.getElementById('historyList').innerHTML = html;
        } else {
            document.getElementById('historyList').innerHTML = '<div style="color:#999;font-size:13px;margin-top:6px">Aucun retrait effectué</div>';
        }
        speak('Bienvenue ' + data.salutation);
    } else {
        resultDiv.innerHTML = '<div class="error-msg">' + data.message + '</div>';
        speak(data.message);
    }
};

document.getElementById('withdrawBtn').onclick = async () => {
    const amount = document.getElementById('withdrawAmount').value;
    const phone = document.getElementById('withdrawPhone').value;
    if (!amount || amount <= 0) { alert('Montant invalide'); return; }
    const token = localStorage.getItem('token');
    if (!token) { alert('Connectez-vous'); return; }
    const wr = document.getElementById('withdrawResult');
    wr.innerHTML = 'Traitement en cours...';
    const start = Date.now();
    const res = await fetch('/withdraw', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
        body: JSON.stringify({ amount: parseInt(amount), phone })
    });
    const elapsed = (Date.now() - start) / 1000;
    const data = await res.json();
    if (res.ok) {
        wr.innerHTML = '<div class="success-msg">' + data.message + ' (temps: ' + elapsed + 's)</div>';
        document.getElementById('balance').innerText = parseFloat(document.getElementById('balance').innerText) - parseInt(amount);
        speak('Retrait effectué');
        setTimeout(() => window.location.reload(), 2000);
    } else {
        wr.innerHTML = '<div class="error-msg">' + (data.error || 'Erreur') + '</div>';
        speak('Échec du retrait');
    }
};

if (localStorage.getItem('token')) {
    document.getElementById('showLoginBtn').click();
    document.getElementById('loginBtn').click();
}
</script>
</body></html>`);
});

// ========== API INSCRIPTION ==========
app.post('/register', async (req, res) => {
    const { email, nom, sexe, password, location } = req.body;
    if (!email?.endsWith('@gmail.com')) return res.status(400).json({ success: false, message: 'Email Gmail requis' });
    if (!/^(?=.*[A-Za-z])(?=.*\d)[A-Za-z\d]{6,}$/.test(password)) return res.status(400).json({ success: false, message: 'Mot de passe faible' });
    if (findUserByEmail(email)) return res.status(409).json({ success: false, message: 'Email déjà utilisé' });
    const hashed = await bcrypt.hash(password, 12);
    const user = {
        id: null,
        email, nom, sexe,
        password: hashed,
        balance: 100000,
        positions: location ? [location] : [],
        transactions: [],
        createdAt: new Date().toISOString()
    };
    addUser(user);
    const salutation = (sexe === 'masculin') ? `Mr ${nom}` : `Mme ${nom}`;
    res.json({ success: true, message: `Compte créé ! Bienvenue ${salutation}. Solde: ${user.balance} FCFA.`, salutation });
});

// ========== API CONNEXION ==========
app.post('/login', async (req, res) => {
    const { email, password, location } = req.body;
    const user = findUserByEmail(email);
    if (!user || !(await bcrypt.compare(password, user.password))) {
        return res.status(401).json({ success: false, message: 'Email ou mot de passe incorrect' });
    }
    if (location) {
        user.positions = user.positions || [];
        user.positions.push(location);
        if (user.positions.length > 10) user.positions.shift();
        updateUser(email, { positions: user.positions });
    }
    const secret = new TextEncoder().encode('mon_secret_super_long');
    const token = await new SignJWT({ id: user.id, email: user.email, nom: user.nom, sexe: user.sexe })
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuedAt()
        .setExpirationTime('24h')
        .sign(secret);
    const salutation = (user.sexe === 'masculin') ? `Mr ${user.nom}` : `Mme ${user.nom}`;
    const lastPosition = user.positions?.length ? user.positions[user.positions.length-1] : null;
    res.json({
        success: true,
        message: 'Connexion réussie',
        token,
        salutation,
        lastPosition,
        balance: user.balance,
        transactions: user.transactions || []
    });
});

// ========== DÉMARRAGE ==========
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log(`✅ Serveur Sarawi prêt sur http://127.0.0.1:${PORT}`));
