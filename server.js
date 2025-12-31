const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const fs = require('fs');
const os = require('os');

require('dotenv').config();

// Optional systeminformation - gracefully handle if not installed
let si = null;
try {
  si = require('systeminformation');
} catch {
  console.warn('systeminformation not installed - server info will use fallback data');
}

// Database connection pool
const pool = new Pool({
  connectionString: `postgresql://${process.env.DB_USER}:${process.env.DB_PASSWORD}@${process.env.DB_HOST}:${process.env.DB_PORT}/${process.env.DB_DATABASE}?sslmode=require`,
  ssl: { rejectUnauthorized: true, ca: process.env.DB_SSL_CERT }
});

const app = express();
const CONFIG = require('./config/config.json');
const PORT = process.env.PORT || CONFIG.server.port;
const MOTD_FILE = path.join(__dirname, CONFIG.server.motdFile);
const LINKS = CONFIG.links;

// Commands handled by frontend - automatically delegates to client
const CLIENT_COMMANDS = new Set(CONFIG.clientCommands);

// Check if command should be handled by client
const isClientCommand = cmd => CLIENT_COMMANDS.has(cmd) || (LINKS[cmd] && !LINKS[cmd].sudoOnly);

// MOTD command handlers - declarative pattern
const MOTD_HANDLERS = {
  '-add': (args) => {
    if (!args) return 'Usage: motd -add [text]';
    fs.appendFileSync(MOTD_FILE, args + '\n', 'utf-8');
    return `MOTD updated: ${args}`;
  },
  '-rm': (args) => {
    const line = parseInt(args, 10);
    const lines = readMotdFile();
    if (isNaN(line) || line < 1 || line > lines.length) return 'Invalid line number.';
    lines.splice(line - 1, 1);
    writeMotdFile(lines);
    return `MOTD line ${line} removed.`;
  },
  '-clear': () => { writeMotdFile([]); return 'MOTD cleared.'; }
};

// Middleware
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());
app.set('view engine', 'ejs');

// =============================
// Helper Functions
// =============================
const readMotdFile = () => {
  try {
    return fs.existsSync(MOTD_FILE) 
      ? fs.readFileSync(MOTD_FILE, 'utf-8').split(/\r?\n/).filter(l => l.trim())
      : [];
  } catch (err) {
    console.error('Error reading MOTD:', err);
    return [];
  }
};

const writeMotdFile = lines => fs.writeFileSync(MOTD_FILE, lines.join('\n'), 'utf-8');

const getLinksListHtml = (showSudoOnly = false) => {
  const lines = Object.entries(LINKS)
    .filter(([, v]) => !v.hidden && (showSudoOnly || !v.sudoOnly))
    .map(([k, v]) => `<code>${k}</code>${v.alias ? ` / <code>${v.alias}</code>` : ''}: ${v.name}`);
  return lines.join('<br/>') + '<br/>Use [command] <code>-blank</code> to open in a new tab.';
};

async function getLastLoginInfo() {
  try {
    const { rows } = await pool.query(
      'SELECT request_date, user_agent, ip, location FROM lkevin_console_lastlogin WHERE id = 1'
    );
    return rows.length ? { success: true, data: rows[0] } : { success: false, error: 'No data found' };
  } catch (err) {
    console.error('Error fetching last login info:', err);
    return { success: false, error: err.message };
  }
}

// =============================
// Routes
// =============================
app.get('/', async (req, res) => {
  const result = await getLastLoginInfo();
  const lastLogin = result.success ? result.data : {};
  lastLogin.request_date = lastLogin.request_date?.toISOString() || null;
  res.render('index.ejs', { lastLogin });
});

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
    console.error('Error saving login:', err);
    res.json({ success: false, error: err.message });
  }
});

app.post('/api/sudo', (req, res) => {
  const { password, arg } = req.body;
  if (password !== process.env.SUDO_PASSWORD) return res.json({ valid: false });

  const [cmd, ...rest] = (arg || '').trim().split(' ');
  const cmdLower = cmd.toLowerCase();
  const hasBlank = rest.includes('-blank');
  const restArgs = rest.filter(a => a !== '-blank').join(' ');

  // Client-side commands - delegate to frontend
  if (isClientCommand(cmdLower)) {
    return res.json({ valid: true, output: '', clientCommand: true });
  }

  // Sudo-only link commands (like fdb)
  const link = LINKS[cmdLower];
  if (link?.sudoOnly) {
    return res.json({
      valid: true,
      output: `Opening ${link.name}...${hasBlank ? ' (new tab)' : ''}`,
      redirect: link.url,
      target: hasBlank ? '_blank' : '_self'
    });
  }

  // MOTD modification commands
  if (cmdLower === 'motd' && restArgs) {
    const [flag, ...flagArgs] = restArgs.split(' ');
    const handler = MOTD_HANDLERS[flag];
    return res.json({ 
      valid: true, 
      output: handler ? handler(flagArgs.join(' ')) : 'Invalid motd flag. Use: -add [text], -rm [line], -clear'
    });
  }

  // Unknown command
  res.json({ valid: true, output: `sudo: unknown command${arg ? `: ${arg}` : ''}` });
});

app.get('/api/motd', (req, res) => {
  try {
    res.json({ success: true, motd: readMotdFile() });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Serve config to frontend - single source of truth
app.get('/api/config', (req, res) => res.json({
  links: CONFIG.links,
  weatherCodes: CONFIG.weatherCodes,
  dateFormat: CONFIG.dateFormat,
  terminal: CONFIG.terminal
}));

// Auto-generate redirect routes from LINKS config
Object.entries(LINKS)
  .filter(([, v]) => v.redirect)
  .forEach(([k, v]) => app.get(`/${k}`, (req, res) => res.redirect(v.url)));

// System info endpoint
app.get('/api/sysinfo/cpu', async (req, res) => {
  try {
    const timestamp = new Date().toISOString();
    
    if (si) {
      const [cpu, load, memory, temperature] = await Promise.all([
        si.cpu(), si.currentLoad(), si.mem(), si.cpuTemperature()
      ]);
      return res.json({ success: true, timestamp, cpu, load, memory, uptime: os.uptime(), temperature: temperature?.main ? temperature : null });
    }

    // Fallback using os module
    const cpus = os.cpus();
    res.json({
      success: true, timestamp,
      cpu: { manufacturer: os.type(), brand: os.platform(), cores: cpus.length },
      load: { avgLoad: os.loadavg()[0], currentLoad: os.loadavg()[0] * 100 / cpus.length },
      memory: { total: os.totalmem(), free: os.freemem(), used: os.totalmem() - os.freemem() },
      uptime: os.uptime(), temperature: null
    });
  } catch (err) {
    console.error('Error gathering sysinfo:', err);
    res.json({
      success: false, error: err.message, timestamp: new Date().toISOString(),
      loadavg: os.loadavg(),
      memory: { total: os.totalmem(), free: os.freemem(), used: os.totalmem() - os.freemem() },
      uptime: os.uptime()
    });
  }
});

app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
