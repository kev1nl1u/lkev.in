// =============================
// Constants & Configuration
// =============================
const currentYear = new Date().getFullYear();
const domain = window.location.hostname || window.location.host || window.location.href.split("/")[2] || 'localhost';

// Command history with localStorage persistence
let STORAGE_KEY = 'lkevin_command_history';
let MAX_HISTORY_SIZE = 100;
let commands = [];
let commandIndex = 0;

// Global state for live server updates
let serverInfoInterval = null;

// Configuration - loaded from server (single source of truth: config/config.json)
let linkConfig = {};
let WEATHER_CODES = {};
let dateFormatOptions = {};

// Generate links list HTML from linkConfig (used by ls and help)
const getLinksListHtml = (showFdb = false) => {
	const lines = Object.entries(linkConfig)
		.filter(([, v]) => !v.hidden && !v.sudoOnly)
		.map(([k, v]) => {
			let line = `<code>${k}</code>${v.alias ? ` / <code>${v.alias}</code>` : ''}: ${v.name}`;
			if (v.subcommands) {
				const subs = Object.keys(v.subcommands).map(s => `<code>${s}</code>`).join(', ');
				line += ` (subcommands: ${subs})`;
			}
			return line;
		});
	if (showFdb) lines.push('<code>fdb</code>: FermiDB');
	return lines.join('<br/>') + '<br/>Use [command] <code>-blank</code> to open in a new tab.';
};

// Generate link commands help from linkConfig
const getLinkCommandsHelp = () => Object.entries(linkConfig)
	.filter(([, v]) => !v.hidden && !v.sudoOnly)
	.map(([k, v]) => {
		let args = '[<code>-blank</code>]';
		if (v.subcommands) args = `[${Object.keys(v.subcommands).map(s => `<code>${s}</code>`).join('|')}] ${args}`;
		return `<p><code>${k}</code>${v.alias ? ` / <code>${v.alias}</code>` : ''} ${v.name} ${args}</p>`;
	})
	.join('\n\t\t\t');

// Get URL for link - use server redirects for external links, direct URL otherwise
const getLinkUrl = (key) => {
	const link = linkConfig[key];
	if (!link) return null;
	return link.redirect ? `/${key}` : link.url;
};

// Location icon helper to reduce repetition
const locationIcon = (loc, found = !!loc) => 
	`<span class="material-symbols-outlined">${found ? 'location_on' : 'not_listed_location'}</span>${loc ? ` ${loc}` : ''}`;

// Format MOTD lines consistently
const formatMotd = (lines, useNumbers = false) => 
	lines.map((l, i) => `${useNumbers ? `${i + 1}.` : '*'} ${l}<br/>`).join('');

// =============================
// Utility Functions
// =============================
const getOS = () => {
	const p = navigator.platform.toLowerCase(), ua = navigator.userAgent.toLowerCase();
	return p.includes('win') ? 'Windows' : p.includes('mac') ? 'MacOS' : p.includes('linux') ? 'Linux' :
		/iphone|ipad|ipod/.test(ua) ? 'iOS' : /android/.test(ua) ? 'Android' : 'Unknown';
};

const getBrowser = () => {
	const ua = navigator.userAgent;
	return ua.includes("Chrome") && !ua.includes("Edg") && !ua.includes("OPR") ? "Chrome" :
		ua.includes("Firefox") ? "Firefox" : ua.includes("Safari") && !ua.includes("Chrome") ? "Safari" :
		ua.includes("Edg") ? "Edge" : ua.includes("OPR") || ua.includes("Opera") ? "Opera" : "Unknown";
};

const getUserAgent = () => {
	const os = getOS(), browser = getBrowser();
	return os && browser ? `${os} / ${browser}` : os || browser || 'unknown agent';
};

const formatDate = (date, options = dateFormatOptions) => new Intl.DateTimeFormat(navigator.language, {
	...options, timeZone: options.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone
}).format(date);

const $ = s => document.querySelector(s);
const $$ = s => document.querySelectorAll(s);
const escapeHtml = text => { const d = document.createElement('div'); d.textContent = text; return d.innerHTML; };
const setCursorAtEnd = el => {
	const range = document.createRange(), sel = window.getSelection();
	range.selectNodeContents(el); range.collapse(false);
	sel.removeAllRanges(); sel.addRange(range);
};
const saveCommandHistory = () => localStorage.setItem(STORAGE_KEY, JSON.stringify(commands.slice(-MAX_HISTORY_SIZE)));
const deactivate = el => { el.removeAttribute('contenteditable'); el.classList.remove('active'); };

