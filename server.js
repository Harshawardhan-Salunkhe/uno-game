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

// --- PERSISTENCE ---
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

// --- GAME STATE ---
let players = [];
let deck = [];
let discardPile = [];
let winners = []; 
let turnIndex = 0;
let direction = 1;
let gameRunning = false;
let currentColor = '';
let turnTimer = null;

// --- HELPER FUNCTIONS ---
function createDeck() {
    deck = [];
    const colors = ['Red', 'Blue', 'Green', 'Yellow'];
    const values = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'Skip', 'Reverse', 'Draw2'];
    colors.forEach(c => values.forEach(v => { deck.push({color:c, value:v, type:'normal'}); if(v!=='0') deck.push({color:c, value:v, type:'normal'}); }));
    for(let i=0; i<4; i++) { deck.push({color:'Black', value:'Wild', type:'wild'}); deck.push({color:'Black', value:'Wild Draw4', type:'wild'}); }
    return deck;
}
function shuffleDeck() { for (let i = deck.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [deck[i], deck[j]] = [deck[j], deck[i]]; } }

function checkDeck() {
    if (deck.length < 2) { // Ensure we always have cards for penalties
        let top = discardPile.pop();
        deck = discardPile;
        discardPile = [top];
        shuffleDeck();
    }
}

function advanceTurn(skips=0) { 
    if(turnTimer) { clearTimeout(turnTimer); turnTimer = null; }
    let activePlayers = players.filter(p => !p.finished);
    if (activePlayers.length === 0) return;

    let steps = 1 + skips;
    while(steps > 0) {
        turnIndex = (turnIndex + direction + players.length) % players.length;
        if (!players[turnIndex].finished) steps--;
    }
}

function resetGame() {
    gameRunning = false;
    deck = [];
    discardPile = [];
    winners = [];
    players.forEach(p => { p.hand = []; p.finished = false; p.saidUno = false; });
}

