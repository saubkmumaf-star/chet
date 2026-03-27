let userProfile = null;
let targetUserProfile = null; 
let currentRoomKey = null;
let lastKnownStatuses = {};
let replyingTo = null; 
let userSettings = { notif: true, sound: true };
let chatHistoryLength = 0; 
let syncInterval = null;
let token = localStorage.getItem('proChatToken');

const popSound = new Audio('https://actions.google.com/sounds/v1/water/pop.ogg');
let soundUnlocked = false;
document.body.addEventListener('click', () => {
    if (!soundUnlocked) {
        popSound.volume = 0; popSound.play().then(() => { popSound.pause(); popSound.currentTime = 0; popSound.volume = 1; soundUnlocked = true; }).catch(e=>{});
    }
});

window.onload = async function() {
    const stored = localStorage.getItem('proChatUser');
    token = localStorage.getItem('proChatToken');
    
    if (!stored) return forceLogout(); 
    
    try {
        userProfile = JSON.parse(stored);
        
        document.getElementById('myName').innerText = userProfile.name;
        document.getElementById('myUidStr').innerText = userProfile.uid;

        if(localStorage.getItem('chatSettings')) { userSettings = JSON.parse(localStorage.getItem('chatSettings')); }
        document.getElementById('toggleNotif').checked = userSettings.notif;
        document.getElementById('toggleSound').checked = userSettings.sound;

        if(userSettings.notif && Notification.permission !== "granted" && Notification.permission !== "denied") {
            Notification.requestPermission();
        }
        
        const lastChat = localStorage.getItem('lastChatUser');
        if (lastChat) {
            targetUserProfile = JSON.parse(lastChat);
            openDM(true);
        }
        
        syncInterval = setInterval(syncChatData, 2000);
    } catch(e) { forceLogout(); }
};

function forceLogout() { 
    localStorage.clear(); 
    sessionStorage.clear();
    window.location.href = '/'; 
}

async function searchUser() {
    const tUid = document.getElementById('searchUid').value.trim();
    if(!tUid) return alert("Enter a UID!");
    if(tUid === userProfile.uid) return alert("You cannot chat with yourself!");

    try {
        const res = await fetch('/api/search-user', { 
            method: 'POST', 
            headers: {'Content-Type': 'application/json', 'Authorization': `Bearer ${token}`}, 
            body: JSON.stringify({ targetUid: tUid }) 
        });
        const data = await res.json();

        if(data.success) {
            targetUserProfile = { uid: tUid, name: data.name };
            openDM();
        } else alert("Account not found!");
    } catch(e) { alert("Server Error."); }
}

function openDM(isAutoReload = false) {
    document.getElementById('searchArea').style.display = 'none';
    document.getElementById('chatArea').style.display = 'flex';
    document.getElementById('roomName').innerText = targetUserProfile.name;
    document.getElementById('activeStatusInfo').innerText = "Connecting...";

    currentRoomKey = [userProfile.uid, targetUserProfile.uid].sort().join('_');
    
    localStorage.setItem('lastChatUser', JSON.stringify(targetUserProfile));

    if (!isAutoReload) {
        chatHistoryLength = 0;
        document.getElementById('chatBox').innerHTML = '';
    }
    syncChatData(); 
}

function goBackToSearch() {
    document.getElementById('chatArea').style.display = 'none';
    document.getElementById('searchArea').style.display = 'flex';
    currentRoomKey = null;
    targetUserProfile = null;
    localStorage.removeItem('lastChatUser'); 
}

function openSettings() { document.getElementById('settingsModal').classList.add('show'); }
function closeSettings() { document.getElementById('settingsModal').classList.remove('show'); }
function updateSettings() {
    userSettings.notif = document.getElementById('toggleNotif').checked;
    userSettings.sound = document.getElementById('toggleSound').checked;
    localStorage.setItem('chatSettings', JSON.stringify(userSettings));
    if(userSettings.notif && Notification.permission !== "granted") Notification.requestPermission();
}

function triggerAlert(senderName) {
    if(senderName === userProfile.name) return;
    if(userSettings.sound && soundUnlocked) { popSound.currentTime = 0; popSound.play().catch(e=>{}); }
    if(userSettings.notif && document.visibilityState !== 'visible') {
        if(Notification.permission === "granted") {
            const notif = new Notification(`New message`, { body: `Message from ${senderName}`, icon: 'https://cdn-icons-png.flaticon.com/512/1041/1041916.png' });
            notif.onclick = function() { window.focus(); this.close(); };
        }
    }
}

