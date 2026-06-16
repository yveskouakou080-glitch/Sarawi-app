const express = require('express');
const { SignJWT } = require('jose');
const bcrypt = require('bcryptjs');
const axios = require('axios');
const crypto = require('crypto');
const fs = require('fs');
const app = express();
app.use(express.json());

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
function findUserBySponsorCode(code) { return getUsers().find(u => u.sponsorCode === code); }
async function generateUniqueSponsorCode() { let code, exists = true; while (exists) { code = 'SAR-' + crypto.randomBytes(3).toString('hex').toUpperCase(); exists = !!findUserBySponsorCode(code); } return code; }

const ADMIN_PASSWORD = 'admin123';
const FEDAPAY_API_KEY = 'sk_sandbox_qvc_xPvQ6JpuUl7xPVkUha0X'; // sandbox

function verifyAdminToken(req, res, next) {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Token requis' });
    try {
        const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString());
        if (payload.role === 'admin') { req.admin = payload; next(); }
        else res.status(403).json({ error: 'Accès refusé' });
    } catch(e) { res.status(400).json({ error: 'Token invalide' }); }
}

app.get('/admin', (req, res) => {
    res.send(`<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>Admin Sarawi</title><style>body{font-family:sans-serif;background:#f0f2f5;padding:20px}.container{max-width:1200px;margin:auto;background:#fff;border-radius:20px;padding:20px}.login-form{max-width:300px;margin:50px auto}input,button{width:100%;padding:10px;margin:8px 0;border-radius:10px}button{background:#3b82f6;color:#fff;border:none;cursor:pointer}table{width:100%;border-collapse:collapse;margin-top:20px}th,td{border:1px solid #ddd;padding:8px;text-align:left}th{background:#3b82f6;color:#fff}.hidden{display:none}</style></head>
<body><div class="container"><h1>Admin</h1><div id="loginDiv" class="login-form"><input type="password" id="adminPassword" placeholder="Mot de passe"><button onclick="loginAdmin()">Se connecter</button><div id="loginError"></div></div><div id="dashboardDiv" class="hidden"><button onclick="logoutAdmin()">Déconnexion</button><div id="usersList"></div></div></div>
<script>async function loginAdmin(){const pwd=document.getElementById('adminPassword').value;const r=await fetch('/admin/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:pwd})});const d=await r.json();if(r.ok){localStorage.setItem('adminToken',d.token);document.getElementById('loginDiv').classList.add('hidden');document.getElementById('dashboardDiv').classList.remove('hidden');loadUsers();}else{document.getElementById('loginError').innerText=d.error;}}
async function loadUsers(){const t=localStorage.getItem('adminToken');const r=await fetch('/admin/users',{headers:{'Authorization':'Bearer '+t}});const u=await r.json();if(r.ok){let h='赶<th>ID</th><th>Email</th><th>Nom</th><th>Sexe</th><th>Solde</th><th>Code parrainage</th><th>Date</th><th>Position</th></tr>';u.forEach(u=>{let lp='Non partagée';if(u.lastPosition) lp='<a href="https://www.google.com/maps?q='+u.lastPosition.lat+','+u.lastPosition.lng+'" target="_blank">Voir</a>';h+='<tr><td>'+u.id+'</td><td>'+u.email+'</td><td>'+u.nom+'</td><td>'+u.sexe+'</td><td>'+u.balance+'</td><td>'+u.sponsorCode+'</td><td>'+new Date(u.createdAt).toLocaleString()+'</td><td>'+lp+'</td></tr>';});h+='</table>';document.getElementById('usersList').innerHTML='<table border="1">'+h+'赶';}else{document.getElementById('usersList').innerHTML='Erreur';}}
function logoutAdmin(){localStorage.removeItem('adminToken');document.getElementById('loginDiv').classList.remove('hidden');document.getElementById('dashboardDiv').classList.add('hidden');}
if(localStorage.getItem('adminToken')){document.getElementById('loginDiv').classList.add('hidden');document.getElementById('dashboardDiv').classList.remove('hidden');loadUsers();}
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
        sponsorCode: u.sponsorCode, createdAt: u.createdAt,
        lastPosition: u.positions?.length ? u.positions[u.positions.length-1] : null
    }));
    res.json(users);
});

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
        await axios.post('https://sandbox.api.fedapay.com/v1/transactions', {
            amount, currency: 'XOF', description: 'Retrait',
            customer: { email: user.email, phone_number: phone || '00000000' },
            callback_url: 'https://votre-site.com/callback'
        }, { headers: { 'Authorization': `Bearer ${FEDAPAY_API_KEY}`, 'Content-Type': 'application/json' } });
        const newBalance = user.balance - amount;
        updateUser(email, { balance: newBalance });
        res.json({ success: true, message: `Retrait de ${amount} FCFA effectué. Nouveau solde: ${newBalance} FCFA` });
    } catch(e) { res.status(500).json({ error: 'Erreur FedaPay' }); }
});

app.get('/', (req, res) => {
    res.send(`<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sarawi</title><style>body{background:#f5f7fb;display:flex;justify-content:center;align-items:center;min-height:100vh;padding:12px}.container{background:#fff;border-radius:28px;padding:20px;max-width:400px}.form-group{margin-bottom:14px}input,select{width:100%;padding:12px;border-radius:14px;border:1px solid #ccc}button{width:100%;background:#3b82f6;color:#fff;border:none;border-radius:40px;padding:12px;margin-top:8px}.toggle-buttons{display:flex;gap:10px;margin-bottom:20px}.toggle-btn{flex:1;background:#f1f5f9;border-radius:40px;padding:8px;text-align:center;cursor:pointer}.active{background:#3b82f6;color:#fff}.hidden{display:none}.success-msg{background:#e6fffa;color:#234e52;padding:10px;border-radius:14px;margin-top:16px}.error-msg{background:#ffe6e6;color:#c00;padding:10px;border-radius:14px;margin-top:16px}</style></head>
<body><div class="container"><h1>Inscription</h1><div class="toggle-buttons"><div class="toggle-btn active" id="showRegisterBtn">S'inscrire</div><div class="toggle-btn" id="showLoginBtn">Se connecter</div></div>
<div id="registerForm"><div class="form-group"><label>Email Gmail</label><input type="email" id="regEmail"></div><div class="form-group"><label>Nom</label><input type="text" id="regNom"></div><div class="form-group"><label>Sexe</label><select id="regSexe"><option value="masculin">Masculin</option><option value="feminin">Féminin</option></select></div><div class="form-group"><label>Mot de passe (6+ lettres+chiffres)</label><input type="password" id="regPass"></div><div class="form-group"><label>Confirmer</label><input type="password" id="regConfirmPass"></div><div class="form-group"><label>Code promo</label><input type="text" id="regCode" placeholder="MITCHE99"></div><div class="form-group"><label>Code parrainage (optionnel)</label><input type="text" id="regSponsor"></div><div class="form-group"><label>Captcha: <span id="captchaOp1">5</span> + <span id="captchaOp2">3</span> = ?</label><input type="number" id="captchaAnswer"></div><button id="registerBtn">Créer mon compte</button><div id="switchToLogin">Déjà un compte ? Se connecter</div></div>
<div id="loginForm" class="hidden"><div class="form-group"><label>Email</label><input type="email" id="loginEmail"></div><div class="form-group"><label>Mot de passe</label><input type="password" id="loginPass"></div><button id="loginBtn">Se connecter</button><div id="switchToRegister">Pas encore de compte ? S'inscrire</div></div>
<div id="result"></div>
<div id="dashboard" class="hidden"><h3>Mon compte</h3><p>Solde: <strong id="balance">0</strong> FCFA</p><p>Mon code parrainage: <strong id="mySponsorCode"></strong></p><div class="form-group"><label>Montant à retirer (FCFA)</label><input type="number" id="withdrawAmount"></div><button id="withdrawBtn">Retirer</button><div id="withdrawResult"></div></div></div>
<script>
let operand1, operand2, captchaResult;
function generateCaptcha(){ operand1 = Math.floor(Math.random()*10)+1; operand2 = Math.floor(Math.random()*10)+1; captchaResult = operand1+operand2; document.getElementById('captchaOp1').innerText=operand1; document.getElementById('captchaOp2').innerText=operand2; }
generateCaptcha();
function speak(m){ if(window.speechSynthesis){ let u=new SpeechSynthesisUtterance(m); u.lang='fr-FR'; window.speechSynthesis.cancel(); window.speechSynthesis.speak(u); } }
function getCurrentPosition(){ return new Promise((res,rej)=>navigator.geolocation.getCurrentPosition(res,rej,{enableHighAccuracy:true,timeout:10000})); }
const registerDiv=document.getElementById('registerForm'), loginDiv=document.getElementById('loginForm'), dashboardDiv=document.getElementById('dashboard');
document.getElementById('showRegisterBtn').onclick=()=>{ registerDiv.classList.remove('hidden'); loginDiv.classList.add('hidden'); dashboardDiv.classList.add('hidden'); generateCaptcha(); };
document.getElementById('showLoginBtn').onclick=()=>{ registerDiv.classList.add('hidden'); loginDiv.classList.remove('hidden'); dashboardDiv.classList.add('hidden'); };
document.getElementById('switchToLogin').onclick=()=>document.getElementById('showLoginBtn').click();
document.getElementById('switchToRegister').onclick=()=>document.getElementById('showRegisterBtn').click();
document.getElementById('registerBtn').onclick=async()=>{
    let email=document.getElementById('regEmail').value.trim(), nom=document.getElementById('regNom').value.trim(), sexe=document.getElementById('regSexe').value, pass=document.getElementById('regPass').value, confirm=document.getElementById('regConfirmPass').value, code=document.getElementById('regCode').value.trim(), sponsor=document.getElementById('regSponsor').value.trim();
    let captcha=parseInt(document.getElementById('captchaAnswer').value);
    if(captcha!==captchaResult){ speak("Captcha incorrect"); alert("Captcha incorrect"); generateCaptcha(); return; }
    if(!email.endsWith('@gmail.com')){ speak("Email Gmail requis"); alert("Email Gmail requis"); return; }
    if(pass!==confirm){ speak("Mots de passe différents"); alert("Mots de passe différents"); return; }
    if(!/^(?=.*[A-Za-z])(?=.*\\d)[A-Za-z\\d]{6,}$/.test(pass)){ speak("Mot de passe trop faible"); alert("6+ caractères, lettres+chiffres"); return; }
    if(code!=='MITCHE99'){ speak("Code promo invalide"); alert("Code promo invalide"); return; }
    let location=null; try{ const pos=await getCurrentPosition(); location={lat:pos.coords.latitude,lng:pos.coords.longitude}; }catch(e){}
    const res=await fetch('/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email,nom,sexe,password:pass,codePromo:code,location,sponsorCode:sponsor})});
    const data=await res.json();
    if(data.success){ document.getElementById('result').innerHTML='<div class="success-msg">'+data.message+'</div>'; speak("Compte créé"); setTimeout(()=>document.getElementById('showLoginBtn').click(),1500); }
    else{ document.getElementById('result').innerHTML='<div class="error-msg">'+data.message+'</div>'; speak(data.message); }
};
document.getElementById('loginBtn').onclick=async()=>{
    let email=document.getElementById('loginEmail').value.trim(), pass=document.getElementById('loginPass').value;
    if(!email.endsWith('@gmail.com')){ speak("Email Gmail requis"); alert("Email Gmail requis"); return; }
    let location=null; try{ const pos=await getCurrentPosition(); location={lat:pos.coords.latitude,lng:pos.coords.longitude}; }catch(e){}
    const res=await fetch('/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email,password:pass,location})});
    const data=await res.json();
    if(data.success){ document.getElementById('result').innerHTML='<div class="success-msg">Bienvenue '+data.salutation+'</div>'; localStorage.setItem('token',data.token); document.getElementById('balance').innerText=data.balance; document.getElementById('mySponsorCode').innerText=data.sponsorCode; dashboardDiv.classList.remove('hidden'); speak('Bienvenue '+data.salutation); }
    else{ document.getElementById('result').innerHTML='<div class="error-msg">'+data.message+'</div>'; speak(data.message); }
};
document.getElementById('withdrawBtn').onclick=async()=>{
    let amount=document.getElementById('withdrawAmount').value, phone=document.getElementById('withdrawPhone')?.value||'';
    if(!amount||amount<=0){ alert("Montant invalide"); return; }
    let token=localStorage.getItem('token'); if(!token){ alert("Connectez-vous"); return; }
    let wr=document.getElementById('withdrawResult'); wr.innerHTML='Traitement...';
    let start=Date.now();
    let res=await fetch('/withdraw',{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+token},body:JSON.stringify({amount:parseInt(amount),phone})});
    let elapsed=(Date.now()-start)/1000; let data=await res.json();
    if(res.ok){ wr.innerHTML='<div class="success-msg">'+data.message+' (temps: '+elapsed+'s)</div>'; document.getElementById('balance').innerText=parseFloat(document.getElementById('balance').innerText)-parseInt(amount); speak("Retrait effectué"); }
    else{ wr.innerHTML='<div class="error-msg">Erreur</div>'; speak("Échec du retrait"); }
};
</script></body></html>`);
});

app.post('/register', async (req, res) => {
    const { email, nom, sexe, password, codePromo, location, sponsorCode } = req.body;
    if (codePromo !== 'MITCHE99') return res.status(400).json({ success: false, message: 'Code promo invalide' });
    if (!email?.endsWith('@gmail.com')) return res.status(400).json({ success: false, message: 'Email Gmail requis' });
    if (!/^(?=.*[A-Za-z])(?=.*\d)[A-Za-z\d]{6,}$/.test(password)) return res.status(400).json({ success: false, message: 'Mot de passe faible' });
    if (findUserByEmail(email)) return res.status(409).json({ success: false, message: 'Email déjà utilisé' });
    let parrainEmail = null, bonusParrain = 0, bonusFilleul = 0;
    if (sponsorCode) {
        const parrain = findUserBySponsorCode(sponsorCode);
        if (parrain) {
            parrainEmail = parrain.email;
            bonusParrain = 5000;
            bonusFilleul = 2500;
            parrain.balance += bonusParrain;
            updateUser(parrain.email, { balance: parrain.balance });
        } else return res.status(400).json({ success: false, message: 'Code parrainage invalide' });
    }
    const hashed = await bcrypt.hash(password, 12);
    const sponsorCodeNew = await generateUniqueSponsorCode();
    const initialBalance = 100000 + bonusFilleul;
    addUser({
        email, nom, sexe, password: hashed, codePromo, sponsorCode: sponsorCodeNew,
        balance: initialBalance, positions: location ? [location] : [], createdAt: new Date().toISOString(),
        transactions: []
    });
    const salutation = (sexe === 'masculin') ? `Mr ${nom}` : `Mme ${nom}`;
    let message = `Compte créé ! Bienvenue ${salutation}. Solde: ${initialBalance} FCFA.`;
    if (bonusFilleul) message += ` +${bonusFilleul} FCFA de parrainage.`;
    res.json({ success: true, message, salutation });
});

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
        sponsorCode: user.sponsorCode
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log(`✅ Serveur prêt sur http://127.0.0.1:${PORT}`));

