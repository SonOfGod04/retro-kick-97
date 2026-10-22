# Retro Kick '97 ⚽

A retro-inspired, playable 7-a-side football game built with **Phaser 3, TypeScript, and Vite**. Play in a modern browser—no install required for players.

> **Game rule:** Each side has 7 players: 6 outfield players and 1 goalkeeper.

## Features

- Retro arcade-inspired pitch and scoreboard
- 7 players per team, including a goalkeeper
- Keyboard movement, sprinting, passing, shooting, and tackling
- CPU-controlled opposition
- Match clock, two halves, score tracking, and new-match reset
- Responsive browser layout
- GitHub Pages deployment workflow

## Controls

| Key | Action |
| --- | --- |
| `W A S D` or arrow keys | Move the controlled player |
| `X` | Pass when near the ball; otherwise switch to the nearest teammate |
| `Z` | Shoot toward the opponent's goal |
| `Space` | Attempt a tackle |
| `Shift` | Sprint |
| `P` | Pause / resume |
| `Enter` | Start a new match after full-time |

Click the pitch to begin. A match has two 2-minute halves. This is an arcade prototype; gameplay and AI can be expanded over time.

## Run locally

### Requirements

- Node.js 20 or newer (Node.js 22 LTS recommended)
- npm (included with Node.js)
- Git (for GitHub publishing)

### Install and start

```bash
git clone https://github.com/YOUR-USERNAME/retro-kick-97.git
cd retro-kick-97
npm install
npm run dev
```

Vite prints a local URL, usually `http://localhost:5173`. Open it in your browser.

### Production build

```bash
npm run typecheck
npm run build
npm run preview
```

The production-ready site is generated in `dist/`.

## Publish to GitHub

1. Create a **public** repository named `retro-kick-97` on GitHub. Do not initialise it with a README if you already have this project folder.
2. Open this folder in VS Code.
3. Open **Terminal → New Terminal** and run:

```bash
git init
git add .
git commit -m "Build Retro Kick 97 browser football game"
git branch -M main
git remote add origin https://github.com/YOUR-USERNAME/retro-kick-97.git
git push -u origin main
```

Replace `YOUR-USERNAME` with your GitHub username. If Git asks you to authenticate, follow the GitHub sign-in prompt; never paste a password or token into source code.

If the project is already a Git repository, skip `git init`. If `origin` already exists, check it with `git remote -v` rather than adding it again.

## Deploy on GitHub Pages

A workflow in `.github/workflows/deploy.yml` builds the game and publishes `dist/` whenever you push to `main`.

1. Push the project to a GitHub repository named `retro-kick-97`.
2. On GitHub, open **Settings → Pages**.
3. Under **Build and deployment → Source**, choose **GitHub Actions**.
4. Open the **Actions** tab and wait for the Pages workflow to finish.
5. Your site will be available at `https://YOUR-USERNAME.github.io/retro-kick-97/`.

The Vite base path is configured for that repository name. If you choose a different repository name, update `base` in `vite.config.ts` and the workflow path as needed.

## Project structure

```text
retro-kick-97/
├── .github/
│   └── workflows/
│       └── deploy.yml
├── src/
│   ├── main.ts
│   └── style.css
├── .gitignore
├── index.html
├── package.json
├── README.md
├── tsconfig.app.json
├── tsconfig.json
└── vite.config.ts
```

## Technology

- [Phaser 3](https://phaser.io/) — 2D browser game framework
- [TypeScript](https://www.typescriptlang.org/) — typed game code
- [Vite](https://vite.dev/) — development server and production bundler
- [GitHub Pages](https://pages.github.com/) — static hosting

## Roadmap

- Improved team formations and player switching
- More convincing passing, possession, and CPU tactics
- Touchscreen controls
- Sound effects and crowd ambience
- Team selection and tournament mode
- Gameplay tests and accessibility improvements

## License

No license is applied by default. Before making the repository public, decide how others may use the code. If you want a permissive open-source project, consider the MIT License and add a `LICENSE` file with the standard MIT text and your chosen copyright holder. Do not copy assets, music, logos, or code from commercial football games without permission.

## Contributing

Issues and pull requests are welcome. Please describe the change and test with `npm run typecheck` and `npm run build` before submitting a pull request.