function timeAgo(timestamp) {
    const seconds = Math.floor((Date.now() - timestamp) / 1000);
    if (seconds < 60) return "Active just now";
    const minutes = Math.floor(seconds / 60); if (minutes < 60) return `Active ${minutes}m ago`;
    const hours = Math.floor(minutes / 60); if (hours < 24) return `Active ${hours}h ago`;
    const days = Math.floor(hours / 24); return `Active ${days}d ago`;
}

function updateStatusUI() {
    if (!currentRoomKey || !lastKnownStatuses || !targetUserProfile) return;
    const statusEl = document.getElementById('activeStatusInfo');
    const targetStatus = lastKnownStatuses[targetUserProfile.uid];
    
    if (targetStatus && targetStatus.online) { 
        statusEl.innerText = "🟢 Active Now"; statusEl.classList.add('online-text'); 
    } else if (targetStatus && !targetStatus.online) {
        statusEl.innerText = timeAgo(targetStatus.lastSeen); statusEl.classList.remove('online-text');
    } else {
        statusEl.innerText = "Offline"; statusEl.classList.remove('online-text');
    }
}

async function syncChatData() {
    try {
        const res = await fetch('/api/chat/sync', {
            method: 'POST',
            headers: {'Content-Type': 'application/json', 'Authorization': `Bearer ${token}`},
            body: JSON.stringify({ roomKey: currentRoomKey, uid: userProfile.uid, name: userProfile.name })
        });
        const data = await res.json();

        if(data.statuses) {
            lastKnownStatuses = data.statuses;
            updateStatusUI();
        }

        if(data.history && currentRoomKey) {
            if (data.history.length > chatHistoryLength) {
                const newMessages = data.history.slice(chatHistoryLength);
                newMessages.forEach(msg => {
                    appendMessage(msg);
                    if(msg.senderId !== userProfile.uid) triggerAlert(msg.sender);
                });
                chatHistoryLength = data.history.length;
                document.getElementById('chatBox').scrollTop = document.getElementById('chatBox').scrollHeight;
            }

            data.history.forEach(msg => {
                if(msg.senderId === userProfile.uid && msg.seen) {
                    const indicator = document.getElementById('seen_' + msg.msgId); 
                    if (indicator) indicator.classList.add('seen');
                }
            });
        }
    } catch(e) { console.log("Sync Error"); }
}

document.getElementById('msgInput').addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendTextMessage(); }
});

function handleTextInput(el) {
    el.style.height = '44px'; let newHeight = el.scrollHeight;
    if(newHeight > 120) newHeight = 120; el.style.height = newHeight + 'px';
    const actionIcons = document.getElementById('actionIcons'); const toggleBtn = document.getElementById('toggleBtn');
    if (el.value.trim().length > 0) { actionIcons.style.display = 'none'; toggleBtn.style.display = 'flex'; toggleBtn.innerHTML = '➕'; } 
    else { actionIcons.style.display = 'flex'; toggleBtn.style.display = 'none'; el.style.height = '44px'; }
}

function toggleActionIcons() {
    const actionIcons = document.getElementById('actionIcons'); const toggleBtn = document.getElementById('toggleBtn');
    if (actionIcons.style.display === 'none') { actionIcons.style.display = 'flex'; toggleBtn.innerHTML = '✖️'; } 
    else { actionIcons.style.display = 'none'; toggleBtn.innerHTML = '➕'; }
}

function formatTime(seconds) {
    if(isNaN(seconds) || !isFinite(seconds)) return "0:00";
    let m = Math.floor(seconds / 60), s = Math.floor(seconds % 60); return m + ":" + (s < 10 ? '0' : '') + s;
}

function startReply(senderName, msgContent) {
    replyingTo = { sender: senderName, message: msgContent };
    document.getElementById('replyContextName').innerText = `Replying to ${senderName}`;
    document.getElementById('replyContextText').innerText = msgContent;
    document.getElementById('replyContext').style.display = 'block';
    document.getElementById('msgInput').focus();
}
function cancelReply() { replyingTo = null; document.getElementById('replyContext').style.display = 'none'; }


// ==========================================
// 🚀 100% SECURE MEDIA LOAD SYSTEM (2-Min Token)
// ==========================================

