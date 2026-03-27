const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const jwt = require('jsonwebtoken');
const { google } = require('googleapis');

const app = express();

app.use(express.json());
app.use(express.static('public'));

// মডিউল কানেকশন
const { router: authRoutes, authenticateToken, JWT_SECRET } = require('./register');
app.use('/api/auth', authRoutes);

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'register.html')));
app.get('/chat', (req, res) => res.sendFile(path.join(__dirname, 'public', 'chat.html')));

const dbDir = path.join(__dirname, 'database');
const usersDataDir = path.join(dbDir, 'users_data');
const roomsDir = path.join(__dirname, 'rooms'); 
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir);
if (!fs.existsSync(usersDataDir)) fs.mkdirSync(usersDataDir);
if (!fs.existsSync(roomsDir)) fs.mkdirSync(roomsDir);

// ⚠️ Google Drive Setup
const DRIVE_MAIN_FOLDER_ID = '1z_UgrqPeBRC_zbX51rexF9Fi1F95Wiym'; 
let drive;
try {
    const credentials = JSON.parse(fs.readFileSync('./client_secret.json'));
    const { client_secret, client_id, redirect_uris } = credentials.installed || credentials.web;
    const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);
    oAuth2Client.setCredentials(JSON.parse(fs.readFileSync('./token.json')));
    drive = google.drive({ version: 'v3', auth: oAuth2Client });
} catch (err) { console.error("Drive Setup Error."); }

// Helpers
async function getOrCreateDriveFolder(folderName, parentId) {
    try {
        const query = `name='${folderName}' and mimeType='application/vnd.google-apps.folder' and '${parentId}' in parents and trashed=false`;
        const res = await drive.files.list({ q: query, fields: 'files(id, name)' });
        if (res.data.files.length > 0) return res.data.files[0].id; 
        const folder = await drive.files.create({ resource: { name: folderName, mimeType: 'application/vnd.google-apps.folder', parents: [parentId] }, fields: 'id' });
        return folder.data.id;
    } catch (err) { return parentId; }
}

async function syncFileToDrive(localFilePath, fileName, parentFolderId) {
    if (!fs.existsSync(localFilePath)) return;
    try {
        const res = await drive.files.list({ q: `name='${fileName}' and '${parentFolderId}' in parents and trashed=false`, fields: 'files(id)' });
        const media = { mimeType: 'application/json', body: fs.createReadStream(localFilePath) };
        if (res.data.files.length > 0) await drive.files.update({ fileId: res.data.files[0].id, media: media });
        else await drive.files.create({ resource: { name: fileName, parents: [parentFolderId] }, media: media, fields: 'id' });
    } catch(e) {}
}

function extractFileId(url) {
    if (!url) return "";
    if (url.includes('id=')) return url.match(/id=([a-zA-Z0-9_-]+)/)[1];
    return url.trim(); 
}

// ⚠️ Active Status Tracker (File Based)
const statusFile = path.join(dbDir, 'active_status.json');
if (!fs.existsSync(statusFile)) fs.writeFileSync(statusFile, JSON.stringify({}));

function updateActiveStatus(uid, username, isOnline) {
    let statuses = {};
    try { statuses = JSON.parse(fs.readFileSync(statusFile, 'utf8')); } catch(e) {}
    statuses[uid] = { uid, username, online: isOnline, lastSeen: Date.now() };
    fs.writeFileSync(statusFile, JSON.stringify(statuses, null, 2));
    return statuses;
}

// ==========================================
// 🚀 VERCEL READY APIs (No Socket.io)
// ==========================================

// Search User
app.post('/api/search-user', authenticateToken, (req, res) => {
    const { targetUid } = req.body;
    let db = JSON.parse(fs.readFileSync(path.join(dbDir, 'users.json'), 'utf8'));
    if (db.users[targetUid]) res.json({ success: true, name: db.users[targetUid].fullName });
    else res.json({ success: false });
});

// ১. ⚠️ CHAT SYNC (Polling API) - এটি প্রতি ২ সেকেন্ড পর পর ব্রাউজার থেকে কল হবে
app.post('/api/chat/sync', authenticateToken, (req, res) => {
    const { roomKey, uid, name } = req.body;
    
    // ইউজারকে অনলাইনে দেখানো
    const statuses = updateActiveStatus(uid, name, true);
    
    if(!roomKey) return res.json({ statuses });

    const chatFile = path.join(roomsDir, roomKey, 'history.json');
    let history = [];
    if (fs.existsSync(chatFile)) history = JSON.parse(fs.readFileSync(chatFile, 'utf8'));

    res.json({ history, statuses });
});

