# Constrapp — Frontend

The entire Constrapp application lives in this directory (React 19 + Vite +
Tailwind CSS v4 + Firebase client SDK).

**Start with the [root README](../README.md)** for project overview, Firebase
setup, and the documentation index. Conventions: [AGENT.md](../AGENT.md).

## Commands (run from this directory)

```bash
npm install                  # install dependencies
cp .env.example .env.local   # then fill in Firebase web config
npm run dev                  # dev server with HMR
npm run build                # production build → dist/
npm run preview              # serve the production build locally
npm run lint                 # ESLint
```
