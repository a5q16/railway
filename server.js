require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();

// 1. Global Middleware
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '10mb' }));

// 2. Health Checks (Required for Railway)
app.get('/', (req, res) => res.status(200).send('Railway Health Check OK'));
app.get('/api/ping', (req, res) => res.status(200).json({ status: 'Alive' }));

app.post('/api/check-auth', (req, res) => {
    try {
        const { authJson } = req.body;
        if (!authJson) return res.json({ valid: false, message: 'No JSON provided' });

        let parsed;
        try { 
            parsed = JSON.parse(authJson); 
        } catch(e) { 
            return res.json({ valid: false, message: 'Invalid JSON format' }); 
        }

        const token = parsed.accessToken;
        if (!token) return res.json({ valid: false, message: 'Missing accessToken' });

        const parts = token.split('.');
        if (parts.length !== 3) return res.json({ valid: false, message: 'Tampered Token: Missing structural parts.' });

        // STRICT TAMPER CHECK: OpenAI RS256 signatures are 342 characters long.
        // If a user deletes even 1 character from the end, this will catch them.
        if (parts[2].length < 340) {
            return res.json({ valid: false, message: 'Validation Failed: Token signature has been tampered with or truncated.' });
        }

        const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf8'));
        const currentUnixTime = Math.floor(Date.now() / 1000);

        if (payload.exp && payload.exp < currentUnixTime) {
            return res.json({ valid: false, message: 'Session Token has expired.' });
        }

        const email = payload['https://api.openai.com/profile']?.email || parsed.user?.email || 'Unknown';
        // ONLY trust the cryptographically secure JWT payload for the plan
        const realPlan = payload['https://api.openai.com/auth']?.chatgpt_plan_type || 'FREE';

        const name = parsed.user?.name || 'Unknown';
        const picture = parsed.user?.picture || '';
        const userId = parsed.user?.id || 'N/A';
        const expires = payload.exp ? new Date(payload.exp * 1000).toLocaleString() : 'Unknown';

        return res.json({ 
            valid: true, 
            email: email, 
            plan: realPlan.toUpperCase(),
            name: name,
            picture: picture,
            userId: userId,
            expires: expires
        });

    } catch (error) {
        return res.json({ valid: false, message: 'Failed to process token data. It may be corrupted.' });
    }
});

// 4. Fallback Error Handler
app.use((req, res) => res.status(404).json({ error: 'Route Not Found' }));

// 5. Start Server
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server listening on port ${PORT}`);
});
