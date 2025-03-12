const WebSocket = require('ws');

const port = process.env.PORT || 10000;
const wss = new WebSocket.Server({ port });

let peers = new Map(); // All connected clients
let waitingPool = new Set(); // For peer-to-peer matching
let streamers = new Map(); // Active streamers
let viewers = new Map(); // Viewer-to-streamer mapping
let reports = new Map();
let bannedIPs = new Set();

function connectRandomPeers() {
    const waitingArray = Array.from(waitingPool);
    if (waitingArray.length >= 2) {
        const peer1Id = waitingArray[0];
        const peer2Id = waitingArray[1];
        const peer1 = peers.get(peer1Id);
        const peer2 = peers.get(peer2Id);
        if (peer1 && peer2 && peer1.readyState === WebSocket.OPEN && peer2.readyState === WebSocket.OPEN) {
            console.log(`Matching ${peer1Id} with ${peer2Id}`);
            peer1.send(JSON.stringify({ type: 'matched', peerId: peer2Id }));
            peer2.send(JSON.stringify({ type: 'matched', peerId: peer1Id }));
            waitingPool.delete(peer1Id);
            waitingPool.delete(peer2Id);
        } else {
            if (!peer1 || peer1.readyState !== WebSocket.OPEN) waitingPool.delete(peer1Id);
            if (!peer2 || peer2.readyState !== WebSocket.OPEN) waitingPool.delete(peer2Id);
            setTimeout(connectRandomPeers, 1000);
        }
    }
}

function connectViewerToStreamer(viewerId) {
    const streamerIds = Array.from(streamers.keys());
    if (streamerIds.length === 0) {
        const viewerWs = peers.get(viewerId);
        if (viewerWs) viewerWs.send(JSON.stringify({ type: 'no-streamers' }));
        return;
    }
    const randomStreamerId = streamerIds[Math.floor(Math.random() * streamerIds.length)];
    const streamerWs = streamers.get(randomStreamerId);
    if (streamerWs && streamerWs.readyState === WebSocket.OPEN) {
        viewers.set(viewerId, randomStreamerId);
        console.log(`Viewer ${viewerId} connected to streamer ${randomStreamerId}`);
        updateViewerCount(randomStreamerId);
        peers.get(viewerId).send(JSON.stringify({ type: 'connected-to-streamer', streamerId: randomStreamerId }));
    }
}

