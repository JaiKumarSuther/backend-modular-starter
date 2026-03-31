# backend-modular-starter

> Industry-ready modular Node.js backend scaffolding CLI — by Jai

Scaffold a production-ready Express backend with auth, users, Swagger, rate limiting, optional databases (MongoDB/PostgreSQL/MySQL), Redis, Socket.IO, and Docker — in seconds.

## Installation

```bash
npm install -g backend-modular-starter
```

Or run with `npx`:

```bash
npx backend-modular-starter
```

## Usage

```bash
backend-modular-starter
```

Pass the project name as a positional argument to skip the name prompt:

```bash
npx backend-modular-starter my-project-name
```

You'll be prompted to choose:

- **Project name** – Folder name for your new project
- **Database** – MongoDB, PostgreSQL, MySQL, or None
- **Redis** – Include Redis for caching/queues
- **Socket.IO** – Include real-time events
- **Docker** – Add Dockerfile + docker-compose
- **npm install** – Run install automatically

## What You Get

- **Express** with security (Helmet, CORS, rate limiting)
- **Auth** – JWT register/login/me with brute-force protection
- **User module** – CRUD, change password, soft delete, role-based access
- **Swagger** – Auto-generated API docs at `/api-docs`
- **Validation** – Joi-ready middleware
- **Logging** – Winston with file transports
- **Graceful shutdown** – SIGTERM/SIGINT handling
- **Health check** – `/health` endpoint that pings DB + Redis

## Requirements

- Node.js >= 16
- Git (optional; used for initial commit)

## License

MIT © Jai