// =============================
// API Functions
// =============================
async function fetchJSON(url, options = {}) {
	const response = await fetch(url, options);
	if (!response.ok) throw new Error(response.statusText);
	return response.json();
}

async function getIP(ipEl) {
	try {
		const data = await fetchJSON('https://ipinfo.io/json');
		const ip = data.ip || null;
		if (ipEl) ipEl.textContent = ip || 'unknown';
		return ip;
	} catch (error) {
		console.error('Error fetching IP address:', error);
		if (ipEl) ipEl.textContent = 'unknown';
		return null;
	}
}

async function getLocation(ip, locationEl) {
	try {
		const data = await fetchJSON(`https://ipapi.co/${ip}/json/`);
		if (data.error) throw new Error(data.reason || 'Unknown error');
		const location = [data.city, data.country_name].filter(Boolean).join(', ') || null;
		if (locationEl) locationEl.innerHTML = locationIcon(location);
		return location;
	} catch (error) {
		console.error('Error fetching location:', error);
		if (locationEl) locationEl.innerHTML = locationIcon(null);
		return null;
	}
}

// =============================
// Live Server Updates Management
// =============================
function stopServerUpdates(showMessage = true) {
	if (!serverInfoInterval) return false;
	
	clearInterval(serverInfoInterval.id);
	const { containerId } = serverInfoInterval;
	
	if (containerId) {
		const el = document.getElementById(containerId);
		if (el && showMessage) {
			const note = document.createElement('div');
			note.innerHTML = '<p>Live updates stopped (Ctrl+C).</p>';
			el.appendChild(note);
		}
	}
	
	serverInfoInterval = null;
	return true;
}

// =============================
// Terminal Output Functions
// =============================
const printOutput = html => {
	const el = document.createElement('div');
	el.className = 'output line';
	el.innerHTML = html;
	$('.commands').appendChild(el);
};

const printP = text => printOutput(`<p>${text}</p>`);
const printError = (cmd, msg) => printP(cmd ? `${cmd}: ${msg}` : msg);

function printNewPrompt() {
	const line = document.createElement('div');
	line.className = 'line';
	line.innerHTML = `
		<span class="linestart"><span class="user">user</span>@<span class="url">${domain}</span>:<span class="path">~</span>$</span>
		<div class="command-input active" contenteditable="true" autofocus autocomplete="off" autocapitalize="off" autocorrect="off"></div>
	`;
	$('.commands').appendChild(line);
	$('.command-input.active').focus();
	window.scrollTo(0, document.body.scrollHeight);
}

