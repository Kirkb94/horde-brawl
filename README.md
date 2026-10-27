# Horde Brawl

A BAPBAP-style hero brawler built on Horde Duel: 16 fighters per battle royale, 13 heroes to pick from. Same engine, maps, voices and online server. Two pillars drive the design: **hero kits** and **cards**. The zone is a closing ring of zombies (the Tide), not a storm.

## Pillar 1 · Hero kits
Every hero has one readable loop. The keys are rebindable in Settings.

| Key | Slot | Notes |
|---|---|---|
| Fire | Gun | Each hero's Horde Duel weapon |
| Space | Dash | i-frames. Baiting out the other player's dash is the core mind game |
| Q / right click | Signature | The Horde Duel ability |
| E | Skill | New. Short cooldown |
| X | Ultimate | New. Charges from damage you deal (heroes count 2× more than zombies), kills and a steady trickle (1.2 a second). Damage charge is capped per second so one big cast can't refill it. A first ult takes about 45-60 s. Fills on a Tyrant kill. Rates live in `ULT_TRICKLE`, `ULT_HERO`, `ULT_ZOMB`, `ULT_KILL`, `ULT_SEC` |

| Hero | Loop | E skill | X ultimate |
|---|---|---|---|
| Wren | Turret network | Relay: swap places with your turret | Overclock: turrets fire 3× faster, you 40% faster |
| Cinder | Ignite, then detonate | Flashpoint: burning foes explode | Wildfire: a wall of ten fire bombs |
| Haze | Tag and trap | Smoke Step: a dash that trails gas | Choke Cloud: a huge slowing gas field that shows foes through walls |
| Aegis | Absorb, then release | Shield Bash: a charge that hits for half your barrier's HP | Bulwark: 220 HP barrier and half damage for you and allies |
| Rampart | Pin them to walls | Hook: a chained hook that drags the first hero it hits back to you | Fortress: four spiked walls |
| Veil | Stealth resets | Shadow Step: a silent blink, then cloak | Deadeye: a piercing rail shot. A kill resets Cloak |
| Torque | Air mobility | Satchel: a delayed charge | Barrage: twenty rockets around your aim |
| Lattice | Zone control | Overload: every post discharges | Cage: an electrified trap on the nearest foe |
| Argus | Mark and punish | Paint: +30% damage taken from everyone | Uplink: strikes every enemy hero on the map (a dash dodges it) |
| Halcyon | Protect and pull | Backdraft: pull foes in and burn them | Sanctuary: a healing dome |
| Sabre | Chain resets | Parry: reflects shots for 0.7s | Thousand Cuts: blink through six foes |
| Anvil | Dive and hold | Shockwave: a rolling quake that roots, then stuns | Unbound: a few seconds of huge max health |
| Mortis | Fight with an army | Grave Hover: rise up, then swoop and raise crawlers | Raise Dead: a Matriarch that spawns spiders |

Per-hero cooldowns and ult charge speed (`x`) come from the `ABAL` table. All kit numbers live in `KIT` (text and cooldowns) and in `skillCore` / `ultCore` in `public/index.html`.

## Pillar 2 · Cards
- **Common cards** are small stat pieces whose value depends on the kit holding them. Heavy Rounds (+2 per pellet) is huge on a shotgun, and Vampiric Rounds suits fast guns. These are Horde Duel's upgrades plus 11 new ones.
- **Tags and sets:** every card has a tag (Power, Tempo, Sustain, Mobility, Tech, Ultimate, Horde). Three cards of one tag (stacks count) light up its set bonus. Tune this in `TAGS` and `SET_AT`.
- **Gold rare cards** break a rule. There are five general ones and one per hero. From drop 2 a rare can replace the third card (`RARE_CHANCE` = 30%). Killing the Tyrant offers three rares.
- **One free reroll per match** in solo play.
- Bots grab rares whenever they see one.

## The Tide (replaces the storm)
The zone never burns you. Outside it the horde pours in and hunters spawn on you, as in Horde Duel. Each shrink is a phase. Brutes grow more common every phase, runners join from phase 1 (about 20 s), and **the Tyrant** (a boss) rises near the middle of the zone in phase 2 (about 70 s). It is marked on the minimap, and its health shows on the HUD. Its killer gets a full ultimate, 60 HP and a rare card. The drop's top killer (3+ kills) carries a **bounty**, and hunters spawn on them. All numbers live in `TIDE`.