// --- SOCKET LOGIC ---
io.on('connection', (socket) => {
    console.log('Connected:', socket.id);

    socket.on('joinGame', (name) => {
        if (gameRunning) return socket.emit('error', 'Game in progress');
        if (players.find(p => p.name === name)) return;
        players.push({ id: socket.id, name, hand: [], finished: false, saidUno: false });
        io.emit('updatePlayerList', players);
    });

    socket.on('startGame', () => {
        if (players.length < 2) return;
        createDeck(); shuffleDeck();
        players.forEach(p => {
            p.hand = deck.splice(0, 7);
            p.finished = false;
            p.saidUno = false;
        });
        discardPile = [deck.pop()];
        while(discardPile[0].color === 'Black') { deck.unshift(discardPile.pop()); shuffleDeck(); discardPile.push(deck.pop()); }
        currentColor = discardPile[0].color;
        
        winners = [];
        gameRunning = true; 
        turnIndex = 0; 
        direction = 1;
        updateGameState();
    });

    socket.on('playCard', ({ cardIndex, chosenColor }) => {
        const player = players.find(p => p.id === socket.id);
        if (!gameRunning || players[turnIndex].id !== socket.id) return;

        const card = player.hand[cardIndex];
        const top = discardPile[discardPile.length - 1];
        
        // Validation
        let valid = (card.color === currentColor) || (card.value === top.value) || (card.color === 'Black');
        if (!valid) return;

        // --- UNO PENALTY CHECK ---
        // If you have 2 cards, you are about to have 1. You MUST have said UNO.
        let penalty = false;
        if (player.hand.length === 2 && !player.saidUno) {
            penalty = true; // Mark for punishment
        }

        // Stop Timer
        if(turnTimer) { clearTimeout(turnTimer); turnTimer = null; }

        // Execute Play
        player.hand.splice(cardIndex, 1);
        discardPile.push(card);
        player.saidUno = false; // Reset flag

        // --- APPLY PENALTY ---
        if (penalty) {
            checkDeck();
            player.hand.push(deck.pop(), deck.pop()); // Add 2 cards
            socket.emit('message', "⚠️ YOU FORGOT TO SAY UNO! +2 Cards Penalty!");
            io.emit('message', `🔔 ${player.name} forgot UNO and drew 2 penalty cards!`);
        }

        // --- ACTION LOGIC ---
        let skip = 0;
        if (card.value === 'Reverse') { 
            direction *= -1; 
            if(players.filter(p => !p.finished).length === 2) skip=1; 
        }
        else if (card.value === 'Skip') skip = 1;
        else if (card.value === 'Draw2') { 
            skip=1; 
            let vIndex = turnIndex;
            do { vIndex = (vIndex + direction + players.length) % players.length; } while(players[vIndex].finished);
            checkDeck();
            players[vIndex].hand.push(deck.pop(),deck.pop()); 
        }
        else if (card.value.includes('Wild')) { 
            currentColor = chosenColor; 
            if(card.value.includes('Draw4')) { 
                skip=1; 
                let vIndex = turnIndex;
                do { vIndex = (vIndex + direction + players.length) % players.length; } while(players[vIndex].finished);
                checkDeck();
                players[vIndex].hand.push(deck.pop(),deck.pop(),deck.pop(),deck.pop()); 
            }
        }
        if (card.color !== 'Black') currentColor = card.color;

        // --- WINNER LOGIC ---
        if (player.hand.length === 0) {
            player.finished = true;
            winners.push({ name: player.name, rank: winners.length + 1 });
            io.emit('message', `🏆 ${player.name} finished Rank #${winners.length}!`);

            const active = players.filter(p => !p.finished);
            if (active.length <= 1) {
                if (active.length === 1) winners.push({ name: active[0].name, rank: winners.length + 1 });
                gameRunning = false;
                io.emit('gameOver', winners);
                return;
            }
        }

        advanceTurn(skip);
        updateGameState();
    });

    socket.on('drawCard', () => {
        if (players[turnIndex].id !== socket.id) return;
        checkDeck();

        const player = players.find(p => p.id === socket.id);
        const newCard = deck.pop();
        player.hand.push(newCard);
        io.to(player.id).emit('yourHand', player.hand);

        // Check Playable
        const top = discardPile[discardPile.length - 1];
        const isPlayable = (newCard.color === currentColor) || (newCard.value === top.value) || (newCard.color === 'Black');

        if (isPlayable) {
            socket.emit('message', "Playable! Drop it in 5s or skip.");
            socket.emit('timerStart', 5);
            if(turnTimer) clearTimeout(turnTimer);
            turnTimer = setTimeout(() => {
                io.emit('message', `${player.name} hesitated! Next turn.`);
                advanceTurn(); 
                updateGameState();
            }, 5000);
        } else {
            socket.emit('message', "No luck. Next turn.");
            advanceTurn();
            updateGameState();
        }
    });

    socket.on('sayUno', () => {
        const player = players.find(p => p.id === socket.id);
        if (player.hand.length === 2) {
            player.saidUno = true;
            io.emit('message', `🔔 ${player.name} shouted UNO!`);
        }
    });

    socket.on('playAgain', () => {
        resetGame();
        io.emit('resetLobby');
        io.emit('updatePlayerList', players);
    });

    socket.on('disconnect', () => {
        if(turnTimer) clearTimeout(turnTimer);
        players = players.filter(p => p.id !== socket.id);
        io.emit('updatePlayerList', players);
        if(players.length < 2 && gameRunning) {
            gameRunning = false;
            resetGame();
            io.emit('resetLobby');
        }
    });
});

function updateGameState() {
    if(!gameRunning) return;
    io.emit('gameState', {
        topCard: discardPile[discardPile.length - 1],
        currentColor,
        currentPlayer: players[turnIndex].id,
        direction: direction > 0 ? "CW" : "CCW"
    });
    players.forEach(p => io.to(p.id).emit('yourHand', p.hand));
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server Ready on port ${PORT}`));