// =============================
// Command Registry - Single source of truth
// =============================
// clientOnly: true = handled by frontend (not server)
// group: 'core' | 'utility' | 'link' - for help organization
// handler: function | string - function to execute or static output string
// noArgs: true = reject any arguments
const COMMANDS = {
	// Core commands
	help:    { description: 'display this help message', args: '[command]', clientOnly: true, group: 'core',
	           help: 'Display a list of all available commands. Use <code>help [command]</code> to get detailed information about a specific command.' },
	about:   { description: 'information about me', clientOnly: true, group: 'core', noArgs: true,
	           help: 'Display information about me.',
	           handler: `I'm Kevin, a Computer Engineering student at the University of Padua (UniPD), and a graduate of I.S. E. Fermi Mantova.<br/>You can explore my open source projects on <a href="https://lkev.in/gh" target="_blank" rel="noopener">GitHub</a>.` },
	sudo:    { description: 'get superuser privileges', args: '[command [arg...]]', group: 'core',
	           help: 'Execute a command with superuser privileges. Requires password authentication.<br/><br/>Usage: <code>sudo [command] [args...]</code><br/><br/>Examples:<br/>• <code>sudo motd -add Hello World</code> - Add a message to MOTD<br/>• <code>sudo fdb</code> - Access restricted links' },
	motd:    { description: 'view the message of the day', clientOnly: true, group: 'core',
	           help: 'Display the current Message of the Day (MOTD).<br/><br/>With sudo privileges, you can modify the MOTD:<br/>• <code>sudo motd -add [text]</code> - Add a new line<br/>• <code>sudo motd -rm [line]</code> - Remove a line by number<br/>• <code>sudo motd -clear</code> - Clear all messages' },
	echo:    { description: 'display text', args: '[text]', clientOnly: true, group: 'core',
	           help: 'Display the provided text in the terminal.<br/><br/>Usage: <code>echo [text]</code><br/><br/>Example: <code>echo Hello World</code>' },
	clear:   { description: 'clear the terminal', clientOnly: true, group: 'core', noArgs: true,
	           help: 'Clear all output from the terminal screen.' },
	exit:    { description: 'exit the terminal', clientOnly: true, group: 'core', noArgs: true,
	           help: 'Attempt to close the terminal window. May not work in all browsers due to security restrictions.' },
	ls:      { description: 'list connections', clientOnly: true, group: 'core', noArgs: true,
	           help: 'List all available link commands. Each link can be opened directly by typing its name, or use <code>-blank</code> to open in a new tab.' },
	// Utility commands
	info:    { description: 'system information', args: '[<code>server</code>]', clientOnly: true, group: 'utility',
	           help: 'Display system information.<br/><br/>Usage:<br/>• <code>info</code> - Show your browser/device info<br/>• <code>info server</code> - Show live server statistics (updates every 2s, press Ctrl+C to stop)' },
	weather: { description: 'weather', args: '[location, <code>-gps</code>]', clientOnly: true, group: 'utility',
	           help: 'Display current weather information.<br/><br/>Usage:<br/>• <code>weather</code> - Weather at your IP location<br/>• <code>weather [city]</code> - Weather at specified location<br/>• <code>weather -gps</code> - Weather using GPS (requires permission)' },
	cfu:     { description: 'my current CFU count', clientOnly: true, group: 'utility', noArgs: true,
	           help: 'Display Kevin\'s current university credit (CFU) count. Work in progress.',
	           handler: 'WIP' },
	env:     { description: 'display .env file', clientOnly: true, group: 'utility', noArgs: true,
	           help: 'Display the environment variables file. Just for fun!',
	           handler: 'USER="you"<br/>STUPID="true"<br/>ASTI="esplosa"<br/>SUDO="nano"' },
};

// Get list of client-only command names (for sudo delegation check)
const getClientCommands = () => [
	...Object.entries(COMMANDS).filter(([, v]) => v.clientOnly).map(([k]) => k),
	...Object.entries(linkConfig).filter(([, v]) => !v.sudoOnly).map(([k]) => k)
];

// Generate help text dynamically from COMMANDS registry
const generateHelpText = () => {
	const byGroup = (group) => Object.entries(COMMANDS)
		.filter(([, v]) => v.group === group)
		.map(([k, v]) => `<p><code>${k}</code> ${v.description}${v.args ? ` ${v.args}` : ''}</p>`)
		.join('\n\t\t\t');

	return `
		<p>${domain} ${getUserAgent()} Bash, version 1.0-release<br/>These shell commands are defined internally. Type 'help' to see this list.</p>
		<p><strong>Core commands:</strong></p>
		<div class="command-help-list">${byGroup('core')}</div>
		<p><strong>Link commands:</strong></p>
		<div class="command-help-list">
			<p><code>ls</code> list connections</p>
			${getLinkCommandsHelp()}
		</div>
		<p><strong>Utility:</strong></p>
		<div class="command-help-list">${byGroup('utility')}</div>
	`;
};

// Generic command executor - handles noArgs and static handlers
const execCmd = (name, args, customHandler) => {
	const cmd = COMMANDS[name];
	if (cmd?.noArgs && args.length) return printError(name, `unrecognized argument: ${args.join(' ')}`);
	if (typeof cmd?.handler === 'string') return printP(cmd.handler);
	if (customHandler) return customHandler(args);
};