**Spawns:** heroes drop at least ~1000 apart where the map allows it (`SPAWN_MIN`, `spawnSpread`), inside a spawn shield bubble that blocks all damage for 6 s (`SPAWN_SH`) and ends early when the hero attacks.

## Online
Online works as in Horde Duel. E and X are sent as `e` and `x` input actions, and `ult`, `skCD` and the new status timers are in the snapshots. Rare picks after a Tyrant kill are auto-chosen for online players, and rerolls are solo-only for now. Siege is solo only for now (the server does not run its shop, towers and lanes). Modifiers work online too: the room leader sets them in the lobby. Effects like beams and rings are drawn locally, so remote players see the result (damage, deploys) but not every flash.
`sim.js` stubs `MutationObserver`, `ResizeObserver` and `documentElement.classList`. The newer Horde Duel page uses them, and without the stubs the server-authoritative mode crashes on load.

---

# Horde Duel Online

Up to 16 players per room on one Render web service. The service serves the game page and runs the multiplayer.

## Two modes (environment variable `MODE`)
| | `auth` (default) | `relay` |
|---|---|---|
| Who runs the match | **The server** (same game code, bots and zombies, headless) | The room creator's browser |
| Host tab must stay open | No | Yes |
| If the creator leaves | Match continues, next player becomes room leader | Room closes |
| Render plan | **Standard (1 CPU) for full 16-fighter matches.** Starter (0.5 CPU) can't keep up once the horde grows: a match costs about 60% of a core, so the server gets throttled. See "Server speed" below | Free works |
| Lag | One network hop, one clock, no weak host | Host's PC and upload limit everyone |
| Rejoin after disconnect | Supported (auth only) | Not available: the server replies "Rejoin isn't available on this server" |

Rejoin is auth-only because the server owns the match state and can hold a player's slot. In relay mode the host's browser owns it, so a dropped player has to join a new room.
Players send inputs; the server sends each player a snapshot of what is near them 20 times a second.
Your own movement is predicted locally so it stays responsive. In `auth` mode every fighter, bullet and zombie is simulated in one place, so nobody has a different picture of the match.

## Deploy on Render (about 5 minutes)
1. Put this folder in a GitHub repo.
2. In Render choose **New → Blueprint** and pick the repo. `render.yaml` sets it up (Starter plan, `MODE=auth`).
   Or **New → Web Service** manually: Runtime Node, Build `npm install`, Start `npm start`, Health check `/healthz`, env `MODE=auth`.
3. Open the `https://<your-service>.onrender.com` URL, tap **Play online**, then **Create a room** and share the 4 letter code, or **Quick play**.
4. Pick a Render region close to your players.

**Free plan:** the sim needs more CPU than the free instance offers, so use `MODE=relay` there. Free services also sleep after about 15 minutes idle (first player waits up to a minute).

## Rejoin (auth mode only)
If a player drops mid-match, `MODE=auth` keeps their slot for a short time so they can rejoin the same match. The private session token the server issues when you join (not the socket ID or player ID) is the rejoin identity: the browser keeps it in `sessionStorage` for that tab, and the server only accepts a 32-hex token that matches a held slot, closes any stale old connection, and resends the match state. A socket gets 5 failed attempts before it is closed. The client shows "Reconnecting…" and retries for about 25 seconds (the slot is held for 30). `MODE=relay` does not support rejoin: the match lives in the creator's browser, so the server has nothing to hand back. A relay server answers a rejoin attempt with "Rejoin isn't available on this server", and a dropped player has to start or join a new room.

