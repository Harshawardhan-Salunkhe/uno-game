const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- PERSISTENCE (Users) ---
const USERS_FILE = path.join(__dirname, 'users.json');
function getUsers() {
    if (!fs.existsSync(USERS_FILE)) return [];
    const data = fs.readFileSync(USERS_FILE);
    return data.length ? JSON.parse(data) : [];
}
function saveUser(user) {
    const users = getUsers();
    users.push(user);
    fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}

// --- AUTH ---
app.post('/api/register', (req, res) => {
    const { username, password } = req.body;
    const users = getUsers();
    if (users.find(u => u.username === username)) return res.json({ success: false, message: "Username taken!" });
    saveUser({ username, password });
    res.json({ success: true });
});

app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    const user = getUsers().find(u => u.username === username && u.password === password);
    res.json(user ? { success: true, username: user.username } : { success: false, message: "Invalid credentials" });
});

// ==========================================================
//  MULTI-LOBBY SYSTEM (THE NEW CORE)
// ==========================================================
const lobbies = {}; // Stores all active game rooms. Key = Room Code

// --- HELPER: Generate Code ---
function generateLobbyCode() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let result = '';
    for (let i = 0; i < 6; i++) result += chars.charAt(Math.floor(Math.random() * chars.length));
    return result;
}

// --- HELPER: Deck Creation ---
function createDeck() {
    let deck = [];
    const colors = ['Red', 'Blue', 'Green', 'Yellow'];
    const values = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'Skip', 'Reverse', 'Draw2'];
    colors.forEach(c => values.forEach(v => { deck.push({color:c, value:v}); if(v!=='0') deck.push({color:c, value:v}); }));
    for(let i=0; i<4; i++) { deck.push({color:'Black', value:'Wild'}); deck.push({color:'Black', value:'Wild Draw4'}); }
    return deck;
}
function shuffle(deck) { for (let i = deck.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [deck[i], deck[j]] = [deck[j], deck[i]]; } }