// =============================
// Command Handlers
// =============================
const commandConfig = {
	help:  { execute: args => {
		if (args.length === 1) {
			const cmdName = args[0].toLowerCase();
			const cmd = COMMANDS[cmdName];
			const link = linkConfig[cmdName];
			
			if (cmd) {
				const helpText = cmd.help || cmd.description;
				printOutput(`<p><strong>${cmdName}</strong>${cmd.args ? ` ${cmd.args}` : ''}<br/><br/>${helpText}</p>`);
			} else if (link && !link.sudoOnly) {
				let helpText = `Open ${link.name}. Use <code>-blank</code> to open in a new tab.`;
				let argsText = '[<code>-blank</code>]';
				if (link.subcommands) {
					const subs = Object.entries(link.subcommands)
						.map(([k, v]) => `• <code>${cmdName} ${k}</code> - ${v.name}`)
						.join('<br/>');
					helpText += `<br/><br/>Subcommands:<br/>${subs}`;
					argsText = `[${Object.keys(link.subcommands).join('|')}] ${argsText}`;
				}
				printOutput(`<p><strong>${cmdName}</strong> ${argsText}<br/><br/>${helpText}</p>`);
			} else {
				printError('help', `no help entry for '${cmdName}'`);
			}
		} else if (args.length > 1) {
			printError('help', `unrecognized argument: ${args.slice(1).join(' ')}`);
		} else {
			printOutput(generateHelpText());
		}
	}},
	about: { execute: args => execCmd('about', args) },
	cfu:   { execute: args => execCmd('cfu', args) },
	env:   { execute: args => execCmd('env', args) },
	clear: { execute: args => execCmd('clear', args, () => { $('.sh').innerHTML = '<div class="commands"></div>'; }) },
	ls:    { execute: args => execCmd('ls', args, () => printP(`Available connections:<br/>${getLinksListHtml()}`)) },
	
	exit: { execute: args => execCmd('exit', args, () => {
		printP('Exiting terminal...');
		setTimeout(() => { window.close(); printError('exit', 'Unable to close terminal.'); }, 1000);
	})},
	
	sudo: { execute: args => { if (!args.length) printP('usage: <code>sudo</code> [command [arg...]]'); } },
	echo: { execute: args => printP(args.length ? escapeHtml(args.join(' ')) : '') },
	
	motd: {
		execute: async args => {
			if (args.length) return printError('motd', `unrecognized argument: ${args.join(' ')}`);
			try {
				const { success, motd } = await fetchJSON('/api/motd');
				printP(success && motd?.length ? formatMotd(motd, true) : 'No message of the day set.');
			} catch (err) {
				console.error('Error fetching MOTD:', err);
				printError('motd', 'could not fetch message of the day');
			}
		}
	},

	info: {
		execute: async (args) => {
			const argsLower = (args || []).map(a => a.toLowerCase());
			const wantsServer = argsLower.includes('server') || argsLower.includes('srv');

			if (!wantsServer) {
				const info = {
					'OS': getOS(), 'Browser': getBrowser(), 'User Agent': getUserAgent(),
					'Screen Resolution': `${screen.width}x${screen.height}`,
					'Color Depth': `${screen.colorDepth}-bit`,
					'Platform': navigator.platform,
					'CPU Cores': navigator.hardwareConcurrency || 'Unknown',
					'Device Memory': navigator.deviceMemory ? `${navigator.deviceMemory} GB` : 'Unknown',
					'Language': navigator.language,
					'Timezone': Intl.DateTimeFormat().resolvedOptions().timeZone,
					'Cookies Enabled': navigator.cookieEnabled ? 'Yes' : 'No',
					'JavaScript Enabled': 'Yes',
					'Do Not Track': navigator.doNotTrack == '1' ? 'Yes' : 'No',
					'Online Status': navigator.onLine ? 'Online' : 'Offline',
					'IP Address': '<span class="info-ip">fetching...</span>',
					'Location': '<span class="info-location">fetching...</span>'
				};
				printP(`<strong>Your System Information:</strong><br/>` + 
					Object.entries(info).map(([k, v]) => `${k}: ${v}`).join('<br/>'));

				const ip = await getIP($('.commands .output .info-ip'));
				await getLocation(ip, $('.commands .output .info-location'));
			} else {
				const containerId = `server-info-${Date.now()}`;
				printOutput(`<div id="${containerId}" class="server-info"></div>`);

				const container = document.getElementById(containerId);
				const el = document.createElement('div');
				el.innerHTML = '<p>Loading server info...</p>';
				el.classList.add('info-container');
				container.appendChild(el);

				const renderServer = (data) => {
					if (!data) {
						el.innerHTML = '<p>Unable to fetch server info.</p>';
						return;
					}

					const { cpu = {}, load = {}, memory: mem = {}, temperature, uptime = 0, timestamp } = data;
					const temp = temperature?.main ? `${temperature.main} °C` : 'N/A';
					const perCore = load.cpus?.length 
						? load.cpus.map((c, i) => `Core ${i}: ${c.load.toFixed(1)}%`).join('<br/>') 
						: '';

					el.innerHTML = `
						<p><strong>Server System Information (as of ${new Date(timestamp).toLocaleString()}):</strong><br/>
						CPU: ${cpu.manufacturer || ''} ${cpu.brand || ''} (${cpu.cores || cpu.physicalCores || 'N/A'} cores)<br/>
						Load: ${load.currentLoad ? load.currentLoad.toFixed(1) + '%' : (load.avgLoad || 'N/A')}<br/>
						Memory: ${mem.used ? `${Math.round((mem.used / mem.total) * 100)}% used (${(mem.used / 1073741824).toFixed(2)} GB / ${(mem.total / 1073741824).toFixed(2)} GB)` : 'N/A'}<br/>
						Uptime: ${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m<br/>
						Temperature: ${temp}<br/>
						<div>${perCore}</div></p>
					`;
				};

				const fetchAndRender = async () => {
					try {
						const data = await fetchJSON('/api/sysinfo/cpu');
						renderServer(data);
					} catch (e) {
						el.innerHTML = `<p>Error fetching server info: ${e.message}</p>`;
					}
				};

				await fetchAndRender();
				stopServerUpdates(false);
				
				const id = setInterval(fetchAndRender, 2000);
				serverInfoInterval = { id, containerId };
				
				const infoNote = document.createElement('div');
				infoNote.innerHTML = '<p>Live updates every 2s. Use <code>CTRL+C</code> to stop.</p>';
				container.appendChild(infoNote);
			}
		}
	},

	weather: {
		acceptsArgs: true,
		execute: async (args) => {
			const argsLower = (args || []).map(a => a.toLowerCase());
			const wantsGps = argsLower.includes('-gps');
			const filteredArgs = args.filter(a => a.toLowerCase() !== '-gps');
			const locationInput = filteredArgs.join(' ');
			let lat, lon, displayLocation;

			try {
				if (wantsGps) {
					if (!('geolocation' in navigator)) {
						printError('weather', 'GPS not available in this browser');
						return;
					}

					const pos = await new Promise((resolve, reject) => {
						navigator.geolocation.getCurrentPosition(resolve, reject, {
							enableHighAccuracy: true,
							maximumAge: 60000,
							timeout: 30000
						});
					});

					lat = pos.coords.latitude;
					lon = pos.coords.longitude;

					try {
						const geoData = await fetchJSON(
							`https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lon}`,
							{ headers: { 'User-Agent': `${domain}`, 'Accept-Language': navigator.language } }
						);
						if (geoData?.address) {
							const addr = geoData.address;
							displayLocation = [addr.city || addr.town || addr.village || addr.hamlet || addr.county, addr.state, addr.country]
								.filter(Boolean).join(', ');
						} else {
							displayLocation = `Lat ${lat.toFixed(2)}, Lon ${lon.toFixed(2)}`;
						}
					} catch {
						displayLocation = `Lat ${lat.toFixed(2)}, Lon ${lon.toFixed(2)}`;
					}
				} else if (locationInput) {
					const geoData = await fetchJSON(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(locationInput)}`);
					if (!geoData.results?.length) throw new Error("Location not found.");
					const place = geoData.results[0];
					lat = place.latitude;
					lon = place.longitude;
					displayLocation = `${place.name}, ${place.country}`;
				} else {
					const locData = await fetchJSON('https://ipinfo.io/json');
					[lat, lon] = locData.loc.split(',');
					displayLocation = `${locData.city}, ${locData.country}`;
				}
			} catch (err) {
				if (err.code === 1) {
					printError('weather', 'GPS authorization not given (permission denied)');
				} else if (err.code === 2) {
					printError('weather', 'GPS position unavailable');
				} else if (err.code === 3) {
					printError('weather', 'GPS request timed out');
				} else {
					printError('weather', 'Could not resolve location.');
				}
				return;
			}

			try {
				const weatherData = await fetchJSON(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current_weather=true&timezone=auto`);
				if (!weatherData.current_weather) throw new Error('No weather data available');
				
				const { current_weather: weather, timezone = 'UTC' } = weatherData;
				const conditionText = WEATHER_CODES[weather.weathercode] || 'Unknown';
				const emoji = conditionText.match(/[\p{Emoji}]/gu)?.pop() || '🌡️';
				const condition = conditionText.replace(/[\p{Emoji}]/gu, '').trim();
				const formattedTime = formatDate(new Date(), { ...dateFormatOptions, timeZone: timezone });

				printOutput(`
					<div class="weather-card">
						<span class="weather-emoji">${emoji}</span>
						<div class="weather-info">
							<span class="weather-location">${displayLocation}</span>
							<span>${condition}</span>
							<span>${weather.temperature}°C</span>
							<span>Wind: ${weather.windspeed} km/h</span>
							<span>${formattedTime}</span>
						</div>
					</div>
				`);
			} catch (err) {
				console.error('Weather fetch error:', err);
				printError('weather', 'could not fetch weather data');
			}
		}
	}
};

