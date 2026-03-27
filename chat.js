const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const { google } = require('googleapis');
const { Readable } = require('stream');

const app = express();
app.use(express.json());
// Public folder setup
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

// ⚠️ Google Drive Setup (Shudhu chabi read korar jonno)
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

// ৪. ⚠️ SECURE MEDIA TOKEN API (2 Minute Expiry - Drive Hidden)
app.post('/api/media/token', authenticateToken, (req, res) => {
    const { fileId } = req.body;
    // ২ মিনিটের জন্য এনক্রিপ্টেড টোকেন তৈরি
    const shortToken = jwt.sign({ fileId }, JWT_SECRET, { expiresIn: '2m' });
    res.json({ url: `/api/media/stream/${shortToken}` });
});

// ৫. ⚠️ SECURE STREAMING API (Link expires in 2 mins)
app.get('/api/media/stream/:token', async (req, res) => {
    try {
        const decoded = jwt.verify(req.params.token, JWT_SECRET);
        const response = await drive.files.get({ fileId: decoded.fileId, alt: 'media' }, { responseType: 'stream' });
        
        // 브라우জারে ক্যাশ কন্ট্রোল (২ মিনিট পর ডিলিট)
        res.setHeader('Content-Type', response.headers['content-type'] || 'application/octet-stream');
        res.setHeader('Cache-Control', 'private, max-age=120'); 
        response.data.pipe(res); // Vercel server theke data stream hobe
    } catch (err) {
        res.status(403).send("⚠️ Token Expired or Invalid");
    }
});

// ৬. ⚠️ MEDIA UPLOAD API (Memory to Drive - Super Fast)
const upload = multer({ storage: multer.memoryStorage() }); 

app.post('/upload', upload.single('file'), async (req, res) => {
    const { key: roomKey, uid } = req.body;
    if (!req.file || !roomKey || !uid) return res.status(400).json({ error: "Missing data!" });

    try {
        let fileName = req.file.originalname === 'blob' ? `voice_${Date.now()}.webm` : req.file.originalname;

        // Memory (RAM) theke Stream toiri kora
        const fileStream = new Readable();
        fileStream.push(req.file.buffer);
        fileStream.push(null);

        // Upload sorasori Main Folder e (Kono Timeout hobe na)
        const driveFile = await drive.files.create({ 
            resource: { name: fileName, parents: [DRIVE_MAIN_FOLDER_ID] }, 
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