// Server theke shudhu matro 2 minuter jonno ekti gopon link nibe
async function fetchSecureLink(fileId) {
    try {
        const res = await fetch('/api/media/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
            body: JSON.stringify({ fileId })
        });
        const data = await res.json();
        return data.url; // ETA GOOGLE DRIVE ER LINK NOY, ETA VERCEL ER HIDDEN LINK
    } catch(e) { return null; }
}

// User jokhon blur image-e click korbe tokhon ei function cholbe
async function revealImage(fileId, mediaId) {
    const textEl = document.getElementById('text_' + mediaId);
    const imgEl = document.getElementById('img_' + mediaId);
    const boxEl = document.getElementById('box_' + mediaId);
    
    textEl.innerText = "⏳ Decrypting...";
    
    const secureUrl = await fetchSecureLink(fileId);
    if(secureUrl) {
        imgEl.onload = () => {
            imgEl.style.filter = "none";
            textEl.style.display = "none";
            boxEl.style.height = "auto";
            boxEl.style.background = "transparent";
            boxEl.onclick = () => openViewer(secureUrl); // Now opens full screen
        };
        imgEl.src = secureUrl;
    } else {
        textEl.innerText = "❌ Failed";
    }
}

// Voice note er play button e click korle eita cholbe
async function playSecureAudio(fileId, mediaId) {
    const audio = document.getElementById(mediaId);
    const icon = document.getElementById('icon_' + mediaId);
    
    // Onno kono voice chalano thakle ta bondho korbe
    document.querySelectorAll('audio').forEach(a => { if(a.id !== mediaId && !a.paused) { a.pause(); document.getElementById('icon_' + a.id).innerText = "▶"; } });

    if (audio.paused) {
        // Jodi audio r kono source na thake (mane ekhono token ney ni)
        if (!audio.src || audio.src === window.location.href || audio.src.endsWith('/null')) {
            icon.innerText = "⏳";
            const secureUrl = await fetchSecureLink(fileId);
            if (secureUrl) {
                audio.src = secureUrl;
                audio.play().then(() => { icon.innerText = "⏸"; }).catch(e=> { icon.innerText = "▶"; });
            } else icon.innerText = "❌";
        } else {
            audio.play(); icon.innerText = "⏸";
        }
    } else {
        audio.pause(); icon.innerText = "▶";
    }
}

function updateChatAudio(id) { const audio = document.getElementById(id); if(!isNaN(audio.duration)) { document.getElementById('prog_' + id).style.width = ((audio.currentTime / audio.duration) * 100) + '%'; document.getElementById('time_' + id).innerText = formatTime(audio.currentTime); } }
function setAudioDuration(id) { const audio = document.getElementById(id); const timeSpan = document.getElementById('time_' + id); if (!audio || !timeSpan) return; if (isFinite(audio.duration)) { timeSpan.innerText = formatTime(audio.duration); } }
function seekChatAudio(e, id) { const audio = document.getElementById(id); const rect = e.currentTarget.getBoundingClientRect(); if(isFinite(audio.duration)) audio.currentTime = ((e.clientX - rect.left) / rect.width) * audio.duration; }
function resetChatAudio(id) { document.getElementById('icon_' + id).innerText = "▶"; document.getElementById('prog_' + id).style.width = '0%'; setAudioDuration(id); }

