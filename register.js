const express = require('express');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const nodemailer = require('nodemailer');
const { google } = require('googleapis');

const router = express.Router();
const dbDir = path.join(__dirname, 'database');
const usersFile = path.join(dbDir, 'users.json');

if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir);
if (!fs.existsSync(usersFile)) {
    fs.writeFileSync(usersFile, JSON.stringify({ lastUid: 100000, users: {} }, null, 2));
}

// ⚠️ Email Setup (আপনার ইমেইল ও অ্যাপ পাসওয়ার্ড দিন)
const EMAIL_SENDER = 'saubkmumaf@gmail.com'; 
const EMAIL_APP_PASSWORD = 'ksfg fzuw cyrp mrhk'; 

const transporter = nodemailer.createTransport({
    service: 'gmail', auth: { user: EMAIL_SENDER, pass: EMAIL_APP_PASSWORD }
});

// ⚠️ Google Drive Setup
const DRIVE_MAIN_FOLDER_ID = '1z_UgrqPeBRC_zbX51rexF9Fi1F95Wiym'; // আপনার ড্রাইভ ফোল্ডার আইডি
let drive;
try {
    const credentials = JSON.parse(fs.readFileSync(path.join(__dirname, 'client_secret.json')));
    const { client_secret, client_id, redirect_uris } = credentials.installed || credentials.web;
    const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);
    const token = fs.readFileSync(path.join(__dirname, 'token.json'));
    oAuth2Client.setCredentials(JSON.parse(token));
    drive = google.drive({ version: 'v3', auth: oAuth2Client });
} catch (err) { console.error("Drive Auth Error:", err.message); }

async function getOrCreateDriveFolder(folderName, parentId) {
    try {
        const query = `name='${folderName}' and mimeType='application/vnd.google-apps.folder' and '${parentId}' in parents and trashed=false`;
        const res = await drive.files.list({ q: query, fields: 'files(id, name)' });
        if (res.data.files.length > 0) return res.data.files[0].id; 
        const folder = await drive.files.create({ resource: { name: folderName, mimeType: 'application/vnd.google-apps.folder', parents: [parentId] }, fields: 'id' });
        return folder.data.id;
    } catch (err) { throw err; } // Error throw করবে যাতে catch block ধরতে পারে
}

async function syncFileToDrive(localFilePath, fileName, parentFolderId) {
    if (!fs.existsSync(localFilePath)) return;
    try {
        const query = `name='${fileName}' and '${parentFolderId}' in parents and trashed=false`;
        const res = await drive.files.list({ q: query, fields: 'files(id)' });
        const media = { mimeType: 'application/json', body: fs.createReadStream(localFilePath) };
        if (res.data.files.length > 0) {
            await drive.files.update({ fileId: res.data.files[0].id, media: media });
        } else {
            await drive.files.create({ resource: { name: fileName, parents: [parentFolderId] }, media: media, fields: 'id' });
        }
    } catch(e) { throw e; }
}

const otpStorage = {}; 

router.post('/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        let db = JSON.parse(fs.readFileSync(usersFile));
        const user = Object.values(db.users).find(u => u.email === email);
        if (!user) return res.status(400).json({ error: "Account not found! Please check your email or register." });
        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) return res.status(400).json({ error: "Incorrect password! Please try again." });
        res.json({ success: true, user: { uid: user.uid, name: user.fullName, email: user.email } });
    } catch (e) {
        res.status(500).json({ error: "Server is busy right now. Please try again a bit later." });
    }
});

router.post('/register', async (req, res) => {
    try {
        const { firstName, surname, email, password } = req.body;
        if(!email || !password) return res.status(400).json({ error: "Email and password required!" });
        let db = JSON.parse(fs.readFileSync(usersFile));
        if(Object.values(db.users).find(u => u.email === email)) return res.status(400).json({ error: "This email is already registered!" });

        const otp = Math.floor(100000 + Math.random() * 900000).toString();
        const hashedPassword = await bcrypt.hash(password, 10); 
        otpStorage[email] = { code: otp, data: { firstName, surname, email, password: hashedPassword }, expires: Date.now() + (10 * 60 * 1000) };

        await transporter.sendMail({
            from: `"Pro Chat" <${EMAIL_SENDER}>`, to: email, subject: "Your Verification Code",
            html: `<div style="font-family: Arial; padding: 20px; border: 1px solid #eee; border-radius: 10px; max-width: 400px; margin: auto;">
                    <h2 style="color: #0084ff; text-align: center;">Welcome to Pro Chat!</h2>
                    <p style="color: #555; text-align: center;">Your secure OTP code is:</p>
                    <h1 style="color: #333; letter-spacing: 5px; text-align: center; background: #f0f2f5; padding: 15px; border-radius: 8px;">${otp}</h1>
                    <p style="color: #999; font-size: 12px; text-align: center;">This code expires in 10 minutes.</p>
                   </div>`
        });
        res.json({ success: true, message: "OTP sent to your email." });
    } catch(err) { 
        res.status(500).json({ error: "Failed to send email. Please try again a bit later." }); 
    }
});

router.post('/verify-otp', async (req, res) => {
    try {
        const { email, otp } = req.body;
        const record = otpStorage[email];
        if(!record) return res.status(400).json({ error: "OTP expired or invalid. Please try again." });
        if(record.code !== otp) return res.status(400).json({ error: "Incorrect OTP code!" });

        let db = JSON.parse(fs.readFileSync(usersFile));
        db.lastUid += 1;
        const newUid = db.lastUid.toString();
        
        db.users[newUid] = {
            uid: newUid, email: record.data.email, password: record.data.password,
            fullName: `${record.data.firstName} ${record.data.surname}`, joinedAt: new Date().toISOString()
        };
        fs.writeFileSync(usersFile, JSON.stringify(db, null, 2));

        const userFolder = path.join(dbDir, 'users_data', newUid);
        if (!fs.existsSync(userFolder)) fs.mkdirSync(userFolder, { recursive: true });

        // ⚠️ Google Drive Sync with Error Catching
        try {
            const dbFolderId = await getOrCreateDriveFolder('Database', DRIVE_MAIN_FOLDER_ID);
            await syncFileToDrive(usersFile, 'users.json', dbFolderId);
            const usersDataFolderId = await getOrCreateDriveFolder('users_data', dbFolderId);
            await getOrCreateDriveFolder(newUid, usersDataFolderId); 
        } catch(e) { 
            console.log("Cloud sync error:", e.message);
            // আমরা ক্লাউড সিঙ্ক ফেইল করলেও ইউজারকে আটকে রাখব না। লোকাল ডাটাবেস রেডি।
        }

        delete otpStorage[email];
        res.json({ success: true, user: { uid: newUid, name: db.users[newUid].fullName, email: db.users[newUid].email } });
    } catch (error) {
        res.status(500).json({ error: "Server is setting up your data. Please try again a bit later." });
    }
});

router.post('/check-auth', (req, res) => {
    const { uid } = req.body;
    let db = JSON.parse(fs.readFileSync(usersFile));
    if(db.users[uid]) res.json({ valid: true });
    else res.json({ valid: false });
});

module.exports = router;