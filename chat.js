const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const { google } = require('googleapis');
const { Readable } = require('stream');
const crypto = require('crypto');

const app = express();
app.use(express.json());
// Public folder setup
app.use(express.static(path.join(__dirname, 'public')));

// Module Connection (register.js theke)
const { router: authRoutes, authenticateToken, JWT_SECRET } = require('./register');
app.use('/api/auth', authRoutes);

// Crypto Setup (Drive ID Hide korar jonno)
const ENCRYPTION_KEY = crypto.createHash('sha256').update(JWT_SECRET).digest();
const IV_LENGTH = 16;

function encryptFileId(text) {
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv('aes-256-cbc', ENCRYPTION_KEY, iv);
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    return iv.toString('hex') + ':' + encrypted;
}

function decryptFileId(text) {
    try {
        if (!text || !text.includes(':')) return text; // Backward compatibility for old files
        const [ivHex, encryptedHex] = text.split(':');
        const iv = Buffer.from(ivHex, 'hex');
        const decipher = crypto.createDecipheriv('aes-256-cbc', ENCRYPTION_KEY, iv);
        let decrypted = decipher.update(encryptedHex, 'hex', 'utf8');
        decrypted += decipher.final('utf8');
        return decrypted;
    } catch (e) {
        return text;
    }
}

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

// ⚠️ Google Drive Setup
const DRIVE_MAIN_FOLDER_ID = '11eyuQecg66EBHl-2CPYvhKJfVYNHrd7-'; 
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
function extractFileId(url) {
    if (!url) return "";
    if (url.includes('id=')) return url.match(/id=([a-zA-Z0-9_-]+)/)[1];
    return url.trim(); 
}

async function updateActiveStatus(uid, username, isOnline) {
    await Status.findOneAndUpdate(
        { uid },
        { username, online: isOnline, lastSeen: Date.now() },
        { upsert: true, new: true }
    );
    const allStatuses = await Status.find({});
    const statusMap = {};
    allStatuses.forEach(s => statusMap[s.uid] = s);
    return statusMap;
}

// ==========================================
// 🚀 VERCEL READY APIs
// ==========================================

// Search User (MongoDB theke)
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

// ৪. ⚠️ ULTIMATE SECURE BLOB STREAM API (No Links Exposed!)
app.post('/api/media/secure-stream', authenticateToken, async (req, res) => {
    try {
        const { fileId } = req.body;
        const realFileId = decryptFileId(fileId);
        // Direct Drive theke data ene kono link charai stream kora hocche
        const response = await drive.files.get({ fileId: realFileId, alt: 'media' }, { responseType: 'stream' });
        
        res.setHeader('Content-Type', response.headers['content-type'] || 'application/octet-stream');
        res.setHeader('Cache-Control', 'no-store'); // Browser ke cache korte dibe na
        response.data.pipe(res);
    } catch (err) {
        res.status(500).send("Stream Error");
    }
});

// ৫. ⚠️ MEDIA UPLOAD API (Memory to Drive - Super Fast)
const upload = multer({ storage: multer.memoryStorage() }); 

app.post('/upload', upload.single('file'), async (req, res) => {
    const { key: roomKey, uid } = req.body;
    if (!req.file || !roomKey || !uid) return res.status(400).json({ error: "Missing data!" });

    try {
        const user = await User.findOne({ uid });
        let targetFolderId = DRIVE_MAIN_FOLDER_ID;
        
        let isVoice = req.file.originalname === 'blob' || req.file.mimetype.includes('audio');
        let fileName = isVoice ? `voice_${Date.now()}.webm` : req.file.originalname;

        if (user && user.driveFolders) {
            targetFolderId = isVoice ? user.driveFolders.voice : user.driveFolders.media;
        }

        // Memory (RAM) theke Stream toiri kora
        const fileStream = new Readable();
        fileStream.push(req.file.buffer);
        fileStream.push(null);

        // Upload sorasori User Specific Folder e
        const driveFile = await drive.files.create({ 
            resource: { name: fileName, parents: [targetFolderId] }, 
            media: { mimeType: req.file.mimetype, body: fileStream }, 
            fields: 'id' 
        });
        
        const encryptedUrl = encryptFileId(driveFile.data.id);

        res.json({ url: encryptedUrl, type: req.file.mimetype });
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