function appendMessage(data) {
    const box = document.getElementById('chatBox');
    const div = document.createElement('div');
    div.className = 'msg-container'; div.dataset.id = data.msgId; div.dataset.senderid = data.senderId; 
    
    const isMe = data.senderId === userProfile.uid; 
    div.style.alignItems = isMe ? 'flex-end' : 'flex-start';
    let bgColor = isMe ? '#0084ff' : '#fff', textColor = isMe ? 'white' : 'black', nameColor = isMe ? '#e0f0ff' : '#0084ff';
    
    let content = `<div class="msg" style="background: ${bgColor}; color: ${textColor}; padding: 10px; border-radius: 12px; max-width: 80%; position: relative;">`;
    content += `<div class="reply-icon-bg" style="position: absolute; right: ${isMe ? 'auto' : '-30px'}; left: ${isMe ? '-30px' : 'auto'}; top: 50%; transform: translateY(-50%); opacity: 0;">↩️</div>`;

    if(data.replyTo) {
        const qColor = isMe ? 'rgba(255,255,255,0.2)' : 'rgba(0,0,0,0.05)';
        const qBorder = isMe ? '#fff' : '#0084ff';
        content += `<div class="reply-quote" style="background: ${qColor}; border-left-color: ${qBorder}; padding: 5px; margin-bottom: 5px; border-radius: 5px; font-size: 12px; border-left: 3px solid;">
                        <div style="font-weight: bold; color: ${isMe?'#fff':'#0084ff'}">${data.replyTo.sender}</div>
                        <div style="white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 150px;">${data.replyTo.message}</div>
                    </div>`;
    }

    content += `<span class="sender-name" style="color: ${nameColor}; font-size: 11px; font-weight: bold; margin-bottom: 3px; display: block;">${data.sender} <span class="time" style="font-weight: normal; margin-left: 5px; opacity: 0.8;">${data.time}</span></span>`;
    
    const mediaId = 'media_' + Math.random().toString(36).substr(2, 9); 
    
    if (data.type === 'text') { 
        content += `<div class="msg-text" style="word-wrap: break-word;">${data.message}</div>`; 
    } else if (data.type.startsWith('image/')) { 
        // 🔒 BLURRED SECURE IMAGE BOX
        content += `
        <div id="box_${mediaId}" style="width: 220px; height: 160px; background: #ccd0d5; border-radius: 8px; display: flex; align-items: center; justify-content: center; cursor: pointer; position: relative; overflow: hidden; margin-top: 5px;" onclick="revealImage('${data.url}', '${mediaId}')">
            <div id="text_${mediaId}" style="position: absolute; z-index: 2; background: rgba(0,0,0,0.6); color: white; padding: 6px 12px; border-radius: 20px; font-size: 12px; font-weight: bold; backdrop-filter: blur(2px);">🔒 Tap to View</div>
            <img id="img_${mediaId}" src="" style="width: 100%; height: 100%; object-fit: cover; filter: blur(20px); transition: filter 0.3s ease;" />
        </div>`; 
    } else if (data.type.startsWith('audio/')) {
        // 🔒 SECURE AUDIO BOX
        const btnBg = isMe ? '#fff' : '#0084ff', iconColor = isMe ? '#0084ff' : '#fff', trackBg = isMe ? 'rgba(255,255,255,0.4)' : 'rgba(0,0,0,0.15)', trackFill = isMe ? '#fff' : '#0084ff';
        content += `<div class="custom-audio" style="display: flex; align-items: center; gap: 10px; margin-top: 5px; width: 220px;">
                        <audio id="${mediaId}" onloadedmetadata="setAudioDuration('${mediaId}')" ontimeupdate="updateChatAudio('${mediaId}')" onended="resetChatAudio('${mediaId}')"></audio>
                        <button class="play-btn" onclick="playSecureAudio('${data.url}', '${mediaId}')" style="background: ${btnBg}; color: ${iconColor}; border: none; width: 35px; height: 35px; border-radius: 50%; cursor: pointer; flex-shrink: 0; display:flex; justify-content:center; align-items:center;"><span id="icon_${mediaId}">▶</span></button>
                        <div class="progress-track" style="flex: 1; height: 5px; background: ${trackBg}; border-radius: 5px; position: relative; cursor: pointer;" onclick="seekChatAudio(event, '${mediaId}')">
                            <div id="prog_${mediaId}" class="progress-fill" style="position: absolute; left: 0; top: 0; height: 100%; width: 0%; background: ${trackFill}; border-radius: 5px;"></div>
                        </div>
                        <span id="time_${mediaId}" class="audio-time" style="font-size: 11px;">Voice</span>
                    </div>`;
    }
    content += `</div>`;
    if (isMe) { const seenClass = data.seen ? 'seen' : ''; content += `<div class="seen-dot ${seenClass}" id="seen_${data.msgId}" style="width: 10px; height: 10px; border-radius: 50%; background: ${data.seen ? '#4caf50' : '#ccc'}; align-self: flex-end; margin-top: 2px;"></div>`; }
    
    div.innerHTML = content; box.appendChild(div);
    
    if (!isMe && !data.seen) {
        fetch('/api/chat/seen', {
            method: 'POST',
            headers: {'Content-Type': 'application/json', 'Authorization': `Bearer ${token}`},
            body: JSON.stringify({ roomKey: currentRoomKey, msgId: data.msgId })
        });
    }
}

