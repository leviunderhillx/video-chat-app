const WebSocket = require('ws');

// Use Render's dynamic port (default 10000) or fallback to 8080 for local testing
const port = process.env.PORT || 10000;
const wss = new WebSocket.Server({ port });

let peers = new Map();
let waitingPool = new Set();
let reports = new Map();
let bannedIPs = new Set();

function connectRandomPeers() {
    const waitingArray = Array.from(waitingPool);
    console.log('Waiting pool:', waitingArray);
    if (waitingArray.length >= 2) {
        const peer1Id = waitingArray[0];
        const peer2Id = waitingArray[1];
        
        const peer1 = peers.get(peer1Id);
        const peer2 = peers.get(peer2Id);
        
        if (peer1 && peer2 && peer1.readyState === WebSocket.OPEN && peer2.readyState === WebSocket.OPEN) {
            console.log(`Matching ${peer1Id} with ${peer2Id}`);
            peer1.send(JSON.stringify({ type: 'matched', peerId: peer2Id }));
            console.log(`Sent matched message to ${peer1Id} with peer ${peer2Id}`);
            peer2.send(JSON.stringify({ type: 'matched', peerId: peer1Id }));
            console.log(`Sent matched message to ${peer2Id} with peer ${peer1Id}`);
            waitingPool.delete(peer1Id);
            waitingPool.delete(peer2Id);
        } else {
            console.log('Matching failed: One or both peers not available or closed');
            if (!peer1 || peer1.readyState !== WebSocket.OPEN) waitingPool.delete(peer1Id);
            if (!peer2 || peer2.readyState !== WebSocket.OPEN) waitingPool.delete(peer2Id);
            setTimeout(connectRandomPeers, 1000); // Retry after 1s
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
            console.log('Sending admin update:', connectedPeers);
            ws.send(JSON.stringify({ type: 'admin-update', peers: connectedPeers }));
        }
    });
}

wss.on('connection', (ws, req) => {
    const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress;
    console.log(`New connection from IP: ${ip}`);
    if (bannedIPs.has(ip)) {
        console.log(`Banned IP attempted connection: ${ip}`);
        ws.send(JSON.stringify({ type: 'banned', reason: 'You have been banned' }));
        ws.close();
        return;
    }

    const peerId = Math.random().toString(36).substring(2);
    peers.set(peerId, ws);
    ws.ip = ip;
    ws.isAdmin = false;
    console.log(`Assigned peer ID: ${peerId}`);
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
        }
        else if (data.type === 'join') {
            waitingPool.add(peerId);
            console.log(`${peerId} joined waiting pool. Pool size: ${waitingPool.size}`);
            connectRandomPeers();
            broadcastAdminUpdate();
        }
        else if (data.type === 'report') {
            const reportedPeerId = data.reportedPeerId;
            const myPeerId = data.myPeerId;
            const reportedWs = peers.get(reportedPeerId);
            const myWs = peers.get(myPeerId);

            if (reportedWs) {
                const reportedIP = reportedWs.ip;
                const reportCount = (reports.get(reportedIP) || 0) + 1;
                reports.set(reportedIP, reportCount);
                console.log(`Report for ${reportedPeerId} (IP: ${reportedIP}). Count: ${reportCount}`);
                
                if (reportCount >= 10) {
                    bannedIPs.add(reportedIP);
                    reportedWs.send(JSON.stringify({ type: 'banned', reason: 'Banned due to 10 reports' }));
                    reportedWs.close();
                    peers.delete(reportedPeerId);
                    waitingPool.delete(reportedPeerId);
                    console.log(`Banned IP: ${reportedIP}`);
                } else {
                    if (reportedWs.readyState === WebSocket.OPEN) {
                        reportedWs.send(JSON.stringify({ type: 'requeue' }));
                        waitingPool.add(reportedPeerId);
                    }
                    if (myWs && myWs.readyState === WebSocket.OPEN) {
                        myWs.send(JSON.stringify({ type: 'requeue' }));
                        waitingPool.add(myPeerId);
                    }
                    console.log(`Requeued ${myPeerId} and ${reportedPeerId} to waiting pool`);
                }
            } else {
                console.log(`Reported peer not found: ${reportedPeerId}`);
                if (myWs && myWs.readyState === WebSocket.OPEN) {
                    myWs.send(JSON.stringify({ type: 'requeue' }));
                    waitingPool.add(myPeerId);
                }
            }
            connectRandomPeers();
            broadcastAdminUpdate();
        }
        else if (data