// ২. ⚠️ SEND MESSAGE API
app.post('/api/chat/send', authenticateToken, async (req, res) => {
    const { roomKey, uid, sender, message, type, url, replyTo } = req.body;
    const now = new Date();
    const dbMsg = { msgId: 'msg_' + Date.now(), senderId: uid, sender, message: message || "", type, url: extractFileId(url), time: now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: true }), date: now.toLocaleDateString(), seen: false, replyTo: replyTo || null };
    
    const localRoomDir = path.join(roomsDir, roomKey);
    if (!fs.existsSync(localRoomDir)) fs.mkdirSync(localRoomDir, { recursive: true });
    
    const masterFile = path.join(localRoomDir, 'history.json');
    let history = [];
    if (fs.existsSync(masterFile)) history = JSON.parse(fs.readFileSync(masterFile, 'utf8'));
    history.push(dbMsg);
    fs.writeFileSync(masterFile, JSON.stringify(history, null, 2));

    const uids = roomKey.split('_'); 
    uids.forEach(userUid => {
        const userFolder = path.join(usersDataDir, userUid, 'chats');
        if (!fs.existsSync(userFolder)) fs.mkdirSync(userFolder, { recursive: true });
        fs.writeFileSync(path.join(userFolder, `${roomKey}.json`), JSON.stringify(history, null, 2));
    });

    res.json({ success: true });
});

// ৩. ⚠️ MARK SEEN API
app.post('/api/chat/seen', authenticateToken, (req, res) => {
    const { roomKey, msgId } = req.body;
    const masterFile = path.join(roomsDir, roomKey, 'history.json');
    if (fs.existsSync(masterFile)) {
        let history = JSON.parse(fs.readFileSync(masterFile, 'utf8'));
        let updated = false;
        for (let i = history.length - 1; i >= 0; i--) {
            if (history[i].msgId === msgId && !history[i].seen) {
                history[i].seen = true; updated = true; break; 
            }
        }
        if (updated) {
            fs.writeFileSync(masterFile, JSON.stringify(history, null, 2));
            res.json({ success: true });
        } else res.json({ success: false });
    }
});

// ৪. ⚠️ STEALTH MEDIA API (GET Request for images/audio)
app.get('/api/media/:fileId', async (req, res) => {
    const token = req.query.token;
    if (!token) return res.status(401).send("Unauthorized");
    
    jwt.verify(token, JWT_SECRET, async (err) => {
        if (err) return res.status(403).send("Forbidden");
        try {
            const response = await drive.files.get({ fileId: req.params.fileId, alt: 'media' }, { responseType: 'stream' });
            res.setHeader('Content-Type', response.headers['content-type']);
            response.data.pipe(res); // ড্রাইভ থেকে সরাসরি ব্রাউজারে স্ট্রিম হবে
        } catch (error) { res.status(404).send("File not found"); }
    });
});

// ৫. ⚠️ MEDIA UPLOAD API
const upload = multer({ dest: 'uploads/' });
app.post('/upload', upload.single('file'), async (req, res) => {
    const { key: roomKey, uid } = req.body;
    if (!req.file || !roomKey || !uid) return res.status(400).json({ error: "Missing data!" });

    try {
        const folderType = req.file.mimetype.startsWith('audio/') ? 'voice' : 'media';
        const userMediaDir = path.join(usersDataDir, uid, folderType);
        if (!fs.existsSync(userMediaDir)) fs.mkdirSync(userMediaDir, { recursive: true });

        let fileName = req.file.originalname === 'blob' ? `voice_${Date.now()}.webm` : req.file.originalname;
        const localFilePath = path.join(userMediaDir, fileName);
        fs.renameSync(req.file.path, localFilePath);

        const dbId = await getOrCreateDriveFolder('Database', DRIVE_MAIN_FOLDER_ID);
        const udId = await getOrCreateDriveFolder('users_data', dbId);
        const userDriveFolder = await getOrCreateDriveFolder(uid, udId);
        const mediaDriveFolder = await getOrCreateDriveFolder(folderType, userDriveFolder);

        const driveFile = await drive.files.create({ 
            resource: { name: fileName, parents: [mediaDriveFolder] }, 
            media: { mimeType: req.file.mimetype, body: fs.createReadStream(localFilePath) }, fields: 'id' 
        });
        await drive.permissions.create({ fileId: driveFile.data.id, requestBody: { role: 'reader', type: 'anyone' } });

        if (fs.existsSync(localFilePath)) fs.unlinkSync(localFilePath); // পিসি থেকে ডিলিট
        res.json({ url: driveFile.data.id, type: req.file.mimetype });
    } catch (error) { res.status(500).json({ error: "Upload failed" }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 API SERVER RUNNING ON PORT ${PORT}`));