// Swipe to Reply & Other UI Logic Below...
let isDragging = false; let startX = 0; let swipeEl = null;
function initSwipe(e, clientX) { const msgNode = e.target.closest('.msg'); if(msgNode && !e.target.closest('.play-btn') && !e.target.closest('.progress-track')) { isDragging = true; startX = clientX; swipeEl = msgNode; swipeEl.style.transition = 'none'; } }
function moveSwipe(e, clientX) {
    if(!isDragging || !swipeEl) return;
    const diff = clientX - startX; const isMe = swipeEl.parentElement.style.alignItems === 'flex-end';
    if((isMe && diff < 0 && diff > -70) || (!isMe && diff > 0 && diff < 70)) { swipeEl.style.transform = `translateX(${diff}px)`; const icon = swipeEl.querySelector('.reply-icon-bg'); if(icon) icon.style.opacity = Math.abs(diff) / 70; }
}
function endSwipe(e, clientX) {
    if(!isDragging || !swipeEl) return;
    isDragging = false; const diff = clientX - startX;
    swipeEl.style.transition = 'transform 0.3s cubic-bezier(0.25, 0.8, 0.25, 1)'; swipeEl.style.transform = `translateX(0px)`;
    const icon = swipeEl.querySelector('.reply-icon-bg'); if(icon) icon.style.opacity = 0;
    const isMe = swipeEl.parentElement.style.alignItems === 'flex-end';
    if((isMe && diff < -40) || (!isMe && diff > 40)) {
        const senderName = swipeEl.querySelector('.sender-name').childNodes[0].textContent.trim();
        let msgContent = "Media Content"; if(swipeEl.querySelector('.msg-text')) msgContent = swipeEl.querySelector('.msg-text').innerText;
        startReply(senderName, msgContent);
    }
    swipeEl = null;
}
document.getElementById('chatBox').addEventListener('touchstart', e => initSwipe(e, e.changedTouches[0].screenX));
document.getElementById('chatBox').addEventListener('touchmove', e => moveSwipe(e, e.changedTouches[0].screenX));
document.getElementById('chatBox').addEventListener('touchend', e => endSwipe(e, e.changedTouches[0].screenX));
document.getElementById('chatBox').addEventListener('mousedown', e => initSwipe(e, e.clientX));
document.getElementById('chatBox').addEventListener('mousemove', e => moveSwipe(e, e.clientX));
window.addEventListener('mouseup', e => { if(isDragging) endSwipe(e, e.clientX); });

let currentHighResUrl = '';
function openViewer(url) { currentHighResUrl = url; document.getElementById('viewerImg').src = url; document.getElementById('viewerImg').classList.remove('zoomed'); document.getElementById('imageViewer').classList.add('show'); }
function closeViewer(e, force = false) { if (force || e.target.id === 'imageViewer') document.getElementById('imageViewer').classList.remove('show'); }
function toggleZoom(e) { e.stopPropagation(); document.getElementById('viewerImg').classList.toggle('zoomed'); }
async function downloadImage(e) { e.stopPropagation(); if (!currentHighResUrl) return; const a = document.createElement('a'); a.style.display = 'none'; a.href = currentHighResUrl; a.download = 'ChatImage_' + Date.now() + '.png'; document.body.appendChild(a); a.click(); document.body.removeChild(a); }

