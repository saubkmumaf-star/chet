let userProfile = null;
let targetUserProfile = null; 
let currentRoomKey = null;
let lastKnownStatuses = {};
let replyingTo = null; 
let userSettings = { notif: true, sound: true };
let chatHistoryLength = 0; 
let syncInterval = null;
let token = localStorage.getItem('proChatToken');

// --- Audio Recording Variables ---
let mediaRecorder = null;
let audioChunks = [];
let recordedBlob = null;
let recordedAudioUrl = null;
let recordingStream = null;
let isRecording = false;
let recordInterval = null;
let recordSeconds = 0;

const popSound = new Audio('https://actions.google.com/sounds/v1/water/pop.ogg');
let soundUnlocked = false;

// User click korle sound unlock hobe
document.body.addEventListener('click', () => {
    if (!soundUnlocked) {
        popSound.volume = 0; popSound.play().then(() => { popSound.pause(); popSound.currentTime = 0; popSound.volume = 1; soundUnlocked = true; }).catch(e=>{});
    }
});

// 1. FB Moto Auto Load (Reload Fix)
window.onload = async function() {
    const stored = localStorage.getItem('proChatUser');
    token = localStorage.getItem('proChatToken');
    
    if (!stored || !token) return forceLogout(); 
    
    try {
        userProfile = JSON.parse(stored);
        document.getElementById('myName').innerText = userProfile.name;
        document.getElementById('myUidStr').innerText = userProfile.uid;

        if(localStorage.getItem('chatSettings')) { userSettings = JSON.parse(localStorage.getItem('chatSettings')); }
        document.getElementById('toggleNotif').checked = userSettings.notif;
        document.getElementById('toggleSound').checked = userSettings.sound;

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
    window.location.href = '/'; 
}

// 2. Search & Room Logic
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

// 3. SECURE BLOB STREAMING (Drive Link Hidden)
async function fetchSecureBlobUrl(fileId) {
    try {
        const res = await fetch('/api/media/secure-stream', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
            body: JSON.stringify({ fileId })
        });
        if (!res.ok) throw new Error("Blocked");
        const blob = await res.blob();
        return URL.createObjectURL(blob); // Temporary Memory URL
    } catch(e) { return null; }
}

async function revealImage(fileId, mediaId) {
    const textEl = document.getElementById('text_' + mediaId);
    const imgEl = document.getElementById('img_' + mediaId);
    textEl.innerText = "⏳ Decrypting...";
    const secureBlobUrl = await fetchSecureBlobUrl(fileId);
    if(secureBlobUrl) {
        imgEl.onload = () => {
            imgEl.style.filter = "none";
            textEl.style.display = "none";
        };
        imgEl.src = secureBlobUrl;
        imgEl.onclick = () => openViewer(secureBlobUrl);
    } else textEl.innerText = "❌ Error";
}

async function playSecureAudio(fileId, mediaId) {
    const audio = document.getElementById(mediaId);
    const icon = document.getElementById('icon_' + mediaId);
    if (audio.paused) {
        if (!audio.src || audio.src === window.location.href) {
            icon.innerText = "⏳";
            const secureBlobUrl = await fetchSecureBlobUrl(fileId);
            if (secureBlobUrl) {
                audio.src = secureBlobUrl;
                audio.play(); icon.innerText = "⏸";
            } else icon.innerText = "❌";
        } else { audio.play(); icon.innerText = "⏸"; }
    } else { audio.pause(); icon.innerText = "▶"; }
}

// 4. Chat Sync & Messaging
async function syncChatData() {
    if(!currentRoomKey) return;
    try {
        const res = await fetch('/api/chat/sync', {
            method: 'POST',
            headers: {'Content-Type': 'application/json', 'Authorization': `Bearer ${token}`},
            body: JSON.stringify({ roomKey: currentRoomKey, uid: userProfile.uid, name: userProfile.name })
        });
        const data = await res.json();
        
        // 1. Update Active Status in UI
        if (data.statuses && targetUserProfile) {
            const targetStatus = data.statuses[targetUserProfile.uid];
            const statusEl = document.getElementById('activeStatusInfo');
            if (targetStatus && targetStatus.online) {
                statusEl.innerText = 'Active Now';
                statusEl.classList.add('online-text');
            } else {
                statusEl.innerText = 'Offline';
                statusEl.classList.remove('online-text');
            }
        }

        // 2. Update Chat History
        if(data.history && data.history.length > chatHistoryLength) {
            const newMessages = data.history.slice(chatHistoryLength);
            newMessages.forEach(msg => appendMessage(msg));
            chatHistoryLength = data.history.length;
            document.getElementById('chatBox').scrollTop = document.getElementById('chatBox').scrollHeight;
        }
    } catch(e) {}
}

async function sendTextMessage() {
    const textInput = document.getElementById('msgInput');
    const text = textInput.value.trim();
    if(text && currentRoomKey) {
        textInput.value = '';
        await fetch('/api/chat/send', {
            method: 'POST',
            headers: {'Content-Type': 'application/json', 'Authorization': `Bearer ${token}`},
            body: JSON.stringify({ roomKey: currentRoomKey, uid: userProfile.uid, sender: userProfile.name, message: text, type: 'text' })
        });
        syncChatData();
    }
}

