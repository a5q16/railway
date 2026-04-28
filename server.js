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

// 3. Auth Check Route (Pure Local JWT Decode)
app.post('/api/check-auth', async (req, res) => {
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

        // REAL VERIFICATION: Hit OpenAI's official API to prove the token is alive and untampered
        try {
            await axios.get('https://api.openai.com/v1/models', {
                headers: { 'Authorization': `Bearer ${token}` },
                timeout: 8000
            });
        } catch (apiError) {
            // If OpenAI rejects it, it's either tampered, incomplete, or expired.
            return res.json({ valid: false, message: 'Token rejected by OpenAI. It is either incomplete, tampered, or expired.' });
        }

        // If we reach here, OpenAI accepted the token. It is 100% valid and untampered.
        // Now we can safely decode the payload for display purposes.
        const parts = token.split('.');
        const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf8'));
        
        const email = payload['https://api.openai.com/profile']?.email || parsed.user?.email || 'Unknown';
        // Show both what the JWT says and what the wrapper claims, so the admin has full context.
        const jwtPlan = payload['https://api.openai.com/auth']?.chatgpt_plan_type || 'Unknown';
        const wrapperPlan = parsed.account?.planType || 'Unknown';
        
        const name = parsed.user?.name || 'Unknown';
        const picture = parsed.user?.picture || '';
        const userId = parsed.user?.id || 'N/A';
        const expires = payload.exp ? new Date(payload.exp * 1000).toLocaleString() : 'Unknown';

        return res.json({ 
            valid: true, 
            email: email, 
            plan: `${wrapperPlan.toUpperCase()} (JWT: ${jwtPlan})`,
            name: name,
            picture: picture,
            userId: userId,
            expires: expires
        });

    } catch (error) {
        console.error('Server Error:', error.message);
        return res.json({ valid: false, message: 'Internal server error during validation.' });
    }
});

// 4. Fallback Error Handler
app.use((req, res) => res.status(404).json({ error: 'Route Not Found' }));

// 5. Start Server
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server listening on port ${PORT}`);
});
