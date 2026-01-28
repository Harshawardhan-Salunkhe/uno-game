// This file handles visual effects only

// Create the container if it doesn't exist
function initEffects() {
    if (!document.getElementById('fx-container')) {
        const container = document.createElement('div');
        container.id = 'fx-container';
        document.body.appendChild(container);
    }
}

// MAIN FUNCTION: Call this from script.js
function playAnimation(type) {
    initEffects();
    const container = document.getElementById('fx-container');
    const el = document.createElement('div');
    
    // 1. DRAW 4 (+4)
    if (type === 'DRAW_4') {
        el.className = 'fx-draw4';
        el.innerText = "+4";
    } 
    
    // 2. DRAW 2 (+2)
    else if (type === 'DRAW_2') {
        el.className = 'fx-draw4'; // Re-use draw4 style but smaller
        el.style.fontSize = "100px";
        el.style.webkitTextStroke = "3px orange";
        el.innerText = "+2";
    }

    // 3. REVERSE (Spinning Arrow)
    else if (type === 'REVERSE') {
        el.className = 'fx-reverse';
        el.innerText = "🔄";
    }

    // 4. SKIP (Banned Sign)
    else if (type === 'SKIP') {
        el.className = 'fx-skip';
        el.innerText = "🚫";
    }

    // 5. WILD (Screen Flash)
    else if (type === 'WILD') {
        el.className = 'fx-wild';
    }

    // Add to screen
    container.appendChild(el);

    // Remove after 1.5 seconds (cleanup)
    setTimeout(() => {
        el.remove();
    }, 1500);
}
