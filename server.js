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
const si = require('systeminformation');
const os = require('os');

app.get('/', async (req, res) => {
    var lastLogin = await getLastLoginInfo();
    lastLogin = lastLogin.success ? lastLogin.data : {};
    lastLogin.request_date = lastLogin.request_date ? lastLogin.request_date.toISOString() : null;
    res.render('index.ejs', { lastLogin });
});

async function getLastLoginInfo(req, res) {
  const query = 'SELECT request_date, user_agent, ip, location FROM lkevin_console_lastlogin WHERE id = 1';
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
    const { user_agent, ip_address, location } = req.body;
    const login_date = new Date().toISOString(); 

    const query = `
        INSERT INTO lkevin_console_lastlogin (id, request_date, user_agent, ip, location)
        VALUES (1, $1, $2, $3, $4)
        ON CONFLICT (id)
        DO UPDATE SET
            request_date = EXCLUDED.request_date,
            user_agent = EXCLUDED.user_agent,
            ip = EXCLUDED.ip,
            location = EXCLUDED.location;
    `;

    try {
        await pool.query(query, [login_date, user_agent, ip_address, location || null]);
        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.json({ success: false, error: err.message });
    }
});

app.post('/api/sudo', (req, res) => {
	const { password, arg } = req.body;
	const correctPassword = process.env.SUDO_PASSWORD;

	if (password === correctPassword) {
		if (arg === 'ls') {
			var output = `
<p>Available connections:<br/>	
<code>fn</code> / <code>ferminotify</code>: Fermi Notify<br/>
<code>uni</code>: Uni tools<br/>
<code>ig</code>: Instagram<br/>
<code>gh</code>: GitHub<br/>
<code>li</code>: LinkedIn<br/>
<code>fdb</code>: FermiDB<br/>
Use [command] <code>-blank</code> to open in a new tab.</p>`
		} else if (arg && arg.startsWith('motd ')) {
			let flag = arg.substring(5); // Remove 'motd ' prefix
			if (flag.startsWith('-add ')) {
				let newMotd = flag.substring(5); // Remove '-add ' prefix
				fs.appendFileSync('motd.txt', newMotd + '\n', 'utf-8');
				var output = 'MOTD updated. ' + newMotd;
			} else if (flag.startsWith('-rm ')) {
				let line = parseInt(flag.substring(4)); // Remove '-rm ' prefix
				if (!isNaN(line)) {
					let motdLines = fs.readFileSync('motd.txt', 'utf-8').split('\n');
					if (line >= 1 && line <= motdLines.length) {
						motdLines.splice(line - 1, 1);
						fs.writeFileSync('motd.txt', motdLines.join('\n'), 'utf-8');
						var output = 'MOTD line ' + line + ' removed.';
					} else {
						var output = 'Invalid line number.';
					}
				} else {
					var output = 'Invalid line number.';
				}
			} else if (flag === '-clear') {
				fs.writeFileSync('motd.txt', '', 'utf-8');
				var output = 'MOTD cleared.';
			} else {
				var output = 'Invalid motd flag.';
			}
		} else if (arg === 'fdb') {
			var output = 'Opening FermiDB...';
			var redirect = 'https://fdb.lkev.in';
		} else if (arg === 'fdb -blank') {
			var output = 'Opening FermiDB in a new tab...';
			var redirect = 'https://fdb.lkev.in';
			var target = '_blank';
		} else {
			res.json({ valid: true, output: 'sudo: unknown command' + (arg ? `: ${arg}` : ''), redirect: null, target: null });
			return;
		}
		res.json({ valid: true, output, redirect, target });
	} else {
		res.json({ valid: false });
	}
});

app.get('/api/motd', (req, res) => {
	try {
		const content = fs.existsSync('motd.txt') ? fs.readFileSync('motd.txt', 'utf-8') : '';
		const lines = content.split(/\r?\n/).filter(line => line.trim() !== '');
		res.json({ success: true, motd: lines });
	} catch (err) {
		console.error('Error reading MOTD:', err);
		res.status(500).json({ success: false, error: err.message });
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

// GET /api/sysinfo/cpu - returns live CPU/memory/load/temperature data
app.get('/api/sysinfo/cpu', async (req, res) => {
	try {
		// Try to get rich info from systeminformation
		const [cpu, currentLoad, mem, osInfo, cpuTemp] = await Promise.all([
			si.cpu(),
			si.currentLoad(),
			si.mem(),
			si.time(),
			si.cpuTemperature()
		]).catch(() => null);

		// Fallbacks using os module if systeminformation failed
		const fallbackLoad = os.loadavg ? os.loadavg() : null;
		const fallbackMem = {
			total: os.totalmem(),
			free: os.freemem()
		};

		const result = {
			success: true,
			timestamp: new Date().toISOString(),
			cpu: cpu || { manufacturer: os.type(), brand: os.platform(), cores: os.cpus().length },
			load: currentLoad || { avgload: fallbackLoad, raw: os.cpus().map(c => c.times) },
			memory: mem || fallbackMem,
			uptime: os.uptime(),
			temperature: (cpuTemp && cpuTemp.main) ? cpuTemp : null
		};

		res.json(result);
	} catch (err) {
		console.error('Error gathering sysinfo:', err);
		// Minimal fallback
		try {
			res.json({
				success: false,
				error: err.message,
				timestamp: new Date().toISOString(),
				loadavg: os.loadavg(),
				memory: { total: os.totalmem(), free: os.freemem() },
				uptime: os.uptime()
			});
		} catch (e) {
			res.status(500).json({ success: false, error: 'Unable to gather system information' });
		}
	}
});

app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});
