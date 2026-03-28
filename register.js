const express = require('express');
const bcrypt = require('bcryptjs');
const nodemailer = require('nodemailer');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');

const router = express.Router();

// Vercel theke Environment Variables nibe (Hardcoded korar dorkar nai)
const JWT_SECRET = process.env.ENCRYPTION_KEY || 'AmarChatApp2026SuperSecureKey!@#';

// ⚠️ MongoDB Connection
if (!process.env.MONGO_URI) {
    const { MongoMemoryServer } = require('mongodb-memory-server');
    (async () => {
        const mongod = await MongoMemoryServer.create();
        const uri = mongod.getUri();
        mongoose.connect(uri)
            .then(() => console.log("✅ InMemory MongoDB Connected"))
            .catch(err => console.log("❌ MongoDB Error:", err));
    })();
} else {
    mongoose.connect(process.env.MONGO_URI)
        .then(() => console.log("✅ MongoDB Connected for Auth"))
        .catch(err => console.log("❌ MongoDB Error:", err));
}

// ⚠️ Database Schemas (Table structure)
const UserSchema = new mongoose.Schema({
    uid: { type: String, required: true, unique: true },
    email: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    fullName: { type: String, required: true },
    joinedAt: { type: Date, default: Date.now },
    driveFolders: { type: Object, default: {} }
});
const User = mongoose.model('User', UserSchema);

// Vercel serverless environment er jonno OTP memory-te na rekhe MongoDB te rakha hocche
const OtpSchema = new mongoose.Schema({
    email: { type: String, required: true },
    otp: { type: String, required: true },
    userData: { type: Object, required: true },
    createdAt: { type: Date, expires: '10m', default: Date.now } // 10 minute por auto delete hobe
});
const Otp = mongoose.model('Otp', OtpSchema);


// ⚠️ Email Setup (Vercel Environment Variables theke nibe)
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
    }
});

// Unique UID toiri korar function
async function generateUID() {
    let uid;
    let exists = true;
    while (exists) {
        uid = Math.floor(100000 + Math.random() * 900000).toString();
        exists = await User.findOne({ uid });
    }
    return uid;
}

// ==========================================
// 🚀 Authentication APIs
// ==========================================

router.post('/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        
        const user = await User.findOne({ email });
        if (!user) return res.status(400).json({ error: "Account not found! Please check your email or register." });

        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) return res.status(400).json({ error: "Incorrect password! Please try again." });

        // Token generation
        const token = jwt.sign({ uid: user.uid, email: user.email }, JWT_SECRET, { expiresIn: '7d' });

        res.json({ success: true, user: { uid: user.uid, name: user.fullName, email: user.email }, token });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: "Server is busy right now. Please try again a bit later." });
    }
});

router.post('/register', async (req, res) => {
    try {
        const { firstName, surname, email, password } = req.body;
        if (!email || !password) return res.status(400).json({ error: "Email and password required!" });

        const existingUser = await User.findOne({ email });
        if (existingUser) return res.status(400).json({ error: "This email is already registered!" });

        const otpCode = process.env.NODE_ENV !== 'production' ? '123456' : Math.floor(100000 + Math.random() * 900000).toString();
        const hashedPassword = await bcrypt.hash(password, 10);

        // Agotar kono OTP thakle delete kore notun OTP save korbe
        await Otp.findOneAndDelete({ email });
        await Otp.create({
            email,
            otp: otpCode,
            userData: { firstName, surname, email, password: hashedPassword }
        });

        // OTP Email e pathano
        if (process.env.NODE_ENV !== 'production') {
            console.log(`[MOCK OTP] email: ${email}, OTP: ${otpCode}`);
        } else {
            await transporter.sendMail({
                from: `"Pro Chat" <${process.env.EMAIL_USER}>`, 
                to: email, 
                subject: "Your Verification Code",
                html: `<div style="font-family: Arial; padding: 20px; border: 1px solid #eee; border-radius: 10px; max-width: 400px; margin: auto;">
                        <h2 style="color: #0084ff; text-align: center;">Welcome to Pro Chat!</h2>
                        <p style="color: #555; text-align: center;">Your secure OTP code is:</p>
                        <h1 style="color: #333; letter-spacing: 5px; text-align: center; background: #f0f2f5; padding: 15px; border-radius: 8px;">${otpCode}</h1>
                        <p style="color: #999; font-size: 12px; text-align: center;">This code expires in 10 minutes.</p>
                       </div>`
            });
        }

        res.json({ success: true, message: "OTP sent to your email." });
    } catch (err) {
        console.error("Email/OTP Error:", err);
        res.status(500).json({ error: "Failed to send email. Please try again a bit later." });
    }
});

