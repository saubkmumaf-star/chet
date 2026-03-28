const fs = require('fs');

async function testUpload() {
    const FormData = (await import('form-data')).default || require('form-data');
    const fetch = (await import('node-fetch')).default || require('node-fetch');

    const form = new FormData();
    form.append('file', Buffer.from('test voice data'), { filename: 'voice.webm', contentType: 'audio/webm' });
    form.append('key', 'room_123');
    form.append('uid', 'user_123');

    try {
        const res = await fetch('http://localhost:3000/upload', {
            method: 'POST',
            body: form
        });
        const data = await res.json();
        console.log("Upload Response:", data);
        if (data.url && data.url.includes(':')) {
            console.log("Encryption is Working!");
            
            // Test Secure Stream
            const streamRes = await fetch('http://localhost:3000/api/media/secure-stream', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ fileId: data.url })
            });
            console.log("Stream Status:", streamRes.status);
            const text = await streamRes.text();
            console.log("Stream Data Length:", text.length, "Data:", text.substring(0, 20));

        } else {
            console.log("Failed. Data:", data);
        }
    } catch(e) {
        console.error("Test Script Error:", e);
    }
}
testUpload();
