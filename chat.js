const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const { google } = require('googleapis');
const { Readable } = require('stream'); // Drive e memory theke upload er jonno lagbe

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Module Connection (register.js theke)
const { router: authRoutes, authenticateToken, JWT_SECRET } = require('./register');
app.use('/api/auth', authRoutes);

// MongoDB Chat Schemas (Text Message o Active Status er jonno)
const MessageSchema = new mongoose.Schema({
    roomKey: String,
    msgId: String,
    senderId: String,
    sender: String,
    message: String,
    type: String,
    url: String,
    time: String,
    date: String,
    seen: { type: Boolean, default: false },
    replyTo: Object
});
const Message = mongoose.model('Message', MessageSchema);

const StatusSchema = new mongoose.Schema({
    uid: { type: String, unique: true },
    username: String,
    online: Boolean,
    lastSeen: Number
});
const Status = mongoose.model('Status', StatusSchema);

// MongoDB User Model (register.js theke asbe)
const User = mongoose.model('User');

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'register.html')));
app.get('/chat', (req, res) => res.sendFile(path.join(__dirname, 'public', 'chat.html')));

// ⚠️ Google Drive Setup (Reading is fine on Vercel, writing is not)
const DRIVE_MAIN_FOLDER_ID = '1z_UgrqPeBRC_zbX51rexF9Fi1F95Wiym'; 
let drive;
try {
    const credentials = JSON.parse(fs.readFileSync(path.join(__dirname, 'client_secret.json')));
    const { client_secret, client_id, redirect_uris } = credentials.installed || credentials.web;
    const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);
    oAuth2Client.setCredentials(JSON.parse(fs.readFileSync(path.join(__dirname, 'token.json'))));
    drive = google.drive({ version: 'v3', auth: oAuth2Client });
    console.log("✅ Google Drive Connected");
} catch (err) { 
    console.error("❌ Google Drive Setup Error:", err.message); 
}

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

function extractFileId(url) {
    if (!url) return "";
    if (url.includes('id=')) return url.match(/id=([a-zA-Z0-9_-]+)/)[1];
    return url.trim(); 
}

async function updateActiveStatus(uid, username, isOnline) {
    const status = await Status.findOneAndUpdate(
        { uid },
        { username, online: isOnline, lastSeen: Date.now() },
        { upsert: true, new: true }
    );
    // Return all statuses for sync
    const allStatuses = await Status.find({});
    const statusMap = {};
    allStatuses.forEach(s => statusMap[s.uid] = s);
    return statusMap;
}

// ==========================================
// 🚀 VERCEL READY APIs
// ==========================================

// Search User (Now from MongoDB)
app.post('/api/search-user', authenticateToken, async (req, res) => {
    try {
        const { targetUid } = req.body;
        const user = await User.findOne({ uid: targetUid });
        if (user) res.json({ success: true, name: user.fullName });
        else res.json({ success: false });
    } catch (e) {
        res.status(500).json({ success: false });
    }
});

// ১. ⚠️ CHAT SYNC (MongoDB theke)
app.post('/api/chat/sync', authenticateToken, async (req, res) => {
    try {
        const { roomKey, uid, name } = req.body;
        
        // Active Status Update MongoDB te
        const statuses = await updateActiveStatus(uid, name, true);
        
        if (!roomKey) return res.json({ statuses });

        // Fetch Chat History from MongoDB
        const history = await Message.find({ roomKey }).sort({ _id: 1 });
        res.json({ history, statuses });
    } catch (e) {
        res.status(500).json({ error: "Sync Error" });
    }
});

// ২. ⚠️ SEND MESSAGE API (MongoDB te Save)
app.post('/api/chat/send', authenticateToken, async (req, res) => {
    try {
        const { roomKey, uid, sender, message, type, url, replyTo } = req.body;
        const now = new Date();
        
        const newMessage = new Message({
            roomKey,
            msgId: 'msg_' + Date.now(),
            senderId: uid,
            sender,
            message: message || "",
            type,
            url: extractFileId(url),
            time: now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: true }),
            date: now.toLocaleDateString(),
            replyTo: replyTo || null
        });

        await newMessage.save();
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: "Failed to send message" });
    }
});

// ৩. ⚠️ MARK SEEN API (MongoDB update)
app.post('/api/chat/seen', authenticateToken, async (req, res) => {
    try {
        const { roomKey, msgId } = req.body;
        await Message.updateMany(
            { roomKey, msgId },
            { $set: { seen: true } }
        );
        res.json({ success: true });
    } catch (e) {
        res.json({ success: false });
    }
});

// ৪. ⚠️ STEALTH MEDIA API (Google Drive theke Stream)
app.get('/api/media/:fileId', async (req, res) => {
    const token = req.query.token;
    if (!token) return res.status(401).send("Unauthorized");
    
    jwt.verify(token, JWT_SECRET, async (err) => {
        if (err) return res.status(403).send("Forbidden");
        try {
            const response = await drive.files.get({ fileId: req.params.fileId, alt: 'media' }, { responseType: 'stream' });
            res.setHeader('Content-Type', response.headers['content-type']);
            response.data.pipe(res); 
        } catch (error) { res.status(404).send("File not found"); }
    });
});

// ৫. ⚠️ MEDIA UPLOAD API (Memory to Drive - No Folder Created!)
// Khub guruttopurno: memoryStorage() bebohar kora hoyeche!
const upload = multer({ storage: multer.memoryStorage() }); 

app.post('/upload', upload.single('file'), async (req, res) => {
    const { key: roomKey, uid } = req.body;
    if (!req.file || !roomKey || !uid) return res.status(400).json({ error: "Missing data!" });

    try {
        const folderType = req.file.mimetype.startsWith('audio/') ? 'voice' : 'media';
        let fileName = req.file.originalname === 'blob' ? `voice_${Date.now()}.webm` : req.file.originalname;

        // Drive Folder Tree Setup
        const dbId = await getOrCreateDriveFolder('Database', DRIVE_MAIN_FOLDER_ID);
        const udId = await getOrCreateDriveFolder('users_data', dbId);
        const userDriveFolder = await getOrCreateDriveFolder(uid, udId);
        const mediaDriveFolder = await getOrCreateDriveFolder(folderType, userDriveFolder);

        // Memory (Buffer) theke Stream toiri kora
        const fileStream = new Readable();
        fileStream.push(req.file.buffer);
        fileStream.push(null);

        // Upload sorasori Drive-e
        const driveFile = await drive.files.create({ 
            resource: { name: fileName, parents: [mediaDriveFolder] }, 
            media: { mimeType: req.file.mimetype, body: fileStream }, 
            fields: 'id' 
        });
        
        await drive.permissions.create({ fileId: driveFile.data.id, requestBody: { role: 'reader', type: 'anyone' } });

        res.json({ url: driveFile.data.id, type: req.file.mimetype });
    } catch (error) { 
        console.error("Upload Error:", error);
        res.status(500).json({ error: "Upload failed" }); 
    }
});

// Vercel er jonno app export kora hocche (niche kono app.listen thakbe na)
module.exports = app;
const PORT = process.env.PORT || 3000;
if (process.env.NODE_ENV !== 'production') {
    app.listen(PORT, () => console.log(`🚀 API SERVER RUNNING ON PORT ${PORT}`));
}