let mediaStream = null; let mediaRecorder; let audioChunks = []; let audioBlob = null; let audioContext; let analyser; let animationId; let recTimer; let recTime = 0;
function stopMicrophone() { if (mediaStream) { mediaStream.getTracks().forEach(track => track.stop()); mediaStream = null; } }
async function startRecording() {
    try {
        mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true }); mediaRecorder = new MediaRecorder(mediaStream); audioChunks = [];
        document.getElementById('mainToolbar').style.display = 'none'; document.getElementById('recordingUI').style.display = 'flex';
        recTime = 0; document.getElementById('recTimeDisplay').innerText = "0:00"; recTimer = setInterval(() => { recTime++; document.getElementById('recTimeDisplay').innerText = formatTime(recTime); }, 1000);
        audioContext = new (window.AudioContext || window.webkitAudioContext)(); const source = audioContext.createMediaStreamSource(mediaStream); analyser = audioContext.createAnalyser(); source.connect(analyser); analyser.fftSize = 64; drawWaveform();
        mediaRecorder.ondataavailable = e => { if (e.data.size > 0) audioChunks.push(e.data); };
        mediaRecorder.onstop = () => { audioBlob = new Blob(audioChunks, { type: 'audio/webm' }); document.getElementById('audioPreview').src = URL.createObjectURL(audioBlob); clearInterval(recTimer); cancelAnimationFrame(animationId); document.getElementById('recordingUI').style.display = 'none'; document.getElementById('previewUI').style.display = 'flex'; stopMicrophone(); };
        mediaRecorder.start();
    } catch (err) { alert("Microphone access denied!"); }
}
function drawWaveform() {
    const canvas = document.getElementById('waveform'); const canvasCtx = canvas.getContext('2d'); const bufferLength = analyser.frequencyBinCount; const dataArray = new Uint8Array(bufferLength); canvasCtx.clearRect(0, 0, canvas.width, canvas.height); const barWidth = 4, gap = 2, barCount = Math.floor(canvas.width / (barWidth + gap));
    function draw() { animationId = requestAnimationFrame(draw); analyser.getByteFrequencyData(dataArray); canvasCtx.fillStyle = '#f0f2f5'; canvasCtx.fillRect(0, 0, canvas.width, canvas.height); let x = 0; for(let i = 0; i < barCount; i++) { let dataIndex = Math.floor((i / barCount) * bufferLength); let value = dataArray[dataIndex]; let barHeight = (value / 255) * canvas.height; if(barHeight < 3) barHeight = 3; canvasCtx.fillStyle = '#0084ff'; let y = (canvas.height - barHeight) / 2; canvasCtx.fillRect(x, y, barWidth, barHeight); x += barWidth + gap; } } draw();
}
function stopRecording() { if(mediaRecorder && mediaRecorder.state === "recording") mediaRecorder.stop(); }
function cancelAudio() { audioBlob = null; document.getElementById('previewUI').style.display = 'none'; document.getElementById('mainToolbar').style.display = 'flex'; stopMicrophone(); }

function togglePreview() { const audio = document.getElementById('audioPreview'); const btn = document.getElementById('previewPlayBtn'); if(audio.paused) { audio.play(); btn.innerText = "⏸"; } else { audio.pause(); btn.innerText = "▶"; } }
function updatePreviewTime() { const audio = document.getElementById('audioPreview'); document.getElementById('previewProgress').style.width = ((audio.currentTime / audio.duration) * 100) + '%'; }
function resetPreview() { document.getElementById('previewPlayBtn').innerText = "▶"; document.getElementById('previewProgress').style.width = '0%'; }
function seekPreviewAudio(e) { const audio = document.getElementById('audioPreview'); const rect = e.currentTarget.getBoundingClientRect(); if(!isNaN(audio.duration)) audio.currentTime = ((e.clientX - rect.left) / rect.width) * audio.duration; }

async function uploadFileAndSend(file) {
    const formData = new FormData(); formData.append('file', file); formData.append('key', currentRoomKey); formData.append('uid', userProfile.uid); 
    try { 
        const res = await fetch('/upload', { method: 'POST', body: formData }); 
        const data = await res.json(); 
        await fetch('/api/chat/send', { method: 'POST', headers: {'Content-Type': 'application/json', 'Authorization': `Bearer ${token}`}, body: JSON.stringify({ roomKey: currentRoomKey, uid: userProfile.uid, sender: userProfile.name, type: data.type, url: data.url, replyTo: replyingTo }) });
        cancelReply(); syncChatData();
    } catch (err) { alert("Upload failed!"); }
}

async function sendTextMessage() {
    const textInput = document.getElementById('msgInput'); const text = textInput.value.trim();
    if(text && currentRoomKey) { 
        textInput.value = ''; handleTextInput(textInput); cancelReply();
        await fetch('/api/chat/send', { method: 'POST', headers: {'Content-Type': 'application/json', 'Authorization': `Bearer ${token}`}, body: JSON.stringify({ roomKey: currentRoomKey, uid: userProfile.uid, sender: userProfile.name, message: text, type: 'text', replyTo: replyingTo }) });
        syncChatData(); 
    }
}
function handleImageUpload(input) { if(input.files[0]) { uploadFileAndSend(input.files[0]); input.value = ''; } }
function sendVoiceMessage() { if(audioBlob) { uploadFileAndSend(new File([audioBlob], "voice_msg.webm", { type: "audio/webm" })); cancelAudio(); } }