function updateViewerCount(streamerId) {
    const viewerCount = Array.from(viewers.entries()).filter(([_, sId]) => sId === streamerId).length;
    const streamerWs = streamers.get(streamerId);
    if (streamerWs && streamerWs.readyState === WebSocket.OPEN) {
        streamerWs.send(JSON.stringify({ type: 'viewer-count', count: viewerCount }));
    }
    viewers.forEach((sId, vId) => {
        if (sId === streamerId) {
            const viewerWs = peers.get(vId);
            if (viewerWs && viewerWs.readyState === WebSocket.OPEN) {
                viewerWs.send(JSON.stringify({ type: 'viewer-count', count: viewerCount }));
            }
        }
    });
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
    ws.isStreamer = false;
    console.log(`New connection from IP: ${ip}, assigned peer ID: ${peerId}`);
    ws.send(JSON.stringify({ type: 'connected', peerId }));

    ws.on('message', (message) => {
        let data;
        try {
            data = JSON.parse(message);
            console.log(`Received from ${peerId}:`, data);
        } catch (error) {
            console.error('Invalid message format:', error);
            return;
        }

        if (data.type === 'admin-login' && data.password === (process.env.ADMIN_PASSWORD || 'secret123')) {
            ws.isAdmin = true;
            console.log(`${peerId} logged in as admin`);
            broadcastAdminUpdate();
        } else if (data.type === 'join') {
            waitingPool.add(peerId);
            connectRandomPeers();
            broadcastAdminUpdate();
        } else if (data.type === 'start-live') {
            streamers.set(peerId, ws);
            ws.isStreamer = true;
            console.log(`${peerId} started streaming`);
            updateViewerCount(peerId);
        } else if (data.type === 'join-live') {
            connectViewerToStreamer(peerId);
        } else if (data.type === 'report') {
            const reportedPeerId = data.reportedPeerId;
            const myPeerId = data.myPeerId;
            const reportedWs = peers.get(reportedPeerId);
            const myWs = peers.get(myPeerId);
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
                    streamers.delete(reportedPeerId);
                } else {
                    if (reportedWs.readyState === WebSocket.OPEN) {
                        reportedWs.send(JSON.stringify({ type: 'requeue' }));
                        waitingPool.add(reportedPeerId);
                    }
                    if (myWs && myWs.readyState === WebSocket.OPEN) {
                        myWs.send(JSON.stringify({ type: 'requeue' }));
                        waitingPool.add(myPeerId);
                    }
                }
            }
            connectRandomPeers();
            broadcastAdminUpdate();
        } else if (data.type === 'end-chat') {
            const myPeerId = data.myPeerId;
            const targetPeerId = data.target;
            const targetWs = peers.get(targetPeerId);
            const myWs = peers.get(myPeerId);
            if (targetWs && targetWs.readyState === WebSocket.OPEN) {
                targetWs.send(JSON.stringify({ type: 'requeue' }));
                waitingPool.add(targetPeerId);
            }
            if (myWs && myWs.readyState === WebSocket.OPEN) {
                myWs.send(JSON.stringify({ type: 'requeue' }));
                waitingPool.add(myPeerId);
            }
            connectRandomPeers();
            broadcastAdminUpdate();
        } else if (data.type === 'chat') {
            if (viewers.has(peerId)) {
                const streamerId = viewers.get(peerId);
                const streamerWs = streamers.get(streamerId);
                if (streamerWs && streamerWs.readyState === WebSocket.OPEN) {
                    console.log(`Relaying chat from viewer ${peerId} to streamer ${streamerId}: ${data.message}`);
                    streamerWs.send(JSON.stringify({
                        type: 'chat',
                        message: data.message,
                        sender: peerId
                    }));
                    viewers.forEach((sId, vId) => {
                        if (sId === streamerId && vId !== peerId) {
                            const viewerWs = peers.get(vId);
                            if (viewerWs) viewerWs.send(JSON.stringify({
                                type: 'chat',
                                message: data.message,
                                sender: peerId
                            }));
                        }
                    });
                }
            } else {
                const targetPeer = peers.get(data.target);
                if (targetPeer && targetPeer.readyState === WebSocket.OPEN) {
                    targetPeer.send(JSON.stringify({
                        type: 'chat',
                        message: data.message,
                        sender: peerId
                    }));
                }
            }
        } else if (data.type === 'admin-ban' && ws.isAdmin) {
            const targetPeerId = data.peerId;
            const targetWs = peers.get(targetPeerId);
            if (targetWs) {
                bannedIPs.add(targetWs.ip);
                targetWs.send(JSON.stringify({ type: 'banned', reason: 'Banned by admin' }));
                targetWs.close();
                peers.delete(targetPeerId);
                waitingPool.delete(targetPeerId);
                streamers.delete(targetPeerId);
                viewers.delete(targetPeerId);
                broadcastAdminUpdate();
            }
        } else if (data.type === 'admin-screenshot-request' && ws.isAdmin) {
            const targetPeer = peers.get(data.peerId);
            if (targetPeer) {
                targetPeer.send(JSON.stringify({ type: 'screenshot-request', requester: peerId }));
            }
        } else if (data.type === 'screenshot-response') {
            const adminPeer = peers.get(data.requester);
            if (adminPeer && adminPeer.isAdmin) {
                adminPeer.send(JSON.stringify({
                    type: 'screenshot-response',
                    peerId: peerId,
                    screenshot: data.screenshot
                }));
            }
        } else if (data.type === 'offer' || data.type === 'answer' || data.type === 'candidate') {
            const targetPeer = peers.get(data.target);
            if (targetPeer && targetPeer.readyState === WebSocket.OPEN) {
                targetPeer.send(JSON.stringify(data));
            }
        }
    });

    ws.on('close', () => {
        waitingPool.delete(peerId);
        peers.delete(peerId);
        if (ws.isStreamer) {
            streamers.delete(peerId);
            viewers.forEach((sId, vId) => {
                if (sId === peerId) {
                    const viewerWs = peers.get(vId);
                    if (viewerWs) viewerWs.send(JSON.stringify({ type: 'streamer-disconnected' }));
                    viewers.delete(vId);
                }
            });
        } else if (viewers.has(peerId)) {
            const streamerId = viewers.get(peerId);
            viewers.delete(peerId);
            updateViewerCount(streamerId);
        }
        peers.forEach((peer) => {
            peer.send(JSON.stringify({ type: 'peer-disconnected', peerId }));
        });
        broadcastAdminUpdate();
        connectRandomPeers();
        console.log(`Peer ${peerId} disconnected`);
    });

    ws.on('error', (error) => {
        console.error(`WebSocket error for ${peerId}:`, error);
    });
});

wss.on('listening', () => {
    console.log(`WebSocket server running on port ${port}`);
});