// =============================
// Command Execution
// =============================
function handleLinkCommand(command, args, config) {
	const hasBlank = args.includes('-blank');
	const target = hasBlank ? '_blank' : '_self';
	const filteredArgs = args.filter(a => a !== '-blank');
	
	// Check for subcommand
	if (filteredArgs.length && config.subcommands) {
		const subCmd = filteredArgs[0].toLowerCase();
		const sub = config.subcommands[subCmd];
		if (sub) {
			if (filteredArgs.length > 1) {
				return printError(`${command} ${subCmd}`, `unrecognized argument: ${filteredArgs.slice(1).join(' ')}`);
			}
			window.open(sub.url, target);
			printP(`Connecting to ${sub.name}...${target === '_blank' ? ' (new tab)' : ''}`);
			return;
		}
		return printError(command, `unknown subcommand: ${subCmd}. Available: ${Object.keys(config.subcommands).join(', ')}`);
	}
	
	if (filteredArgs.length) {
		return printError(command, `unrecognized argument: ${filteredArgs.join(' ')}`);
	}
	
	// Use getLinkUrl to handle redirect vs direct URLs
	const url = getLinkUrl(command) || config.url;
	window.open(url, target);
	printP(`Connecting to ${config.name}...${target === '_blank' ? ' (new tab)' : ''}`);
}

