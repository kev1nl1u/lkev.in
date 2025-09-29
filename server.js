const express = require('express');
const path = require('path');
const { Pool } = require("pg");
const fs = require('fs');

require("dotenv").config();

const pool = new Pool({
  connectionString: `postgresql://${process.env.DB_USER}:${process.env.DB_PASSWORD}@${process.env.DB_HOST}:${process.env.DB_PORT}/${process.env.DB_DATABASE}?sslmode=require`,
  ssl: {
    rejectUnauthorized: true,
    ca: process.env.DB_SSL_CERT
  }
});

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));
app.set("view engine", "ejs");

app.use(express.json());

app.get('/', async (req, res) => {
    var lastLogin = await getLastLoginInfo();
    lastLogin = lastLogin.success ? lastLogin.data : {};
    lastLogin.request_date = lastLogin.request_date ? lastLogin.request_date.toISOString() : null;
    res.render('index.ejs', { lastLogin });
});

async function getLastLoginInfo(req, res) {
  const query = 'SELECT request_date, user_agent, ip FROM lkevin_console_lastlogin WHERE id = 1';
  try {
	const result = await pool.query(query);
	if (result.rows.length > 0) {
	  return { success: true, data: result.rows[0] };
	} else {
	  return { success: false, error: 'No data found' };
	}
  } catch (err) {
    console.error('Error fetching last login info:', err);
    res.json({ success: false, error: err.message });
  }
}

app.post('/api/save-login', async (req, res) => {
    const { user_agent, ip_address } = req.body;
    const login_date = new Date().toISOString(); 

    const query = `
        INSERT INTO lkevin_console_lastlogin (id, request_date, user_agent, ip)
        VALUES (1, $1, $2, $3)
        ON CONFLICT (id)
        DO UPDATE SET
            request_date = EXCLUDED.request_date,
            user_agent = EXCLUDED.user_agent,
            ip = EXCLUDED.ip;
    `;

    try {
        await pool.query(query, [login_date, user_agent, ip_address || null]);
        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.json({ success: false, error: err.message });
    }
});


app.get('/gh', (req, res) => {
	res.redirect('https://github.com/kev1nl1u');
});

app.get('/ig', (req, res) => {
	res.redirect('https://www.instagram.com/kev1nl1u/');
});

app.get('/li', (req, res) => {
	res.redirect('https://linkedin.com/in/liuck');
});

app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});