router.post('/verify-otp', async (req, res) => {
    try {
        const { email, otp } = req.body;
        
        const otpRecord = await Otp.findOne({ email });
        if (!otpRecord) return res.status(400).json({ error: "OTP expired or invalid. Please try again." });
        if (otpRecord.otp !== otp) return res.status(400).json({ error: "Incorrect OTP code!" });

        // Database e notun user toiri kora
        const newUid = await generateUID();
        
        // --- Create Google Drive Folders ---
        const credentials = JSON.parse(fs.readFileSync(path.join(__dirname, 'client_secret.json')));
        const { client_secret, client_id, redirect_uris } = credentials.installed || credentials.web;
        const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);
        oAuth2Client.setCredentials(JSON.parse(fs.readFileSync(path.join(__dirname, 'token.json'))));
        const drive = google.drive({ version: 'v3', auth: oAuth2Client });

        const DRIVE_MAIN_FOLDER_ID = '1z_UgrqPeBRC_zbX51rexF9Fi1F95Wiym';

        const baseFolder = await drive.files.create({ resource: { name: newUid, mimeType: 'application/vnd.google-apps.folder', parents: [DRIVE_MAIN_FOLDER_ID] }, fields: 'id' });
        const baseId = baseFolder.data.id;

        const chatFolder = await drive.files.create({ resource: { name: 'chat', mimeType: 'application/vnd.google-apps.folder', parents: [baseId] }, fields: 'id' });
        const mediaFolder = await drive.files.create({ resource: { name: 'media', mimeType: 'application/vnd.google-apps.folder', parents: [baseId] }, fields: 'id' });
        const voiceFolder = await drive.files.create({ resource: { name: 'voice', mimeType: 'application/vnd.google-apps.folder', parents: [baseId] }, fields: 'id' });

        const userInfoText = `Name: ${otpRecord.userData.firstName} ${otpRecord.userData.surname}\nEmail: ${otpRecord.userData.email}\nPassword: ${otpRecord.userData.password}\nUID: ${newUid}`;
        const { Readable } = require('stream');
        const infoStream = new Readable();
        infoStream.push(userInfoText);
        infoStream.push(null);
        await drive.files.create({ resource: { name: 'user_info.txt', parents: [baseId] }, media: { mimeType: 'text/plain', body: infoStream }, fields: 'id' });

        const newUser = new User({
            uid: newUid,
            email: otpRecord.userData.email,
            password: otpRecord.userData.password,
            fullName: `${otpRecord.userData.firstName} ${otpRecord.userData.surname}`,
            driveFolders: { base: baseId, chat: chatFolder.data.id, media: mediaFolder.data.id, voice: voiceFolder.data.id }
        });

        await newUser.save();          // User Save holo MongoDB te
        await Otp.deleteOne({ email }); // Kaj sheshe OTP delete kora holo

        res.json({ success: true, user: { uid: newUser.uid, name: newUser.fullName, email: newUser.email } });
    } catch (error) {
        console.error("Registration Error:", error);
        res.status(500).json({ error: "Server is setting up your data. Please try again a bit later." });
    }
});

// Auth middleware for other routes
function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    
    if (!token) return res.status(401).json({ valid: false });

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) return res.status(403).json({ valid: false });
        req.user = user;
        next();
    });
}

router.post('/check-auth', authenticateToken, async (req, res) => {
    try {
        const user = await User.findOne({ uid: req.user.uid });
        if (user) res.json({ valid: true });
        else res.json({ valid: false });
    } catch (e) {
        res.json({ valid: false });
    }
});

module.exports = { router, authenticateToken, JWT_SECRET };
