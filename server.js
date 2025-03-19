const WebSocket = require('ws');

const port = process.env.PORT || 10000;
const wss = new WebSocket.Server({ port });

// --- Data Structures ---
let peers = new Map();          // Maps playerId (e.g., "Player 1") to WebSocket
let waitingPool = new Set();    // Set of playerIds waiting to be matched
let reports = new Map();        // Tracks reports per IP
let bannedIPs = new Set();      // Banned IPs
let availablePlayerIds = ['Player 1', 'Player 2', 'Player 3', 'Player 4', 'Player 5']; // Pool of reusable IDs
let usedPlayerIds = new Set();  // Tracks currently used IDs

function assignPlayerId() {
    for (let id of availablePlayerIds) {
        if (!usedPlayerIds.has(id)) {
            usedPlayerIds.add(id);
            return id;
        }
    }
    return null; // No available IDs
}

function releasePlayerId(playerId) {
    usedPlayerIds.delete(playerId);
}

function connectRandomPeers() {
    const waitingArray = Array.from(waitingPool);
    if (waitingArray.length < 2) return;

    const player1Id = waitingArray[0];
    const player2Id = waitingArray[1];
    const player1 = peers.get(player1Id);
    const player2 = peers.get(player2Id);

    if (player1 && player2 && player1.readyState === WebSocket.OPEN && player2.readyState === WebSocket.OPEN) {
        console.log(`Matching ${player1Id} with ${player2Id}`);
        player1.send(JSON.stringify({ type: 'matched', playerId: player2Id }));
        player2.send(JSON.stringify({ type: 'matched', playerId: player1Id }));
        waitingPool.delete(player1Id);
        waitingPool.delete(player2Id);
    } else {
        if (!player1 || player1.readyState !== WebSocket.OPEN) waitingPool.delete(player1Id);
        if (!player2 || player2.readyState !== WebSocket.OPEN) waitingPool.delete(player2Id);
        setTimeout(connectRandomPeers, 1000);
    }
}

function broadcastAdminUpdate() {
    peers.forEach(ws => {
        if (ws.isAdmin) {
            const connectedPeers = Array.from(peers.entries()).map(([id, peer]) => ({
                playerId: id,
                ip: peer.ip
            }));
            ws.send(JSON.stringify({ type: 'admin-update', peers: connectedPeers }));
        }
    });
}

function pingPeers() {
    peers.forEach((ws, playerId) => {
        if (ws.readyState === WebSocket.OPEN) {
            ws.ping();
        } else {
            peers.delete(playerId);
            waitingPool.delete(playerId);
            releasePlayerId(playerId);
            console.log(`Removed dead peer: ${playerId}`);
        }
    });
}

setInterval(pingPeers, 30000);