## Settings (environment variables)
- `MODE` = `auth` or `relay`
- `TICK_HZ` (default 30): server simulation rate
- `MAX_MATCHES` (default 4 in auth mode): matches the server runs at once. Each uses roughly 15 MB and 5 to 10% of a core.
- `MAX_ROOMS` (default 60), `DEFLATE=0` turns off WebSocket compression
- `ALLOWED_ORIGINS`: comma-separated origins (or bare hosts) whose pages may open the WebSocket, e.g. `https://mygame.example.com,other.example.org`. Use this only if the page is hosted somewhere other than this server. Always allowed without configuring: the server's own host (same-origin), `RENDER_EXTERNAL_URL`, `http(s)://localhost`, `127.0.0.1` and `[::1]` on any port (set `ALLOW_LOCALHOST=0` to turn that off), and non-browser clients that send no Origin header. `ALLOWED_ORIGINS=*` disables the check (not recommended). A rejected handshake gets HTTP 403 with a message naming the offending origin and this variable, and the server logs `ws: rejected origin ...`. Browsers show this as a failed WebSocket connection, so check the server log or the Network tab to see the message.
- `GET /healthz` returns `ok`. `GET /stats` shows mode, rooms, matches, the server tick time (`tickMsAvg` should stay well under 33) and `lostGameSec`, the game time dropped because the CPU could not keep up. It should stay near 0.

## Server speed (why online play rubberbanded)
The server runs the match in fixed ticks of 1/`TICK_HZ` seconds. It measures real elapsed time and, after a stall (Render throttles a plan that uses more CPU than it pays for), runs up to 4 ticks back to back to catch up. The old loop capped each tick at 0.05s and dropped the rest. On the Starter plan that ran matches at about half speed, so each player's predicted movement kept running ahead of the server and got pulled back.
Clients also measure how fast the server's clock really runs over 2-second windows. If it falls below about 90% of real time, they predict their own movement at that speed, so a struggling server feels slower rather than rubberbanding.
On the server only, zombies with no fighter within 650px think every other tick. Zombies scan a per-tick list of living fighters instead of every entity on the map.

## Run locally
```
npm install
npm start      # http://localhost:3000
```
Open it in several browser windows: create a room in one, join with the code in the others.

## Releasing
The game shows a **What's new** screen once per new version over the main menu, and the menu's *What's new* button reopens it. It reads `public/changelog.json`, a static file shipped with the game (never fetched from GitHub). If the file is missing or broken there is no screen.

At push time, add the push's notes with `tools/changelog.mjs` (Node 18+, no packages). Give it the commits of the push (everything since the previous push) as JSON on stdin or with `--commits`, plus optional hand-written notes:
```
node tools/changelog.mjs --commits commits.json --notes notes.md
```
- `commits.json`: `[{"hash":"f32ae16","date":"2026-10-26T13:29:53-04:00","subject":"...","body":"..."}, ...]`
- `notes.md`: `# Title`, then `## New` / `## Balance` / `## Fixes` / `## Visuals` headings with `- item` lines. JSON `{"title":"...","groups":[{"name":"New","items":["..."]}]}` also works. Without notes the commits are grouped by keyword (fix/bug → Fixes, balance/nerf/buff/dmg/hp → Balance, art/anim/visual/tiles → Visuals, else New). `Co-Authored-By` and `Claude-Session` lines are dropped.
- It puts the new version first in `public/changelog.json` (the newest commit hash is the version id; re-running replaces it) and keeps the last 10. Commit the file, then push. Other options: `--out`, `--title`, `--date YYYY-MM-DD`, `--id`, `--keep`, `--dry-run`, `--help`.
- Each player's last seen version is kept in their browser (`localStorage` key `hordenews`). Links with a room code or `?fast`, and online rejoins, skip the screen and only show the button.

## Files
- `server.js` rooms, relay and match loop. `sim.js` runs the game's own code headlessly inside the server.
- `public/index.html` the game (solo plus online). `dev/` has the online layer source and the build script.

## Game modes
The room leader picks the mode in the lobby: **Battle royale** (lobby size slider 2–16, empty slots are bots), **1v1** (2 players) and **2v2** (4 players, each picks Team A/B; teammates cannot hurt each other). 1v1/2v2 use a small arena with a light zombie horde, first to 3 round wins. Solo play has the same modes in the main menu (2v2 solo = you + a bot ally vs two bots).

## Rematch and highlights
When a match ends, the room leader gets **Rematch** (same players, mode, teams and lobby size; everyone else sees a waiting note) or **Back to lobby**. Everyone gets a **Highlights** replay: the sim records the match at 10 samples a second and picks the best five moments (multi-kills, final blows, long shots, clutch kills). The reel is sent once with the final results, about 50 to 100 KB.
