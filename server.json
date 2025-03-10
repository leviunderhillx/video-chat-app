const WebSocket = require('ws');
const wss = new WebSocket.Server({ port: 8080 });

let peers = new Map();
let waitingPool = new Set();
let reports = new Map();
let bannedIPs = new Set();

function connectRandomPeers() {
    const waitingArray = Array.from(waitingPool);
    if (waitingArray.length >= 2) {
        const peer1Id = waitingArray[0];
        const peer2Id = waitingArray[1];
        
        const peer1 = peers.get(peer1Id);
        const peer2 = peers.get(peer2Id);
        
        if (peer1 && peer2) {
            peer1.send(JSON.stringify({ type: 'matched', peerId: peer2Id }));
            peer2.send(JSON.stringify({ type: 'matched', peerId: peer1Id }));
            waitingPool.delete(peer1Id);
            waitingPool.delete(peer2Id);
        }
    }
}

function broadcastAdminUpdate() {
    peers.forEach((ws) => {
        if (ws.isAdmin) {
            const connectedPeers = Array.from(peers.entries()).map(([id, peer]) => ({
                peerId: id,
                ip: peer.ip
            }));
            ws.send(JSON.stringify({ type: 'admin-update', peers: connectedPeers }));
        }
    });
}

wss.on('connection', (ws, req) => {
    const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress;
    if (bannedIPs.has(ip)) {
        ws.send(JSON.stringify({ type: 'banned', reason: 'You have been banned' }));
        ws.close();
        return;
    }

    const peerId = Math.random().toString(36).substring(2);
    peers.set(peerId, ws);
    ws.ip = ip;
    ws.isAdmin = false;
    ws.send(JSON.stringify({ type: 'connected', peerId }));

    ws.on('message', (message) => {
        const data = JSON.parse(message);
        
        if (data.type === 'admin-login' && data.password === 'secret123') {
            ws.isAdmin = true;
            broadcastAdminUpdate();
        }
        else if (data.type === 'join') {
            waitingPool.add(peerId);
            connectRandomPeers();
            broadcastAdminUpdate();
        }
        else if (data.type === 'report') {
            const reportedPeerId = data.reportedPeerId;
            const reportedWs = peers.get(reportedPeerId);
            if (reportedWs) {
                const reportedIP = reportedWs.ip;
                const reportCount = (reports.get(reportedIP) || 0) + 1;
                reports.set(reportedIP, reportCount);
                
                if (reportCount >= 10) {
                    bannedIPs.add(reportedIP);
                    reportedWs.send(JSON.stringify({ type: 'banned', reason: 'Banned due to 10 reports' }));
                    reportedWs.close();
                    peers.delete(reportedPeerId);
                    waitingPool.delete(reportedPeerId);
                    broadcastAdminUpdate();
                }
            }
        }
        else if (data.type === 'chat') {
            const targetPeer = peers.get(data.target);
            if (targetPeer) {
                targetPeer.send(JSON.stringify({
                    type: 'chat',
                    message: data.message,
                    sender: peerId
                }));
            }
        }
        else if (data.type === 'admin-ban' && ws.isAdmin) {
            const targetPeerId = data.peerId;
            const targetWs = peers.get(targetPeerId);
            if (targetWs) {
                bannedIPs.add(targetWs.ip);
                targetWs.send(JSON.stringify({ type: 'banned', reason: 'Banned by admin' }));
                targetWs.close();
                peers.delete(targetPeerId);
                waitingPool.delete(targetPeerId);
                broadcastAdminUpdate();
            }
        }
        else if (data.type === 'admin-screenshot-request' && ws.isAdmin) {
            const targetPeer = peers.get(data.peerId);
            if (targetPeer) {
                targetPeer.send(JSON.stringify({ type: 'screenshot-request', requester: peerId }));
            }
        }
        else if (data.type === 'screenshot-response') {
            const adminPeer = peers.get(data.requester);
            if (adminPeer && adminPeer.isAdmin) {
                adminPeer.send(JSON.stringify({
                    type: 'screenshot-response',
                    peerId: peerId,
                    screenshot: data.screenshot
                }));
            }
        }
        else if (data.type === 'offer' || data.type === 'answer' || data.type === 'candidate') {
            const targetPeer = peers.get(data.target);
            if (targetPeer) {
                targetPeer.send(JSON.stringify(data));
            }
        }
    });

    ws.on('close', () => {
        waitingPool.delete(peerId);
        peers.delete(peerId);
        peers.forEach((peer) => {
            peer.send(JSON.stringify({ type: 'peer-disconnected', peerId }));
        });
        broadcastAdminUpdate();
    });

    ws.on('error', (error) => {
        console.error('WebSocket error:', error);
    });
});

console.log('WebSocket server running on ws://0.0.0.0:8080');