async function handleCommand(input) {
	const [command, ...args] = input.trim().split(' ');
	const cmd = command.toLowerCase();
	const link = linkConfig[cmd];

	if (commandConfig[cmd]) {
		await commandConfig[cmd].execute(args);
	} else if (link && !link.sudoOnly) {
		handleLinkCommand(cmd, args, link);
	} else {
		printError('', `Unrecognized command: ${cmd}`);
	}

	window.scrollTo(0, document.body.scrollHeight);
}

async function handleSudoAuth(originalCommand, password) {
	try {
		const sudoArg = originalCommand.slice(5).trim();
		const { valid, output, redirect, target, clientCommand } = await (await fetch('/api/sudo', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ password, arg: sudoArg })
		})).json();

		if (!valid) return printError(originalCommand, 'authentication failure');

		const firstWord = sudoArg.split(' ')[0].toLowerCase();

		// Server indicated this should be handled client-side, or we recognize it as a client command
		if (clientCommand || getClientCommands().includes(firstWord)) {
			await handleCommand(sudoArg);
		} else if (output) {
			printP(output);
			if (redirect) window.open(redirect, target === '_blank' ? '_blank' : '_self');
		}

		// Refresh header MOTD if changed
		if (sudoArg.toLowerCase().startsWith('motd')) {
			try {
				const { success, motd } = await fetchJSON('/api/motd');
				const el = $('.MOTD');
				if (el) el.innerHTML = success && motd?.length ? formatMotd(motd) + '<br/>' : '';
			} catch {}
		}
	} catch {
		printError(originalCommand, 'generic error');
	}
	printNewPrompt();
}

// =============================
// Password Input Handler
// =============================
function setupPasswordInput(originalCommand) {
	printOutput(`<div class="line">[sudo] password:
		<div class="password-input active" contenteditable="true" spellcheck="false" autofocus autocomplete="off" autocapitalize="off" autocorrect="off"></div>
	</div>`);
	
	const input = $('.password-input.active');
	input.focus();
	let pwd = '';

	input.addEventListener('beforeinput', e => {
		e.preventDefault();
		if (e.inputType === 'insertText') pwd += e.data;
		else if (e.inputType === 'deleteContentBackward') pwd = pwd.slice(0, -1);
	});

	input.addEventListener('keydown', async e => {
		if (e.key === 'Enter') {
			e.preventDefault(); deactivate(input);
			if (!pwd) { printError(originalCommand, 'no password entered'); printNewPrompt(); return; }
			await handleSudoAuth(originalCommand, pwd);
		} else if (e.key === 'c' && (e.ctrlKey || e.metaKey)) {
			e.preventDefault(); deactivate(input);
			printError(originalCommand, 'command canceled'); printNewPrompt();
		}
	});
}

