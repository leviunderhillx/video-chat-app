const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');

const port = process.env.PORT || 10000;
const wss = new WebSocket.Server({ port });

// Data Structures
let peers = new Map();       // Maps UUID to WebSocket
let waitingPool = new Set(); // Set of UUIDs waiting to be matched
let reports = new Map();     // Tracks reports per IP
let bannedIPs = new Set();   // Banned IPs

function connectRandomPeers() {
    const waitingArray = Array.from(waitingPool);
    console.log('Waiting pool:', waitingArray);
    if (waitingArray.length < 2) return;

    const user1Id = waitingArray[0];
    const user2Id = waitingArray[1];
    const user1 = peers.get(user1Id);
    const user2 = peers.get(user2Id);

    if (user1 && user2 && user1.readyState === WebSocket.OPEN && user2.readyState === WebSocket.OPEN) {
        console.log(`Matching ${user1Id} with ${user2Id}`);
        user1.send(JSON.stringify({ type: 'matched', peerId: user2Id }));
        user2.send(JSON.stringify({ type: 'matched', peerId: user1Id }));
        waitingPool.delete(user1Id);
        waitingPool.delete(user2Id);
    } else {
        if (!user1 || user1.readyState !== WebSocket.OPEN) {
            waitingPool.delete(user1Id);
            peers.delete(user1Id);
            console.log(`Cleaned up stale ${user1Id}`);
        }
        if (!user2 || user2.readyState !== WebSocket.OPEN) {
            waitingPool.delete(user2Id);
            peers.delete(user2Id);
            console.log(`Cleaned up stale ${user2Id}`);
        }
        setTimeout(connectRandomPeers, 1000);
    }
}

function pingPeers() {
    peers.forEach((ws, userId) => {
        if (ws.readyState === WebSocket.OPEN) {
            ws.ping();
        } else {
            peers.delete(userId);
            waitingPool.delete(userId);
            console.log(`Removed dead peer: ${userId}`);
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

    const userId = uuidv4();
    peers.set(userId, ws);
    ws.ip = ip;
    ws.userId = userId;
    ws.send(JSON.stringify({ type: 'connected', userId }));

    ws.on('message', (message) => {
        let data;
        try {
            data = JSON.parse(message);
            console.log(`Received from ${userId}:`, data);
        } catch (error) {
            console.error('Invalid message:', error);
            return;
        }

        let reportedUserId, targetUserId, reportedWs, myWs, targetWs, reportCount;

        switch (data.type) {
            case 'join':
                waitingPool.add(userId);
                connectRandomPeers();
                break;
            case 'stop-video':
                targetUserId = data.target;
                targetWs = peers.get(targetUserId);
                if (targetWs && targetWs.readyState === WebSocket.OPEN) {
                    targetWs.send(JSON.stringify({ type: 'requeue' }));
                    console.log(`Notified ${targetUserId} to end call by ${userId}`);
                }
                waitingPool.delete(userId);
                break;
            case 'skip-chat':
                targetUserId = data.target;
                targetWs = peers.get(targetUserId);
                if (targetWs && targetWs.readyState === WebSocket.OPEN) {
                    targetWs.send(JSON.stringify({ type: 'requeue' }));
                    console.log(`${targetUserId} notified to end call by ${userId}`);
                }
                waitingPool.delete(userId);
                break;
            case 'report':
                reportedUserId = data.reportedUserId;
                reportedWs = peers.get(reportedUserId);
                myWs = peers.get(userId);
                if (reportedWs) {
                    const reportedIP = reportedWs.ip;
                    reportCount = (reports.get(reportedIP) || 0) + 1;
                    reports.set(reportedIP, reportCount);

                    if (reportCount >= 10) {
                        bannedIPs.add(reportedIP);
                        reportedWs.send(JSON.stringify({ type: 'banned', reason: '10 reports' }));
                        reportedWs.close();
                        peers.delete(reportedUserId);
                        waitingPool.delete(reportedUserId);
                    } else if (reportedWs.readyState === WebSocket.OPEN) {
                        reportedWs.send(JSON.stringify({ type: 'requeue' }));
                        waitingPool.add(reportedUserId);
                    }
                }
                if (myWs && myWs.readyState === WebSocket.OPEN) {
                    myWs.send(JSON.stringify({ type: 'requeue' }));
                    waitingPool.add(userId);
                }
                connectRandomPeers();
                break;
            case 'offer':
            case 'answer':
            case 'candidate':
            case 'chat':
                targetWs = peers.get(data.target);
                if (targetWs && targetWs.readyState === WebSocket.OPEN) {
                    targetWs.send(JSON.stringify(data));
                } else {
                    console.log(`Target ${data.target} not found or closed`);
                }
                break;
        }
    });

    ws.on('close', () => {
        peers.delete(userId);
        waitingPool.delete(userId);
        peers.forEach(peer => {
            if (peer.readyState === WebSocket.OPEN) {
                peer.send(JSON.stringify({ type: 'peer-disconnected', userId }));
            }
        });
        console.log(`User ${userId} disconnected`);
        connectRandomPeers();
    });

    ws.on('pong', () => {
        ws.isAlive = true;
    });

    ws.on('error', (error) => {
        console.error(`WebSocket error for ${userId}:`, error);
        peers.delete(userId);
        waitingPool.delete(userId);
    });
});

wss.on('error', (error) => {
    console.error('Server error:', error);
});

wss.on('listening', () => {
    console.log(`Server running on port ${port}`);
});