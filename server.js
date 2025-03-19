const WebSocket = require('ws');

const port = process.env.PORT || 10000;
const wss = new WebSocket.Server({ port });

// --- Data Structures ---
let peers = new Map();          // Stores all connected peers (peerId -> WebSocket)
let waitingPool = new Set();    // Peers waiting to be matched
let reports = new Map();        // Tracks reports per IP
let bannedIPs = new Set();      // Banned IPs

function connectRandomPeers() {
    // Matches two peers from the waiting pool
    const waitingArray = Array.from(waitingPool);
    if (waitingArray.length < 2) return;

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
        // Remove stale peers and retry
        if (!peer1 || peer1.readyState !== WebSocket.OPEN) waitingPool.delete(peer1Id);
        if (!peer2 || peer2.readyState !== WebSocket.OPEN) waitingPool.delete(peer2Id);
        setTimeout(connectRandomPeers, 1000);
    }
}

function broadcastAdminUpdate() {
    // Sends updated peer list to all admins
    peers.forEach(ws => {
        if (ws.isAdmin) {
            const connectedPeers = Array.from(peers.entries()).map(([id, peer]) => ({
                peerId: id,
                ip: peer.ip
            }));
            ws.send(JSON.stringify({ type: 'admin-update', peers: connectedPeers }));
        }
    });
}

function pingPeers() {
    // Pings all peers to detect dead connections
    peers.forEach((ws, peerId) => {
        if (ws.readyState === WebSocket.OPEN) {
            ws.ping();
        } else {
            peers.delete(peerId);
            waitingPool.delete(peerId);
            console.log(`Removed dead peer: ${peerId}`);
        }
    });
}

// Ping every 30 seconds to keep connections alive on Render
setInterval(pingPeers, 30000);

wss.on('connection', (ws, req) => {
    // --- New Connection Handler ---
    const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress;
    console.log(`New connection from IP: ${ip}`);
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
        let data;
        try {
            data = JSON.parse(message);
            console.log(`Received from ${peerId}:`, data);
        } catch (error) {
            console.error('Invalid message:', error);
            return;
        }

        // Declare all variables once at the top of the message handler scope
        let myPeerId, reportedPeerId, targetPeerId, reportedWs, myWs, targetPeer, targetWs, adminPeer, reportedIP, reportCount;

        switch (data.type) {
            case 'admin-login':
                // Authenticate admin
                if (data.password === (process.env.ADMIN_PASSWORD || 'secret123')) {
                    ws.isAdmin = true;
                    console.log(`${peerId} is now admin`);
                    broadcastAdminUpdate();
                }
                break;
            case 'join':
                // Add peer to waiting pool
                waitingPool.add(peerId);
                connectRandomPeers();
                broadcastAdminUpdate();
                break;
            case 'leave':
                // Remove peer from waiting pool when video is stopped
                waitingPool.delete(peerId);
                console.log(`${peerId} left the waiting pool`);
                broadcastAdminUpdate();
                break;
            case 'report':
                // Handle peer report
                reportedPeerId = data.reportedPeerId;
                myPeerId = data.myPeerId;
                reportedWs = peers.get(reportedPeerId);
                myWs = peers.get(myPeerId);

                if (reportedWs) {
                    reportedIP = reportedWs.ip;
                    reportCount = (reports.get(reportedIP) || 0) + 1;
                    reports.set(reportedIP, reportCount);

                    if (reportCount >= 10) {
                        bannedIPs.add(reportedIP);
                        reportedWs.send(JSON.stringify({ type: 'banned', reason: '10 reports' }));
                        reportedWs.close();
                        peers.delete(reportedPeerId);
                        waitingPool.delete(reportedPeerId);
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
                } else if (myWs && myWs.readyState === WebSocket.OPEN) {
                    myWs.send(JSON.stringify({ type: 'requeue' }));
                    waitingPool.add(myPeerId);
                }
                connectRandomPeers();
                broadcastAdminUpdate();
                break;
            case 'end-chat':
                // End chat and requeue both peers
                myPeerId = data.myPeerId;
                targetPeerId = data.target;
                targetWs = peers.get(targetPeerId);
                myWs = peers.get(myPeerId);

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
                break;
            case 'chat':
            case 'offer':
            case 'answer':
            case 'candidate':
                // Relay signaling or chat messages
                targetPeer = peers.get(data.target);
                if (targetPeer && targetPeer.readyState === WebSocket.OPEN) {
                    targetPeer.send(JSON.stringify(data));
                }
                break;
            case 'admin-ban':
                // Admin bans a peer
                if (ws.isAdmin) {
                    targetWs = peers.get(data.peerId);
                    if (targetWs) {
                        bannedIPs.add(targetWs.ip);
                        targetWs.send(JSON.stringify({ type: 'banned', reason: 'Admin ban' }));
                        targetWs.close();
                        peers.delete(data.peerId);
                        waitingPool.delete(data.peerId);
                        broadcastAdminUpdate();
                    }
                }
                break;
            case 'admin-screenshot-request':
                // Admin requests a screenshot
                if (ws.isAdmin) {
                    targetPeer = peers.get(data.peerId);
                    if (targetPeer) {
                        targetPeer.send(JSON.stringify({ type: 'screenshot-request', requester: peerId }));
                    }
                }
                break;
            case 'screenshot-response':
                // Relay screenshot to admin
                adminPeer = peers.get(data.requester);
                if (adminPeer && adminPeer.isAdmin) {
                    adminPeer.send(JSON.stringify({
                        type: 'screenshot-response',
                        peerId: peerId,
                        screenshot: data.screenshot
                    }));
                }
                break;
        }
    });

    ws.on('close', () => {
        // Clean up on disconnect
        peers.delete(peerId);
        waitingPool.delete(peerId);
        peers.forEach(peer => {
            peer.send(JSON.stringify({ type: 'peer-disconnected', peerId }));
        });
        broadcastAdminUpdate();
        connectRandomPeers();
    });

    ws.on('pong', () => {
        // Keep connection alive
        ws.isAlive = true;
    });

    ws.on('error', (error) => {
        console.error(`WebSocket error for ${peerId}:`, error);
    });
});

wss.on('error', (error) => {
    console.error('Server error:', error);
});

wss.on('listening', () => {
    console.log(`Server running on port ${port}`);
});