// --- SOCKET LOGIC ---
io.on('connection', (socket) => {
    console.log('Connected:', socket.id);

    // 1. CREATE LOBBY
    socket.on('createLobby', (username) => {
        const code = generateLobbyCode();
        lobbies[code] = {
            code: code,
            players: [{ id: socket.id, name: username, hand: [], finished: false, saidUno: false }],
            deck: [],
            discardPile: [],
            turnIndex: 0,
            direction: 1,
            gameRunning: false,
            drawPenalty: 0,
            currentColor: '',
            turnTimer: null
        };
        
        socket.join(code); // Socket.io Room feature
        socket.emit('lobbyCreated', code);
        io.to(code).emit('updatePlayerList', lobbies[code].players);
    });

    // 2. JOIN LOBBY
    socket.on('joinLobby', ({ code, username }) => {
        const lobby = lobbies[code];
        if (!lobby) return socket.emit('error', 'Lobby not found!');
        if (lobby.gameRunning) return socket.emit('error', 'Game already started!');
        if (lobby.players.find(p => p.name === username)) return socket.emit('error', 'Name taken!');

        lobby.players.push({ id: socket.id, name: username, hand: [], finished: false, saidUno: false });
        socket.join(code);
        
        // Notify user they joined successfully
        socket.emit('joinedLobby', code);
        // Update everyone in the room
        io.to(code).emit('updatePlayerList', lobby.players);
    });

    // 3. START GAME
    socket.on('startGame', (code) => {
        const lobby = lobbies[code];
        if (!lobby || lobby.players.length < 2) return;

        lobby.deck = createDeck();
        shuffle(lobby.deck);
        
        lobby.players.forEach(p => {
            p.hand = lobby.deck.splice(0, 7);
            p.finished = false;
            p.saidUno = false;
        });

        lobby.discardPile = [lobby.deck.pop()];
        while(lobby.discardPile[0].color === 'Black') { 
            lobby.deck.unshift(lobby.discardPile.pop()); 
            shuffle(lobby.deck); 
            lobby.discardPile.push(lobby.deck.pop()); 
        }
        
        lobby.currentColor = lobby.discardPile[0].color;
        lobby.gameRunning = true;
        lobby.turnIndex = 0;
        
        updateGameState(code);
    });

    // 4. PLAY CARD
    socket.on('playCard', ({ code, cardIndex, chosenColor }) => {
        const lobby = lobbies[code];
        if(!lobby || !lobby.gameRunning) return;
        
        const player = lobby.players.find(p => p.id === socket.id);
        if (lobby.players[lobby.turnIndex].id !== socket.id) return;

        const card = player.hand[cardIndex];
        const top = lobby.discardPile[lobby.discardPile.length - 1];

        // VALIDATION
        let isValid = false;
        if (lobby.drawPenalty > 0) {
            if (card.value.includes('Draw4')) isValid = true;
            else if (card.value === 'Draw2' && (card.color === lobby.currentColor || top.value === 'Draw2')) isValid = true;
        } else {
            if (card.color === lobby.currentColor || card.value === top.value || card.color === 'Black') isValid = true;
        }

        if (!isValid) return;

        // Clear Timer
        if(lobby.turnTimer) { clearTimeout(lobby.turnTimer); lobby.turnTimer = null; }

        player.hand.splice(cardIndex, 1);
        lobby.discardPile.push(card);
        
        // Handle Color
        lobby.currentColor = (card.color === 'Black') ? chosenColor : card.color;

        // Handle Effects
        let skip = 0;
        if (card.value === 'Reverse') {
            lobby.direction *= -1;
            if(lobby.players.filter(p => !p.finished).length === 2) skip = 1;
        }
        else if (card.value === 'Skip') skip = 1;
        else if (card.value === 'Draw2') lobby.drawPenalty += 2;
        else if (card.value.includes('Draw4')) lobby.drawPenalty += 4;

        // WIN CONDITION
        if (player.hand.length === 0) {
            player.finished = true;
            const winners = lobby.players.filter(p => p.finished);
            io.to(code).emit('message', `🏆 ${player.name} Finished!`);
            
            if (lobby.players.filter(p => !p.finished).length <= 1) {
                lobby.gameRunning = false;
                io.to(code).emit('gameOver', winners);
                delete lobbies[code]; // Cleanup lobby after game
                return;
            }
        }

        advanceTurn(lobby, skip);
        updateGameState(code);
    });

    // 5. DRAW CARD
    socket.on('drawCard', (code) => {
        const lobby = lobbies[code];
        if(!lobby || lobby.players[lobby.turnIndex].id !== socket.id) return;
        const player = lobby.players.find(p => p.id === socket.id);

        // PENALTY DRAW
        if (lobby.drawPenalty > 0) {
            for(let i=0; i<lobby.drawPenalty; i++) {
                if(lobby.deck.length === 0) refillDeck(lobby);
                player.hand.push(lobby.deck.pop());
            }
            lobby.drawPenalty = 0;
            io.to(player.id).emit('yourHand', player.hand);
            advanceTurn(lobby);
            updateGameState(code);
            return;
        }

        // NORMAL DRAW
        if(lobby.deck.length === 0) refillDeck(lobby);
        const newCard = lobby.deck.pop();
        player.hand.push(newCard);
        io.to(player.id).emit('yourHand', player.hand);
        
        advanceTurn(lobby); // Simple rule: Draw passes turn immediately
        updateGameState(code);
    });

    // 6. DISCONNECT & CLEANUP
    socket.on('disconnect', () => {
        // Find which lobby this socket belongs to
        let foundCode = null;
        for (const [code, lobby] of Object.entries(lobbies)) {
            const pIndex = lobby.players.findIndex(p => p.id === socket.id);
            if (pIndex !== -1) {
                foundCode = code;
                const player = lobby.players[pIndex];
                const wasTurn = (pIndex === lobby.turnIndex);
                
                lobby.players.splice(pIndex, 1);
                
                if (lobby.players.length === 0) {
                    delete lobbies[code]; // Delete empty lobby
                } else {
                    if (pIndex < lobby.turnIndex) lobby.turnIndex--;
                    if (wasTurn) advanceTurn(lobby, 0);
                    
                    io.to(code).emit('message', `⚠️ ${player.name} disconnected.`);
                    io.to(code).emit('updatePlayerList', lobby.players);
                    updateGameState(code);
                }
                break;
            }
        }
    });
});

// --- UTILS ---
function refillDeck(lobby) {
    if (lobby.discardPile.length > 1) {
        let top = lobby.discardPile.pop();
        lobby.deck = lobby.discardPile;
        lobby.discardPile = [top];
        shuffle(lobby.deck);
    }
}

function advanceTurn(lobby, skips=0) {
    let steps = 1 + skips;
    let active = lobby.players.filter(p => !p.finished);
    if (active.length === 0) return;
    
    while(steps > 0) {
        lobby.turnIndex = (lobby.turnIndex + lobby.direction + lobby.players.length) % lobby.players.length;
        if (!lobby.players[lobby.turnIndex].finished) steps--;
    }
}

function updateGameState(code) {
    const lobby = lobbies[code];
    if(!lobby || !lobby.gameRunning) return;
    
    io.to(code).emit('gameState', {
        topCard: lobby.discardPile[lobby.discardPile.length - 1],
        currentColor: lobby.currentColor,
        currentPlayer: lobby.players[lobby.turnIndex].id,
        direction: lobby.direction > 0 ? "CW" : "CCW",
        
        // --- NEW ADDITION: This sends the names & card counts ---
        playerInfo: lobby.players.map(p => ({ 
            name: p.name, 
            cards: p.hand.length, 
            id: p.id 
        }))
    });
    
    lobby.players.forEach(p => io.to(p.id).emit('yourHand', p.hand));
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));