function appendMessage(data) {
    const box = document.getElementById('chatBox');
    const div = document.createElement('div');
    const isMe = data.senderId === userProfile.uid;
    div.className = 'msg-container';
    div.style.alignItems = isMe ? 'flex-end' : 'flex-start';
    
    const mediaId = 'media_' + Math.random().toString(36).substr(2, 9);
    let content = `<div class="msg" style="background: ${isMe?'#0084ff':'#fff'}; color: ${isMe?'#fff':'#000'};">`;
    content += `<span style="font-size:10px; opacity:0.6; display:block;">${data.sender}</span>`;

    if (data.type === 'text') content += `<div>${data.message}</div>`;
    else if (data.type.startsWith('image/')) {
        content += `<div id="box_${mediaId}" style="width:200px; height:150px; background:#ccc; position:relative; overflow:hidden; border-radius:8px; cursor:pointer;" onclick="revealImage('${data.url}', '${mediaId}')">
            <div id="text_${mediaId}" style="position:absolute; top:50%; left:50%; transform:translate(-50%,-50%); z-index:2; background:rgba(0,0,0,0.5); color:#fff; padding:5px 10px; border-radius:15px; font-size:12px;">🔒 Tap to View</div>
            <img id="img_${mediaId}" src="" style="width:100%; height:100%; object-fit:cover; filter:blur(15px);">
        </div>`;
    } else if (data.type.startsWith('audio/')) {
        content += `<div style="display:flex; align-items:center; gap:10px; width:200px;">
            <audio id="${mediaId}"></audio>
            <button id="icon_${mediaId}" onclick="playSecureAudio('${data.url}', '${mediaId}')" style="background:#fff; border:none; border-radius:50%; width:30px; height:30px; cursor:pointer;">▶</button>
            <div style="flex:1; height:4px; background:rgba(0,0,0,0.1); border-radius:2px;"></div>
        </div>`;
    }
    content += `</div>`;
    div.innerHTML = content;
    box.appendChild(div);
}

// 5. Multimedia Upload
async function uploadFileAndSend(file) {
    const formData = new FormData();
    formData.append('file', file);
    formData.append('key', currentRoomKey);
    formData.append('uid', userProfile.uid);
    try {
        const res = await fetch('/upload', { method: 'POST', body: formData });
        const data = await res.json();
        await fetch('/api/chat/send', {
            method: 'POST',
            headers: {'Content-Type': 'application/json', 'Authorization': `Bearer ${token}`},
            body: JSON.stringify({ roomKey: currentRoomKey, uid: userProfile.uid, sender: userProfile.name, type: data.type, url: data.url })
        });
        syncChatData();
    } catch (e) { alert("Upload Failed!"); }
}

function handleImageUpload(input) { if(input.files[0]) uploadFileAndSend(input.files[0]); }

// 6. Voice Recording Logic
async function startRecording() {
    try {
        recordingStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        mediaRecorder = new MediaRecorder(recordingStream);
        audioChunks = [];

        mediaRecorder.ondataavailable = (event) => {
            if (event.data.size > 0) audioChunks.push(event.data);
        };

        mediaRecorder.onstop = () => {
            recordedBlob = new Blob(audioChunks, { type: 'audio/webm' });
            recordedAudioUrl = URL.createObjectURL(recordedBlob);
            const previewAudio = document.getElementById('audioPreview');
            previewAudio.src = recordedAudioUrl;
            
            document.getElementById('recordingUI').style.display = 'none';
            document.getElementById('previewUI').style.display = 'flex';
        };

        mediaRecorder.start();
        isRecording = true;
        
        // UI Updates for Recording
        document.getElementById('mainToolbar').style.display = 'none';
        document.getElementById('recordingUI').style.display = 'flex';
        
        recordSeconds = 0;
        document.getElementById('recTimeDisplay').innerText = "0:00";
        recordInterval = setInterval(() => {
            recordSeconds++;
            const mins = Math.floor(recordSeconds / 60);
            const secs = recordSeconds % 60;
            document.getElementById('recTimeDisplay').innerText = `${mins}:${secs < 10 ? '0' : ''}${secs}`;
        }, 1000);
    } catch (err) {
        alert("Microphone permission denied or not supported.");
    }
}

function stopRecording() {
    if (mediaRecorder && isRecording) {
        mediaRecorder.stop();
        isRecording = false;
        clearInterval(recordInterval);
        recordingStream.getTracks().forEach(track => track.stop());
    }
}

function cancelAudio() {
    recordedBlob = null;
    recordedAudioUrl = null;
    document.getElementById('audioPreview').src = "";
    document.getElementById('previewProgress').style.width = "0%";
    
    document.getElementById('previewUI').style.display = 'none';
    document.getElementById('mainToolbar').style.display = 'flex';
}

function togglePreview() {
    const audio = document.getElementById('audioPreview');
    const playBtn = document.getElementById('previewPlayBtn');
    if (audio.paused) {
        audio.play();
        playBtn.innerText = "⏸";
    } else {
        audio.pause();
        playBtn.innerText = "▶";
    }
}

function updatePreviewTime() {
    const audio = document.getElementById('audioPreview');
    if (audio.duration) {
        const percent = (audio.currentTime / audio.duration) * 100;
        document.getElementById('previewProgress').style.width = percent + "%";
    }
}

function seekPreviewAudio(event) {
    const track = event.currentTarget;
    const clickX = event.offsetX;
    const width = track.offsetWidth;
    const progress = clickX / width;
    const audio = document.getElementById('audioPreview');
    if (audio.duration) {
        audio.currentTime = progress * audio.duration;
    }
}

function resetPreview() {
    const playBtn = document.getElementById('previewPlayBtn');
    playBtn.innerText = "▶";
    document.getElementById('previewProgress').style.width = "0%";
}

function sendVoiceMessage() {
    if (recordedBlob) {
        const file = new File([recordedBlob], 'blob', { type: 'audio/webm' });
        uploadFileAndSend(file);
        cancelAudio();
    }
}