// =============================
// Event Handlers
// =============================
function handleCtrlC(e) {
	if ((e.key === 'c' || e.key === 'C') && (e.ctrlKey || e.metaKey)) {
		e.preventDefault();
		if (stopServerUpdates()) {
			printNewPrompt();
		}
	}
}

async function handleCommandInput(e) {
	const input = e.target;

	if (e.key === 'c' && (e.ctrlKey || e.metaKey)) {
		e.preventDefault();
		if (stopServerUpdates()) { printP('Live updates stopped (Ctrl+C).'); printNewPrompt(); return; }
		deactivate(input); printError('', 'command canceled'); printNewPrompt(); return;
	}

	if (e.key === 'Enter') {
		e.preventDefault(); deactivate(input);
		const cmd = input.textContent.trim();
		if (!cmd) { printNewPrompt(); return; }

		if (!commands.length || commands.at(-1) !== cmd) { commands.push(cmd); saveCommandHistory(); }
		commandIndex = commands.length;

		await handleCommand(cmd);
		if ((cmd.startsWith('info server') || cmd.startsWith('info srv')) && serverInfoInterval) return;
		if (!cmd.startsWith('sudo') || cmd === 'sudo') printNewPrompt();
		else setupPasswordInput(cmd);
	} else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
		e.preventDefault();
		if (!commands.length) return;
		commandIndex = e.key === 'ArrowUp' 
			? Math.max(0, commandIndex - 1) 
			: Math.min(commands.length, commandIndex + 1);
		input.textContent = commands[commandIndex] || '';
		if (input.textContent) setCursorAtEnd(input);
	}
}

const handleDocumentClick = () => {
	if (!window.getSelection()?.toString()) $('.command-input.active')?.focus();
};

// =============================
// Initialization
// =============================
async function init(lastLogin) {
	// Load configuration from server (single source of truth: config/config.json)
	try {
		const config = await fetchJSON('/api/config');
		linkConfig = config.links || {};
		WEATHER_CODES = config.weatherCodes || {};
		dateFormatOptions = config.dateFormat || {};
		STORAGE_KEY = config.terminal?.storageKey || STORAGE_KEY;
		MAX_HISTORY_SIZE = config.terminal?.maxHistorySize || MAX_HISTORY_SIZE;
	} catch (err) {
		console.error('Failed to load config:', err);
	}

	// Load command history from localStorage
	commands = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
	commandIndex = commands.length;

	$$('.year').forEach(el => el.textContent = currentYear);
	$$('.url').forEach(el => el.textContent = domain);

	const now = new Date();
	const dateEl = $('.date');
	if (dateEl) dateEl.textContent = formatDate(now);

	const lastDateEl = $('.last-date');
	if (lastDateEl) {
		const ld = lastLogin?.request_date;
		lastDateEl.textContent = ld ? formatDate(new Date(ld)) : 'never';
	}

	const ua = getUserAgent();
	$('.user-agent') && ($('.user-agent').textContent = ua);
	$('.last-user-agent') && ($('.last-user-agent').textContent = lastLogin?.user_agent || 'unknown agent');
	$('.last-ip') && ($('.last-ip').textContent = lastLogin?.ip || '');
	$('.last-location') && ($('.last-location').innerHTML = locationIcon(lastLogin?.location));

	const ip = await getIP($('.ip'));
	const loc = await getLocation(ip, $('.location'));

	// MOTD
	try {
		const { success, motd } = await fetchJSON('/api/motd');
		const el = $('.MOTD');
		if (el && success && motd?.length) el.innerHTML = formatMotd(motd) + '<br/>';
	} catch {}

	// Save login
	try {
		await fetch('/api/save-login', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ login_date: now.toISOString(), user_agent: ua, ip_address: ip, location: loc })
		});
	} catch {}

	document.addEventListener('keydown', handleCtrlC);
	document.addEventListener('click', handleDocumentClick);
	document.addEventListener('keydown', e => {
		if (e.target.classList.contains('command-input') && e.target.classList.contains('active')) handleCommandInput(e);
	});
}

window.terminalInit = init;