wss.on('connection', (ws, req) => {
    const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress;
    console.log(`New connection from IP: ${ip}`);
    if (bannedIPs.has(ip)) {
        ws.send(JSON.stringify({ type: 'banned', reason: 'You have been banned' }));
        ws.close();
        return;
    }

    const playerId = assignPlayerId();
    if (!playerId) {
        ws.send(JSON.stringify({ type: 'error', message: 'No available player slots' }));
        ws.close();
        return;
    }

    peers.set(playerId, ws);
    ws.ip = ip;
    ws.isAdmin = false;
    ws.send(JSON.stringify({ type: 'connected', playerId }));

    ws.on('message', (message) => {
        let data;
        try {
            data = JSON.parse(message);
            console.log(`Received from ${playerId}:`, data);
        } catch (error) {
            console.error('Invalid message:', error);
            return;
        }

        let myPlayerId, reportedPlayerId, targetPlayerId, reportedWs, myWs, targetPeer, targetWs, adminPeer, reportedIP, reportCount;

        switch (data.type) {
            case 'admin-login':
                if (data.password === (process.env.ADMIN_PASSWORD || 'secret123')) {
                    ws.isAdmin = true;
                    console.log(`${playerId} is now admin`);
                    broadcastAdminUpdate();
                }
                break;
            case 'join':
                waitingPool.add(playerId);
                connectRandomPeers();
                broadcastAdminUpdate();
                break;
            case 'leave':
                waitingPool.delete(playerId);
                console.log(`${playerId} left the waiting pool`);
                broadcastAdminUpdate();
                break;
            case 'stop-video':
                myPlayerId = data.myPlayerId;
                targetPlayerId = data.target;
                targetWs = peers.get(targetPlayerId);

                if (targetWs && targetWs.readyState === WebSocket.OPEN) {
                    targetWs.send(JSON.stringify({ type: 'requeue' }));
                    waitingPool.add(targetPlayerId);
                    console.log(`Requeued ${targetPlayerId} due to ${myPlayerId} stopping video`);
                }
                waitingPool.delete(myPlayerId);
                broadcastAdminUpdate();
                break;
            case 'skip-chat':
                myPlayerId = data.myPlayerId;
                targetPlayerId = data.target;
                myWs = peers.get(myPlayerId);
                targetWs = peers.get(targetPlayerId);

                if (myWs && myWs.readyState === WebSocket.OPEN) {
                    myWs.send(JSON.stringify({ type: 'requeue' }));
                    waitingPool.add(myPlayerId);
                    console.log(`Requeued ${myPlayerId} due to skipping chat`);
                }
                if (targetWs && targetWs.readyState === WebSocket.OPEN) {
                    targetWs.send(JSON.stringify({ type: 'requeue' }));
                    waitingPool.add(targetPlayerId);
                    console.log(`Requeued ${targetPlayerId} due to ${myPlayerId} skipping chat`);
                }
                setTimeout(connectRandomPeers, 3000);
                broadcastAdminUpdate();
                break;
            case 'report':
                reportedPlayerId = data.reportedPlayerId;
                myPlayerId = data.myPlayerId;
                reportedWs = peers.get(reportedPlayerId);
                myWs = peers.get(myPlayerId);

                if (reportedWs) {
                    reportedIP = reportedWs.ip;
                    reportCount = (reports.get(reportedIP) || 0) + 1;
                    reports.set(reportedIP, reportCount);

                    if (reportCount >= 10) {
                        bannedIPs.add(reportedIP);
                        reportedWs.send(JSON.stringify({ type: 'banned', reason: '10 reports' }));
                        reportedWs.close();
                        peers.delete(reportedPlayerId);
                        waitingPool.delete(reportedPlayerId);
                        releasePlayerId(reportedPlayerId);
                    } else {
                        if (reportedWs.readyState === WebSocket.OPEN) {
                            reportedWs.send(JSON.stringify({ type: 'requeue' }));
                            waitingPool.add(reportedPlayerId);
                        }
                        if (myWs && myWs.readyState === WebSocket.OPEN) {
                            myWs.send(JSON.stringify({ type: 'requeue' }));
                            waitingPool.add(myPlayerId);
                        }
                    }
                } else if (myWs && myWs.readyState === WebSocket.OPEN) {
                    myWs.send(JSON.stringify({ type: 'requeue' }));
                    waitingPool.add(myPlayerId);
                }
                connectRandomPeers();
                broadcastAdminUpdate();
                break;
            case 'end-chat':
                myPlayerId = data.myPlayerId;
                targetPlayerId = data.target;
                targetWs = peers.get(targetPlayerId);
                myWs = peers.get(myPlayerId);

                if (targetWs && targetWs.readyState === WebSocket.OPEN) {
                    targetWs.send(JSON.stringify({ type: 'requeue' }));
                    waitingPool.add(targetPlayerId);
                }
                if (myWs && myWs.readyState === WebSocket.OPEN) {
                    myWs.send(JSON.stringify({ type: 'requeue' }));
                    waitingPool.add(myPlayerId);
                }
                connectRandomPeers();
                broadcastAdminUpdate();
                break;
            case 'chat':
            case 'offer':
            case 'answer':
            case 'candidate':
                targetPeer = peers.get(data.target);
                if (targetPeer && targetPeer.readyState === WebSocket.OPEN) {
                    targetPeer.send(JSON.stringify(data));
                }
                break;
            case 'admin-ban':
                if (ws.isAdmin) {
                    targetWs = peers.get(data.playerId);
                    if (targetWs) {
                        bannedIPs.add(targetWs.ip);
                        targetWs.send(JSON.stringify({ type: 'banned', reason: 'Admin ban' }));
                        targetWs.close();
                        peers.delete(data.playerId);
                        waitingPool.delete(data.playerId);
                        releasePlayerId(data.playerId);
                        broadcastAdminUpdate();
                    }
                }
                break;
            case 'admin-screenshot-request':
                if (ws.isAdmin) {
                    targetPeer = peers.get(data.playerId);
                    if (targetPeer) {
                        targetPeer.send(JSON.stringify({ type: 'screenshot-request', requester: playerId }));
                    }
                }
                break;
            case 'screenshot-response':
                adminPeer = peers.get(data.requester);
                if (adminPeer && adminPeer.isAdmin) {
                    adminPeer.send(JSON.stringify({
                        type: 'screenshot-response',
                        playerId: playerId,
                        screenshot: data.screenshot
                    }));
                }
                break;
        }
    });

    ws.on('close', () => {
        peers.delete(playerId);
        waitingPool.delete(playerId);
        releasePlayerId(playerId);
        peers.forEach(peer => {
            peer.send(JSON.stringify({ type: 'peer-disconnected', playerId }));
        });
        console.log(`Player ${playerId} disconnected`);
        broadcastAdminUpdate();
        connectRandomPeers();
    });

    ws.on('pong', () => {
        ws.isAlive = true;
    });

    ws.on('error', (error) => {
        console.error(`WebSocket error for ${playerId}:`, error);
    });
});

wss.on('error', (error) => {
    console.error('Server error:', error);
});

wss.on('listening', () => {
    console.log(`Server running on port ${port}`);
});